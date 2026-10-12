// Editing tools: markup, comments, typed text, drawing, shapes, cover and redact, with undo and redo.
// Every change goes into the open file through the PDF engine, so what is saved is what the engine renders.
import {
  engine,
  call,
  PdfAnnotationSubtype as T,
  PdfBlendMode,
  PdfStandardFont,
  PdfTextAlignment,
  PdfVerticalAlignment,
  PdfAnnotationBorderStyle,
  PdfAnnotationReplyType,
  PdfAnnotationIcon,
  fromEngineRect,
  toEngineRect,
} from "./engine.js";
import { askText, askConfirm } from "./dialog.js";
import { openPopover, closePopover } from "./popover.js";

const HIGHLIGHT_COLORS = ["#FFD23F", "#7BD389", "#FF8FA3", "#FFB347", "#B39DDB"];
const PEN_COLORS = ["#E03131", "#1C1B19", "#2F9E44", "#F08C00", "#862E9C"];
const NOT_EDITABLE = new Set([T.LINK, T.POPUP, T.WIDGET]);
const MOVABLE = new Set([T.TEXT, T.FREETEXT, T.SQUARE, T.CIRCLE, T.INK, T.STAMP]);
const HAS_TEXT = new Set([T.TEXT, T.FREETEXT, T.HIGHLIGHT, T.UNDERLINE, T.STRIKEOUT, T.SQUARE, T.CIRCLE]);

const stored = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be unavailable; options simply do not persist.
    }
  },
};

const unionRect = (rects) => {
  const x0 = Math.min(...rects.map((r) => r.origin.x));
  const y0 = Math.min(...rects.map((r) => r.origin.y));
  const x1 = Math.max(...rects.map((r) => r.origin.x + r.size.width));
  const y1 = Math.max(...rects.map((r) => r.origin.y + r.size.height));
  return { origin: { x: x0, y: y0 }, size: { width: x1 - x0, height: y1 - y0 } };
};

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

export class Editor extends EventTarget {
  constructor({ view, optionsEl, railEl }) {
    super();
    this.view = view;
    this.optionsEl = optionsEl;
    this.railEl = railEl;
    this.doc = null;
    this.tool = "select";
    this.history = { undo: [], redo: [] };
    this.dirty = false;
    this.selected = null; // { page, id }
    this.options = {
      highlight: { color: stored.get("opt.highlight", HIGHLIGHT_COLORS[0]) },
      underline: { color: stored.get("opt.underline", PEN_COLORS[0]) },
      strikeout: { color: stored.get("opt.strikeout", PEN_COLORS[0]) },
      text: { color: stored.get("opt.text", PEN_COLORS[1]), size: stored.get("opt.textSize", 14) },
      draw: { color: stored.get("opt.draw", PEN_COLORS[0]), width: stored.get("opt.drawWidth", 2) },
      rect: { color: stored.get("opt.rect", PEN_COLORS[0]), width: stored.get("opt.rectWidth", 2) },
    };
    this.handlers = {
      select: this.#selectTool(),
      note: this.#noteTool(),
      text: this.#textTool(),
      draw: this.#drawTool(),
      rect: this.#shapeTool("rect"),
      cover: this.#shapeTool("cover"),
      redact: this.#shapeTool("redact"),
    };
    view.addEventListener("selection", (e) => this.#onTextSelection(e.detail.has));
    view.addEventListener("data", (e) => this.#drawSelected(e.detail.page));
    window.addEventListener("keydown", (e) => this.#onKey(e));
    for (const btn of railEl.querySelectorAll("[data-tool]")) btn.addEventListener("click", () => this.setTool(btn.dataset.tool));
    this.setTool("select");
  }

  // ---------------------------------------------------------------- document

  attach(doc) {
    this.doc = doc;
    this.history = { undo: [], redo: [] };
    this.dirty = false;
    this.selected = null;
    closePopover();
    this.#emitChange();
  }

  markClean() {
    this.dirty = false;
    this.#emitChange();
  }

  markDirty() {
    this.dirty = true;
    this.#emitChange();
  }

  #emitChange() {
    this.dispatchEvent(new CustomEvent("change", { detail: { dirty: this.dirty, canUndo: this.history.undo.length > 0, canRedo: this.history.redo.length > 0 } }));
  }

  /** The name stored on comments and markup. Asked for once, then remembered. */
  async author() {
    let name = stored.get("author", "");
    if (name) return name;
    name = await askText({
      title: "Your name",
      label: "Comments and markup you add are labelled with this name.",
      okText: "Continue",
      validate: (v) => (v.trim() ? null : "Please enter a name."),
    });
    name = (name ?? "").trim();
    if (name) stored.set("author", name);
    return name || "Reader";
  }

  // -------------------------------------------------------------------- tools

  setTool(name) {
    if (!this.handlers[name] && !["highlight", "underline", "strikeout"].includes(name)) name = "select";
    closePopover();
    this.tool = name;
    for (const btn of this.railEl.querySelectorAll("[data-tool]")) btn.setAttribute("aria-pressed", String(btn.dataset.tool === name));
    this.view.pointerTool = this.handlers[name] ?? null;
    if (name !== "select") this.#select(null);
    this.#renderOptions();
    // Text already selected when a markup tool is chosen is marked up straight away.
    if (["highlight", "underline", "strikeout"].includes(name) && this.view.hasSelection()) this.#onTextSelection(true);
  }

  #renderOptions() {
    const o = this.optionsEl;
    o.replaceChildren();
    const swatches = (colors, key, storeKey) => {
      const wrap = el("div", "swatches");
      for (const color of colors) {
        const b = el("button", "swatch");
        b.type = "button";
        b.style.background = color;
        b.title = color;
        b.setAttribute("aria-label", `Colour ${color}`);
        b.setAttribute("aria-pressed", String(this.options[key].color === color));
        b.addEventListener("click", () => {
          this.options[key].color = color;
          stored.set(storeKey, color);
          for (const s of wrap.children) s.setAttribute("aria-pressed", String(s === b));
        });
        wrap.append(b);
      }
      return wrap;
    };
    const slider = (label, key, prop, min, max, storeKey, unit) => {
      const wrap = el("label", "label");
      const value = el("span", null, `${this.options[key][prop]}${unit}`);
      const input = document.createElement("input");
      input.type = "range";
      input.min = min;
      input.max = max;
      input.value = this.options[key][prop];
      input.addEventListener("input", () => {
        this.options[key][prop] = Number(input.value);
        value.textContent = `${input.value}${unit}`;
        stored.set(storeKey, Number(input.value));
      });
      wrap.append(`${label} `, input, " ", value);
      return wrap;
    };
    const hint = (text) => o.append(el("span", "hint", text));
    switch (this.tool) {
      case "highlight":
        o.append(swatches(HIGHLIGHT_COLORS, "highlight", "opt.highlight"));
        hint("Select text to highlight it.");
        break;
      case "underline":
        o.append(swatches(PEN_COLORS, "underline", "opt.underline"));
        hint("Select text to underline it.");
        break;
      case "strikeout":
        o.append(swatches(PEN_COLORS, "strikeout", "opt.strikeout"));
        hint("Select text to strike it through.");
        break;
      case "note":
        hint("Click where the comment should go.");
        break;
      case "text":
        o.append(swatches(PEN_COLORS, "text", "opt.text"), slider("Size", "text", "size", 8, 48, "opt.textSize", " pt"));
        hint("Click or drag to place text.");
        break;
      case "draw":
        o.append(swatches(PEN_COLORS, "draw", "opt.draw"), slider("Width", "draw", "width", 1, 12, "opt.drawWidth", " pt"));
        break;
      case "rect":
        o.append(swatches(PEN_COLORS, "rect", "opt.rect"), slider("Width", "rect", "width", 1, 10, "opt.rectWidth", " pt"));
        hint("Drag to draw a rectangle.");
        break;
      case "cover":
        hint("Drag over what to hide. The content stays in the file; use Redact to remove it for good.");
        break;
      case "redact":
        hint("Drag over text to remove it permanently.");
        break;
      default:
        break;
    }
    o.hidden = o.childElementCount === 0;
  }

  // ---------------------------------------------------------- markup on text

  #onTextSelection(has) {
    if (!has || !["highlight", "underline", "strikeout"].includes(this.tool)) return;
    this.#applyMarkup(this.tool).catch((err) => this.#fail("add the markup", err));
  }

  async #applyMarkup(kind) {
    const groups = await this.view.selectedRects();
    if (!groups.length) return;
    const type = { highlight: T.HIGHLIGHT, underline: T.UNDERLINE, strikeout: T.STRIKEOUT }[kind];
    const color = this.options[kind].color;
    const made = [];
    for (const { page, rects } of groups) {
      const segments = rects.map((r) => toEngineRect({ x: r.x, y: r.y, w: r.w, h: r.h }));
      const annot = {
        type,
        rect: unionRect(segments),
        segmentRects: segments,
        strokeColor: color,
        color,
        opacity: 1,
        contents: "",
        ...(kind === "highlight" ? { blendMode: PdfBlendMode.Multiply } : {}),
      };
      made.push(await this.#create(page, annot, { record: false }));
    }
    this.view.clearSelection();
    this.#record(`Add ${kind}`, made);
  }

  // ------------------------------------------------------------ create/update

  async #create(pageIndex, annot, { record = true, label = "Add" } = {}) {
    const full = {
      flags: ["print"],
      ...annot,
      id: annot.id ?? crypto.randomUUID(),
      pageIndex,
      author: annot.author ?? (await this.author()),
      created: annot.created ?? new Date(),
      modified: new Date(),
    };
    await this.#add(pageIndex, full);
    const entry = { pageIndex, full };
    if (record) this.#record(label, [entry]);
    return entry;
  }

  async #add(pageIndex, full) {
    const page = this.view.pages[pageIndex].pageObj;
    await call(engine().createPageAnnotation(this.doc, page, full));
    this.#afterEdit(pageIndex);
  }

  async #remove(pageIndex, full) {
    const page = this.view.pages[pageIndex].pageObj;
    await call(engine().removePageAnnotation(this.doc, page, full));
    if (this.selected?.id === full.id) this.selected = null;
    this.#afterEdit(pageIndex);
  }

  async #update(pageIndex, next) {
    const page = this.view.pages[pageIndex].pageObj;
    await call(engine().updatePageAnnotation(this.doc, page, next, { regenerateAppearance: true }));
    this.#afterEdit(pageIndex);
  }

  #afterEdit(pageIndex) {
    this.view.invalidatePage(pageIndex);
    this.markDirty();
    this.dispatchEvent(new CustomEvent("edited", { detail: { page: pageIndex } }));
  }

  /** Pushes one undo step for a set of created annotations. */
  #record(label, entries) {
    this.history.undo.push({
      label,
      undo: async () => {
        for (const e of [...entries].reverse()) await this.#remove(e.pageIndex, e.full);
      },
      redo: async () => {
        for (const e of entries) await this.#add(e.pageIndex, e.full);
      },
    });
    this.history.redo = [];
    this.#emitChange();
  }

  async undo() {
    const step = this.history.undo.pop();
    if (!step) return;
    try {
      await step.undo();
      this.history.redo.push(step);
    } catch (err) {
      this.#fail("undo that", err);
    }
    this.#emitChange();
  }

  async redo() {
    const step = this.history.redo.pop();
    if (!step) return;
    try {
      await step.redo();
      this.history.undo.push(step);
    } catch (err) {
      this.#fail("redo that", err);
    }
    this.#emitChange();
  }

  #fail(what, err) {
    console.error(`Could not ${what}`, err);
    this.dispatchEvent(new CustomEvent("error", { detail: { message: `Could not ${what}: ${err.message}` } }));
  }

  // -------------------------------------------------------------- comments

  /** Adds a reply to a comment (a note linked to the comment it answers). */
  async reply(parent, text) {
    const body = text.trim();
    if (!body) return;
    const r = parent.annotation.rect;
    await this.#create(
      parent.pageIndex,
      {
        type: T.TEXT,
        rect: { origin: { x: r.origin.x, y: r.origin.y }, size: { width: 20, height: 20 } },
        contents: body,
        inReplyToId: parent.id,
        replyType: PdfAnnotationReplyType.Reply,
        strokeColor: "#FFD23F",
        color: "#FFD23F",
        opacity: 1,
        icon: PdfAnnotationIcon.Comment,
      },
      { label: "Reply" }
    );
  }

  /** Deletes a comment and anything that replies to it. */
  async deleteComment(comment) {
    const page = this.view.pages[comment.pageIndex].pageObj;
    const all = await call(engine().getPageAnnotations(this.doc, page));
    const victims = [];
    const collect = (id) => {
      for (const a of all) {
        if (a.inReplyToId === id) {
          victims.push(a);
          collect(a.id);
        }
      }
    };
    collect(comment.id);
    const own = all.find((a) => a.id === comment.id);
    const targets = [...victims, ...(own ? [own] : [])];
    const entries = [];
    for (const a of targets) {
      await this.#remove(comment.pageIndex, a);
      entries.push({ pageIndex: comment.pageIndex, full: a });
    }
    this.history.undo.push({
      label: "Delete comment",
      undo: async () => {
        for (const e of [...entries].reverse()) await this.#add(e.pageIndex, e.full);
      },
      redo: async () => {
        for (const e of entries) await this.#remove(e.pageIndex, e.full);
      },
    });
    this.history.redo = [];
    this.#emitChange();
  }

  /** Changes the text of a comment. */
  async editComment(comment, text) {
    const page = this.view.pages[comment.pageIndex].pageObj;
    const all = await call(engine().getPageAnnotations(this.doc, page));
    const before = all.find((a) => a.id === comment.id);
    if (!before) return;
    await this.#changeAnnotation(comment.pageIndex, before, { ...before, contents: text, modified: new Date() }, "Edit comment");
  }

  async #changeAnnotation(pageIndex, before, after, label) {
    await this.#update(pageIndex, after);
    this.history.undo.push({
      label,
      undo: () => this.#update(pageIndex, before),
      redo: () => this.#update(pageIndex, after),
    });
    this.history.redo = [];
    this.#emitChange();
  }

  // ------------------------------------------------------------ pointer tools

  #pagePoint(e, p) {
    const r = p.el.getBoundingClientRect();
    const s = r.width / p.w;
    return { x: Math.min(p.w, Math.max(0, (e.clientX - r.left) / s)), y: Math.min(p.h, Math.max(0, (e.clientY - r.top) / s)), s, left: r.left, top: r.top };
  }

  #noteTool() {
    const self = this;
    return {
      active: false,
      cursor: "crosshair",
      down(e, view) {
        const hit = view.pointToPage(e);
        if (!hit) return false;
        this.active = true;
        this.hit = hit;
        e.preventDefault();
        return true;
      },
      move() {},
      up(e) {
        this.active = false;
        const { p, x, y } = this.hit;
        const pageIndex = p.index;
        const clientX = e.clientX;
        const clientY = e.clientY;
        self.author().then((who) =>
          openPopover({
            x: clientX + 12,
            y: clientY + 12,
            who,
            placeholder: "Write a comment…",
            submitText: "Add comment",
            onSubmit: (text) => {
              if (!text.trim()) return;
              self
                .#create(
                  pageIndex,
                  {
                    type: T.TEXT,
                    rect: { origin: { x: Math.max(0, x - 2), y: Math.max(0, y - 2) }, size: { width: 20, height: 20 } },
                    contents: text.trim(),
                    strokeColor: "#FFD23F",
                    color: "#FFD23F",
                    opacity: 1,
                    icon: PdfAnnotationIcon.Comment,
                  },
                  { label: "Add comment" }
                )
                .catch((err) => self.#fail("add the comment", err));
            },
          })
        );
      },
    };
  }

  #textTool() {
    const self = this;
    return {
      active: false,
      cursor: "text",
      down(e, view) {
        const hit = view.pointToPage(e);
        if (!hit) return false;
        this.active = true;
        this.p = hit.p;
        this.start = self.#pagePoint(e, hit.p);
        this.preview = el("div", "preview-rect");
        hit.p.layers.marks.append(this.preview);
        e.preventDefault();
        return true;
      },
      move(e) {
        const cur = self.#pagePoint(e, this.p);
        self.#placeRect(this.preview, this.start, cur);
      },
      up(e) {
        this.active = false;
        const cur = self.#pagePoint(e, this.p);
        this.preview.remove();
        const size = self.options.text.size;
        let w = Math.abs(cur.x - this.start.x);
        let h = Math.abs(cur.y - this.start.y);
        let x = Math.min(cur.x, this.start.x);
        let y = Math.min(cur.y, this.start.y);
        if (w < 12 && h < 12) {
          w = 220;
          h = size * 1.4 + 6;
          x = this.start.x;
          y = this.start.y;
        }
        const pageIndex = this.p.index;
        const scale = cur.s;
        const screenLeft = cur.left + x * scale;
        const screenTop = cur.top + y * scale;
        self.author().then((who) =>
          openPopover({
            x: screenLeft,
            y: screenTop + Math.max(h * scale, size * scale) + 6,
            who,
            placeholder: "Type your text…",
            submitText: "Place text",
            fontSize: Math.max(12, Math.min(20, size * scale)),
            onSubmit: (text) => {
              if (!text.trim()) return;
              const lines = text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil((line.length * size * 0.52) / Math.max(20, w - 6))), 0);
              const height = Math.max(h, lines * size * 1.3 + 6);
              self
                .#create(
                  pageIndex,
                  {
                    type: T.FREETEXT,
                    rect: toEngineRect({ x, y, w, h: height }),
                    contents: text,
                    fontFamily: PdfStandardFont.Helvetica,
                    fontSize: size,
                    fontColor: self.options.text.color,
                    textAlign: PdfTextAlignment.Left,
                    verticalAlign: PdfVerticalAlignment.Top,
                    opacity: 1,
                  },
                  { label: "Add text" }
                )
                .catch((err) => self.#fail("add the text", err));
            },
          })
        );
      },
    };
  }

  #drawTool() {
    const self = this;
    const NS = "http://www.w3.org/2000/svg";
    return {
      active: false,
      cursor: "crosshair",
      down(e, view) {
        const hit = view.pointToPage(e);
        if (!hit) return false;
        this.active = true;
        this.p = hit.p;
        const pt = self.#pagePoint(e, hit.p);
        this.points = [{ x: pt.x, y: pt.y }];
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", `0 0 ${hit.p.w} ${hit.p.h}`);
        svg.setAttribute("preserveAspectRatio", "none");
        this.line = document.createElementNS(NS, "polyline");
        this.line.setAttribute("fill", "none");
        this.line.setAttribute("stroke", self.options.draw.color);
        this.line.setAttribute("stroke-width", String(self.options.draw.width));
        this.line.setAttribute("stroke-linecap", "round");
        this.line.setAttribute("stroke-linejoin", "round");
        svg.append(this.line);
        hit.p.layers.marks.append(svg);
        this.svg = svg;
        e.preventDefault();
        return true;
      },
      move(e) {
        const events = e.getCoalescedEvents?.() ?? [e];
        for (const ev of events) {
          const pt = self.#pagePoint(ev, this.p);
          const last = this.points[this.points.length - 1];
          if (Math.hypot(pt.x - last.x, pt.y - last.y) >= 0.6) this.points.push({ x: pt.x, y: pt.y });
        }
        this.line.setAttribute("points", this.points.map((q) => `${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(" "));
      },
      up() {
        this.active = false;
        this.svg.remove();
        const pts = this.points.length === 1 ? [this.points[0], { x: this.points[0].x + 0.1, y: this.points[0].y }] : this.points;
        const w = self.options.draw.width;
        const xs = pts.map((q) => q.x);
        const ys = pts.map((q) => q.y);
        const rect = { origin: { x: Math.min(...xs) - w, y: Math.min(...ys) - w }, size: { width: Math.max(...xs) - Math.min(...xs) + 2 * w, height: Math.max(...ys) - Math.min(...ys) + 2 * w } };
        self
          .#create(this.p.index, { type: T.INK, rect, inkList: [{ points: pts }], strokeColor: self.options.draw.color, color: self.options.draw.color, opacity: 1, strokeWidth: w }, { label: "Draw" })
          .catch((err) => self.#fail("add the drawing", err));
      },
    };
  }

  #placeRect(node, a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    node.style.left = `calc(var(--s) * ${x.toFixed(2)}px)`;
    node.style.top = `calc(var(--s) * ${y.toFixed(2)}px)`;
    node.style.width = `calc(var(--s) * ${Math.abs(a.x - b.x).toFixed(2)}px)`;
    node.style.height = `calc(var(--s) * ${Math.abs(a.y - b.y).toFixed(2)}px)`;
  }

  #shapeTool(kind) {
    const self = this;
    return {
      active: false,
      cursor: "crosshair",
      down(e, view) {
        const hit = view.pointToPage(e);
        if (!hit) return false;
        this.active = true;
        this.p = hit.p;
        this.start = self.#pagePoint(e, hit.p);
        this.preview = el("div", kind === "cover" ? "preview-cover" : kind === "redact" ? "preview-redact" : "preview-rect");
        hit.p.layers.marks.append(this.preview);
        e.preventDefault();
        return true;
      },
      move(e) {
        self.#placeRect(this.preview, this.start, self.#pagePoint(e, this.p));
      },
      up(e) {
        this.active = false;
        const end = self.#pagePoint(e, this.p);
        this.preview.remove();
        const r = { x: Math.min(this.start.x, end.x), y: Math.min(this.start.y, end.y), w: Math.abs(end.x - this.start.x), h: Math.abs(end.y - this.start.y) };
        if (r.w < 3 || r.h < 3) return;
        const pageIndex = this.p.index;
        if (kind === "redact") {
          self.#redact(pageIndex, r).catch((err) => self.#fail("redact that", err));
          return;
        }
        const base =
          kind === "cover"
            ? { color: "#FFFFFF", strokeColor: "#FFFFFF", strokeWidth: 0 }
            : { color: "transparent", strokeColor: self.options.rect.color, strokeWidth: self.options.rect.width };
        self
          .#create(pageIndex, { type: T.SQUARE, rect: toEngineRect(r), opacity: 1, strokeStyle: PdfAnnotationBorderStyle.SOLID, ...base }, { label: kind === "cover" ? "Cover" : "Rectangle" })
          .catch((err) => self.#fail("add the shape", err));
      },
    };
  }

  async #redact(pageIndex, r) {
    const ok = await askConfirm({
      title: "Remove this permanently?",
      message: "The text under this box is deleted from the file and replaced with a black box. This cannot be undone, and saved copies cannot be recovered. Images and drawings under the box are not removed.",
      okText: "Redact",
    });
    if (!ok) return;
    const page = this.view.pages[pageIndex].pageObj;
    const rect = toEngineRect(r);
    const mark = {
      id: crypto.randomUUID(),
      pageIndex,
      type: T.REDACT,
      rect,
      segmentRects: [rect],
      color: "#000000",
      overlayColor: "#000000",
      opacity: 1,
      author: await this.author(),
      created: new Date(),
      modified: new Date(),
      flags: ["print"],
    };
    // Mark the area, then apply it: the content under it is deleted and a black box is drawn in its place.
    await call(engine().createPageAnnotation(this.doc, page, mark));
    await call(engine().applyRedaction(this.doc, page, mark));
    // A redaction rewrites the page, so earlier undo steps no longer apply to it.
    this.history = { undo: [], redo: [] };
    this.#afterEdit(pageIndex);
    this.#emitChange();
  }

  // -------------------------------------------------- select / move / delete

  #annotationAt(pd, x, y) {
    const annots = pd.annots ?? [];
    for (let i = annots.length - 1; i >= 0; i--) {
      const a = annots[i];
      if (NOT_EDITABLE.has(a.type)) continue;
      const rects = (a.segmentRects?.length ? a.segmentRects : [a.rect]).map(fromEngineRect);
      const pad = a.type === T.INK ? 4 : 1.5;
      if (rects.some((r) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad)) return a;
    }
    return null;
  }

  #select(sel) {
    const prev = this.selected;
    this.selected = sel;
    if (prev && prev.page !== sel?.page) this.#drawSelected(prev.page);
    if (sel) this.#drawSelected(sel.page);
    else if (prev) this.#drawSelected(prev.page);
  }

  #drawSelected(pageIndex) {
    const p = this.view.pages[pageIndex];
    if (!p) return;
    for (const n of p.layers.marks.querySelectorAll(".sel-box")) n.remove();
    if (!this.selected || this.selected.page !== pageIndex || !p.data) return;
    const a = p.data.annots?.find((x) => x.id === this.selected.id);
    if (!a) return;
    const rects = (a.segmentRects?.length ? a.segmentRects : [a.rect]).map(fromEngineRect);
    for (const r of rects) {
      const n = el("div", "sel-box");
      n.style.left = `calc(var(--s) * ${r.x.toFixed(2)}px)`;
      n.style.top = `calc(var(--s) * ${r.y.toFixed(2)}px)`;
      n.style.width = `calc(var(--s) * ${r.w.toFixed(2)}px)`;
      n.style.height = `calc(var(--s) * ${r.h.toFixed(2)}px)`;
      p.layers.marks.append(n);
    }
  }

  #selectTool() {
    const self = this;
    return {
      active: false,
      cursor: null,
      down(e, view) {
        const hit = view.pointToPage(e);
        const pd = hit?.p.data;
        if (!pd) return false;
        const annot = self.#annotationAt(pd, hit.x, hit.y);
        if (!annot) {
          self.#select(null);
          return false;
        }
        const now = performance.now();
        const again = this.last && this.last.id === annot.id && now - this.last.t < 450;
        this.last = { id: annot.id, t: now };
        self.#select({ page: hit.p.index, id: annot.id });
        view.clearSelection();
        if (again && HAS_TEXT.has(annot.type)) {
          self.#editText(hit.p.index, annot, e);
          e.preventDefault();
          return true;
        }
        this.active = true;
        this.drag = { annot, p: hit.p, start: self.#pagePoint(e, hit.p), moved: false, dx: 0, dy: 0 };
        e.preventDefault();
        return true;
      },
      move(e) {
        const d = this.drag;
        if (!d) return;
        const cur = self.#pagePoint(e, d.p);
        d.dx = cur.x - d.start.x;
        d.dy = cur.y - d.start.y;
        if (!d.moved && Math.hypot(d.dx * cur.s, d.dy * cur.s) < 4) return;
        if (!MOVABLE.has(d.annot.type)) return;
        d.moved = true;
        for (const n of d.p.layers.marks.querySelectorAll(".sel-box")) n.style.transform = `translate(calc(var(--s) * ${d.dx.toFixed(2)}px), calc(var(--s) * ${d.dy.toFixed(2)}px))`;
      },
      up() {
        this.active = false;
        const d = this.drag;
        this.drag = null;
        if (!d?.moved) return;
        const a = d.annot;
        const moveRect = (r) => ({ origin: { x: r.origin.x + d.dx, y: r.origin.y + d.dy }, size: r.size });
        const next = { ...a, rect: moveRect(a.rect), modified: new Date() };
        if (a.type === T.INK) next.inkList = a.inkList.map((l) => ({ points: l.points.map((q) => ({ x: q.x + d.dx, y: q.y + d.dy })) }));
        self.#changeAnnotation(d.p.index, a, next, "Move").catch((err) => self.#fail("move that", err));
      },
    };
  }

  #editText(pageIndex, annot, e) {
    this.author().then((who) =>
      openPopover({
        x: e.clientX + 8,
        y: e.clientY + 8,
        who,
        value: annot.contents ?? "",
        submitText: "Save",
        onSubmit: (text) => {
          if (text === (annot.contents ?? "")) return;
          this.#changeAnnotation(pageIndex, annot, { ...annot, contents: text, modified: new Date() }, "Edit text").catch((err) => this.#fail("save the text", err));
        },
      })
    );
  }

  async deleteSelected() {
    if (!this.selected) return;
    const { page, id } = this.selected;
    const a = this.view.pages[page].data?.annots?.find((x) => x.id === id);
    if (!a) return;
    // Replies to a deleted comment would be orphaned, so they go with it.
    const all = this.view.pages[page].data.annots;
    const targets = [a];
    const collect = (parentId) => {
      for (const x of all) {
        if (x.inReplyToId === parentId) {
          targets.push(x);
          collect(x.id);
        }
      }
    };
    collect(a.id);
    const entries = [];
    for (const t of targets) {
      await this.#remove(page, t);
      entries.push({ pageIndex: page, full: t });
    }
    this.selected = null;
    this.history.undo.push({
      label: "Delete",
      undo: async () => {
        for (const e of [...entries].reverse()) await this.#add(e.pageIndex, e.full);
      },
      redo: async () => {
        for (const e of entries) await this.#remove(e.pageIndex, e.full);
      },
    });
    this.history.redo = [];
    this.#emitChange();
  }

  // ---------------------------------------------------------------- keyboard

  #onKey(e) {
    if (!this.doc) return;
    const t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable || document.querySelector("dialog[open]");
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z" && !e.shiftKey) {
      e.preventDefault();
      this.undo();
    } else if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
      e.preventDefault();
      this.redo();
    } else if (!mod && !e.altKey && (key === "delete" || key === "backspace") && this.selected) {
      e.preventDefault();
      this.deleteSelected().catch((err) => this.#fail("delete that", err));
    } else if (!mod && !e.altKey && key === "escape") {
      if (this.selected) this.#select(null);
      else if (this.tool !== "select") this.setTool("select");
    } else if (!mod && !e.altKey) {
      const tools = { v: "select", h: "highlight", u: "underline", s: "strikeout", n: "note", t: "text", d: "draw", r: "rect" };
      if (tools[key]) {
        e.preventDefault();
        this.setTool(tools[key]);
      }
    }
  }
}
