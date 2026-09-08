import { FileText, CheckSquare, Square } from "lucide-react";

interface SourceRow {
  id: string;
  file_name: string;
  processing_status?: string | null;
}

/**
 * NotebookLM-style sources rail: every source is a checkbox; the checked set
 * grounds the chat. Empty selection = all sources.
 */
export function SourcesRail({
  sources,
  selected,
  onToggle,
  onToggleAll,
}: {
  sources: SourceRow[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}) {
  const allSelected = sources.length > 0 && sources.every((s) => selected.has(s.id));

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
          return (
            <button
              key={s.id}
              onClick={() => onToggle(s.id)}
              className={`w-full flex items-start gap-2 rounded-[5px] px-2 py-1.5 text-left transition-colors ${
                checked ? "bg-card shadow-surface" : "hover:bg-accent/60"
              }`}
            >
              {checked ? (
                <CheckSquare className="h-3.5 w-3.5 text-brand shrink-0 mt-0.5" />
              ) : (
                <Square className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0 mt-0.5" />
              )}
              <span className="min-w-0">
                <span className={`block text-[11.5px] leading-snug break-words ${checked ? "text-foreground" : "text-muted-foreground"}`}>
                  {s.file_name}
                </span>
              </span>
            </button>
          );
        })}
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
