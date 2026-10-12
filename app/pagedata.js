// Page geometry model: glyph boxes grouped into lines, plus hit-testing, selection rectangles,
// auto-detected links and link-area correction. Pure functions, no DOM, so they can be tested alone.
// All coordinates are PDF points with the origin at the top-left of the displayed page.

const FLAG_SPACE = 1;
const FLAG_EMPTY = 2;

/**
 * @param geometry result of engine.getPageGeometry: { runs: [{ rect, charStart, glyphs: [{x,y,width,height,flags}] }] }
 * @param text     the page text; glyph i of the page belongs to text[i]
 */
export function buildPageData(geometry, text) {
  const n = text.length;
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  const gw = new Float32Array(n);
  const gh = new Float32Array(n);
  const flags = new Uint8Array(n);
  const lines = [];
  let current = null;

  for (const run of geometry.runs) {
    const r = run.rect;
    if (run.glyphs.length === 0) continue;
    const first = run.charStart;
    const last = run.charStart + run.glyphs.length - 1;
    const overlapY = current ? Math.min(current.bottom, r.y + r.height) - Math.max(current.top, r.y) : 0;
    const minH = current ? Math.min(current.bottom - current.top, r.height) : 0;
    const continues = current && overlapY >= 0.5 * minH && r.x >= current.right - r.height * 0.5 && first === current.last + 1;
    if (continues) {
      current.top = Math.min(current.top, r.y);
      current.bottom = Math.max(current.bottom, r.y + r.height);
      current.right = Math.max(current.right, r.x + r.width);
      current.last = last;
    } else {
      current = { top: r.y, bottom: r.y + r.height, left: r.x, right: r.x + r.width, first, last };
      lines.push(current);
    }
    for (let k = 0; k < run.glyphs.length; k++) {
      const i = first + k;
      if (i >= n) break;
      const g = run.glyphs[k];
      gx[i] = g.x;
      gy[i] = g.y;
      gw[i] = g.width;
      gh[i] = g.height;
      flags[i] = g.flags;
    }
  }
  return { text, n, gx, gy, gw, gh, flags, lines };
}

const visible = (pd, i) => !(pd.flags[i] & FLAG_EMPTY) && pd.gw[i] > 0.01;

/**
 * Finds the caret position (0..n, the gap before character i) nearest to a point.
 * With clamp=false it returns -1 unless the point is on a line of text; with clamp=true it always
 * returns the nearest position, which is what dragging a selection into empty space needs.
 */
export function caretAt(pd, px, py, clamp) {
  let best = -1;
  let bestScore = Infinity;
  for (let li = 0; li < pd.lines.length; li++) {
    const L = pd.lines[li];
    const slack = (L.bottom - L.top) * 0.2;
    const dy = py < L.top - slack ? L.top - slack - py : py > L.bottom + slack ? py - (L.bottom + slack) : 0;
    const dx = px < L.left ? L.left - px : px > L.right ? px - L.right : 0;
    if (!clamp && (dy > 0 || dx > 3)) continue;
    const score = dy * 4 + dx;
    if (score < bestScore) {
      bestScore = score;
      best = li;
    }
  }
  if (best < 0) return -1;
  const L = pd.lines[best];
  let lastVisible = -1;
  for (let i = L.first; i <= L.last; i++) {
    if (!visible(pd, i)) continue;
    lastVisible = i;
    if (px < pd.gx[i] + pd.gw[i] / 2) return i;
  }
  return lastVisible >= 0 ? lastVisible + 1 : L.first;
}

/** Character index under a point, or -1. Used for double-click and for the text cursor. */
export function charAt(pd, px, py) {
  for (const L of pd.lines) {
    const slack = (L.bottom - L.top) * 0.1;
    if (py < L.top - slack || py > L.bottom + slack || px < L.left || px > L.right) continue;
    for (let i = L.first; i <= L.last; i++) {
      if (visible(pd, i) && px >= pd.gx[i] && px <= pd.gx[i] + pd.gw[i]) return i;
    }
  }
  return -1;
}

const isWordChar = (ch) => /[\p{L}\p{N}_]/u.test(ch);

/** Range [lo, hi) of the word around character i (double-click). */
export function wordRange(pd, i) {
  const ch = pd.text[i];
  if (ch === undefined) return [i, i];
  const same = isWordChar(ch) ? isWordChar : (c) => !isWordChar(c) && !/\s/.test(c);
  if (/\s/.test(ch)) return [i, i + 1];
  let lo = i;
  let hi = i + 1;
  while (lo > 0 && same(pd.text[lo - 1])) lo--;
  while (hi < pd.n && same(pd.text[hi])) hi++;
  return [lo, hi];
}

/** Range [lo, hi) of the whole line containing character i (triple-click). */
export function lineRange(pd, i) {
  for (const L of pd.lines) {
    if (i >= L.first && i <= L.last) {
      let hi = L.last + 1;
      while (hi > L.first && !visible(pd, hi - 1)) hi--;
      return [L.first, Math.max(hi, L.first)];
    }
  }
  return [i, i];
}

/** One rectangle per line for the characters in [lo, hi). */
export function rangeRects(pd, lo, hi) {
  const rects = [];
  for (const L of pd.lines) {
    const a = Math.max(lo, L.first);
    const b = Math.min(hi - 1, L.last);
    if (a > b) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = a; i <= b; i++) {
      if (!visible(pd, i)) continue;
      x0 = Math.min(x0, pd.gx[i]);
      x1 = Math.max(x1, pd.gx[i] + pd.gw[i]);
      y0 = Math.min(y0, pd.gy[i]);
      y1 = Math.max(y1, pd.gy[i] + pd.gh[i]);
    }
    if (x1 > x0) rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return rects;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+|\b[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gi;

/** Plain-text web and email addresses that the file does not mark up as links. */
export function findAutolinks(pd) {
  const found = [];
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(pd.text))) {
    let end = m.index + m[0].length;
    // Sentence punctuation and unbalanced closing brackets are not part of the address.
    while (end > m.index && /[.,;:!?)\]}'"]/.test(pd.text[end - 1])) {
      if (/[)\]}]/.test(pd.text[end - 1])) {
        const body = pd.text.slice(m.index, end);
        const open = { ")": "(", "]": "[", "}": "{" }[pd.text[end - 1]];
        if (body.split(open).length >= body.split(pd.text[end - 1]).length) break;
      }
      end--;
    }
    const raw = pd.text.slice(m.index, end);
    if (raw.length < 4) continue;
    let url = raw;
    if (/^www\./i.test(raw)) url = `http://${raw}`;
    else if (!/^https?:\/\//i.test(raw)) url = `mailto:${raw}`;
    found.push({ url, lo: m.index, hi: end, rects: rangeRects(pd, m.index, end) });
  }
  return found;
}

const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);
export function overlapFraction(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1e-6, Math.min(area(a), area(b)));
}

/**
 * Link areas in real files are often a little off the text they belong to: shifted down by half a line, too
 * narrow, or sitting in the white space under the line. Viewers that trust the file highlight and
 * open the link from that empty space. This returns the area of the text the link covers instead:
 * one rectangle per line, whole words. Rectangles that do not look like text links (images, buttons,
 * anything much taller than a line) are returned unchanged.
 */
export function snapLinkRect(pd, r) {
  const candidates = [];
  let maxLineH = 0;
  for (const L of pd.lines) {
    const lh = L.bottom - L.top;
    if (lh <= 0) continue;
    const overlapX = Math.min(r.x + r.w, L.right) - Math.max(r.x, L.left);
    if (overlapX <= 0) continue;
    const overlapY = Math.min(r.y + r.h, L.bottom) - Math.max(r.y, L.top);
    if (overlapY > 0.3 * Math.min(r.h, lh)) {
      candidates.push(L);
      maxLineH = Math.max(maxLineH, lh);
    }
  }
  if (candidates.length === 0) {
    // The area may sit in the white space just above or below its text: take the nearest line, if it is close.
    let nearest = null;
    let nearestDist = Infinity;
    const cy = r.y + r.h / 2;
    for (const L of pd.lines) {
      const lh = L.bottom - L.top;
      const overlapX = Math.min(r.x + r.w, L.right) - Math.max(r.x, L.left);
      if (lh <= 0 || overlapX < 0.3 * Math.min(r.w, L.right - L.left)) continue;
      const dist = Math.abs(cy - (L.top + L.bottom) / 2);
      if (dist < nearestDist && dist <= lh * 1.1 + r.h / 2) {
        nearest = L;
        nearestDist = dist;
      }
    }
    if (!nearest) return [r];
    candidates.push(nearest);
    maxLineH = nearest.bottom - nearest.top;
  }
  if (r.h > 2.2 * maxLineH * candidates.length) return [r];

  const out = [];
  for (const L of candidates) {
    let a = -1;
    let b = -1;
    for (let i = L.first; i <= L.last; i++) {
      if (!visible(pd, i)) continue;
      const cx = pd.gx[i] + pd.gw[i] / 2;
      if (cx >= r.x - 0.5 && cx <= r.x + r.w + 0.5) {
        if (a < 0) a = i;
        b = i;
      }
    }
    if (a < 0) continue;
    // A link that starts or ends inside a word covers the whole word. Words end at spaces and at visible
    // gaps, because many files position words separately without a space character between them.
    while (a > L.first && !wordBreakBefore(pd, L, a)) a--;
    while (b < L.last && !wordBreakBefore(pd, L, b + 1)) b++;
    out.push(...rangeRects(pd, a, b + 1));
  }
  const unique = [];
  for (const q of out) {
    if (!unique.some((u) => Math.abs(u.x - q.x) < 0.5 && Math.abs(u.y - q.y) < 0.5 && Math.abs(u.w - q.w) < 0.5 && Math.abs(u.h - q.h) < 0.5)) unique.push(q);
  }
  return unique.length ? unique : [r];
}

/** True if a word ends between character i - 1 and character i. */
function wordBreakBefore(pd, line, i) {
  if (/\s/.test(pd.text[i - 1] ?? " ") || /\s/.test(pd.text[i] ?? " ")) return true;
  let j = i - 1;
  while (j >= line.first && !visible(pd, j)) j--;
  if (j < line.first || !visible(pd, i)) return true;
  const gap = pd.gx[i] - (pd.gx[j] + pd.gw[j]);
  return gap > 0.14 * (line.bottom - line.top);
}
