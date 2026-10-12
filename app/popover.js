// A small floating text box for entering or editing a comment or a piece of typed text.
let current = null;

export function closePopover() {
  current?.close();
}

/**
 * Opens a text entry popover at a point in the window. A click outside it saves the text if there is any
 * and cancels otherwise; Escape cancels; Ctrl+Enter saves.
 */
export function openPopover({ x, y, who = "", value = "", placeholder = "", submitText = "Save", width = 300, fontSize, onSubmit, onCancel }) {
  closePopover();
  const root = document.createElement("div");
  root.className = "popover";
  root.style.width = `${width}px`;
  if (who) {
    const p = document.createElement("p");
    p.className = "who";
    p.textContent = who;
    root.append(p);
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.placeholder = placeholder;
  if (fontSize) area.style.fontSize = `${fontSize}px`;
  const row = document.createElement("div");
  row.className = "row";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn primary";
  save.textContent = submitText;
  row.append(cancel, save);
  root.append(area, row);
  document.body.append(root);

  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - root.offsetHeight - 8));
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;

  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    document.removeEventListener("pointerdown", outside, true);
    root.remove();
    if (current === handle) current = null;
  };
  const submit = () => {
    const text = area.value;
    close();
    onSubmit?.(text);
  };
  const abort = () => {
    close();
    onCancel?.();
  };
  const outside = (e) => {
    if (root.contains(e.target)) return;
    if (area.value.trim()) submit();
    else abort();
  };
  cancel.addEventListener("click", abort);
  save.addEventListener("click", submit);
  area.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      abort();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  });
  // Listen on the next turn so the click that opened the popover does not close it.
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);

  const handle = { close };
  current = handle;
  return handle;
}
