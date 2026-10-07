import { useState } from "react";
import { ChevronDown, Download, ExternalLink, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isDeckSource, pickPrimarySource, type DealSource } from "@/lib/deckSources";
import { describeSource, downloadSourceFile, driveFileUrl, sourceDriveUrl } from "@/lib/driveLinks";

/**
 * Every deck of a deal in one place: download any version, or open its copy
 * in Google Drive. With a single deck it collapses to a plain "Deck" button
 * with the same two actions, so the partner never hunts for the file.
 */
export function DeckFilesMenu({
  sources,
  deal,
  driveFolderUrl,
}: {
  sources: DealSource[];
  deal?: { gdrive_file_id?: string | null; memo_gdrive_file_id?: string | null } | null;
  /** Optional: the deal's Drive folder (not yet tracked; reserved). */
  driveFolderUrl?: string | null;
}) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const decks = sources.filter(isDeckSource);
  const primaryId = pickPrimarySource(sources)?.id;
  if (decks.length === 0) return null;

  const download = async (s: DealSource) => {
    setDownloading(s.id);
    try {
      await downloadSourceFile(s);
    } catch (e) {
      toast.error(`Couldn't download ${s.file_name}: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setDownloading(null);
    }
  };

  const ordered = [...decks].sort((a, b) => (a.id === primaryId ? -1 : b.id === primaryId ? 1 : (b.created_at ?? "").localeCompare(a.created_at ?? "")));
  const syncedCount = ordered.filter((s) => !!sourceDriveUrl(s, deal, primaryId)).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={decks.length === 1 ? "Deck files" : `Deck files · ${decks.length} decks`}
        className="inline-flex items-center gap-1.5 rounded-[5px] border border-border bg-background px-2.5 py-1.5 text-[12px] font-medium text-foreground hover:bg-accent transition-colors"
      >
        <FileText className="h-3 w-3" />
        {decks.length === 1 ? "Deck" : `Decks · ${decks.length}`}
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[340px]">
        <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">
          {decks.length === 1 ? "Deck file" : `${decks.length} decks linked to this deal`}
          {syncedCount > 0 && ` · ${syncedCount} in Drive`}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ordered.map((s) => {
          const driveUrl = sourceDriveUrl(s, deal, primaryId);
          const isPrimary = s.id === primaryId;
          const meta = describeSource(s);
          return (
            <div key={s.id} role="group" aria-label={s.file_name} className="flex items-start gap-2 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] text-foreground">{s.file_name}</span>
                  {isPrimary && decks.length > 1 && (
                    <span className="shrink-0 rounded-full bg-brand-muted px-1.5 py-px text-[9.5px] font-medium text-brand">Primary</span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground tabular-nums">
                  {meta || "—"}
                  {s.processing_status === "processing" && " · reading…"}
                  {s.processing_status === "error" && " · couldn't read"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <DropdownMenuItem
                  asChild
                  disabled={!s.storage_path || downloading === s.id}
                  onSelect={(e) => { e.preventDefault(); void download(s); }}
                >
                  <button
                    aria-label={`Download ${s.file_name}`}
                    title={s.storage_path ? "Download" : "No stored file"}
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                  >
                    {downloading === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  </button>
                </DropdownMenuItem>
                <DropdownMenuItem asChild disabled={!driveUrl}>
                  <a
                    href={driveUrl ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={driveUrl ? `Open ${s.file_name} in Google Drive` : `${s.file_name} is not in Google Drive`}
                    title={driveUrl ? "Open in Google Drive" : "Not synced to Drive"}
                    className={`rounded p-1 ${driveUrl ? "text-muted-foreground hover:text-foreground" : "text-muted-foreground/30 pointer-events-none"}`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </DropdownMenuItem>
              </div>
            </div>
          );
        })}
        {deal?.memo_gdrive_file_id && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a
                href={driveFileUrl(deal.memo_gdrive_file_id)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open the memo PDF in Google Drive"
                className="text-[12px]"
              >
                <ExternalLink className="h-3.5 w-3.5 mr-2" /> Memo PDF in Drive
              </a>
            </DropdownMenuItem>
          </>
        )}
        {driveFolderUrl && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={driveFolderUrl} target="_blank" rel="noopener noreferrer" className="text-[12px]">
                <ExternalLink className="h-3.5 w-3.5 mr-2" /> Open deal folder in Drive
              </a>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
