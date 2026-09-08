import { useState } from "react";
import { StickyNote, Pin, PinOff, Trash2, FileUp, Loader2 } from "lucide-react";
import { useDealNotes } from "@/hooks/useDealNotes";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Shared notes on a deal — the "Studio" side of the data room. Notes are
 * visible to the whole team; each note is editable by its author.
 */
export function DealNotesPanel({
  dealId,
  memberLabel,
  onAppendToMemo,
}: {
  dealId?: string;
  memberLabel: (userId: string) => string | null;
  onAppendToMemo?: (content: string) => Promise<void>;
}) {
  const { user } = useAuth();
  const { notes, isLoading, addNote, togglePin, deleteNote } = useDealNotes(dealId);
  const [draft, setDraft] = useState("");

  const submit = () => {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    addNote.mutate(content, {
      onError: (e: any) => {
        setDraft(content);
        toast.error(`Note failed: ${e.message}`);
      },
    });
  };

  return (
    <div className="w-[264px] shrink-0 border-l border-border bg-surface-sunken/60 hidden lg:flex flex-col min-h-0">
      <div className="flex items-center gap-1.5 px-3.5 py-2.5 border-b border-border">
        <StickyNote className="h-3 w-3 text-muted-foreground" />
        <span className="eyebrow">Notes · {notes.length}</span>
      </div>

      <div className="flex-1 overflow-auto p-2.5 space-y-2">
        {isLoading && (
          <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading notes…
          </div>
        )}
        {!isLoading && notes.length === 0 && (
          <p className="px-1 py-3 text-[11px] text-muted-foreground leading-relaxed">
            Notes are shared with your whole team. Save chat answers here, or jot down diligence
            thoughts — then push the good ones into the memo.
          </p>
        )}
        {notes.map((n) => {
          const mine = n.user_id === user?.id;
          const author = mine ? "You" : memberLabel(n.user_id) || n.author_email?.split("@")[0] || "Teammate";
          return (
            <div
              key={n.id}
              className={`group rounded-[5px] border bg-card px-2.5 py-2 ${
                n.pinned ? "border-brand/40" : "border-border"
              }`}
            >
              <p className="text-[12px] leading-relaxed text-foreground whitespace-pre-wrap break-words">
                {n.content}
              </p>
              <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="font-medium">{author}</span>
                <span className="text-muted-foreground/50">·</span>
                <span>{timeAgo(n.created_at)}</span>
                <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {onAppendToMemo && (
                    <button
                      title="Append to memo"
                      className="hover:text-brand transition-colors"
                      onClick={() =>
                        toast.promise(onAppendToMemo(n.content), {
                          loading: "Adding to memo…",
                          success: "Added to memo draft",
                          error: (e) => e.message,
                        })
                      }
                    >
                      <FileUp className="h-3 w-3" />
                    </button>
                  )}
                  <button
                    title={n.pinned ? "Unpin" : "Pin"}
                    className="hover:text-brand transition-colors"
                    onClick={() => togglePin.mutate({ id: n.id, pinned: !n.pinned })}
                  >
                    {n.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                  </button>
                  {mine && (
                    <button
                      title="Delete note"
                      className="hover:text-destructive transition-colors"
                      onClick={() => deleteNote.mutate(n.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-border p-2.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder="Add a note… (⌘↵ to save)"
          rows={2}
          className="w-full resize-none rounded-[5px] border border-input bg-card px-2.5 py-2 text-[12px] outline-none placeholder:text-muted-foreground focus:border-brand/50"
          disabled={!dealId}
        />
        <button
          onClick={submit}
          disabled={!draft.trim() || addNote.isPending || !dealId}
          className="mt-1.5 w-full rounded-[5px] bg-primary px-2.5 py-1.5 text-[11.5px] font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {addNote.isPending ? "Saving…" : "Save note"}
        </button>
      </div>
    </div>
  );
}
