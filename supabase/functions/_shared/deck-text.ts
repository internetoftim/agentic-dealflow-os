// Text shaping shared by every deck extractor. Pure, so it is unit-tested.

/** "[Slide N] …" blocks: the format deep-research's slide parser and the chat grounding expect. */
export function formatSlides(pages: string[]): string {
  return pages
    .map((p, i) => ({ n: i + 1, text: p.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim() }))
    .filter((p) => p.text.length > 0)
    .map((p) => `[Slide ${p.n}] ${p.text}`)
    .join("\n\n");
}

/**
 * The original regex extractor: reads only UNCOMPRESSED content streams, which
 * almost no real PDF has. Kept as a last-resort fallback behind the real
 * parser in pdf-text.ts.
 */
export function naivePdfText(arrayBuffer: ArrayBuffer): { text: string; pageCount: number } {
  const bytes = new Uint8Array(arrayBuffer);
  const raw = new TextDecoder("latin1").decode(bytes);
  const pageCount = (raw.match(/\/Type\s*\/Page(?!\s*s)/g) || []).length;

  const textChunks: string[] = [];
  const btPattern = /BT\s([\s\S]*?)ET/g;
  let match;
  while ((match = btPattern.exec(raw)) !== null) {
    const block = match[1];
    const tjPattern = /\(([^)]*)\)\s*Tj/g;
    let tj;
    while ((tj = tjPattern.exec(block)) !== null) {
      const text = tj[1].replace(/\\n/g, "\n").replace(/\\\(/g, "(").replace(/\\\)/g, ")");
      if (text.trim()) textChunks.push(text.trim());
    }
    const tjArrayPattern = /\[([^\]]*)\]\s*TJ/g;
    let tja;
    while ((tja = tjArrayPattern.exec(block)) !== null) {
      const inner = tja[1];
      const strPattern = /\(([^)]*)\)/g;
      let s;
      while ((s = strPattern.exec(inner)) !== null) {
        const text = s[1].replace(/\\n/g, "\n").replace(/\\\(/g, "(").replace(/\\\)/g, ")");
        if (text.trim()) textChunks.push(text.trim());
      }
    }
  }
  return { text: textChunks.join(" ").replace(/\s+/g, " ").trim(), pageCount };
}

/** Pick the better of two extraction results (more text wins; keep a known page count). */
export function betterExtraction(
  a: { text: string; pageCount: number },
  b: { text: string; pageCount: number },
): { text: string; pageCount: number } {
  const best = b.text.length > a.text.length ? b : a;
  return { text: best.text, pageCount: best.pageCount || a.pageCount || b.pageCount };
}
