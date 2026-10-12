// The Pages panel: thumbnails you can select, drag to reorder and act on.
import { engine, call } from "./engine.js";

const WIDTH = 132;

export class Thumbnails extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.doc = null;
    this.items = [];
    this.selected = new Set();
    this.anchor = 0;
    this.generation = 0;
    this.current = 0;
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.#render(Number(e.target.dataset.index));
    }, { root: container, rootMargin: "300px 0px" });
  }

  setDocument(doc) {
    this.generation++;
    this.doc = doc;
    this.observer.disconnect();
    this.container.replaceChildren();
    this.items = [];
    this.selected = new Set();
    for (const page of doc.pages) {
      const item = document.createElement("div");
      item.className = "thumb";
      item.dataset.index = String(page.index);
      item.draggable = true;
      item.tabIndex = 0;
      const frame = document.createElement("div");
      frame.className = "thumb-frame";
      frame.style.aspectRatio = `${page.size.width} / ${page.size.height}`;
      const label = document.createElement("span");
      label.className = "thumb-num";
      label.textContent = String(page.index + 1);
      item.append(frame, label);
      this.#wire(item, page.index);
      this.container.append(item);
      this.items.push({ el: item, frame, canvas: null, rendered: false, rendering: false });
      this.observer.observe(item);
    }
    this.setCurrent(Math.min(this.current, doc.pageCount - 1));
  }

  clear() {
    this.generation++;
    this.observer.disconnect();
    this.container.replaceChildren();
    this.items = [];
    this.selected = new Set();
    this.doc = null;
  }

  setCurrent(index) {
    this.current = index;
    this.items.forEach((it, i) => it.el.classList.toggle("current", i === index));
    const el = this.items[index]?.el;
    if (el) {
      const c = this.container;
      if (el.offsetTop < c.scrollTop || el.offsetTop + el.offsetHeight > c.scrollTop + c.clientHeight) {
        c.scrollTop = el.offsetTop - c.clientHeight / 2 + el.offsetHeight / 2;
      }
    }
  }

  refreshPage(index) {
    const it = this.items[index];
    if (!it) return;
    it.rendered = false;
    this.#render(index);
  }

  selection() {
    return [...this.selected].sort((a, b) => a - b);
  }

  /** Selects the given pages (after a change has rebuilt the list). */
  selectPages(indices) {
    const valid = indices.filter((i) => i >= 0 && i < this.items.length);
    this.selected = new Set(valid);
    this.anchor = valid[0] ?? 0;
    this.items.forEach((it, i) => it.el.classList.toggle("selected", this.selected.has(i)));
    this.dispatchEvent(new CustomEvent("selection", { detail: { pages: this.selection() } }));
  }

  #select(index, { shift = false, toggle = false } = {}) {
    if (shift) {
      const [lo, hi] = [Math.min(this.anchor, index), Math.max(this.anchor, index)];
      this.selected = new Set();
      for (let i = lo; i <= hi; i++) this.selected.add(i);
    } else if (toggle) {
      if (this.selected.has(index)) this.selected.delete(index);
      else this.selected.add(index);
      this.anchor = index;
    } else {
      this.selected = new Set([index]);
      this.anchor = index;
    }
    this.items.forEach((it, i) => it.el.classList.toggle("selected", this.selected.has(i)));
    this.dispatchEvent(new CustomEvent("selection", { detail: { pages: this.selection() } }));
  }

  #wire(item, index) {
    item.addEventListener("click", (e) => this.#select(index, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey }));
    item.addEventListener("dblclick", () => this.dispatchEvent(new CustomEvent("go", { detail: { page: index } })));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.dispatchEvent(new CustomEvent("go", { detail: { page: index } }));
      else if (e.key === " ") {
        e.preventDefault();
        this.#select(index, { toggle: true });
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.dispatchEvent(new CustomEvent("delete"));
      }
    });
    item.addEventListener("dragstart", (e) => {
      if (!this.selected.has(index)) this.#select(index);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", this.selection().join(","));
      this.dragging = this.selection();
    });
    item.addEventListener("dragend", () => {
      this.dragging = null;
      this.#clearDrop();
    });
    item.addEventListener("dragover", (e) => {
      if (!this.dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = item.getBoundingClientRect();
      this.#showDrop(index, e.clientY > r.top + r.height / 2);
    });
    item.addEventListener("drop", (e) => {
      if (!this.dragging) return;
      e.preventDefault();
      const r = item.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const moving = this.dragging;
      this.dragging = null;
      this.#clearDrop();
      this.#reorder(moving, index, after);
    });
  }

  #showDrop(index, after) {
    this.#clearDrop();
    this.items[index]?.el.classList.add(after ? "drop-after" : "drop-before");
  }

  #clearDrop() {
    for (const it of this.items) it.el.classList.remove("drop-before", "drop-after");
  }

  #reorder(moving, targetIndex, after) {
    const movingSet = new Set(moving);
    const rest = this.items.map((_, i) => i).filter((i) => !movingSet.has(i));
    let at = rest.indexOf(targetIndex);
    if (at < 0) return; // dropped on one of the moving pages themselves
    if (after) at++;
    const order = [...rest.slice(0, at), ...[...moving].sort((a, b) => a - b), ...rest.slice(at)];
    if (order.every((v, i) => v === i)) return;
    this.dispatchEvent(new CustomEvent("reorder", { detail: { order, moved: moving } }));
  }

  async #render(index) {
    const it = this.items[index];
    const page = this.doc?.pages[index];
    if (!it || !page || it.rendered || it.rendering) return;
    const generation = this.generation;
    it.rendering = true;
    try {
      const dpr = window.devicePixelRatio || 1;
      const scale = (WIDTH * dpr) / page.size.width;
      const raw = await call(engine().renderPageRaw(this.doc, page, { scaleFactor: scale, dpr: 1, withAnnotations: true }));
      if (generation !== this.generation) return;
      if (!it.canvas) {
        it.canvas = document.createElement("canvas");
        it.frame.append(it.canvas);
      }
      it.canvas.width = raw.width;
      it.canvas.height = raw.height;
      const data = raw.data instanceof Uint8ClampedArray ? raw.data : new Uint8ClampedArray(raw.data);
      it.canvas.getContext("2d").putImageData(new ImageData(data, raw.width, raw.height), 0, 0);
      it.rendered = true;
    } catch (err) {
      if (generation === this.generation) console.error("Thumbnail failed", index, err);
    } finally {
      it.rendering = false;
    }
  }
}
