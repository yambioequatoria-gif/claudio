PDFium (Google, via EmbedPDF) compiled to WebAssembly, with the EmbedPDF engine layer.

Built from npm packages @embedpdf/engines@2.15.1, @embedpdf/pdfium@2.15.1 and @embedpdf/models@2.15.1
(all MIT; PDFium itself is BSD-3 / Apache-2.0, see LICENSE.pdfium). The JavaScript is one esbuild bundle
(`embedpdf.js`) of those packages, minified, with no changes to their code. `pdfium.wasm` is copied unchanged.
