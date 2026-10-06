// Browser-side mirror of supabase/functions/_shared/deck-sources.ts (the edge
// functions cannot be imported into the app bundle). A regression test asserts
// the two produce identical paths and classifications.

export const DECK_EXTENSIONS = [".pdf", ".pptx", ".ppt"];

export function isDeckFileName(name: string): boolean {
  const n = name.toLowerCase();
  return DECK_EXTENSIONS.some((e) => n.endsWith(e));
}

export function safeFileName(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "deck";
}

export function attachedDeckPath(userId: string, dealId: string, fileName: string, unique: string): string {
  return `${userId}/${dealId}/decks/${unique}-${safeFileName(fileName)}`;
}

export type DealSource = {
  id: string;
  deal_id: string;
  user_id?: string;
  file_name: string;
  original_size?: string | null;
  compressed_size?: string | null;
  storage_path?: string | null;
  source_type?: string | null;
  processing_status?: string | null;
  is_primary?: boolean | null;
  label?: string | null;
  /** This deck's own copy in Google Drive (each linked deck is synced). */
  gdrive_file_id?: string | null;
  drive_synced_at?: string | null;
  created_at?: string | null;
};

export function isDeckSource(s: Pick<DealSource, "source_type" | "file_name">): boolean {
  if ((s.source_type ?? "") === "attachment") return isDeckFileName(s.file_name ?? "");
  return true;
}

/** The primary deck: the flagged one, else the earliest deck (legacy rows). */
export function pickPrimarySource<T extends DealSource>(sources: T[]): T | undefined {
  const flagged = sources.find((s) => s.is_primary);
  if (flagged) return flagged;
  const decks = sources.filter(isDeckSource);
  const pool = decks.length ? decks : sources;
  return [...pool].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))[0];
}

/** "Primary deck" | "Deck" | "Document", for badges and the Data Room. */
export function sourceKind(s: DealSource, primaryId?: string): "Primary deck" | "Deck" | "Document" {
  if (!isDeckSource(s)) return "Document";
  return s.id === primaryId ? "Primary deck" : "Deck";
}

export const DOC_VIEWER_URL = /^https?:\/\/([\w.-]+\.)?(docsend\.com|papermark\.(com|io)|pandadoc\.com)\//i;
