import { useRef, useState } from "react";
import { Plus, Upload, Link as LinkIcon, Loader2 } from "lucide-react";

/**
 * "Add deck" for an existing deal: pick a PDF/PowerPoint or paste a DocSend /
 * Papermark / PandaDoc link. The deck is linked to the deal as an additional
 * deck — it does not create a new deal.
 */
export function AddDeckControl({
  onAddFile,
  onAddLink,
  busy = false,
  compact = false,
}: {
  onAddFile: (file: File) => void;
  onAddLink: (url: string) => void;
  busy?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const submitLink = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    onAddLink(trimmed);
    setUrl("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy}
        className={`inline-flex items-center gap-1 rounded-[5px] border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-brand/50 transition-colors disabled:opacity-50 ${
          compact ? "px-1.5 py-0.5 text-[10px]" : "w-full justify-center px-2.5 py-1.5 text-[11.5px]"
        }`}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
        {busy ? "Adding…" : "Add deck"}
      </button>
    );
  }

  return (
    <div className="rounded-[5px] border border-border bg-card p-2 space-y-1.5">
      <p className="text-[10.5px] text-muted-foreground leading-snug">
        Link another deck to this deal — a newer version, a later round, an appendix.
      </p>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="w-full inline-flex items-center justify-center gap-1.5 rounded-[5px] border border-input bg-background px-2 py-1.5 text-[11.5px] font-medium text-foreground hover:bg-accent/50 transition-colors"
      >
        <Upload className="h-3 w-3" /> Choose PDF or PowerPoint
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.ppt,.pptx"
        className="hidden"
        aria-label="Deck file to link to this deal"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          onAddFile(file);
          setOpen(false);
        }}
      />
      <div className="flex gap-1">
        <div className="flex-1 flex items-center gap-1.5 rounded-[5px] border border-input bg-background px-2 py-1 min-w-0">
          <LinkIcon className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitLink()}
            placeholder="or paste a deck link…"
            aria-label="Deck link to add to this deal"
            className="flex-1 min-w-0 bg-transparent text-[11.5px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <button
          type="button"
          onClick={submitLink}
          disabled={!url.trim()}
          className="rounded-[5px] bg-primary px-2 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          Link
        </button>
      </div>
      <button type="button" onClick={() => setOpen(false)} className="text-[10.5px] text-muted-foreground hover:text-foreground">
        Cancel
      </button>
    </div>
  );
}
