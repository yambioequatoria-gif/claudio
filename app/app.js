import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
import * as pdfjsViewer from "./vendor/pdfjs/pdf_viewer.mjs";
import { readComments } from "./comments.js";

const VENDOR = new URL("./vendor/pdfjs/", import.meta.url).href;

pdfjsLib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.mjs`;

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
  viewer: $("viewer"),
  commentsBtn: $("commentsBtn"),
  commentCount: $("commentCount"),
  commentsPanel: $("commentsPanel"),
  closeComments: $("closeComments"),
  commentList: $("commentList"),
};

const eventBus = new pdfjsViewer.EventBus();
const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
const findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
const pdfViewer = new pdfjsViewer.PDFViewer({
  container: els.container,
  viewer: els.viewer,
  eventBus,
  linkService,
  findController,
  imageResourcesPath: `${VENDOR}images/`,
});
linkService.setViewer(pdfViewer);

let currentDoc = null;
let currentTask = null;
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

function updateZoomLabel() {
  els.zoomLabel.textContent = `${Math.round(pdfViewer.currentScale * 100)}%`;
}

function askPassword(task, updatePassword, reason) {
  const incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
  const password = window.prompt(
    incorrect ? "Incorrect password. Try again:" : "This PDF is password protected. Password:"
  );
  if (password === null) {
    task.destroy();
  } else {
    updatePassword(password);
  }
}

async function openFile(file) {
  const token = ++openToken;
  setControlsEnabled(false);
  showMessage(`Opening ${file.name}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (token !== openToken) return;

    // pdf.js takes ownership of the buffer it is given, so the comment reader gets its own copy.
    const task = pdfjsLib.getDocument({
      data: bytes.slice(),
      isEvalSupported: false,
      cMapUrl: `${VENDOR}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${VENDOR}standard_fonts/`,
      wasmUrl: `${VENDOR}wasm/`,
    });
    task.onPassword = (updatePassword, reason) => askPassword(task, updatePassword, reason);
    const doc = await task.promise;
    if (token !== openToken) {
      task.destroy();
      return;
    }

    const previousTask = currentTask;
    currentTask = task;
    currentDoc = doc;
    pdfViewer.setDocument(doc);
    linkService.setDocument(doc, null);
    previousTask?.destroy();

    els.docName.textContent = file.name;
    els.docName.title = file.name;
    document.title = `${file.name} · Lite PDF`;
    els.pageCount.textContent = `of ${doc.numPages}`;
    els.pageInput.max = doc.numPages;
    showMessage("");
    setControlsEnabled(true);
    els.findInput.value = "";
    els.findCount.textContent = "";
    els.container.focus();

    loadComments(bytes, token);
  } catch (err) {
    if (token === openToken) {
      showMessage(`Could not open ${file.name}: ${err.message}`);
    }
  }
}

// Comments are read separately from rendering, so a large file still shows up quickly.
async function loadComments(bytes, token) {
  renderCommentsMessage("Reading comments…");
  try {
    const threads = await readComments(bytes);
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

function formatDate(date) {
  return date ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

function renderCommentsMessage(text) {
  els.commentList.replaceChildren(el("p", "empty", text));
  els.commentCount.textContent = "0";
}

function commentNode(comment, isReply) {
  const box = el("div", isReply ? "comment reply" : "comment");
  const meta = el("div", "meta");
  meta.append(el("strong", null, comment.author || "Unknown author"));
  const when = formatDate(comment.date);
  if (when) meta.append(` · ${when}`);
  box.append(meta, el("p", "text", comment.text));
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
    pageButton.addEventListener("click", () => goToPage(thread.page));
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

// Page and zoom events from the viewer keep the toolbar in sync.
eventBus.on("pagesinit", () => {
  pdfViewer.currentScaleValue = "page-width";
  updateZoomLabel();
});
eventBus.on("pagechanging", ({ pageNumber }) => {
  els.pageInput.value = pageNumber;
});
eventBus.on("scalechanging", updateZoomLabel);
eventBus.on("updatefindmatchescount", ({ matchesCount }) => {
  if (!els.findInput.value) {
    els.findCount.textContent = "";
  } else {
    els.findCount.textContent = `${matchesCount.current} of ${matchesCount.total}`;
  }
});
eventBus.on("updatefindcontrolstate", ({ state }) => {
  if (!els.findInput.value) {
    els.findCount.textContent = "";
  } else if (state === pdfjsViewer.FindState.NOT_FOUND) {
    els.findCount.textContent = "No matches";
  }
});

function goToPage(n) {
  if (!currentDoc) return;
  pdfViewer.currentPageNumber = Math.min(Math.max(1, n), currentDoc.numPages);
}

function dispatchFind(type, findPrevious = false) {
  eventBus.dispatch("find", {
    source: window,
    type,
    query: els.findInput.value,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  });
}

els.openBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files[0];
  els.fileInput.value = "";
  if (file) openFile(file);
});

els.prevBtn.addEventListener("click", () => goToPage(pdfViewer.currentPageNumber - 1));
els.nextBtn.addEventListener("click", () => goToPage(pdfViewer.currentPageNumber + 1));
els.pageInput.addEventListener("change", () => goToPage(Number(els.pageInput.value)));

els.zoomInBtn.addEventListener("click", () => {
  pdfViewer.currentScale = pdfViewer.currentScale * 1.25;
});
els.zoomOutBtn.addEventListener("click", () => {
  pdfViewer.currentScale = pdfViewer.currentScale / 1.25;
});
els.fitWidthBtn.addEventListener("click", () => {
  pdfViewer.currentScaleValue = "page-width";
});

els.findInput.addEventListener("input", () => dispatchFind(""));
els.findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    dispatchFind("again", e.shiftKey);
  }
});
els.findNextBtn.addEventListener("click", () => dispatchFind("again", false));
els.findPrevBtn.addEventListener("click", () => dispatchFind("again", true));

els.commentsBtn.addEventListener("click", () => setCommentsOpen(els.commentsPanel.hidden));
els.closeComments.addEventListener("click", () => setCommentsOpen(false));

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    els.fileInput.click();
  } else if (mod && e.key.toLowerCase() === "f") {
    if (!els.findInput.disabled) {
      e.preventDefault();
      els.findInput.focus();
      els.findInput.select();
    }
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
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropHint.hidden = true;
  const file = e.dataTransfer.files[0];
  if (isPdf(file)) {
    openFile(file);
  } else {
    showMessage("That file is not a PDF.");
  }
});

// Set when Windows opens a PDF with this installed app (file_handlers in the manifest).
if ("launchQueue" in window) {
  launchQueue.setConsumer(async (params) => {
    const handle = params.files?.[0];
    if (!handle) return;
    openFile(await handle.getFile());
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

showMessage("Open a PDF to start, or drag one into this window.");
