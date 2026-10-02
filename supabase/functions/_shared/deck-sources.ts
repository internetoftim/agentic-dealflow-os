// A deal is a data room: it can hold several decks (seed deck, Series A deck,
// an updated version, a DocSend capture) plus supporting documents. Exactly one
// deck is the *primary* — the one that sets the deal's identity and feeds deep
// research. Every other deck is "attached": its text is extracted into its own
// source row and grounds chat and memos, but it never renames the deal or
// restarts the pipeline.
//
// Pure helpers (no Deno/Supabase imports) so the regression suite can import
// them. src/lib/deckSources.ts mirrors the path rules for the browser; a test
// keeps the two in step.

export const DECK_EXTENSIONS = [".pdf", ".pptx", ".ppt"];

export function isDeckFileName(name: string): boolean {
  const n = name.toLowerCase();
  return DECK_EXTENSIONS.some((e) => n.endsWith(e));
}

/** Storage-safe file name: keep letters, digits, dot, dash, underscore. */
export function safeFileName(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "deck";
}

/**
 * Where an additional (attached) uploaded deck is stored. The `decks/<unique>-`
 * prefix means a second deck can never overwrite the first, even with the same
 * file name.
 */
export function attachedDeckPath(userId: string, dealId: string, fileName: string, unique: string): string {
  return `${userId}/${dealId}/decks/${unique}-${safeFileName(fileName)}`;
}

/**
 * Where a captured (DocSend / Papermark / PandaDoc) deck is stored. The primary
 * capture keeps the historical `deck.pdf`; attached captures get their own
 * file keyed by the capture job.
 */
export function capturedDeckPath(userId: string, dealId: string, attachJobId?: string | null): string {
  return attachJobId ? `${userId}/${dealId}/decks/${attachJobId}.pdf` : `${userId}/${dealId}/deck.pdf`;
}

export type SourceLike = {
  id: string;
  is_primary?: boolean | null;
  source_type?: string | null;
  storage_path?: string | null;
  file_name?: string | null;
  created_at?: string | null;
};

/** Supporting documents (xlsx, docx, …) attached from email are not decks. */
export function isDeckSource(s: SourceLike): boolean {
  if ((s.source_type ?? "") === "attachment") return isDeckFileName(s.file_name ?? "");
  return true;
}

/** The primary deck: the flagged one, else the earliest deck (legacy rows). */
export function pickPrimarySource<T extends SourceLike>(sources: T[]): T | undefined {
  const flagged = sources.find((s) => s.is_primary);
  if (flagged) return flagged;
  const decks = sources.filter(isDeckSource);
  const pool = decks.length ? decks : sources;
  return [...pool].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))[0];
}

/**
 * Which source row a processing run should write its extracted text to: the
 * one named explicitly, else the one stored at the path being processed, else
 * the primary. Never "every source of the deal".
 */
export function pickTargetSource<T extends SourceLike>(
  sources: T[],
  opts: { sourceId?: string | null; storagePaths?: Array<string | null | undefined> },
): T | undefined {
  if (opts.sourceId) {
    const byId = sources.find((s) => s.id === opts.sourceId);
    if (byId) return byId;
  }
  const paths = (opts.storagePaths ?? []).filter((p): p is string => !!p);
  const byPath = sources.find((s) => !!s.storage_path && paths.includes(s.storage_path));
  if (byPath) return byPath;
  return pickPrimarySource(sources);
}
