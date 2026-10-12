import { engine, call, openDocument, closeDocument, PdfErrorCode, fromEngineRect } from "./engine.js";
import { PdfView } from "./viewer.js";
import { Editor } from "./editor.js";
import { readComments } from "./comments.js";
import { askText, askConfirm, askChoice } from "./dialog.js";
import { openPopover } from "./popover.js";
import { parsePageRange, printPages } from "./print.js";
import { Thumbnails } from "./thumbs.js";
import { rotatePages, deletePages, reorderPages } from "./pageops.js";
import { TabStrip, showMenu, closeMenu, openSwitcher } from "./tabs.js";

const $ = (id) => document.getElementById(id);
const els = {
  openBtn: $("openBtn"),
  saveBtn: $("saveBtn"),
  saveAsBtn: $("saveAsBtn"),
  printBtn: $("printBtn"),
  undoBtn: $("undoBtn"),
  redoBtn: $("redoBtn"),
  fileInput: $("fileInput"),
  prevBtn: $("prevBtn"),
  nextBtn: $("nextBtn"),
  pageInput: $("pageInput"),
  pageCount: $("pageCount"),
  zoomOutBtn: $("zoomOutBtn"),
  zoomInBtn: $("zoomInBtn"),
  zoomLabel: $("zoomLabel"),
  fitWidthBtn: $("fitWidthBtn"),
  findInput: $("findInput"),
  findCount: $("findCount"),
  findPrevBtn: $("findPrevBtn"),
  findNextBtn: $("findNextBtn"),
  docName: $("docName"),
  dirtyDot: $("dirtyDot"),
  message: $("message"),
  dropHint: $("dropHint"),
  toast: $("toast"),
  panes: $("panes"),
  commentsBtn: $("commentsBtn"),
  commentCount: $("commentCount"),
  commentsPanel: $("commentsPanel"),
  closeComments: $("closeComments"),
  commentList: $("commentList"),
  rail: $("rail"),
  toolOptions: $("toolOptions"),
  pagesBtn: $("pagesBtn"),
  pagesPanel: $("pagesPanel"),
  thumbsHost: $("thumbsHost"),
  rotLeftBtn: $("rotLeftBtn"),
  rotRightBtn: $("rotRightBtn"),
  delPagesBtn: $("delPagesBtn"),
  insertPagesBtn: $("insertPagesBtn"),
  extractPagesBtn: $("extractPagesBtn"),
  insertInput: $("insertInput"),
};

const strip = new TabStrip({ barEl: $("tabbar"), listEl: $("tabList"), newBtn: $("newTabBtn"), menuBtn: $("tabMenuBtn") });

/** @type {DocTab[]} in display order */
const tabs = [];
let active = null;
let currentTool = "select";

const controls = [
  els.prevBtn, els.nextBtn, els.pageInput, els.zoomOutBtn, els.zoomInBtn,
  els.fitWidthBtn, els.findInput, els.findPrevBtn, els.findNextBtn, els.commentsBtn,
  els.saveAsBtn, els.printBtn, els.pagesBtn, els.insertPagesBtn, ...els.rail.querySelectorAll("[data-tool]"),
];
const selectionTools = [els.rotLeftBtn, els.rotRightBtn, els.delPagesBtn, els.extractPagesBtn];

function showMessage(text) {
  els.message.textContent = text;
}

let toastTimer = 0;
function toast(text, ms = 2600) {
  clearTimeout(toastTimer);
  els.toast.textContent = text;
  els.toast.hidden = !text;
  if (text && ms) toastTimer = setTimeout(() => (els.toast.hidden = true), ms);
}

// -------------------------------------------------------------------- tabs

/** One open document: its own view, editor (undo history), thumbnails and comment list. */
function createTab({ doc, name, handle, meta }) {
  const id = crypto.randomUUID();
  const pane = document.createElement("div");
  pane.className = "viewer-pane inactive";
  pane.tabIndex = -1;
  els.panes.append(pane);
  const view = new PdfView(pane);
  view.setActive(false);
  const editor = new Editor({ view, optionsEl: els.toolOptions });
  const thumbsEl = document.createElement("div");
  thumbsEl.className = "thumbs";
  thumbsEl.hidden = true;
  els.thumbsHost.append(thumbsEl);
  const thumbs = new Thumbnails(thumbsEl);
  const tab = {
    id, name, handle, meta, doc, pane, view, editor, thumbs, thumbsEl,
    threads: null, findQuery: "", findCount: "",
    pinned: false, openedAt: Date.now(), lastUsed: 0, commentsToken: 0, commentsTimer: 0,
  };
  wireTab(tab);
  return tab;
}

function wireTab(tab) {
  const { view, editor, thumbs } = tab;
  const isActive = () => tab === active;

  view.addEventListener("page", (e) => {
    thumbs.setCurrent(e.detail.page - 1);
    if (isActive()) els.pageInput.value = e.detail.page;
  });
  view.addEventListener("zoom", () => isActive() && syncZoom());
  view.addEventListener("ready", () => isActive() && syncZoom());
  view.addEventListener("find", (e) => {
    const { total, index, query } = e.detail;
    if (!tab.findQuery) tab.findCount = "";
    else if (total === 0) tab.findCount = query !== undefined ? "No matches" : "";
    else tab.findCount = index >= 0 ? `${index + 1} of ${total}` : `${total} matches`;
    if (isActive()) els.findCount.textContent = tab.findCount;
  });
  view.addEventListener("formchange", (e) => {
    editor.markDirty();
    thumbs.refreshPage(e.detail.page);
  });
  view.addEventListener("formerror", (e) => toast(`Could not fill in that field: ${e.detail.message}`, 5000));

  editor.addEventListener("change", () => {
    renderTabs();
    if (isActive()) syncEditState();
  });
  editor.addEventListener("edited", (e) => {
    refreshComments(tab);
    if (e.detail?.page !== undefined) thumbs.refreshPage(e.detail.page);
  });
  editor.addEventListener("error", (e) => toast(e.detail.message, 6000));
  editor.addEventListener("tool", (e) => {
    if (!isActive()) return;
    currentTool = e.detail.tool;
    syncRail();
  });

  thumbs.addEventListener("selection", () => isActive() && syncPageTools());
  thumbs.addEventListener("go", (e) => view.goToPage(e.detail.page + 1));
  thumbs.addEventListener("delete", () => isActive() && els.delPagesBtn.click());
  thumbs.addEventListener("reorder", async (e) => {
    const { order, moved } = e.detail;
    const done = await applyPageChange(tab, "reorder pages", (bytes) => reorderPages(bytes, order));
    if (done) tab.thumbs.selectPages(moved.map((old) => order.indexOf(old)).sort((a, b) => a - b));
  });
}

/** Tabs as the strip shows them. Two tabs with the same file name are told apart by a number. */
function tabInfos(list = tabs) {
  const seen = new Map();
  const numbers = new Map();
  for (const t of tabs) {
    const n = (seen.get(t.name) ?? 0) + 1;
    seen.set(t.name, n);
    numbers.set(t.id, n);
  }
  return list.map((t) => ({
    id: t.id,
    title: numbers.get(t.id) > 1 ? `${t.name} (${numbers.get(t.id)})` : t.name,
    tooltip: t.name,
    dirty: t.editor.dirty,
    pinned: t.pinned,
  }));
}

function renderTabs() {
  strip.render(tabInfos(), active?.id ?? null);
}

function activateTab(tab) {
  if (!tab || tab === active) return;
  const previous = active;
  if (previous) {
    previous.pane.classList.add("inactive");
    previous.pane.removeAttribute("id");
    previous.thumbsEl.hidden = true;
    previous.view.setActive(false);
    previous.editor.active = false;
    clearTimeout(findTimer);
  }
  active = tab;
  tab.lastUsed = Date.now();
  tab.pane.id = "viewerContainer";
  tab.pane.classList.remove("inactive");
  tab.thumbsEl.hidden = false;
  tab.view.setActive(true);
  tab.editor.active = true;
  tab.editor.setTool(currentTool);
  showMessage("");
  syncAll();
  renderTabs();
  if (tab.threads === null) loadComments(tab);
  tab.pane.focus({ preventScroll: true });
}

function moveTab(id, beforeId) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || id === beforeId) return;
  const without = tabs.filter((t) => t !== tab);
  const pinned = without.filter((t) => t.pinned);
  const rest = without.filter((t) => !t.pinned);
  const target = without.find((t) => t.id === beforeId);
  if (tab.pinned) {
    const i = target?.pinned ? pinned.indexOf(target) : pinned.length;
    pinned.splice(i, 0, tab);
  } else {
    const i = target && !target.pinned ? rest.indexOf(target) : target ? 0 : rest.length;
    rest.splice(i, 0, tab);
  }
  tabs.splice(0, tabs.length, ...pinned, ...rest);
  renderTabs();
}

function togglePin(tab) {
  tab.pinned = !tab.pinned;
  // A pinned tab goes to the end of the pinned group; an unpinned one to the start of the rest.
  const others = tabs.filter((t) => t !== tab);
  const pinned = others.filter((t) => t.pinned);
  const rest = others.filter((t) => !t.pinned);
  if (tab.pinned) pinned.push(tab);
  else rest.unshift(tab);
  tabs.splice(0, tabs.length, ...pinned, ...rest);
  renderTabs();
}

/** Sorts the tabs that are not pinned; pinned tabs stay where they are. */
function sortTabs(mode) {
  const pinned = tabs.filter((t) => t.pinned);
  const rest = tabs.filter((t) => !t.pinned);
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  if (mode === "name") rest.sort(byName);
  else if (mode === "name-desc") rest.sort((a, b) => byName(b, a));
  else if (mode === "recent") rest.sort((a, b) => b.lastUsed - a.lastUsed);
  else if (mode === "opened") rest.sort((a, b) => a.openedAt - b.openedAt);
  else if (mode === "unsaved") rest.sort((a, b) => Number(b.editor.dirty) - Number(a.editor.dirty));
  tabs.splice(0, tabs.length, ...pinned, ...rest);
  renderTabs();
}

async function closeTab(tab) {
  if (tab.editor.dirty) {
    activateTab(tab);
    const choice = await askChoice({
      title: `Save changes to ${tab.name}?`,
      message: "Your changes will be lost if you do not save them.",
      choices: [
        { key: "save", label: "Save", primary: true },
        { key: "discard", label: "Don’t save", danger: true },
        { key: "cancel", label: "Cancel" },
      ],
    });
    if (choice === null || choice === "cancel") return false;
    if (choice === "save") {
      await saveDocument(tab);
      if (tab.editor.dirty) return false; // the save did not go through
    }
  }
  const wasActive = tab === active;
  const index = tabs.indexOf(tab);
  tabs.splice(index, 1);
  clearTimeout(tab.commentsTimer);
  tab.commentsToken++;
  tab.view.clear();
  tab.thumbs.clear();
  closeDocument(tab.doc);
  tab.pane.remove();
  tab.thumbsEl.remove();
  if (wasActive) {
    active = null;
    // Go back to the tab used most recently, which is where the reader came from.
    const next = [...tabs].sort((a, b) => b.lastUsed - a.lastUsed)[0];
    if (next) activateTab(next);
    else syncAll();
  }
  renderTabs();
  return true;
}

async function closeMany(list) {
  for (const t of list) {
    if (!tabs.includes(t)) continue;
    if (!(await closeTab(t))) return false;
  }
  return true;
}

strip.addEventListener("activate", (e) => activateTab(tabs.find((t) => t.id === e.detail.id)));
strip.addEventListener("close", (e) => {
  const t = tabs.find((x) => x.id === e.detail.id);
  if (t) closeTab(t);
});
strip.addEventListener("reorder", (e) => moveTab(e.detail.id, e.detail.beforeId));
strip.addEventListener("new", () => chooseFiles());
strip.addEventListener("tabmenu", (e) => {
  const t = tabs.find((x) => x.id === e.detail.id);
  if (!t) return;
  const i = tabs.indexOf(t);
  showMenu(e.detail.x, e.detail.y, [
    { label: "Close tab", onClick: () => closeTab(t) },
    { label: "Close other tabs", disabled: tabs.length < 2, onClick: () => closeMany(tabs.filter((x) => x !== t && !x.pinned)) },
    { label: "Close tabs to the right", disabled: i >= tabs.length - 1, onClick: () => closeMany(tabs.slice(i + 1).filter((x) => !x.pinned)) },
    { separator: true },
    { label: t.pinned ? "Unpin tab" : "Pin tab", onClick: () => togglePin(t) },
    { separator: true },
    { label: "Save", disabled: !t.editor.dirty, onClick: () => saveDocument(t) },
    { label: "Save a copy…", onClick: () => saveDocument(t, { copy: true }) },
  ]);
});
strip.addEventListener("menu", (e) => {
  showMenu(e.detail.x, e.detail.y, [
    { label: "Go to tab…", hint: "Ctrl+K", disabled: tabs.length === 0, onClick: openTabSwitcher },
    { separator: true },
    { heading: "Sort tabs" },
    { label: "By name, A to Z", disabled: tabs.length < 2, onClick: () => sortTabs("name") },
    { label: "By name, Z to A", disabled: tabs.length < 2, onClick: () => sortTabs("name-desc") },
    { label: "Most recently used first", disabled: tabs.length < 2, onClick: () => sortTabs("recent") },
    { label: "In the order opened", disabled: tabs.length < 2, onClick: () => sortTabs("opened") },
    { label: "Unsaved changes first", disabled: tabs.length < 2, onClick: () => sortTabs("unsaved") },
    { separator: true },
    { label: "Close all tabs", disabled: tabs.length === 0, onClick: () => closeMany([...tabs]) },
  ]);
});

function openTabSwitcher() {
  if (!tabs.length) return;
  const byRecent = [...tabs].sort((a, b) => b.lastUsed - a.lastUsed);
  const infos = new Map(tabInfos().map((i) => [i.id, i]));
  openSwitcher({
    items: byRecent.map((t) => infos.get(t.id)),
    activeId: active?.id,
    onPick: (id) => activateTab(tabs.find((t) => t.id === id)),
  });
}

function stepTab(delta) {
  if (tabs.length < 2 || !active) return;
  const i = tabs.indexOf(active);
  activateTab(tabs[(i + delta + tabs.length) % tabs.length]);
}

// ------------------------------------------------------- toolbar follows tab

function syncZoom() {
  if (active) els.zoomLabel.textContent = `${Math.round(active.view.zoom * 100)}%`;
}

function syncRail() {
  for (const btn of els.rail.querySelectorAll("[data-tool]")) btn.setAttribute("aria-pressed", String(btn.dataset.tool === currentTool));
}

function syncEditState() {
  const t = active;
  els.saveBtn.disabled = !t || !t.editor.dirty;
  els.undoBtn.disabled = !t || !t.editor.history.undo.length;
  els.redoBtn.disabled = !t || !t.editor.history.redo.length;
  els.dirtyDot.hidden = !t || !t.editor.dirty;
  document.title = t ? `${t.editor.dirty ? "• " : ""}${t.name} · Lite PDF` : "Lite PDF";
}

function syncPageTools() {
  const has = active && active.thumbs.selection().length > 0;
  for (const b of selectionTools) b.disabled = !has;
}

/** Brings every part of the toolbar and side panels in line with the active tab. */
function syncAll() {
  const t = active;
  for (const c of controls) c.disabled = !t;
  if (!t) {
    els.docName.textContent = "No file open";
    els.docName.title = "";
    els.pageCount.textContent = "of 0";
    els.pageInput.value = 1;
    els.zoomLabel.textContent = "100%";
    els.findInput.value = "";
    els.findCount.textContent = "";
    els.commentCount.textContent = "0";
    els.commentList.replaceChildren();
    for (const b of selectionTools) b.disabled = true;
    els.toolOptions.hidden = true;
    syncEditState();
    showMessage("Open a PDF to start, or drag one into this window.");
    return;
  }
  els.docName.textContent = t.name;
  els.docName.title = t.name;
  els.pageCount.textContent = `of ${t.doc.pageCount}`;
  els.pageInput.max = t.doc.pageCount;
  els.pageInput.value = t.view.pageNumber;
  syncZoom();
  els.findInput.value = t.findQuery;
  els.findCount.textContent = t.findCount;
  if (t.threads) renderComments(t, t.threads);
  else renderCommentsMessage("Reading comments…");
  syncEditState();
  syncPageTools();
  syncRail();
}

// ------------------------------------------------------------------ opening

async function sameFile(tab, file, handle) {
  if (handle && tab.handle?.isSameEntry) {
    try {
      if (await handle.isSameEntry(tab.handle)) return true;
    } catch {
      // Fall back to comparing the file's details.
    }
  }
  return tab.meta && tab.name === file.name && tab.meta.size === file.size && tab.meta.lastModified === file.lastModified;
}

async function openOne(file, handle = null) {
  for (const t of tabs) {
    if (await sameFile(t, file, handle)) {
      activateTab(t);
      toast(`${file.name} is already open`);
      return;
    }
  }
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    toast(`Could not read ${file.name}: ${err.message}`, 6000);
    return;
  }
  await openBytes(bytes, file.name, handle, { size: file.size, lastModified: file.lastModified });
}

async function openMany(entries) {
  for (const { file, handle } of entries) await openOne(file, handle);
}

async function openBytes(bytes, name, handle = null, meta = null) {
  if (tabs.length) toast(`Opening ${name}…`, 0);
  else showMessage(`Opening ${name}…`);
  try {
    let password;
    let doc;
    for (;;) {
      try {
        doc = await openDocument(bytes, password);
        break;
      } catch (err) {
        if (err.code !== PdfErrorCode.Password) throw err;
        password = await askText({
          title: "Password required",
          label: password === undefined ? `${name} is password protected.` : "That password is not correct. Try again.",
          type: "password",
          okText: "Open",
        });
        if (password === null) {
          toast("", 1);
          if (!tabs.length) showMessage("Open a PDF to start, or drag one into this window.");
          return;
        }
      }
    }
    const tab = createTab({ doc, name, handle, meta });
    tab.editor.attach(doc);
    await tab.view.setDocument(doc);
    tab.thumbs.setDocument(doc);
    tabs.push(tab);
    toast("", 1);
    activateTab(tab);
    renderTabs();
  } catch (err) {
    const unreadable = err.code === PdfErrorCode.WrongFormat || /LoadMemDocument|format/i.test(err.message);
    const message = unreadable ? `${name} is not a valid PDF, or it is damaged.` : `Could not open ${name}: ${err.message}`;
    if (tabs.length) toast(message, 7000);
    else showMessage(message);
  }
}

async function chooseFiles() {
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: "PDF documents", accept: { "application/pdf": [".pdf"] } }],
      });
      await openMany(await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle }))));
    } catch (err) {
      if (err?.name !== "AbortError") toast(`Could not open the file: ${err.message}`, 6000);
    }
    return;
  }
  els.fileInput.click();
}

// ------------------------------------------------------------------- saving

const PDF_TYPES = [{ description: "PDF documents", accept: { "application/pdf": [".pdf"] } }];

async function writeToHandle(handle, blob) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/** Saves a document. "Save" writes back to the file it came from; "Save a copy" always asks where. Returns true on success. */
async function saveDocument(tab = active, { copy = false } = {}) {
  if (!tab) return false;
  try {
    toast("Saving…", 0);
    const buffer = await call(engine().saveAsCopy(tab.doc));
    const blob = new Blob([buffer], { type: "application/pdf" });
    let handle = copy ? null : tab.handle;

    if (handle?.createWritable) {
      let granted = (await handle.queryPermission?.({ mode: "readwrite" })) === "granted";
      if (!granted) granted = (await handle.requestPermission?.({ mode: "readwrite" })) === "granted";
      if (!granted) handle = null;
    }
    if (handle?.createWritable) {
      await writeToHandle(handle, blob);
    } else if (window.showSaveFilePicker) {
      const picked = await window.showSaveFilePicker({ suggestedName: tab.name || "document.pdf", types: PDF_TYPES });
      await writeToHandle(picked, blob);
      if (!copy) {
        tab.handle = picked;
        tab.name = picked.name;
        tab.meta = null;
        if (tab === active) syncAll();
        renderTabs();
      }
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = tab.name || "document.pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    if (!copy) tab.editor.markClean();
    toast(copy ? "Copy saved" : "Saved");
    return true;
  } catch (err) {
    if (err?.name === "AbortError") {
      toast("", 1);
      return false;
    }
    toast(`Could not save: ${err.message}`, 6000);
    return false;
  }
}

// ----------------------------------------------------------------- printing

async function printDocument(tab = active) {
  if (!tab) return;
  const count = tab.doc.pageCount;
  const answer = await askText({
    title: "Print",
    label: `Pages to print, for example 1-3, 5. Leave empty to print all ${count}.`,
    okText: "Print",
    validate: (v) => (parsePageRange(v, count) ? null : `Enter page numbers between 1 and ${count}.`),
  });
  if (answer === null) return;
  const indices = parsePageRange(answer, count);
  try {
    await printPages(tab.doc, indices, (n, total) => toast(`Preparing page ${n} of ${total}…`, 0));
    toast("", 1);
  } catch (err) {
    toast(`Could not print: ${err.message}`, 6000);
  }
}

// --------------------------------------------------------------- page changes

const MAX_SNAPSHOT = 120 * 1024 * 1024;

/** Replaces a tab's document with new file bytes, keeping the reader's zoom and place. */
async function reloadDocument(tab, bytes, { keepHistory = true } = {}) {
  tab.commentsToken++;
  const doc = await openDocument(new Uint8Array(bytes));
  const previous = tab.doc;
  tab.doc = doc;
  tab.editor.attach(doc, { keepDirty: true, keepHistory });
  await tab.view.setDocument(doc, { keepView: true });
  tab.thumbs.setDocument(doc);
  if (previous) closeDocument(previous);
  tab.editor.markDirty();
  if (tab === active) {
    els.pageCount.textContent = `of ${doc.pageCount}`;
    els.pageInput.max = doc.pageCount;
    syncPageTools();
  }
  loadComments(tab, { quiet: true });
}

/** Runs a change to the page list: snapshot, transform the bytes, reload, and record one undo step. */
async function applyPageChange(tab, label, transform) {
  if (!tab) return null;
  if (tab.doc.isEncrypted) {
    toast("Page changes are not available for password-protected files yet.", 6000);
    return null;
  }
  try {
    toast("Updating pages…", 0);
    const before = new Uint8Array(await call(engine().saveAsCopy(tab.doc)));
    let after;
    try {
      after = await transform(before);
    } catch (err) {
      // A failed change must not leave the open document half changed.
      await reloadDocument(tab, before);
      throw err;
    }
    await reloadDocument(tab, after, { keepHistory: false });
    const big = before.byteLength > MAX_SNAPSHOT || after.byteLength > MAX_SNAPSHOT;
    tab.editor.recordPageChange(label, big ? null : before, big ? null : after, (bytes) => reloadDocument(tab, bytes));
    toast("", 1);
    if (big) toast("This file is large, so that change cannot be undone.", 5000);
    return true;
  } catch (err) {
    toast(`Could not ${label}: ${err.message}`, 7000);
    return null;
  }
}

function setPagesOpen(open) {
  els.pagesPanel.hidden = !open;
  els.pagesBtn.setAttribute("aria-pressed", String(open));
}

const baseName = (tab) => tab.name.replace(/\.pdf$/i, "");

async function exportBlob(blob, suggestedName) {
  if (window.showSaveFilePicker) {
    const picked = await window.showSaveFilePicker({ suggestedName, types: PDF_TYPES });
    await writeToHandle(picked, blob);
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

els.pagesBtn.addEventListener("click", () => setPagesOpen(els.pagesPanel.hidden));

els.rotLeftBtn.addEventListener("click", () => {
  const tab = active;
  const sel = tab.thumbs.selection();
  applyPageChange(tab, "rotate pages", (bytes) => rotatePages(bytes, sel, -90)).then(() => tab.thumbs.selectPages(sel));
});
els.rotRightBtn.addEventListener("click", () => {
  const tab = active;
  const sel = tab.thumbs.selection();
  applyPageChange(tab, "rotate pages", (bytes) => rotatePages(bytes, sel, 90)).then(() => tab.thumbs.selectPages(sel));
});
els.delPagesBtn.addEventListener("click", async () => {
  const tab = active;
  const sel = tab?.thumbs.selection() ?? [];
  if (!sel.length) return;
  if (sel.length >= tab.doc.pageCount) {
    toast("A document needs at least one page.", 4000);
    return;
  }
  await applyPageChange(tab, "delete pages", (bytes) => deletePages(bytes, sel));
});

els.insertPagesBtn.addEventListener("click", () => els.insertInput.click());
els.insertInput.addEventListener("change", async () => {
  const file = els.insertInput.files[0];
  els.insertInput.value = "";
  const tab = active;
  if (!file || !tab) return;
  let other;
  try {
    other = await openDocument(new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    toast(err.code === PdfErrorCode.Password ? "Password-protected files cannot be inserted yet." : `Could not open ${file.name}: ${err.message}`, 6000);
    return;
  }
  const answer = await askText({
    title: `Insert from ${file.name}`,
    label: `Pages to insert, for example 1-3, 5. Leave empty to insert all ${other.pageCount}.`,
    okText: "Insert",
    validate: (v) => (parsePageRange(v, other.pageCount) ? null : `Enter page numbers between 1 and ${other.pageCount}.`),
  });
  if (answer === null) {
    closeDocument(other);
    return;
  }
  const indices = parsePageRange(answer, other.pageCount);
  const sel = tab.thumbs.selection();
  const at = (sel.length ? sel[sel.length - 1] : tab.view.pageNumber - 1) + 1;
  const done = await applyPageChange(tab, "insert pages", async () => {
    await call(engine().importPages(tab.doc, other, indices, at));
    return new Uint8Array(await call(engine().saveAsCopy(tab.doc)));
  });
  closeDocument(other);
  if (done) tab.thumbs.selectPages(indices.map((_, k) => at + k));
});

els.extractPagesBtn.addEventListener("click", async () => {
  const tab = active;
  const sel = tab?.thumbs.selection() ?? [];
  if (!sel.length) return;
  try {
    toast("Preparing pages…", 0);
    const buffer = await call(engine().extractPages(tab.doc, sel));
    const name = sel.length === 1 ? `${baseName(tab)}-page-${sel[0] + 1}.pdf` : `${baseName(tab)}-pages.pdf`;
    await exportBlob(new Blob([buffer], { type: "application/pdf" }), name);
    toast(`Saved ${sel.length} page${sel.length === 1 ? "" : "s"} as a new file`);
  } catch (err) {
    if (err?.name === "AbortError") toast("", 1);
    else toast(`Could not save the pages: ${err.message}`, 6000);
  }
});

// ----------------------------------------------------------------- comments

function refreshComments(tab) {
  clearTimeout(tab.commentsTimer);
  tab.commentsTimer = setTimeout(() => tabs.includes(tab) && loadComments(tab, { quiet: true }), 150);
}

async function loadComments(tab, { quiet = false } = {}) {
  const token = ++tab.commentsToken;
  if (!quiet && tab === active) renderCommentsMessage("Reading comments…");
  try {
    const threads = await readComments(tab.doc);
    if (token !== tab.commentsToken || !tabs.includes(tab)) return;
    tab.threads = threads;
    if (tab === active) renderComments(tab, threads);
  } catch (err) {
    if (token !== tab.commentsToken || tab !== active) return;
    renderCommentsMessage(`Could not read comments: ${err.message}`);
    els.commentCount.textContent = "!";
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const formatDate = (date) => (date ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

function renderCommentsMessage(text) {
  els.commentList.replaceChildren(el("p", "empty", text));
  els.commentCount.textContent = "0";
}

const AVATAR_COLORS = ["#b8420f", "#2f7d4f", "#9a6a07", "#9d2f5b", "#6b4f2a", "#57534e", "#a1301f"];

// The same author always gets the same colour, so replies are easy to follow.
function avatarColor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function actionButton(label, onClick) {
  const b = el("button", "link-btn", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function commentNode(tab, comment, isReply) {
  const author = comment.author || "Unknown author";
  const box = el("div", isReply ? "comment reply" : "comment");
  const avatar = el("div", "avatar", author.trim().charAt(0).toUpperCase() || "?");
  avatar.style.background = avatarColor(author);
  const body = el("div", "comment-body");
  const meta = el("div", "meta");
  meta.append(el("strong", null, author));
  const when = formatDate(comment.date);
  if (when) meta.append(` · ${when}`);
  const text = el("p", "text", comment.text);

  const actions = el("div", "comment-actions");
  actions.append(
    actionButton("Reply", () => openReplyBox(tab, body, comment)),
    actionButton("Edit", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      openPopover({
        x: r.left - 200,
        y: r.bottom + 6,
        value: comment.text,
        submitText: "Save",
        onSubmit: (value) => {
          if (value.trim() && value !== comment.text) tab.editor.editComment(comment, value).catch((err) => toast(`Could not edit: ${err.message}`, 5000));
        },
      });
    }),
    actionButton("Delete", async () => {
      const ok = await askConfirm({ title: "Delete this comment?", message: "The comment and any replies to it are removed from the document.", okText: "Delete" });
      if (ok) tab.editor.deleteComment(comment).catch((err) => toast(`Could not delete: ${err.message}`, 5000));
    })
  );
  body.append(meta, text, actions);
  box.append(avatar, body);
  return box;
}

function openReplyBox(tab, container, comment) {
  const existing = container.querySelector(".reply-box");
  if (existing) {
    existing.querySelector("textarea").focus();
    return;
  }
  const box = el("div", "reply-box");
  const area = document.createElement("textarea");
  area.placeholder = "Write a reply…";
  const row = el("div", "row");
  const cancel = el("button", "btn", "Cancel");
  cancel.type = "button";
  const post = el("button", "btn primary", "Reply");
  post.type = "button";
  row.append(cancel, post);
  box.append(area, row);
  container.append(box);
  area.focus();
  cancel.addEventListener("click", () => box.remove());
  const submit = async () => {
    const value = area.value.trim();
    if (!value) return;
    post.disabled = true;
    try {
      await tab.editor.reply(comment, value);
    } catch (err) {
      toast(`Could not reply: ${err.message}`, 5000);
      post.disabled = false;
    }
  };
  post.addEventListener("click", submit);
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      box.remove();
    }
  });
}

// Comment text comes from the PDF file, so it is always inserted as text, never as HTML.
function renderComments(tab, threads) {
  const total = threads.reduce((sum, t) => sum + 1 + t.replies.length, 0);
  els.commentCount.textContent = String(total);
  if (threads.length === 0) {
    renderCommentsMessage("No comments in this document. Use the comment tool to add one.");
    return;
  }
  const nodes = threads.map((thread) => {
    const card = el("article", "thread");
    const pageButton = el("button", "thread-page", `Page ${thread.page}`);
    pageButton.type = "button";
    pageButton.addEventListener("click", () => {
      tab.view.goToPage(thread.page);
      if (thread.annotation?.rect) tab.view.revealRect(thread.pageIndex, fromEngineRect(thread.annotation.rect));
    });
    card.append(pageButton, commentNode(tab, thread, false));
    for (const reply of thread.replies) card.append(commentNode(tab, reply, true));
    return card;
  });
  els.commentList.replaceChildren(...nodes);
}

function setCommentsOpen(open) {
  els.commentsPanel.hidden = !open;
  els.commentsBtn.setAttribute("aria-pressed", String(open));
  if (open) els.closeComments.focus();
}

// ---------------------------------------------------------------- toolbar in

els.undoBtn.addEventListener("click", () => active?.editor.undo());
els.redoBtn.addEventListener("click", () => active?.editor.redo());
els.saveBtn.addEventListener("click", () => saveDocument());
els.saveAsBtn.addEventListener("click", () => saveDocument(active, { copy: true }));
els.printBtn.addEventListener("click", () => printDocument());

for (const btn of els.rail.querySelectorAll("[data-tool]")) {
  btn.addEventListener("click", () => active?.editor.setTool(btn.dataset.tool));
}

window.addEventListener("beforeunload", (e) => {
  if (!tabs.some((t) => t.editor.dirty)) return;
  e.preventDefault();
  e.returnValue = "";
});

els.openBtn.addEventListener("click", chooseFiles);
els.fileInput.addEventListener("change", () => {
  const files = [...els.fileInput.files];
  els.fileInput.value = "";
  openMany(files.map((file) => ({ file, handle: null })));
});

const goToPage = (n) => active && active.view.goToPage(Math.min(Math.max(1, n), active.doc.pageCount));
els.prevBtn.addEventListener("click", () => active && goToPage(active.view.pageNumber - 1));
els.nextBtn.addEventListener("click", () => active && goToPage(active.view.pageNumber + 1));
els.pageInput.addEventListener("change", () => goToPage(Number(els.pageInput.value)));

els.zoomInBtn.addEventListener("click", () => active?.view.zoomBy(1.2));
els.zoomOutBtn.addEventListener("click", () => active?.view.zoomBy(1 / 1.2));
els.fitWidthBtn.addEventListener("click", () => active?.view.fitWidth());

let findTimer = 0;
const runFind = () => {
  const tab = active;
  if (!tab) return;
  tab.findQuery = els.findInput.value;
  tab.view.find(tab.findQuery).catch((err) => console.error("Search failed", err));
};
els.findInput.addEventListener("input", () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(runFind, 180);
});
els.findInput.addEventListener("keydown", (e) => {
  const tab = active;
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(findTimer);
    if (tab?.view.hits.length && tab.view.findQuery === els.findInput.value) tab.view.findStep(e.shiftKey ? -1 : 1);
    else runFind();
  } else if (e.key === "Escape") {
    els.findInput.value = "";
    if (tab) {
      tab.findQuery = "";
      tab.findCount = "";
      tab.view.clearFind();
      tab.pane.focus({ preventScroll: true });
    }
    els.findCount.textContent = "";
  }
});
els.findNextBtn.addEventListener("click", () => active?.view.findStep(1));
els.findPrevBtn.addEventListener("click", () => active?.view.findStep(-1));

els.commentsBtn.addEventListener("click", () => setCommentsOpen(els.commentsPanel.hidden));
els.closeComments.addEventListener("click", () => setCommentsOpen(false));

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  const dialogOpen = !!document.querySelector("dialog[open]");
  if (dialogOpen && !(mod && key === "k")) return;
  if (mod && key === "o") {
    e.preventDefault();
    chooseFiles();
  } else if (mod && key === "k") {
    e.preventDefault();
    if (!dialogOpen) openTabSwitcher();
  } else if (mod && key === "tab") {
    e.preventDefault();
    stepTab(e.shiftKey ? -1 : 1);
  } else if ((mod && (key === "pagedown" || key === "pageup")) || (e.altKey && (key === "pagedown" || key === "pageup"))) {
    e.preventDefault();
    stepTab(key === "pagedown" ? 1 : -1);
  } else if ((e.altKey || mod) && /^[1-9]$/.test(key)) {
    // Alt+1 to Alt+8 jump to that tab, Alt+9 to the last one.
    e.preventDefault();
    const target = key === "9" ? tabs[tabs.length - 1] : tabs[Number(key) - 1];
    if (target) activateTab(target);
  } else if (mod && key === "w") {
    // Edge may keep Ctrl+W for itself; where the page does receive it, close just this tab.
    if (active) {
      e.preventDefault();
      closeTab(active);
    }
  } else if (mod && key === "s") {
    e.preventDefault();
    if (active) saveDocument(active, { copy: e.shiftKey });
  } else if (mod && key === "p") {
    e.preventDefault();
    printDocument();
  } else if (mod && key === "f") {
    if (!els.findInput.disabled) {
      e.preventDefault();
      els.findInput.focus();
      els.findInput.select();
    }
  } else if (mod && key === "a" && !typing && active) {
    e.preventDefault();
    active.view.selectAll();
  } else if (mod && (key === "=" || key === "+") && active) {
    e.preventDefault();
    active.view.zoomBy(1.2);
  } else if (mod && key === "-" && active) {
    e.preventDefault();
    active.view.zoomBy(1 / 1.2);
  } else if (mod && key === "0" && active) {
    e.preventDefault();
    active.view.fitWidth();
  } else if (key === "escape" && !typing) {
    closeMenu();
    active?.view.clearSelection();
  }
});

// Drag and drop onto the window: every PDF dropped opens in its own tab.
let dragDepth = 0;
const isPdf = (file) => file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name));
window.addEventListener("dragenter", (e) => {
  if (e.dataTransfer?.types?.includes("Files") === false) return;
  e.preventDefault();
  dragDepth++;
  els.dropHint.hidden = false;
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropHint.hidden = true;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropHint.hidden = true;
  // File handles must be requested while the event is still being handled.
  const dropped = [...(e.dataTransfer.items ?? [])]
    .filter((item) => item.kind === "file")
    .map((item) => ({ file: item.getAsFile(), handle: item.getAsFileSystemHandle?.() ?? null }));
  const entries = [];
  for (const d of dropped) {
    if (!isPdf(d.file)) continue;
    let handle = null;
    try {
      handle = d.handle ? await d.handle : null;
    } catch {
      handle = null;
    }
    entries.push({ file: d.file, handle });
  }
  if (!entries.length) {
    toast("That is not a PDF.");
    return;
  }
  openMany(entries);
});

// Set when Windows opens PDFs with this installed app (file_handlers in the manifest). Several files open as several tabs.
if ("launchQueue" in window) {
  launchQueue.setConsumer(async (params) => {
    const handles = params.files ?? [];
    if (!handles.length) return;
    openMany(await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle }))));
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Start the engine now so the first file opens quickly.
engine();
syncAll();

// For tests and debugging.
window.__lite = {
  tabs,
  get view() {
    return active?.view;
  },
  get editor() {
    return active?.editor;
  },
  get state() {
    return { doc: active?.doc ?? null, name: active?.name ?? "", handle: active?.handle ?? null };
  },
};
