// Changes to the page list of a PDF: rotate, delete, reorder. Each takes the file's bytes and returns new bytes,
// leaving every other object (annotations, links, forms) untouched.
import { PDFDocument, degrees } from "./vendor/pdf-lib/pdf-lib.esm.min.js";

const load = (bytes) => PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });

export async function rotatePages(bytes, indices, delta) {
  const pdf = await load(bytes);
  for (const i of indices) {
    const page = pdf.getPage(i);
    const next = (((page.getRotation().angle + delta) % 360) + 360) % 360;
    page.setRotation(degrees(next));
  }
  return pdf.save();
}

export async function deletePages(bytes, indices) {
  const pdf = await load(bytes);
  if (indices.length >= pdf.getPageCount()) throw new Error("A document needs at least one page.");
  for (const i of [...indices].sort((a, b) => b - a)) pdf.removePage(i);
  return pdf.save();
}

/** `order` lists the old page indices in their new order. */
export async function reorderPages(bytes, order) {
  const pdf = await load(bytes);
  const pages = pdf.getPages();
  if (order.length !== pages.length) throw new Error("The new page order does not match the document.");
  for (let i = pages.length - 1; i >= 0; i--) pdf.removePage(i);
  order.forEach((oldIndex, k) => pdf.insertPage(k, pages[oldIndex]));
  return pdf.save();
}
