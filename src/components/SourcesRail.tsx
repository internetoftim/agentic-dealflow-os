import { FileText, CheckSquare, Square, Star, Trash2, Loader2 } from "lucide-react";
import { AddDeckControl } from "@/components/AddDeckControl";
import { isDeckSource, pickPrimarySource, type DealSource } from "@/lib/deckSources";

type SourceRow = Pick<DealSource, "id" | "file_name"> & Partial<DealSource>;

/**
 * NotebookLM-style sources rail: every source is a checkbox; the checked set
 * grounds the chat. Empty selection = all sources.
 *
 * A deal is a data room and can hold several decks. One is the primary (it
 * defines the deal); owners can link more decks here, promote one to primary,
 * or remove one.
 */
export function SourcesRail({
  sources,
  selected,
  onToggle,
  onToggleAll,
  canManage = false,
  adding = false,
  onAddFile,
  onAddLink,
  onMakePrimary,
  onRemove,
}: {
  sources: SourceRow[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  /** Owner of the deal: may link, promote and remove decks. */
  canManage?: boolean;
  adding?: boolean;
  onAddFile?: (file: File) => void;
  onAddLink?: (url: string) => void;
  onMakePrimary?: (source: SourceRow) => void;
  onRemove?: (source: SourceRow) => void;
}) {
  const allSelected = sources.length > 0 && sources.every((s) => selected.has(s.id));
  const primaryId = pickPrimarySource(sources as DealSource[])?.id;
  const deckCount = sources.filter((s) => isDeckSource(s as DealSource)).length;

  return (
    <div className="w-[210px] shrink-0 border-r border-border bg-surface-sunken/60 hidden lg:flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border">
        <span className="eyebrow">Sources · {sources.length}</span>
        {sources.length > 1 && (
          <button
            onClick={onToggleAll}
            className="text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {allSelected ? "Clear" : "All"}
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-0.5">
        {sources.length === 0 && (
          <p className="px-1.5 py-3 text-[11px] text-muted-foreground leading-relaxed">
            No sources yet. Upload a deck or paste a link in the panel on the left — every source
            lands here and grounds the chat.
          </p>
        )}
        {sources.map((s) => {
          const checked = selected.has(s.id);
          const isPrimary = s.id === primaryId && isDeckSource(s as DealSource);
          const isDeck = isDeckSource(s as DealSource);
          const processing = s.processing_status === "processing";
          const failed = s.processing_status === "error";
          return (
            <div
              key={s.id}
              className={`group/src flex items-start gap-1 rounded-[5px] pr-1 transition-colors ${
                checked ? "bg-card shadow-surface" : "hover:bg-accent/60"
              }`}
            >
              <button
                onClick={() => onToggle(s.id)}
                className="flex-1 min-w-0 flex items-start gap-2 px-2 py-1.5 text-left"
              >
                {checked ? (
                  <CheckSquare className="h-3.5 w-3.5 text-brand shrink-0 mt-0.5" />
                ) : (
                  <Square className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0 mt-0.5" />
                )}
                <span className="min-w-0">
                  <span className={`block text-[11.5px] leading-snug break-words ${checked ? "text-foreground" : "text-muted-foreground"}`}>
                    {s.label ? `${s.label} · ${s.file_name}` : s.file_name}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1">
                    {isPrimary && deckCount > 1 && (
                      <span className="rounded-full bg-brand-muted px-1.5 py-px text-[9.5px] font-medium text-brand">Primary</span>
                    )}
                    {processing && (
                      <span className="inline-flex items-center gap-1 text-[9.5px] text-muted-foreground">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" /> Reading…
                      </span>
                    )}
                    {failed && <span className="text-[9.5px] text-destructive">Couldn't read</span>}
                  </span>
                </span>
              </button>
              {canManage && (
                <span className="flex shrink-0 items-center gap-0.5 pt-1.5 opacity-0 group-hover/src:opacity-100 focus-within:opacity-100 transition-opacity">
                  {isDeck && !isPrimary && onMakePrimary && (
                    <button
                      onClick={() => onMakePrimary(s)}
                      title="Make primary deck"
                      aria-label={`Make ${s.file_name} the primary deck`}
                      className="text-muted-foreground hover:text-brand"
                    >
                      <Star className="h-3 w-3" />
                    </button>
                  )}
                  {onRemove && sources.length > 1 && (
                    <button
                      onClick={() => onRemove(s)}
                      title="Remove from this deal"
                      aria-label={`Remove ${s.file_name} from this deal`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </span>
              )}
            </div>
          );
        })}
        {canManage && onAddFile && onAddLink && (
          <div className="pt-1.5">
            <AddDeckControl onAddFile={onAddFile} onAddLink={onAddLink} busy={adding} />
          </div>
        )}
        {sources.length > 0 && (
          <p className="px-1.5 pt-2 text-[10px] text-muted-foreground/70 leading-relaxed">
            <FileText className="h-3 w-3 inline mr-1 align-[-2px]" />
            Checked sources ground the chat. Nothing checked = all sources.
          </p>
        )}
      </div>
    </div>
  );
}
