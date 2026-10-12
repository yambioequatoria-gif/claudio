// Builds comment threads from the file's annotations: sticky notes, highlight and text-box comments, and replies.
import { engine, call, PdfAnnotationSubtype } from "./engine.js";

// Links, form fields and popups are not comments, even when they carry text.
const NOT_COMMENTS = new Set([PdfAnnotationSubtype.LINK, PdfAnnotationSubtype.WIDGET, PdfAnnotationSubtype.POPUP]);

const toDate = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const byDate = (a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0);

/** Returns threads: each root comment with its replies, ordered by page and date. */
export async function readComments(doc) {
  const perPage = await call(engine().getAllAnnotations(doc));
  const comments = [];
  for (const [pageIndex, annots] of Object.entries(perPage)) {
    for (const a of annots) {
      if (NOT_COMMENTS.has(a.type)) continue;
      const text = (a.contents ?? "").trim();
      if (!text) continue;
      comments.push({
        id: a.id,
        pageIndex: Number(pageIndex),
        page: Number(pageIndex) + 1,
        type: a.type,
        author: a.author ?? "",
        date: toDate(a.modified) ?? toDate(a.created),
        text,
        parent: a.inReplyToId || null,
        annotation: a,
      });
    }
  }
  const byId = new Map(comments.map((c) => [c.id, c]));
  const roots = [];
  const children = new Map();
  for (const c of comments) {
    if (c.parent && byId.has(c.parent)) {
      if (!children.has(c.parent)) children.set(c.parent, []);
      children.get(c.parent).push(c);
    } else {
      roots.push(c);
    }
  }
  const collect = (c, out) => {
    for (const child of children.get(c.id) ?? []) {
      out.push(child);
      collect(child, out);
    }
    return out;
  };
  return roots
    .map((root) => ({ ...root, replies: collect(root, []).sort(byDate) }))
    .sort((a, b) => a.page - b.page || byDate(a, b));
}
