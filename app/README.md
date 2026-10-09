# Lite PDF

A local PDF viewer, built to replace Adobe Acrobat for everyday reading. Editing (text boxes, highlights, page delete, rotate, merge, split) comes next.

Files are opened and rendered in the browser on your computer. They are not uploaded anywhere.

## Run it (Windows)

1. Double-click `run.bat` and leave the window open. It serves the app on http://localhost:8080 and only this computer can reach it.
2. In Edge, open http://localhost:8080 and install the app: the app icon in the address bar (or the menu, then Apps, then Install this site as an app).
3. Right-click a PDF, choose Open with, and pick Lite PDF. To make it the default, use Settings, Apps, Default apps.

The installed app loads from localhost, so `run.bat` must be running when you open a PDF. Opening a PDF without it running shows an error page.

## Use

Open with Ctrl+O, the Open button, or drag a PDF into the window. Page navigation is in the toolbar. Zoom with + and −, or Fit width. Find with Ctrl+F; Enter goes to the next match, Shift+Enter to the previous.

Large files stay responsive because only pages near the screen are drawn.

## Layout

`index.html`, `app.js`, `app.css` are the app. `polyfills.js` patches a method older browsers lack. `sw.js` lets the app load offline once it has been opened. `manifest.webmanifest` declares PDF file handling. `vendor/pdfjs/` is pdf.js 6.3.289, Apache-2.0 licensed (see `vendor/pdfjs/LICENSE`), copied in so nothing is loaded from a CDN.

## Status

Tested in headless Chromium: opening a 20-page and a 400-page PDF, page jumps, zoom, find, and a file-replace. Not yet tested on Windows or in Edge: `run.bat`, installing the app, opening a PDF from Explorer, and password-protected PDFs.
