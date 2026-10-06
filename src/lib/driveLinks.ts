import { supabase } from "@/integrations/supabase/client";
import type { DealSource } from "@/lib/deckSources";

/** Google Drive's viewer URL for a file id. */
export function driveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

/**
 * The Drive link for one deck of a deal. Every synced deck carries its own
 * Drive id; decks synced before per-deck ids existed only have the deal-level
 * id, which belongs to the primary deck.
 */
export function sourceDriveUrl(
  source: Pick<DealSource, "id" | "gdrive_file_id">,
  deal?: { gdrive_file_id?: string | null } | null,
  primaryId?: string | null,
): string | null {
  if (source.gdrive_file_id) return driveFileUrl(source.gdrive_file_id);
  if (deal?.gdrive_file_id && primaryId && source.id === primaryId) return driveFileUrl(deal.gdrive_file_id);
  return null;
}

/** Downloads a stored deck/document to the browser with its original name. */
export async function downloadSourceFile(source: Pick<DealSource, "storage_path" | "file_name">): Promise<void> {
  if (!source.storage_path) throw new Error("No stored file");
  const { data, error } = await supabase.storage.from("decks").download(source.storage_path);
  if (error || !data) throw new Error(error?.message ?? "Download failed");
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = source.file_name || "deck.pdf";
  a.click();
  URL.revokeObjectURL(url);
}

/** Short, scannable description of a deck: "Series A · 3.1MB · 2 Jun 2026". */
export function describeSource(source: Pick<DealSource, "label" | "original_size" | "compressed_size" | "created_at">): string {
  const parts: string[] = [];
  if (source.label) parts.push(source.label);
  const size = source.compressed_size ?? source.original_size;
  if (size) parts.push(size);
  if (source.created_at) {
    const d = new Date(source.created_at);
    if (!Number.isNaN(d.getTime())) parts.push(d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }));
  }
  return parts.join(" · ");
}
