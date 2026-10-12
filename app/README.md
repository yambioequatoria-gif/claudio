# Lite PDF

A local PDF viewer and editor for everyday work: read, search, select and copy text, follow links, add comments and markup, change pages, save and print. A replacement for Acrobat for those jobs.

Files are opened and edited in the browser on your computer. They are not uploaded anywhere.

## Set up (Windows, once)

1. Double-click `setup.bat`. It starts the app's local server in the background and makes it start again at every sign-in. No admin rights are needed. It only has to be run once.
2. In Edge, open http://localhost:8080 and install the app: the app icon in the address bar, or the menu, then Apps, then Install this site as an app.
3. Right-click a PDF, choose Open with, and pick Lite PDF. To make it the default, use Settings, Apps, Default apps.

After that, clicking a PDF just opens it. You don't need to run anything else.

To update, pull the latest version in GitHub Desktop and press Ctrl+R in the app. The server reads files from disk, so nothing needs restarting. If a new version doesn't appear, close and reopen the app window.

To check the server is running, open http://localhost:8080 in Edge. To run it in a visible window for troubleshooting, double-click `run.bat`. Server errors are written to `%LOCALAPPDATA%\LitePDF\server.log`.

## What it does

Reading: smooth scrolling and zoom (Ctrl+wheel, Ctrl and plus or minus, Ctrl+0 for fit width), page navigation, search, text selection by drag, double-click (word), triple-click (line) and Ctrl+A, copy, and clickable links. Plain-text web and email addresses are linked as well. Large files stay responsive because only pages near the screen are drawn.

Comments: the Comments panel lists every comment in the file, including sticky notes, highlight and text-box comments and their threaded replies, from any PDF app. You can reply, edit and delete from the panel.

Editing: the rail on the left has Select, Highlight, Underline, Strike through, Comment, Add text, Draw, Rectangle, Cover and Redact. Single-key shortcuts: V, H, U, S, N, T, D, R. Select an annotation to move it, double-click to edit its text, press Delete to remove it. Undo and redo are Ctrl+Z and Ctrl+Y.

Cover hides what is under it but leaves the content in the file. Redact deletes the text under the box from the file and draws a black box; it cannot be undone.

Pages: the Pages panel shows thumbnails. Select pages (click, Shift-click, Ctrl-click) to rotate, delete or extract them as a new file, drag them to reorder, or insert pages from another PDF. Page changes are undoable.

Saving: Ctrl+S saves back to the file it was opened from (Edge asks for permission the first time). Ctrl+Shift+S saves a copy. Ctrl+P prints, with an optional page range.

Forms: text fields, checkboxes, radio buttons and dropdowns can be filled in; the value is written into the file when you leave the field.

Not done yet: digital signatures, and page changes on password-protected files. Opening a password-protected file works.

## How it is built

No build step and no network access at run time. `index.html`, `app.css` and the `.js` files next to it are the app:

`engine.js` wraps the PDF engine. `viewer.js` lays out and renders pages and handles selection, links and search. `pagedata.js` holds the text geometry: lines of glyph boxes, hit-testing, selection rectangles, auto-detected links, and the correction that snaps a link's area to the text it covers. `editor.js` has the editing tools and undo. `comments.js` builds comment threads. `thumbs.js` and `pageops.js` are the Pages panel and page changes. `forms.js` puts controls over form fields. `print.js` renders pages for printing. `main.js` wires it together.

`sw.js` lets the app load offline once opened. `manifest.webmanifest` declares PDF file handling. `serve.ps1` is the local server, `setup.ps1` registers it at sign-in, and the `.bat` files are double-click wrappers.

`vendor/embedpdf/` is PDFium, the engine used by Chrome and Edge, compiled to WebAssembly by the EmbedPDF project (MIT; PDFium is BSD-3 and Apache-2.0, see the licence files there). `vendor/pdf-lib/` is pdf-lib 1.17.1 (MIT), used for rotating, deleting and reordering pages.

## Why not pdf.js

An earlier version used pdf.js. It places selection and link boxes from a substitute browser font, so inside a line they drift from the real glyphs. PDFium reports the exact box of every glyph, and selection, search highlights and links are now drawn from those, which is why they line up at every zoom level.

## Status

Tested in headless Chromium against five real PDFs and synthetic ones (rotated pages, embedded fonts, 400 pages): rendering, selection, links, search, comments, every editing tool, form filling, passwords, save and reopen, print rendering, and page changes. Alignment was measured on every page: rendered text sits within about one pixel of the engine's text boxes.

Not yet tested on Windows or in Edge: `setup.bat`, installing the app, opening a PDF from Explorer, saving in place through Edge's file permission, and the real print dialog.
