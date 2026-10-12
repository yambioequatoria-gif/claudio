// Thin wrapper around the PDFium engine (see vendor/embedpdf/README.md).
// Everything the viewer knows about a page, a glyph, a link or an annotation comes from here.
import {
  createPdfiumEngine,
  PdfErrorCode,
  PdfAnnotationSubtype,
  MatchFlag,
  PdfStandardFont,
  PdfTextAlignment,
  PdfVerticalAlignment,
  PdfAnnotationBorderStyle,
  PdfAnnotationReplyType,
  PdfBlendMode,
  PdfAnnotationIcon,
  PdfAnnotationLineEnding,
} from "./vendor/embedpdf/embedpdf.js";

export {
  PdfErrorCode,
  PdfAnnotationSubtype,
  MatchFlag,
  PdfStandardFont,
  PdfTextAlignment,
  PdfVerticalAlignment,
  PdfAnnotationBorderStyle,
  PdfAnnotationReplyType,
  PdfBlendMode,
  PdfAnnotationIcon,
  PdfAnnotationLineEnding,
};

let instance = null;

export function engine() {
  if (!instance) {
    // fontFallback: null keeps the engine from requesting fallback fonts from the network.
    instance = createPdfiumEngine(new URL("./vendor/embedpdf/pdfium.wasm", import.meta.url).href, {
      fontFallback: null,
    });
  }
  return instance;
}

/** Awaits an engine task and turns its rejection into a normal Error with a `code`. */
export async function call(task) {
  try {
    return await task.toPromise();
  } catch (failure) {
    const reason = failure?.reason ?? failure;
    const error = new Error(reason?.message || "The PDF engine reported an error.");
    error.code = reason?.code;
    throw error;
  }
}

let docCounter = 0;

/** Opens PDF bytes. Throws an Error with code === PdfErrorCode.Password when a password is needed. */
export async function openDocument(bytes, password) {
  const id = `doc-${++docCounter}`;
  const content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return call(engine().openDocumentBuffer({ id, content }, password ? { password } : undefined));
}

export async function closeDocument(doc) {
  try {
    await call(engine().closeDocument(doc));
  } catch {
    // Closing is best effort; the engine frees everything when the page is closed anyway.
  }
}

// The engine describes rectangles as { origin: {x, y}, size: {width, height} }; the viewer uses { x, y, w, h }.
export const fromEngineRect = (r) => ({ x: r.origin.x, y: r.origin.y, w: r.size.width, h: r.size.height });
export const toEngineRect = (r) => ({ origin: { x: r.x, y: r.y }, size: { width: r.w, height: r.h } });
