import { engine, call, openDocument, closeDocument, PdfErrorCode, fromEngineRect } from "./engine.js";
import { PdfView } from "./viewer.js";
import { Editor } from "./editor.js";
import { readComments } from "./comments.js";
import { askText, askConfirm } from "./dialog.js";
import { openPopover } from "./popover.js";
import { parsePageRange, printPages } from "./print.js";
import { Thumbnails } from "./thumbs.js";
import { rotatePages, deletePages, reorderPages } from "./pageops.js";

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
  container: $("viewerContainer"),
  commentsBtn: $("commentsBtn"),
  commentCount: $("commentCount"),
  commentsPanel: $("commentsPanel"),
  closeComments: $("closeComments"),
  commentList: $("commentList"),
  rail: $("rail"),
  toolOptions: $("toolOptions"),
  pagesBtn: $("pagesBtn"),
  pagesPanel: $("pagesPanel"),
  thumbs: $("thumbs"),
  rotLeftBtn: $("rotLeftBtn"),
  rotRightBtn: $("rotRightBtn"),
  delPagesBtn: $("delPagesBtn"),
  insertPagesBtn: $("insertPagesBtn"),
  extractPagesBtn: $("extractPagesBtn"),
  insertInput: $("insertInput"),
};

const view = new PdfView(els.container);
const editor = new Editor({ view, optionsEl: els.toolOptions, railEl: els.rail });
const thumbs = new Thumbnails(els.thumbs);
const state = { doc: null, name: "", handle: null };
let openToken = 0;

const controls = [
  els.prevBtn, els.nextBtn, els.pageInput, els.zoomOutBtn, els.zoomInBtn,
  els.fitWidthBtn, els.findInput, els.findPrevBtn, els.findNextBtn, els.commentsBtn,
  els.saveAsBtn, els.printBtn, els.pagesBtn, els.insertPagesBtn, ...els.rail.querySelectorAll("[data-tool]"),
];
const selectionTools = [els.rotLeftBtn, els.rotRightBtn, els.delPagesBtn, els.extractPagesBtn];

function setControlsEnabled(enabled) {
  for (const el of controls) el.disabled = !enabled;
  if (!enabled) {
    els.saveBtn.disabled = true;
    els.undoBtn.disabled = true;
    els.redoBtn.disabled = true;
    for (const b of selectionTools) b.disabled = true;
  } else {
    syncEditState();
    syncPageTools();
  }
}

function syncPageTools() {
  const has = state.doc && thumbs.selection().length > 0;
  for (const b of selectionTools) b.disabled = !has;
}

function showMessage(text) {
  els.message.textContent = text;
}

let toastTimer = 0;
function toast(text, ms = 2600) {
  clearTimeout(toastTimer);
  els.toast.textContent = text;
  els.toast.hidden = false;
  if (ms) toastTimer = setTimeout(() => (els.toast.hidden = true), ms);
}

function syncEditState() {
  els.saveBtn.disabled = !state.doc || !editor.dirty;
  els.undoBtn.disabled = !editor.history.undo.length;
  els.redoBtn.disabled = !editor.history.redo.length;
  els.dirtyDot.hidden = !editor.dirty;
  if (state.name) document.title = `${editor.dirty ? "• " : ""}${state.name} · Lite PDF`;
}

// ------------------------------------------------------------------ opening

async function confirmDiscard() {
  if (!editor.dirty) return true;
  return askConfirm({
    title: "Discard unsaved changes?",
    message: `${state.name} has changes that have not been saved. Opening another file will lose them.`,
    okText: "Discard changes",
  });
}

async function openBytes(bytes, name, handle = null) {
  const token = ++openToken;
  setControlsEnabled(false);
  showMessage(`Opening ${name}…`);
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
          label: password === undefined ? "This PDF is password protected." : "That password is not correct. Try again.",
          type: "password",
          okText: "Open",
        });
        if (password === null) {
          if (token === openToken) showMessage(state.doc ? "" : "Open a PDF to start, or drag one into this window.");
          if (state.doc) setControlsEnabled(true);
          return;
        }
      }
    }
    if (token !== openToken) {
      closeDocument(doc);
      return;
    }
    const previous = state.doc;
    state.doc = doc;
    state.name = name;
    state.handle = handle;
    editor.attach(doc);
    await view.setDocument(doc);
    thumbs.setDocument(doc);
    if (previous) closeDocument(previous);

    els.docName.textContent = name;
    els.docName.title = name;
    els.pageCount.textContent = `of ${doc.pageCount}`;
    els.pageInput.max = doc.pageCount;
    els.pageInput.value = 1;
    els.findInput.value = "";
    els.findCount.textContent = "";
    showMessage("");
    setControlsEnabled(true);
    editor.setTool("select");
    els.container.focus({ preventScroll: true });
    loadComments(token);
  } catch (err) {
    if (token === openToken) {
      const unreadable = err.code === PdfErrorCode.WrongFormat || /LoadMemDocument|format/i.test(err.message);
      showMessage(unreadable ? `${name} is not a valid PDF, or it is damaged.` : `Could not open ${name}: ${err.message}`);
    }
  }
}

async function openFile(file, handle = null) {
  if (!(await confirmDiscard())) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openBytes(bytes, file.name, handle);
  } catch (err) {
    showMessage(`Could not read ${file.name}: ${err.message}`);
  }
}

async function chooseFile() {
  if (!(await confirmDiscard())) return;
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "PDF documents", accept: { "application/pdf": [".pdf"] } }],
      });
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      await openBytes(bytes, file.name, handle);
    } catch (err) {
      if (err?.name !== "AbortError") showMessage(`Could not open the file: ${err.message}`);
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

/** Saves the open document. "Save" writes back to the file it came from; "Save a copy" always asks where. */
async function saveDocument({ copy = false } = {}) {
  if (!state.doc) return;
  try {
    toast("Saving…", 0);
    const buffer = await call(engine().saveAsCopy(state.doc));
    const blob = new Blob([buffer], { type: "application/pdf" });
    let handle = copy ? null : state.handle;

    if (handle?.createWritable) {
      let granted = (await handle.queryPermission?.({ mode: "readwrite" })) === "granted";
      if (!granted) granted = (await handle.requestPermission?.({ mode: "readwrite" })) === "granted";
      if (!granted) handle = null;
    }
    if (handle?.createWritable) {
      await writeToHandle(handle, blob);
    } else if (window.showSaveFilePicker) {
      const picked = await window.showSaveFilePicker({ suggestedName: state.name || "document.pdf", types: PDF_TYPES });
      await writeToHandle(picked, blob);
      if (!copy) {
        state.handle = picked;
        state.name = picked.name;
        els.docName.textContent = picked.name;
        els.docName.title = picked.name;
      }
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = state.name || "document.pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    if (!copy) editor.markClean();
    toast(copy ? "Copy saved" : "Saved");
  } catch (err) {
    if (err?.name === "AbortError") {
      toast("", 1);
      els.toast.hidden = true;
      return;
    }
    toast(`Could not save: ${err.message}`, 6000);
  }
}

// ----------------------------------------------------------------- printing

async function printDocument() {
  if (!state.doc) return;
  const count = state.doc.pageCount;
  let indices = null;
  const answer = await askText({
    title: "Print",
    label: `Pages to print, for example 1-3, 5. Leave empty to print all ${count}.`,
    okText: "Print",
    validate: (v) => (parsePageRange(v, count) ? null : `Enter page numbers between 1 and ${count}.`),
  });
  if (answer === null) return;
  indices = parsePageRange(answer, count);
  try {
    await printPages(state.doc, indices, (n, total) => toast(`Preparing page ${n} of ${total}…`, 0));
    els.toast.hidden = true;
  } catch (err) {
    toast(`Could not print: ${err.message}`, 6000);
  }
}

// --------------------------------------------------------------- page changes

const MAX_SNAPSHOT = 120 * 1024 * 1024;

/** Replaces the open document with new file bytes, keeping the reader's zoom and place. */
async function reloadDocument(bytes, { keepHistory = true } = {}) {
  const token = ++openToken;
  const doc = await openDocument(new Uint8Array(bytes));
  const previous = state.doc;
  state.doc = doc;
  editor.attach(doc, { keepDirty: true, keepHistory });
  await view.setDocument(doc, { keepView: true });
  thumbs.setDocument(doc);
  if (previous) closeDocument(previous);
  els.pageCount.textContent = `of ${doc.pageCount}`;
  els.pageInput.max = doc.pageCount;
  editor.markDirty();
  syncPageTools();
  loadComments(token, { quiet: true });
}

/** Runs a change to the page list: snapshot, transform the bytes, reload, and record one undo step. */
async function applyPageChange(label, transform) {
  if (!state.doc) return null;
  if (state.doc.isEncrypted) {
    toast("Page changes are not available for password-protected files yet.", 6000);
    return null;
  }
  try {
    toast("Updating pages…", 0);
    const before = new Uint8Array(await call(engine().saveAsCopy(state.doc)));
    let after;
    try {
      after = await transform(before);
    } catch (err) {
      // A failed change must not leave the open document half changed.
      await reloadDocument(before);
      throw err;
    }
    await reloadDocument(after, { keepHistory: false });
    const big = before.byteLength > MAX_SNAPSHOT || after.byteLength > MAX_SNAPSHOT;
    editor.recordPageChange(label, big ? null : before, big ? null : after, (bytes) => reloadDocument(bytes));
    els.toast.hidden = true;
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

const base = () => state.name.replace(/\.pdf$/i, "");

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
thumbs.addEventListener("selection", syncPageTools);
thumbs.addEventListener("go", (e) => view.goToPage(e.detail.page + 1));
thumbs.addEventListener("delete", () => els.delPagesBtn.click());
view.addEventListener("page", (e) => thumbs.setCurrent(e.detail.page - 1));

els.rotLeftBtn.addEventListener("click", () => {
  const sel = thumbs.selection();
  applyPageChange("rotate pages", (bytes) => rotatePages(bytes, sel, -90)).then(() => thumbs.selectPages(sel));
});
els.rotRightBtn.addEventListener("click", () => {
  const sel = thumbs.selection();
  applyPageChange("rotate pages", (bytes) => rotatePages(bytes, sel, 90)).then(() => thumbs.selectPages(sel));
});
els.delPagesBtn.addEventListener("click", async () => {
  const sel = thumbs.selection();
  if (!sel.length) return;
  if (sel.length >= state.doc.pageCount) {
    toast("A document needs at least one page.", 4000);
    return;
  }
  await applyPageChange("delete pages", (bytes) => deletePages(bytes, sel));
});
thumbs.addEventListener("reorder", async (e) => {
  const { order, moved } = e.detail;
  const done = await applyPageChange("reorder pages", (bytes) => reorderPages(bytes, order));
  if (done) thumbs.selectPages(moved.map((old) => order.indexOf(old)).sort((a, b) => a - b));
});

els.insertPagesBtn.addEventListener("click", () => els.insertInput.click());
els.insertInput.addEventListener("change", async () => {
  const file = els.insertInput.files[0];
  els.insertInput.value = "";
  if (!file || !state.doc) return;
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
  const sel = thumbs.selection();
  const at = (sel.length ? sel[sel.length - 1] : view.pageNumber - 1) + 1;
  const done = await applyPageChange("insert pages", async () => {
    await call(engine().importPages(state.doc, other, indices, at));
    return new Uint8Array(await call(engine().saveAsCopy(state.doc)));
  });
  closeDocument(other);
  if (done) thumbs.selectPages(indices.map((_, k) => at + k));
});

els.extractPagesBtn.addEventListener("click", async () => {
  const sel = thumbs.selection();
  if (!sel.length || !state.doc) return;
  try {
    toast("Preparing pages…", 0);
    const buffer = await call(engine().extractPages(state.doc, sel));
    const name = sel.length === 1 ? `${base()}-page-${sel[0] + 1}.pdf` : `${base()}-pages.pdf`;
    await exportBlob(new Blob([buffer], { type: "application/pdf" }), name);
    toast(`Saved ${sel.length} page${sel.length === 1 ? "" : "s"} as a new file`);
  } catch (err) {
    if (err?.name === "AbortError") els.toast.hidden = true;
    else toast(`Could not save the pages: ${err.message}`, 6000);
  }
});

// ----------------------------------------------------------------- comments

let commentsTimer = 0;
function refreshComments() {
  clearTimeout(commentsTimer);
  commentsTimer = setTimeout(() => state.doc && loadComments(openToken, { quiet: true }), 150);
}

async function loadComments(token, { quiet = false } = {}) {
  if (!quiet) renderCommentsMessage("Reading comments…");
  try {
    const threads = await readComments(state.doc);
    if (token !== openToken) return;
    renderComments(threads);
  } catch (err) {
    if (token === openToken) {
      renderCommentsMessage(`Could not read comments: ${err.message}`);
      els.commentCount.textContent = "!";
    }
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

function commentNode(comment, isReply) {
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
    actionButton("Reply", () => openReplyBox(body, comment)),
    actionButton("Edit", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      openPopover({
        x: r.left - 200,
        y: r.bottom + 6,
        value: comment.text,
        submitText: "Save",
        onSubmit: (value) => {
          if (value.trim() && value !== comment.text) editor.editComment(comment, value).catch((err) => toast(`Could not edit: ${err.message}`, 5000));
        },
      });
    }),
    actionButton("Delete", async () => {
      const ok = await askConfirm({ title: "Delete this comment?", message: "The comment and any replies to it are removed from the document.", okText: "Delete" });
      if (ok) editor.deleteComment(comment).catch((err) => toast(`Could not delete: ${err.message}`, 5000));
    })
  );
  body.append(meta, text, actions);
  box.append(avatar, body);
  return box;
}

function openReplyBox(container, comment) {
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
      await editor.reply(comment, value);
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
function renderComments(threads) {
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
      view.goToPage(thread.page);
      if (thread.annotation?.rect) view.revealRect(thread.pageIndex, fromEngineRect(thread.annotation.rect));
    });
    card.append(pageButton, commentNode(thread, false));
    for (const reply of thread.replies) card.append(commentNode(reply, true));
    return card;
  });
  els.commentList.replaceChildren(...nodes);
}

function setCommentsOpen(open) {
  els.commentsPanel.hidden = !open;
  els.commentsBtn.setAttribute("aria-pressed", String(open));
  if (open) els.closeComments.focus();
}

// ------------------------------------------------------------ editor events

view.addEventListener("formchange", (e) => {
  editor.markDirty();
  thumbs.refreshPage(e.detail.page);
});
view.addEventListener("formerror", (e) => toast(`Could not fill in that field: ${e.detail.message}`, 5000));
editor.addEventListener("change", syncEditState);
editor.addEventListener("edited", (e) => {
  refreshComments();
  if (e.detail?.page !== undefined) thumbs.refreshPage(e.detail.page);
});
editor.addEventListener("error", (e) => toast(e.detail.message, 6000));
els.undoBtn.addEventListener("click", () => editor.undo());
els.redoBtn.addEventListener("click", () => editor.redo());
els.saveBtn.addEventListener("click", () => saveDocument());
els.saveAsBtn.addEventListener("click", () => saveDocument({ copy: true }));
els.printBtn.addEventListener("click", printDocument);

window.addEventListener("beforeunload", (e) => {
  if (!editor.dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

// ------------------------------------------------------------ view -> toolbar

view.addEventListener("page", (e) => {
  els.pageInput.value = e.detail.page;
});
view.addEventListener("zoom", () => {
  els.zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
});
view.addEventListener("ready", () => {
  els.zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
});
view.addEventListener("find", (e) => {
  const { total, index, query } = e.detail;
  if (!els.findInput.value) els.findCount.textContent = "";
  else if (total === 0) els.findCount.textContent = query !== undefined ? "No matches" : "";
  else els.findCount.textContent = index >= 0 ? `${index + 1} of ${total}` : `${total} matches`;
});

// ---------------------------------------------------------------- toolbar in

els.openBtn.addEventListener("click", chooseFile);
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files[0];
  els.fileInput.value = "";
  if (file) openFile(file);
});

const goToPage = (n) => state.doc && view.goToPage(Math.min(Math.max(1, n), state.doc.pageCount));
els.prevBtn.addEventListener("click", () => goToPage(view.pageNumber - 1));
els.nextBtn.addEventListener("click", () => goToPage(view.pageNumber + 1));
els.pageInput.addEventListener("change", () => goToPage(Number(els.pageInput.value)));

els.zoomInBtn.addEventListener("click", () => view.zoomBy(1.2));
els.zoomOutBtn.addEventListener("click", () => view.zoomBy(1 / 1.2));
els.fitWidthBtn.addEventListener("click", () => view.fitWidth());

let findTimer = 0;
const runFind = () => view.find(els.findInput.value).catch((err) => console.error("Search failed", err));
els.findInput.addEventListener("input", () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(runFind, 180);
});
els.findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(findTimer);
    if (view.hits.length && view.findQuery === els.findInput.value) view.findStep(e.shiftKey ? -1 : 1);
    else runFind();
  } else if (e.key === "Escape") {
    els.findInput.value = "";
    view.clearFind();
    els.findCount.textContent = "";
    els.container.focus({ preventScroll: true });
  }
});
els.findNextBtn.addEventListener("click", () => view.findStep(1));
els.findPrevBtn.addEventListener("click", () => view.findStep(-1));

els.commentsBtn.addEventListener("click", () => setCommentsOpen(els.commentsPanel.hidden));
els.closeComments.addEventListener("click", () => setCommentsOpen(false));

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (mod && key === "o") {
    e.preventDefault();
    chooseFile();
  } else if (mod && key === "s") {
    e.preventDefault();
    if (state.doc) saveDocument({ copy: e.shiftKey });
  } else if (mod && key === "p") {
    e.preventDefault();
    printDocument();
  } else if (mod && key === "f") {
    if (!els.findInput.disabled) {
      e.preventDefault();
      els.findInput.focus();
      els.findInput.select();
    }
  } else if (mod && key === "a" && !typing && state.doc) {
    e.preventDefault();
    view.selectAll();
  } else if (mod && (key === "=" || key === "+") && state.doc) {
    e.preventDefault();
    view.zoomBy(1.2);
  } else if (mod && key === "-" && state.doc) {
    e.preventDefault();
    view.zoomBy(1 / 1.2);
  } else if (mod && key === "0" && state.doc) {
    e.preventDefault();
    view.fitWidth();
  } else if (key === "escape" && !typing) {
    view.clearSelection();
  }
});

// Drag and drop onto the window.
let dragDepth = 0;
const isPdf = (file) => file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name));
window.addEventListener("dragenter", (e) => {
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
  const item = e.dataTransfer.items?.[0];
  const file = e.dataTransfer.files[0];
  if (!isPdf(file)) {
    toast("That file is not a PDF.");
    return;
  }
  let handle = null;
  try {
    handle = (await item?.getAsFileSystemHandle?.()) ?? null;
  } catch {
    handle = null;
  }
  openFile(file, handle);
});

// Set when Windows opens a PDF with this installed app (file_handlers in the manifest).
if ("launchQueue" in window) {
  launchQueue.setConsumer(async (params) => {
    const handle = params.files?.[0];
    if (!handle) return;
    openFile(await handle.getFile(), handle);
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Start the engine now so the first file opens quickly.
engine();
setControlsEnabled(false);
showMessage("Open a PDF to start, or drag one into this window.");

// For tests and debugging.
window.__lite = { view, state, editor };
