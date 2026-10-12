// The tab strip, its menus, and the "go to tab" switcher. It only draws and reports what the user did;
// main.js owns the documents and decides what each action means.

let openMenu = null;

export function closeMenu() {
  openMenu?.close();
}

/** Shows a small menu at a point. Items: { label, onClick, hint?, disabled?, separator?, heading? }. */
export function showMenu(x, y, items) {
  closeMenu();
  const root = document.createElement("div");
  root.className = "menu";
  root.setAttribute("role", "menu");
  for (const item of items) {
    if (item.separator) {
      const hr = document.createElement("div");
      hr.className = "menu-sep";
      root.append(hr);
      continue;
    }
    if (item.heading) {
      const h = document.createElement("div");
      h.className = "menu-heading";
      h.textContent = item.heading;
      root.append(h);
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu-item";
    b.setAttribute("role", "menuitem");
    b.disabled = !!item.disabled;
    const label = document.createElement("span");
    label.textContent = item.label;
    b.append(label);
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "menu-hint";
      hint.textContent = item.hint;
      b.append(hint);
    }
    b.addEventListener("click", () => {
      close();
      item.onClick?.();
    });
    root.append(b);
  }
  document.body.append(root);
  const left = Math.max(8, Math.min(x, window.innerWidth - root.offsetWidth - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - root.offsetHeight - 8));
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;

  const onOutside = (e) => {
    if (!root.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const buttons = [...root.querySelectorAll(".menu-item:not(:disabled)")];
      const i = buttons.indexOf(document.activeElement);
      const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };
  function close() {
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", close);
    root.remove();
    if (openMenu?.root === root) openMenu = null;
  }
  setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
  }, 0);
  root.querySelector(".menu-item:not(:disabled)")?.focus();
  openMenu = { close, root };
}

const PIN_ICON =
  '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3zM12 15v6"/></svg>';

export class TabStrip extends EventTarget {
  constructor({ barEl, listEl, newBtn, menuBtn }) {
    super();
    this.barEl = barEl;
    this.listEl = listEl;
    this.menuBtn = menuBtn;
    this.tabs = [];
    this.activeId = null;
    this.dragId = null;

    newBtn.addEventListener("click", () => this.#emit("new"));
    menuBtn.addEventListener("click", () => {
      const r = menuBtn.getBoundingClientRect();
      this.#emit("menu", { x: r.right - 230, y: r.bottom + 6 });
    });
    // The vertical wheel scrolls a crowded strip sideways.
    listEl.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          listEl.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false }
    );
    listEl.addEventListener("dragover", (e) => this.#onDragOver(e));
    listEl.addEventListener("drop", (e) => this.#onDrop(e));
    listEl.addEventListener("dragleave", (e) => {
      if (!listEl.contains(e.relatedTarget)) this.#clearDrop();
    });
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** @param tabs [{ id, title, tooltip, dirty, pinned }] in display order */
  render(tabs, activeId) {
    this.tabs = tabs;
    this.activeId = activeId;
    this.barEl.hidden = tabs.length === 0;
    this.listEl.replaceChildren(...tabs.map((t) => this.#tabEl(t)));
    this.listEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  #tabEl(t) {
    const el = document.createElement("div");
    el.className = "tab";
    el.dataset.id = t.id;
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(t.id === this.activeId));
    el.tabIndex = t.id === this.activeId ? 0 : -1;
    el.draggable = true;
    el.title = t.tooltip || t.title;
    if (t.pinned) el.classList.add("pinned");
    if (t.dirty) el.classList.add("dirty");

    if (t.pinned) {
      const pin = document.createElement("span");
      pin.className = "tab-pin";
      pin.innerHTML = PIN_ICON;
      el.append(pin);
    }
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = t.pinned ? t.title.replace(/\.pdf$/i, "") : t.title;
    el.append(title);

    const dot = document.createElement("span");
    dot.className = "tab-dot";
    dot.title = "Unsaved changes";
    el.append(dot);

    if (!t.pinned) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.setAttribute("aria-label", `Close ${t.title}`);
      close.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.#emit("close", { id: t.id });
      });
      el.append(close);
    }

    el.addEventListener("click", () => this.#emit("activate", { id: t.id }));
    el.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
    });
    el.addEventListener("auxclick", (e) => {
      if (e.button === 1 && !t.pinned) this.#emit("close", { id: t.id });
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.#emit("tabmenu", { id: t.id, x: e.clientX, y: e.clientY });
    });
    el.addEventListener("keydown", (e) => {
      const i = this.tabs.findIndex((x) => x.id === t.id);
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.#emit("activate", { id: t.id });
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const next = this.tabs[i + (e.key === "ArrowRight" ? 1 : -1)];
        if (next) this.listEl.querySelector(`[data-id="${next.id}"]`)?.focus();
      } else if (e.key === "Delete" && !t.pinned) {
        e.preventDefault();
        this.#emit("close", { id: t.id });
      }
    });
    el.addEventListener("dragstart", (e) => {
      this.dragId = t.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", t.id);
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => {
      this.dragId = null;
      el.classList.remove("dragging");
      this.#clearDrop();
    });
    return el;
  }

  #dropTarget(e) {
    const tabEl = e.target instanceof Element ? e.target.closest(".tab") : null;
    if (!tabEl) {
      // Past the last tab: drop at the end.
      return { beforeId: null, el: this.listEl.lastElementChild, after: true };
    }
    const r = tabEl.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    if (!after) return { beforeId: tabEl.dataset.id, el: tabEl, after: false };
    const next = tabEl.nextElementSibling;
    return { beforeId: next ? next.dataset.id : null, el: tabEl, after: true };
  }

  #onDragOver(e) {
    if (!this.dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const { el, after } = this.#dropTarget(e);
    this.#clearDrop();
    el?.classList.add(after ? "drop-after" : "drop-before");
  }

  #onDrop(e) {
    if (!this.dragId) return;
    e.preventDefault();
    const { beforeId } = this.#dropTarget(e);
    const id = this.dragId;
    this.dragId = null;
    this.#clearDrop();
    if (beforeId !== id) this.#emit("reorder", { id, beforeId });
  }

  #clearDrop() {
    for (const el of this.listEl.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
  }
}

/**
 * The "go to tab" switcher. `items` should already be in the order to show them (most recently used first).
 * Resolves nothing; calls onPick(id) when a tab is chosen.
 */
export function openSwitcher({ items, activeId, onPick }) {
  const dialog = document.getElementById("switcher");
  const input = document.getElementById("switcherInput");
  const list = document.getElementById("switcherList");
  let shown = items;
  let index = items.length > 1 ? 1 : 0; // the previously used tab is preselected, like Alt+Tab

  const draw = () => {
    list.replaceChildren();
    if (!shown.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No open tab matches.";
      list.append(empty);
      return;
    }
    shown.forEach((t, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "switch-row";
      row.setAttribute("aria-selected", String(i === index));
      row.title = t.tooltip || t.title;
      const name = document.createElement("span");
      name.className = "switch-name";
      name.textContent = t.title;
      row.append(name);
      const tags = [];
      if (t.id === activeId) tags.push("current");
      if (t.pinned) tags.push("pinned");
      if (t.dirty) tags.push("unsaved");
      if (tags.length) {
        const tag = document.createElement("span");
        tag.className = "switch-tag";
        tag.textContent = tags.join(" · ");
        row.append(tag);
      }
      row.addEventListener("click", () => pick(t.id));
      list.append(row);
    });
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };
  const pick = (id) => {
    close();
    onPick(id);
  };
  const onInput = () => {
    const q = input.value.trim().toLowerCase();
    shown = q ? items.filter((t) => t.title.toLowerCase().includes(q)) : items;
    index = 0;
    draw();
  };
  const onKey = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      index = (index + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[index]) pick(shown[index].id);
    }
  };
  const onClose = () => {
    input.removeEventListener("input", onInput);
    input.removeEventListener("keydown", onKey);
    dialog.removeEventListener("close", onClose);
  };
  function close() {
    if (dialog.open) dialog.close();
  }
  input.value = "";
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKey);
  dialog.addEventListener("close", onClose);
  draw();
  dialog.showModal();
  input.focus();
}
