// Rules for letting an LLM's reading of a deck change a deal's identity.
//
// A model asked to name the company in a deck it cannot read answers
// "Unknown". That answer must never replace a real name: three deals were
// renamed to "Unknown" (and one then "researched" a company called Unknown)
// because the PDF text extractor returned nothing. Pure, so it is unit-tested.

const PLACEHOLDER_NAMES = new Set([
  "", "unknown", "unknown company", "unknown startup", "untitled", "untitled deal", "n/a", "na", "none", "null",
  "startup", "company", "the company", "deck", "pitch deck", "docsend import", "not specified", "not available", "tbd",
]);

export function isPlaceholderName(name: unknown): boolean {
  if (typeof name !== "string") return true;
  return PLACEHOLDER_NAMES.has(name.trim().toLowerCase().replace(/[.!?]+$/, ""));
}

function isUnknownValue(v: unknown): boolean {
  return typeof v !== "string" || isPlaceholderName(v) || v.trim().toLowerCase() === "unknown";
}

/** Is there anything for a model to read? No text and no slide images means no. */
export function hasReadableContent(extractedText: string, imageCount: number): boolean {
  return extractedText.trim().length >= 40 || imageCount > 0;
}

export type DealIdentity = { name?: string | null; stage?: string | null; sector?: string | null };
export type ExtractedMetadata = {
  startup_name?: unknown; stage?: unknown; sector?: unknown; ask_amount?: unknown; valuation?: unknown;
  revenue?: unknown; growth?: unknown; team_size?: unknown; page_count?: unknown;
};

/**
 * The deal fields an extraction may write. A placeholder never overwrites a
 * real value; real values overwrite placeholders and each other (a clearer
 * read of the deck wins).
 */
export function identityUpdate(
  current: DealIdentity,
  metadata: ExtractedMetadata,
  clean: (name: string) => string = (n) => n.trim(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (typeof metadata.startup_name === "string" && !isPlaceholderName(metadata.startup_name)) {
    const cleaned = clean(metadata.startup_name);
    if (!isPlaceholderName(cleaned)) out.name = cleaned;
  }
  for (const key of ["stage", "sector"] as const) {
    const next = metadata[key];
    if (typeof next !== "string" || !next.trim()) continue;
    // "Unknown" only fills an empty slot; it never erases a known stage/sector.
    if (isUnknownValue(next) && !isUnknownValue(current[key])) continue;
    out[key] = next;
  }
  for (const key of ["ask_amount", "valuation", "revenue", "growth", "team_size"] as const) {
    const v = metadata[key];
    if (typeof v === "string" && v.trim() && !isUnknownValue(v)) out[key] = v;
  }
  return out;
}
