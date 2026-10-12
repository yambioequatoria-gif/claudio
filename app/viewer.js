// The PDF view: lays out pages, renders the ones near the viewport with PDFium, and draws text selection,
// links and search highlights from PDFium's own glyph geometry, so they cannot drift from what is drawn.
import { engine, call, fromEngineRect, PdfAnnotationSubtype, MatchFlag } from "./engine.js";
import { buildFormControls } from "./forms.js";
import {
  buildPageData,
  caretAt,
  charAt,
  wordRange,
  lineRange,
  rangeRects,
  findAutolinks,
  snapLinkRect,
  overlapFraction,
} from "./pagedata.js";

const PT_TO_PX = 96 / 72;
const PAD = 20;
const GAP = 14;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const MAX_BITMAP_PIXELS = 36 * 1024 * 1024;
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

export class PdfView extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.pagesEl = document.createElement("div");
    this.pagesEl.className = "pages";
    this.container.append(this.pagesEl);

    this.doc = null;
    this.pages = [];
    this.layout = { tops: [], heights: [], total: 0 };
    this.zoom = 1;
    this.fitMode = "width"; // "width" | "page" | null
    this.generation = 0;
    this.current = 0;

    this.selection = null; // { anchor: {page, caret}, focus: {page, caret} }
    this.selectionText = null;
    this.drag = null;
    this.hot = null; // link under the pointer
    this.hits = [];
    this.hitIndex = -1;
    this.pointerTool = null; // set by the editor to take over pointer input
    this.renderQueue = [];
    this.renderingCount = 0;
    this.scheduled = false;

    this.container.addEventListener("scroll", () => this.#schedule(), { passive: true });
    new ResizeObserver(() => {
      if (this.fitMode) this.#applyFit();
      this.#schedule();
    }).observe(this.container);
    this.container.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false });
    this.pagesEl.addEventListener("pointerdown", (e) => this.#onPointerDown(e));
    this.pagesEl.addEventListener("pointermove", (e) => this.#onHover(e));
    this.pagesEl.addEventListener("pointerleave", () => this.#setHot(null));
    window.addEventListener("pointermove", (e) => this.#onDragMove(e));
    window.addEventListener("pointerup", (e) => this.#onPointerUp(e));
    document.addEventListener("copy", (e) => this.#onCopy(e));
  }

  // ---------------------------------------------------------------- document

  async setDocument(doc, { keepView = false } = {}) {
    const kept = keepView ? { zoom: this.zoom, fit: this.fitMode, scroll: this.container.scrollTop } : null;
    this.generation++;
    this.doc = doc;
    this.pages = [];
    this.pagesEl.replaceChildren();
    this.selection = null;
    this.selectionText = null;
    this.hits = [];
    this.hitIndex = -1;
    this.renderQueue = [];
    this.current = 0;
    for (const pageObj of doc.pages) {
      const el = document.createElement("div");
      el.className = "page";
      el.dataset.page = String(pageObj.index);
      el.style.setProperty("--w", String(pageObj.size.width));
      el.style.setProperty("--h", String(pageObj.size.height));
      const layers = {};
      for (const name of ["find", "sel", "links", "forms", "marks"]) {
        layers[name] = document.createElement("div");
        layers[name].className = `layer ${name}`;
        el.append(layers[name]);
      }
      this.pagesEl.append(el);
      this.pages.push({
        index: pageObj.index,
        pageObj,
        w: pageObj.size.width,
        h: pageObj.size.height,
        el,
        layers,
        canvas: null,
        renderedKey: null,
        rendering: false,
        data: null,
        dataPromise: null,
      });
    }
    if (kept) {
      this.fitMode = kept.fit;
      if (kept.fit) this.#applyFit();
      else {
        this.zoom = kept.zoom;
        this.#relayout();
      }
      this.container.scrollTop = kept.scroll;
    } else {
      this.fitMode = "width";
      this.#applyFit();
      this.container.scrollTop = 0;
    }
    this.#schedule();
    this.#emit("ready", { pageCount: doc.pageCount });
  }

  clear() {
    this.generation++;
    this.doc = null;
    this.pages = [];
    this.pagesEl.replaceChildren();
    this.selection = null;
  }

  get pageCount() {
    return this.pages.length;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ------------------------------------------------------------------ layout

  get scale() {
    return this.zoom * PT_TO_PX;
  }

  #relayout() {
    const s = this.scale;
    this.pagesEl.style.setProperty("--s", String(s));
    let top = PAD;
    const tops = [];
    const heights = [];
    for (const p of this.pages) {
      tops.push(top);
      const h = p.h * s;
      heights.push(h);
      top += h + GAP;
    }
    this.layout = { tops, heights, total: top - GAP + PAD };
  }

  setZoom(value, anchor) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    if (!this.doc || Math.abs(next - this.zoom) < 1e-6) return;
    const keep = anchor ?? this.#viewportAnchor();
    this.zoom = next;
    this.#relayout();
    this.#restoreAnchor(keep);
    for (const p of this.pages) p.renderedKey = p.renderedKey ? `stale:${p.renderedKey}` : null;
    this.#schedule();
    this.#emit("zoom", { zoom: this.zoom, fit: this.fitMode });
  }

  zoomBy(factor, anchor) {
    this.fitMode = null;
    this.setZoom(this.zoom * factor, anchor);
  }

  fitWidth() {
    this.fitMode = "width";
    this.#applyFit();
  }

  fitPage() {
    this.fitMode = "page";
    this.#applyFit();
  }

  #applyFit() {
    if (!this.pages.length) return;
    const page = this.pages[Math.min(this.current, this.pages.length - 1)];
    const availW = Math.max(100, this.container.clientWidth - PAD * 2);
    let zoom = availW / (page.w * PT_TO_PX);
    if (this.fitMode === "page") {
      const availH = Math.max(100, this.container.clientHeight - PAD * 2);
      zoom = Math.min(zoom, availH / (page.h * PT_TO_PX));
    }
    const prev = this.zoom;
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const keep = this.#viewportAnchor();
    this.#relayout();
    this.#restoreAnchor(keep);
    if (Math.abs(prev - this.zoom) > 1e-6) {
      for (const p of this.pages) p.renderedKey = p.renderedKey ? `stale:${p.renderedKey}` : null;
      this.#emit("zoom", { zoom: this.zoom, fit: this.fitMode });
    }
    this.#schedule();
  }

  /** The page under the middle of the viewport and how far down it, so zooming keeps the reader's place. */
  #viewportAnchor() {
    if (!this.layout.tops.length) return null;
    const mid = this.container.scrollTop + this.container.clientHeight / 2;
    const i = this.#pageAtY(mid);
    const frac = (mid - this.layout.tops[i]) / Math.max(1, this.layout.heights[i]);
    const xFrac = (this.container.scrollLeft + this.container.clientWidth / 2) / Math.max(1, this.container.scrollWidth);
    return { page: i, frac, xFrac };
  }

  #restoreAnchor(a) {
    if (!a || !this.layout.tops.length) return;
    const i = Math.min(a.page, this.layout.tops.length - 1);
    this.container.scrollTop = this.layout.tops[i] + a.frac * this.layout.heights[i] - this.container.clientHeight / 2;
    this.container.scrollLeft = a.xFrac * this.container.scrollWidth - this.container.clientWidth / 2;
  }

  #pageAtY(y) {
    const { tops, heights } = this.layout;
    let lo = 0;
    let hi = tops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    // Between pages, report the nearer one.
    if (lo < tops.length - 1 && y > tops[lo] + heights[lo] + GAP / 2) return lo + 1;
    return lo;
  }

  #onWheel(e) {
    if (!e.ctrlKey || !this.doc) return;
    e.preventDefault();
    const rect = this.container.getBoundingClientRect();
    const anchor = { page: this.current, frac: 0, xFrac: 0.5 };
    const y = e.clientY - rect.top + this.container.scrollTop;
    const i = this.#pageAtY(y);
    anchor.page = i;
    anchor.frac = (y - this.layout.tops[i]) / Math.max(1, this.layout.heights[i]);
    anchor.xFrac = (e.clientX - rect.left + this.container.scrollLeft) / Math.max(1, this.container.scrollWidth);
    const before = this.zoom;
    this.fitMode = null;
    this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.002), anchor);
    // Re-centre on the pointer rather than on the middle of the screen.
    if (this.zoom !== before) {
      this.container.scrollTop = this.layout.tops[i] + anchor.frac * this.layout.heights[i] - (e.clientY - rect.top);
      this.container.scrollLeft = anchor.xFrac * this.container.scrollWidth - (e.clientX - rect.left);
    }
  }

  // -------------------------------------------------------------- navigation

  get pageNumber() {
    return this.current + 1;
  }

  goToPage(number, yPt = 0) {
    if (!this.pages.length) return;
    const i = Math.min(Math.max(0, number - 1), this.pages.length - 1);
    this.container.scrollTop = this.layout.tops[i] + yPt * this.scale - 8;
    this.#schedule();
  }

  /** Scrolls so a rectangle (page points) is comfortably in view. */
  revealRect(pageIndex, rect) {
    const p = this.pages[pageIndex];
    if (!p) return;
    const top = this.layout.tops[pageIndex] + rect.y * this.scale;
    const bottom = top + rect.h * this.scale;
    const c = this.container;
    if (top < c.scrollTop + 60 || bottom > c.scrollTop + c.clientHeight - 60) {
      c.scrollTop = top - c.clientHeight * 0.35;
    }
    const left = rect.x * this.scale + (p.el.offsetLeft || 0);
    if (left < c.scrollLeft || left > c.scrollLeft + c.clientWidth - 40) c.scrollLeft = left - c.clientWidth * 0.3;
    this.#schedule();
  }

  // --------------------------------------------------------------- rendering

  #schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.#update();
    });
  }

  #update() {
    if (!this.doc || !this.pages.length) return;
    const { tops, heights } = this.layout;
    const c = this.container;
    const viewTop = c.scrollTop;
    const viewBottom = viewTop + c.clientHeight;

    const mid = viewTop + c.clientHeight / 2;
    const current = this.#pageAtY(mid);
    if (current !== this.current) {
      this.current = current;
      this.#emit("page", { page: current + 1 });
    }

    const margin = c.clientHeight;
    const first = this.#pageAtY(viewTop - margin);
    const last = this.#pageAtY(viewBottom + margin);
    const key = `${this.scale.toFixed(4)}@${window.devicePixelRatio || 1}`;
    const wanted = [];
    for (let i = first; i <= last; i++) {
      const p = this.pages[i];
      const onScreen = tops[i] < viewBottom && tops[i] + heights[i] > viewTop;
      if (!p.data && !p.dataPromise) this.#loadData(p);
      if (p.renderedKey !== key && !p.rendering) wanted.push({ p, onScreen, dist: Math.abs(tops[i] + heights[i] / 2 - mid) });
    }
    wanted.sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || a.dist - b.dist);
    this.renderQueue = wanted.map((w) => w.p);
    this.#pump(key);

    // Release bitmaps far from the viewport so long documents do not exhaust memory.
    const keepFrom = this.#pageAtY(viewTop - margin * 3);
    const keepTo = this.#pageAtY(viewBottom + margin * 3);
    for (let i = 0; i < this.pages.length; i++) {
      if ((i < keepFrom || i > keepTo) && this.pages[i].canvas) this.#releaseBitmap(this.pages[i]);
    }
  }

  #pump(key) {
    while (this.renderingCount < 2 && this.renderQueue.length) {
      const p = this.renderQueue.shift();
      if (p.rendering || p.renderedKey === key) continue;
      this.#renderPage(p, key);
    }
  }

  async #renderPage(p, key) {
    const generation = this.generation;
    p.rendering = true;
    this.renderingCount++;
    try {
      const dpr = window.devicePixelRatio || 1;
      let scale = this.scale * dpr;
      const pixels = p.w * p.h * scale * scale;
      if (pixels > MAX_BITMAP_PIXELS) scale *= Math.sqrt(MAX_BITMAP_PIXELS / pixels);
      const raw = await call(
        engine().renderPageRaw(this.doc, p.pageObj, { scaleFactor: scale, dpr: 1, withAnnotations: true, withForms: true })
      );
      if (generation !== this.generation) return;
      if (!p.canvas) {
        p.canvas = document.createElement("canvas");
        p.canvas.className = "bitmap";
        p.el.prepend(p.canvas);
      }
      p.canvas.width = raw.width;
      p.canvas.height = raw.height;
      const data = raw.data instanceof Uint8ClampedArray ? raw.data : new Uint8ClampedArray(raw.data);
      p.canvas.getContext("2d").putImageData(new ImageData(data, raw.width, raw.height), 0, 0);
      p.renderedKey = key;
      this.#emit("rendered", { page: p.index });
    } catch (err) {
      if (generation === this.generation) console.error("Page render failed", p.index, err);
    } finally {
      p.rendering = false;
      this.renderingCount--;
      if (generation === this.generation) {
        // If the zoom changed while this page was rendering, it needs another pass.
        this.#schedule();
        this.#pump(`${this.scale.toFixed(4)}@${window.devicePixelRatio || 1}`);
      }
    }
  }

  #releaseBitmap(p) {
    p.canvas.width = 0;
    p.canvas.height = 0;
    p.canvas.remove();
    p.canvas = null;
    p.renderedKey = null;
  }

  /** Re-renders a page and reloads its text and links, after the file changed. */
  invalidatePage(index, { geometry = true } = {}) {
    const p = this.pages[index];
    if (!p) return;
    p.renderedKey = null;
    if (geometry) {
      p.data = null;
      p.dataPromise = null;
      p.layers.links.replaceChildren();
    }
    this.#schedule();
  }

  invalidateAll() {
    for (let i = 0; i < this.pages.length; i++) this.invalidatePage(i);
  }

  // ------------------------------------------------------- page data & links

  #loadData(p) {
    const generation = this.generation;
    p.dataPromise = (async () => {
      const [geo, annots, text, widgets] = await Promise.all([
        call(engine().getPageGeometry(this.doc, p.pageObj)),
        call(engine().getPageAnnotations(this.doc, p.pageObj)),
        call(engine().extractText(this.doc, [p.index])),
        call(engine().getPageAnnoWidgets(this.doc, p.pageObj)).catch(() => []),
      ]);
      if (generation !== this.generation) return null;
      const pd = buildPageData(geo, text);
      pd.annots = annots;
      pd.widgets = widgets;
      pd.links = this.#buildLinks(pd, annots);
      p.data = pd;
      this.#drawLinks(p);
      this.#drawForms(p);
      this.#drawSelection();
      this.#emit("data", { page: p.index });
      return pd;
    })().catch((err) => {
      if (generation === this.generation) console.error("Page data failed", p.index, err);
      return null;
    });
    return p.dataPromise;
  }

  async pageData(index) {
    const p = this.pages[index];
    if (!p) return null;
    return p.data ?? (p.dataPromise ?? this.#loadData(p));
  }

  #buildLinks(pd, annots) {
    const links = [];
    const marked = [];
    for (const a of annots) {
      if (a.type !== PdfAnnotationSubtype.LINK || !a.target) continue;
      const action = a.target.type === "action" ? a.target.action : null;
      const dest = a.target.type === "destination" ? a.target.destination : action?.destination;
      const rect = fromEngineRect(a.rect);
      marked.push(rect);
      const rects = snapLinkRect(pd, rect);
      if (action?.uri) links.push({ kind: "uri", url: action.uri, rects });
      else if (dest && typeof dest.pageIndex === "number") {
        links.push({ kind: "goto", page: dest.pageIndex, y: dest.view?.[1] ?? 0, rects });
      }
    }
    // Web and email addresses in the text that the file does not mark up.
    for (const auto of findAutolinks(pd)) {
      if (marked.some((m) => auto.rects.some((r) => overlapFraction(r, m) > 0.3))) continue;
      links.push({ kind: "uri", url: auto.url, rects: auto.rects });
    }
    return links.filter((l) => l.rects.length);
  }

  #drawLinks(p) {
    const layer = p.layers.links;
    layer.replaceChildren();
    p.data.links.forEach((link, k) => {
      const group = document.createElement("a");
      group.className = "link";
      group.dataset.link = String(k);
      group.tabIndex = 0;
      if (link.kind === "uri") group.href = link.url;
      group.setAttribute("role", "link");
      group.addEventListener("click", (e) => {
        e.preventDefault();
        this.#activate(link);
      });
      group.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.#activate(link);
      });
      for (const r of link.rects) group.append(this.#rectEl(r, "hit"));
      layer.append(group);
    });
  }

  #drawForms(p) {
    const commit = async (widget, value) => {
      try {
        await call(engine().setFormFieldValue(this.doc, p.pageObj, widget, value));
        // The engine draws the new value into the page; only the bitmap needs refreshing.
        this.invalidatePage(p.index, { geometry: false });
        this.#emit("formchange", { page: p.index });
      } catch (err) {
        console.error("Could not set the form field", err);
        this.#emit("formerror", { message: err.message });
      }
    };
    p.layers.forms.replaceChildren(...buildFormControls(p, p.data.widgets ?? [], commit));
  }

  #rectEl(r, className) {
    const d = document.createElement("div");
    d.className = className;
    d.style.left = `calc(var(--s) * ${r.x.toFixed(2)}px)`;
    d.style.top = `calc(var(--s) * ${r.y.toFixed(2)}px)`;
    d.style.width = `calc(var(--s) * ${r.w.toFixed(2)}px)`;
    d.style.height = `calc(var(--s) * ${r.h.toFixed(2)}px)`;
    return d;
  }

  #activate(link) {
    if (link.kind === "goto") {
      this.goToPage(link.page + 1, link.y ? Math.max(0, link.y - 20) : 0);
      return;
    }
    try {
      const url = new URL(link.url);
      if (!SAFE_SCHEMES.has(url.protocol)) return;
      if (url.protocol === "http:" || url.protocol === "https:") window.open(url.href, "_blank", "noopener,noreferrer");
      else window.location.href = url.href;
    } catch {
      // A malformed address in the file: nothing to open.
    }
  }

  #linkAt(p, x, y) {
    const links = p.data?.links;
    if (!links) return -1;
    for (let k = links.length - 1; k >= 0; k--) {
      for (const r of links[k].rects) {
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return k;
      }
    }
    return -1;
  }

  #setHot(next) {
    const key = next ? `${next.page}:${next.link}` : null;
    const was = this.hot ? `${this.hot.page}:${this.hot.link}` : null;
    if (key === was) return;
    if (this.hot) this.pages[this.hot.page]?.layers.links.querySelector(`[data-link="${this.hot.link}"]`)?.classList.remove("hot");
    this.hot = next;
    if (next) this.pages[next.page]?.layers.links.querySelector(`[data-link="${next.link}"]`)?.classList.add("hot");
  }

  // ------------------------------------------------------- pointer handling

  /** Converts a pointer event to a page and a point in page units, or null if it is outside every page. */
  pointToPage(e, { clampToPage = false } = {}) {
    const target = e.target instanceof Element ? e.target.closest(".page") : null;
    let p = target ? this.pages[Number(target.dataset.page)] : null;
    if (!p && clampToPage) {
      const rect = this.container.getBoundingClientRect();
      p = this.pages[this.#pageAtY(e.clientY - rect.top + this.container.scrollTop)] ?? null;
    }
    if (!p) return null;
    const r = p.el.getBoundingClientRect();
    const s = r.width / p.w;
    return { p, x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s, scale: s };
  }

  #onHover(e) {
    if (this.drag || this.pointerTool?.active) return;
    const hit = this.pointToPage(e);
    let cursor = "";
    if (hit?.p.data) {
      const k = this.#linkAt(hit.p, hit.x, hit.y);
      if (k >= 0) {
        this.#setHot({ page: hit.p.index, link: k });
        cursor = "pointer";
      } else {
        this.#setHot(null);
        if (charAt(hit.p.data, hit.x, hit.y) >= 0) cursor = "text";
      }
    } else {
      this.#setHot(null);
    }
    this.pagesEl.style.cursor = this.pointerTool?.cursor ?? cursor;
  }

  #onPointerDown(e) {
    if (e.button !== 0 || !this.doc) return;
    // Form fields and the annotation action bar handle their own clicks.
    if (e.target instanceof Element && e.target.closest(".forms .fld, .sel-bar")) return;
    if (this.pointerTool?.down(e, this)) return;
    const hit = this.pointToPage(e);
    if (!hit) {
      this.clearSelection();
      return;
    }
    const pd = hit.p.data;
    // Pointer events always report detail 0, so double and triple clicks are counted here.
    const now = performance.now();
    const last = this.lastClick;
    const repeated = last && now - last.t < 450 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 5;
    const clicks = repeated ? Math.min(3, last.n + 1) : 1;
    this.lastClick = { t: now, x: e.clientX, y: e.clientY, n: clicks };
    this.drag = { startX: e.clientX, startY: e.clientY, moved: false, page: hit.p.index, linkAtDown: pd ? this.#linkAt(hit.p, hit.x, hit.y) : -1, selecting: false, clicks };
    if (!pd) return;
    const caret = caretAt(pd, hit.x, hit.y, false);
    if (caret < 0) {
      this.clearSelection();
      return;
    }
    // Do not start a text drag on top of a link until the pointer actually moves; a plain click follows the link.
    if (clicks >= 3) {
      const [lo, hi] = lineRange(pd, Math.min(caret, pd.n - 1));
      this.#setSelection({ page: hit.p.index, caret: lo }, { page: hit.p.index, caret: hi });
      this.drag.selecting = false;
      return;
    }
    if (clicks === 2) {
      const i = charAt(pd, hit.x, hit.y);
      if (i >= 0) {
        const [lo, hi] = wordRange(pd, i);
        this.#setSelection({ page: hit.p.index, caret: lo }, { page: hit.p.index, caret: hi });
      }
      this.drag.selecting = false;
      return;
    }
    this.drag.anchor = { page: hit.p.index, caret };
    this.drag.selecting = true;
    e.preventDefault();
    this.container.focus({ preventScroll: true });
  }

  async #onDragMove(e) {
    if (this.pointerTool?.active) {
      this.pointerTool.move?.(e, this);
      return;
    }
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
    d.moved = true;
    if (!d.selecting) return;
    d.lastEvent = e;
    this.#autoScroll(e);
    const hit = this.pointToPage(e, { clampToPage: true });
    if (!hit) return;
    const pd = hit.p.data ?? (await this.pageData(hit.p.index));
    if (!pd || !this.drag) return;
    const caret = caretAt(pd, hit.x, hit.y, true);
    if (caret < 0) return;
    this.#setSelection(d.anchor, { page: hit.p.index, caret });
  }

  #autoScroll(e) {
    cancelAnimationFrame(this.autoScrollFrame);
    const step = () => {
      const d = this.drag;
      if (!d?.selecting || !d.lastEvent) return;
      const r = this.container.getBoundingClientRect();
      const y = d.lastEvent.clientY;
      let dy = 0;
      if (y < r.top + 36) dy = -Math.min(30, (r.top + 36 - y) / 2 + 2);
      else if (y > r.bottom - 36) dy = Math.min(30, (y - (r.bottom - 36)) / 2 + 2);
      if (dy) {
        this.container.scrollTop += dy;
        this.#onDragMove(d.lastEvent);
        this.autoScrollFrame = requestAnimationFrame(step);
      }
    };
    this.autoScrollFrame = requestAnimationFrame(step);
  }

  #onPointerUp(e) {
    const d = this.drag;
    if (this.pointerTool?.active) {
      this.pointerTool.up(e, this);
      return;
    }
    if (!d) return;
    this.drag = null;
    cancelAnimationFrame(this.autoScrollFrame);
    if (!d.moved) {
      // A click: follow the link if there is one under the pointer.
      const hit = this.pointToPage(e);
      if (hit?.p.data && d.linkAtDown >= 0 && this.#linkAt(hit.p, hit.x, hit.y) === d.linkAtDown) {
        this.#activate(hit.p.data.links[d.linkAtDown]);
        return;
      }
      if (this.pointerTool?.click?.(e, this)) return;
      if (d.clicks === 1 && d.selecting) this.clearSelection();
    }
    if (this.selection) this.#finishSelection();
  }

  // --------------------------------------------------------------- selection

  #setSelection(anchor, focus) {
    this.selection = { anchor, focus };
    this.selectionText = null;
    this.#drawSelection();
  }

  #ordered() {
    if (!this.selection) return null;
    const { anchor: a, focus: f } = this.selection;
    const forward = a.page < f.page || (a.page === f.page && a.caret <= f.caret);
    return forward ? [a, f] : [f, a];
  }

  hasSelection() {
    const o = this.#ordered();
    return !!o && !(o[0].page === o[1].page && o[0].caret === o[1].caret);
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.selectionText = null;
    this.#drawSelection();
    this.#emit("selection", { has: false });
  }

  selectAll() {
    if (!this.pages.length) return;
    const last = this.pages.length - 1;
    const n = this.pages[last].data?.n ?? 0;
    this.#setSelection({ page: 0, caret: 0 }, { page: last, caret: n });
    this.selectionAll = true;
    this.#finishSelection();
  }

  #drawSelection() {
    const o = this.#ordered();
    for (const p of this.pages) {
      const layer = p.layers.sel;
      if (!o || p.index < o[0].page || p.index > o[1].page || !p.data) {
        if (layer.firstChild) layer.replaceChildren();
        continue;
      }
      const lo = p.index === o[0].page ? o[0].caret : 0;
      const hi = p.index === o[1].page ? o[1].caret : p.data.n;
      layer.replaceChildren(...rangeRects(p.data, lo, hi).map((r) => this.#rectEl(r, "selrect")));
    }
  }

  #finishSelection() {
    if (!this.hasSelection()) {
      this.#emit("selection", { has: false });
      return;
    }
    this.#emit("selection", { has: true });
    // Fetch the text now, so that the synchronous copy event can use it.
    this.selectedText().catch(() => {});
  }

  /** The selected text, read from the file by the engine. */
  async selectedText() {
    if (!this.hasSelection()) return "";
    if (this.selectionText !== null) return this.selectionText;
    const [a, b] = this.#ordered();
    const slices = [];
    for (let i = a.page; i <= b.page; i++) {
      const n = this.pages[i].data?.n ?? (await this.pageData(i))?.n ?? 0;
      const lo = i === a.page ? a.caret : 0;
      const hi = i === b.page ? Math.min(b.caret, n) : n;
      if (hi > lo) slices.push({ pageIndex: i, charIndex: lo, charCount: hi - lo });
    }
    const parts = slices.length ? await call(engine().getTextSlices(this.doc, slices)) : [];
    const text = parts.join("\n").replace(/\r\n?/g, "\n");
    if (this.hasSelection() && this.selection && this.#ordered()[0] === a) this.selectionText = text;
    return text;
  }

  /** Selected text as page rectangles, grouped by page (used to create highlights and underlines). */
  async selectedRects() {
    const o = this.#ordered();
    if (!o || !this.hasSelection()) return [];
    const out = [];
    for (let i = o[0].page; i <= o[1].page; i++) {
      const pd = this.pages[i].data ?? (await this.pageData(i));
      if (!pd) continue;
      const lo = i === o[0].page ? o[0].caret : 0;
      const hi = i === o[1].page ? o[1].caret : pd.n;
      const rects = rangeRects(pd, lo, hi);
      if (rects.length) out.push({ page: i, rects });
    }
    return out;
  }

  #onCopy(e) {
    const active = document.activeElement;
    const inField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.isContentEditable;
    if (!this.hasSelection() || inField) return;
    if (this.selectionText !== null) {
      e.clipboardData.setData("text/plain", this.selectionText);
      e.preventDefault();
    } else {
      e.preventDefault();
      this.selectedText().then((t) => navigator.clipboard?.writeText(t)).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ search

  async find(query, { matchCase = false, wholeWord = false } = {}) {
    const generation = this.generation;
    this.clearFind();
    this.findQuery = query;
    if (!this.doc || !query) {
      this.#emit("find", { total: 0, index: -1, query });
      return 0;
    }
    const flags = (matchCase ? MatchFlag.MatchCase : 0) | (wholeWord ? MatchFlag.MatchWholeWord : 0);
    const result = await call(engine().searchAllPages(this.doc, query, { flags }));
    if (generation !== this.generation) return 0;
    this.hits = result.results.map((r) => ({ page: r.pageIndex, rects: r.rects.map(fromEngineRect) }));
    this.hitIndex = -1;
    this.#drawFind();
    this.#emit("find", { total: this.hits.length, index: -1, query });
    if (this.hits.length) this.findStep(1);
    return this.hits.length;
  }

  findStep(direction) {
    if (!this.hits.length) return;
    const i = this.hitIndex < 0 ? (direction > 0 ? 0 : this.hits.length - 1) : (this.hitIndex + direction + this.hits.length) % this.hits.length;
    this.hitIndex = i;
    this.#drawFind();
    const hit = this.hits[i];
    this.revealRect(hit.page, hit.rects[0]);
    this.#emit("find", { total: this.hits.length, index: i });
  }

  clearFind() {
    this.hits = [];
    this.hitIndex = -1;
    this.findQuery = null;
    for (const p of this.pages) if (p.layers.find.firstChild) p.layers.find.replaceChildren();
  }

  #drawFind() {
    const perPage = new Map();
    this.hits.forEach((h, i) => {
      for (const r of h.rects) {
        const el = this.#rectEl(r, i === this.hitIndex ? "hit-current" : "hit-other");
        if (!perPage.has(h.page)) perPage.set(h.page, []);
        perPage.get(h.page).push(el);
      }
    });
    for (const p of this.pages) {
      const els = perPage.get(p.index);
      if (els) p.layers.find.replaceChildren(...els);
      else if (p.layers.find.firstChild) p.layers.find.replaceChildren();
    }
  }

  // ------------------------------------------------------------------ helper

  /** Lets other modules read what the engine said about a page (text geometry, annotations). */
  pageState(index) {
    return this.pages[index] ?? null;
  }
}
