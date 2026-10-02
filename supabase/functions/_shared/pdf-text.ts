// Real PDF text extraction for the edge runtime (Deno). unpdf bundles a
// serverless build of PDF.js, so it reads compressed streams, CID fonts and
// hex strings — everything the old regex extractor in deck-text.ts cannot.
//
// Deno-only (npm: specifier); the pure shaping/fallback logic lives in
// deck-text.ts where the regression suite can import it.

import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";
import { formatSlides, naivePdfText, betterExtraction } from "./deck-text.ts";

/** Decks are short; cap the work so one huge PDF cannot exhaust the function's CPU budget. */
const MAX_PAGES = 80;

export async function extractPdfTextRobust(arrayBuffer: ArrayBuffer): Promise<{ text: string; pageCount: number; method: "pdfjs" | "regex" | "none" }> {
  let parsed = { text: "", pageCount: 0 };
  try {
    // PDF.js takes ownership of the buffer it is given; hand it a copy.
    const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer.slice(0)));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).slice(0, MAX_PAGES);
    parsed = { text: formatSlides(pages), pageCount: totalPages };
  } catch (e) {
    console.warn("PDF.js text extraction failed, falling back to regex:", e instanceof Error ? e.message : e);
  }

  const naive = naivePdfText(arrayBuffer);
  const best = betterExtraction(parsed, naive);
  const method = best.text.length === 0 ? "none" : best.text === parsed.text ? "pdfjs" : "regex";
  return { ...best, method };
}
