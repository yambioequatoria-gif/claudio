// Printing: each page is rendered by the engine at print resolution and handed to the browser's print dialog.
import { engine, call } from "./engine.js";

const DPI = 200;

/** "1-3, 5" -> [0, 1, 2, 4]. Returns null if the text is not a valid page range. */
export function parsePageRange(text, pageCount) {
  const clean = text.trim();
  if (!clean) return Array.from({ length: pageCount }, (_, i) => i);
  const out = new Set();
  for (const part of clean.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > pageCount) return null;
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

export async function printPages(doc, indices, onProgress) {
  const root = document.getElementById("printRoot");
  root.replaceChildren();
  let style = document.getElementById("printPageStyle");
  if (!style) {
    style = document.createElement("style");
    style.id = "printPageStyle";
    document.head.append(style);
  }
  const urls = [];
  const sizes = new Map();
  try {
    for (let n = 0; n < indices.length; n++) {
      onProgress?.(n + 1, indices.length);
      const page = doc.pages[indices[n]];
      const scale = DPI / 72;
      const raw = await call(engine().renderPageRaw(doc, page, { scaleFactor: scale, dpr: 1, withAnnotations: true, withForms: true }));
      const canvas = document.createElement("canvas");
      canvas.width = raw.width;
      canvas.height = raw.height;
      const data = raw.data instanceof Uint8ClampedArray ? raw.data : new Uint8ClampedArray(raw.data);
      canvas.getContext("2d").putImageData(new ImageData(data, raw.width, raw.height), 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      canvas.width = canvas.height = 0;
      const url = URL.createObjectURL(blob);
      urls.push(url);

      const key = `p${Math.round(page.size.width)}x${Math.round(page.size.height)}`;
      sizes.set(key, page.size);
      const holder = document.createElement("div");
      holder.className = "print-page";
      holder.style.page = key;
      holder.style.width = `${page.size.width}pt`;
      holder.style.height = `${page.size.height}pt`;
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      holder.append(img);
      root.append(holder);
    }
    style.textContent = [...sizes].map(([key, s]) => `@page ${key} { size: ${s.width}pt ${s.height}pt; margin: 0; }`).join("\n");
    await Promise.all([...root.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
    await new Promise((resolve) => {
      const done = () => {
        window.removeEventListener("afterprint", done);
        resolve();
      };
      window.addEventListener("afterprint", done);
      window.print();
      // Some browsers never fire afterprint for a cancelled dialog; do not hold the images forever.
      setTimeout(done, 60000);
    });
  } finally {
    root.replaceChildren();
    for (const u of urls) URL.revokeObjectURL(u);
  }
}
