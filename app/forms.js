// Form filling. Each form field gets an invisible control placed exactly over it; the page bitmap, drawn by the
// engine, always shows the real field. A control only becomes visible while you are typing in it, and the value is
// written into the file when you leave the field.

// Form field types, as numbered by PDFium.
const CHECKBOX = 2;
const RADIO = 3;
const COMBO = 4;
const LIST = 5;
const TEXT = 6;
const READ_ONLY = 1;
const MULTILINE = 4096;
const PASSWORD = 8192;

const place = (node, r) => {
  node.style.left = `calc(var(--s) * ${r.x.toFixed(2)}px)`;
  node.style.top = `calc(var(--s) * ${r.y.toFixed(2)}px)`;
  node.style.width = `calc(var(--s) * ${r.w.toFixed(2)}px)`;
  node.style.height = `calc(var(--s) * ${r.h.toFixed(2)}px)`;
};

/**
 * @param page      the page record from the viewer
 * @param widgets   engine widgets: [{ rect, field: { name, type, value, options, flag } }]
 * @param commit    async (widget, value) => void, writes a field value into the file
 */
export function buildFormControls(page, widgets, commit) {
  const nodes = [];
  for (const widget of widgets) {
    const f = widget.field;
    if (!f || (f.flag & READ_ONLY)) continue;
    const r = { x: widget.rect.origin.x, y: widget.rect.origin.y, w: widget.rect.size.width, h: widget.rect.size.height };
    const fontPt = Math.max(6, Math.min(14, r.h * 0.62));
    let node = null;

    if (f.type === TEXT) {
      const multi = (f.flag & MULTILINE) !== 0;
      node = document.createElement(multi ? "textarea" : "input");
      if (!multi) node.type = f.flag & PASSWORD ? "password" : "text";
      node.value = f.value ?? "";
      node.style.fontSize = `calc(var(--s) * ${fontPt.toFixed(2)}px)`;
      node.setAttribute("aria-label", f.alternateName || f.name);
      node.addEventListener("change", () => {
        f.value = node.value;
        commit(widget, { kind: "text", text: node.value });
      });
      if (!multi) node.addEventListener("keydown", (e) => e.key === "Enter" && node.blur());
    } else if (f.type === CHECKBOX || f.type === RADIO) {
      node = document.createElement("div");
      node.tabIndex = 0;
      node.setAttribute("role", f.type === CHECKBOX ? "checkbox" : "radio");
      node.setAttribute("aria-label", f.alternateName || f.name);
      let checked = !!f.value && f.value !== "Off";
      node.setAttribute("aria-checked", String(checked));
      const toggle = () => {
        checked = f.type === CHECKBOX ? !checked : true;
        node.setAttribute("aria-checked", String(checked));
        f.value = checked ? "Yes" : "";
        commit(widget, { kind: "checked", checked });
      };
      node.addEventListener("click", toggle);
      node.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          toggle();
        }
      });
    } else if (f.type === COMBO || f.type === LIST) {
      node = document.createElement("select");
      node.setAttribute("aria-label", f.alternateName || f.name);
      (f.options ?? []).forEach((o, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = o.label;
        opt.selected = !!o.isSelected;
        node.append(opt);
      });
      if (!(f.options ?? []).some((o) => o.isSelected)) node.selectedIndex = -1;
      node.style.fontSize = `calc(var(--s) * ${fontPt.toFixed(2)}px)`;
      node.addEventListener("change", () => {
        const index = Number(node.value);
        f.options.forEach((o, i) => (o.isSelected = i === index));
        commit(widget, { kind: "selection", index, isSelected: true });
      });
    }
    if (!node) continue;
    node.classList.add("fld");
    place(node, r);
    nodes.push(node);
  }
  return nodes;
}
