// Reads comments from PDF annotations (sticky notes, highlights, text boxes and their replies),
// including files made by Acrobat, Foxit, Preview and other PDF apps.
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFRef, PDFHexString, PDFString } from "./vendor/pdf-lib/pdf-lib.esm.min.js";

const name = (text) => PDFName.of(text);

function textOf(value) {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return "";
}

// PDF dates look like D:20260131101500+01'00'. The time zone is ignored, which is fine for display.
function dateOf(value) {
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(textOf(value));
  if (!match) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00"] = match;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

// Returns threads: each root comment with its replies, ordered by page and date.
export async function readComments(bytes) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = pdf.context;

  const records = [];
  pdf.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const item = annots.get(i);
      const dict = ctx.lookup(item, PDFDict);
      if (!dict) continue;
      const subtype = dict.lookup(name("Subtype"))?.toString();
      if (subtype === "/Popup") continue;
      records.push({
        key: item instanceof PDFRef ? item.toString() : null,
        dict,
        page: index + 1,
        subtype: subtype ? subtype.slice(1) : "Annotation",
      });
    }
  });

  const commentText = (dict) => {
    const own = textOf(dict.lookup(name("Contents")));
    if (own) return own;
    // Some apps keep the text only on the popup that belongs to the note.
    const popup = ctx.lookup(dict.get(name("Popup")), PDFDict);
    return popup ? textOf(popup.lookup(name("Contents"))) : "";
  };

  const roots = [];
  const repliesByParent = new Map();
  for (const rec of records) {
    const text = commentText(rec.dict);
    if (!text) continue;
    const comment = {
      key: rec.key,
      page: rec.page,
      subtype: rec.subtype,
      author: textOf(rec.dict.lookup(name("T"))),
      date: dateOf(rec.dict.lookup(name("M"))) || dateOf(rec.dict.lookup(name("CreationDate"))),
      text,
    };
    const parent = rec.dict.get(name("IRT"));
    if (parent instanceof PDFRef) {
      const list = repliesByParent.get(parent.toString()) || [];
      list.push(comment);
      repliesByParent.set(parent.toString(), list);
    } else {
      roots.push(comment);
    }
  }

  // Collect replies (and replies to replies) under each root. Orphaned replies become roots.
  const attach = (comment, out) => {
    const children = comment.key ? repliesByParent.get(comment.key) || [] : [];
    for (const child of children) {
      out.push(child);
      attach(child, out);
    }
    return out;
  };
  const threads = roots.map((root) => ({ ...root, replies: attach(root, []).sort(byDate) }));
  for (const [parentKey, list] of repliesByParent) {
    const parentExists = records.some((r) => r.key === parentKey);
    if (!parentExists) {
      for (const orphan of list) threads.push({ ...orphan, replies: [] });
    }
  }
  return threads.sort((a, b) => a.page - b.page || byDate(a, b));
}

function byDate(a, b) {
  return (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0);
}
