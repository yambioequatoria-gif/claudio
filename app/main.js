import { engine, call, openDocument, closeDocument, PdfErrorCode, fromEngineRect } from "./engine.js";
import { PdfView } from "./viewer.js";
import { readComments } from "./comments.js";
import { askText } from "./dialog.js";

const $ = (id) => document.getElementById(id);
const els = {
  openBtn: $("openBtn"),
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
  message: $("message"),
  dropHint: $("dropHint"),
  container: $("viewerContainer"),
  commentsBtn: $("commentsBtn"),
  commentCount: $("commentCount"),
  commentsPanel: $("commentsPanel"),
  closeComments: $("closeComments"),
  commentList: $("commentList"),
};

const view = new PdfView(els.container);
const state = { doc: null, name: "", handle: null };
let openToken = 0;

const controls = [
  els.prevBtn, els.nextBtn, els.pageInput, els.zoomOutBtn, els.zoomInBtn,
  els.fitWidthBtn, els.findInput, els.findPrevBtn, els.findNextBtn, els.commentsBtn,
];

function setControlsEnabled(enabled) {
  for (const el of controls) el.disabled = !enabled;
}

function showMessage(text) {
  els.message.textContent = text;
}

// ------------------------------------------------------------------ opening

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
    await view.setDocument(doc);
    if (previous) closeDocument(previous);

    els.docName.textContent = name;
    els.docName.title = name;
    document.title = `${name} · Lite PDF`;
    els.pageCount.textContent = `of ${doc.pageCount}`;
    els.pageInput.max = doc.pageCount;
    els.pageInput.value = 1;
    els.findInput.value = "";
    els.findCount.textContent = "";
    showMessage("");
    setControlsEnabled(true);
    els.container.focus({ preventScroll: true });
    loadComments(token);
  } catch (err) {
    if (token === openToken) showMessage(`Could not open ${name}: ${err.message}`);
  }
}

async function openFile(file, handle = null) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openBytes(bytes, file.name, handle);
  } catch (err) {
    showMessage(`Could not read ${file.name}: ${err.message}`);
  }
}

async function chooseFile() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "PDF documents", accept: { "application/pdf": [".pdf"] } }],
      });
      await openFile(await handle.getFile(), handle);
    } catch (err) {
      if (err?.name !== "AbortError") showMessage(`Could not open the file: ${err.message}`);
    }
    return;
  }
  els.fileInput.click();
}

// ----------------------------------------------------------------- comments

async function loadComments(token) {
  renderCommentsMessage("Reading comments…");
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
  body.append(meta, el("p", "text", comment.text));
  box.append(avatar, body);
  return box;
}

// Comment text comes from the PDF file, so it is always inserted as text, never as HTML.
function renderComments(threads) {
  const total = threads.reduce((sum, t) => sum + 1 + t.replies.length, 0);
  els.commentCount.textContent = String(total);
  if (threads.length === 0) {
    renderCommentsMessage("No comments in this document.");
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
    showMessage("That file is not a PDF.");
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
showMessage("Open a PDF to start, or drag one into this window.");

// For tests and debugging.
window.__lite = { view, state };
