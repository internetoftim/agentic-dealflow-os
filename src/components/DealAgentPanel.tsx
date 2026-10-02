import { useEffect, useRef, useState } from "react";
import { Bot, Check, History, Loader2, Send, ThumbsDown, ThumbsUp, Undo2, X, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { useDealAgent, useDealRevisions, type AgentAction } from "@/hooks/useDealAgent";

const SUGGESTIONS = [
  "The second article isn't about this company — remove it",
  "The stage is actually Series A",
  "Remove the investor that doesn't belong",
  "Add a note: follow up after the partner meeting",
];

/**
 * Side chat for refining the deal's data room by conversation. The agent
 * changes data through server-side tools; each reply lists exactly what
 * changed, every change can be undone, and each reply can be rated. Turns,
 * changes and ratings are logged server-side.
 */
export function DealAgentPanel({
  dealId,
  dealName,
  canEdit,
  onClose,
}: {
  dealId?: string;
  dealName?: string;
  /** Only the deal's owner can change its data. */
  canEdit: boolean;
  onClose: () => void;
}) {
  const { messages, isWorking, send, undo, rate } = useDealAgent(dealId);
  const [input, setInput] = useState("");
  const [view, setView] = useState<"chat" | "history">("chat");
  const [undoing, setUndoing] = useState<string | null>(null);
  const { data: revisions, isLoading: revisionsLoading } = useDealRevisions(dealId, view === "history");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages, isWorking]);

  const submit = (text: string) => {
    if (!text.trim() || !canEdit || isWorking) return;
    setInput("");
    send(text);
  };

  const handleUndo = async (revisionId: string) => {
    setUndoing(revisionId);
    try {
      const result = await undo(revisionId);
      toast.success(result?.summary ?? "Change undone");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't undo that change");
    } finally {
      setUndoing(null);
    }
  };

  const handleRate = (turnId: string, rating: 1 | -1) => {
    rate(turnId, rating).catch(() => toast.error("Couldn't save your rating"));
  };

  return (
    <aside className="w-[340px] shrink-0 border-l border-border bg-card flex flex-col min-h-0" aria-label="Deal agent">
      <header className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border shrink-0">
        <Bot className="h-4 w-4 text-brand shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground leading-tight">Deal agent</p>
          <p className="text-[11px] text-muted-foreground truncate">{dealName ? `Refine ${dealName}` : "Select a deal"}</p>
        </div>
        <button
          onClick={() => setView(view === "chat" ? "history" : "chat")}
          aria-pressed={view === "history"}
          title="Change history"
          className={`inline-flex items-center gap-1 rounded-[5px] px-1.5 py-1 text-[11px] transition-colors ${
            view === "history" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <History className="h-3.5 w-3.5" /> History
        </button>
        <button onClick={onClose} aria-label="Close deal agent" className="p-1 rounded text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {view === "history" ? (
        <div className="flex-1 overflow-auto p-3 space-y-1.5">
          <p className="text-[11px] text-muted-foreground leading-relaxed pb-1">
            Every change to this deal's data, newest first. Undo restores the values from before the change.
          </p>
          {revisionsLoading && <p className="text-[12px] text-muted-foreground">Loading…</p>}
          {!revisionsLoading && (revisions ?? []).length === 0 && (
            <p className="text-[12px] text-muted-foreground">No changes yet.</p>
          )}
          {(revisions ?? []).map((r) => {
            const isUndo = !!r.reverts;
            const undone = !!r.reverted_at;
            return (
              <div key={r.id} className="rounded-[5px] border border-border bg-background px-2.5 py-2">
                <div className="flex items-start gap-2">
                  <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground tabular-nums">v{r.version}</span>
                  <p className={`flex-1 min-w-0 text-[12px] leading-snug break-words ${undone ? "text-muted-foreground line-through" : "text-foreground"}`}>{r.summary}</p>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[10.5px] text-muted-foreground">
                    {r.actor === "agent" ? "Agent" : "You"} · {new Date(r.created_at).toLocaleString()}
                    {undone && " · undone"}
                  </span>
                  {canEdit && !isUndo && !undone && (
                    <button
                      onClick={() => handleUndo(r.id)}
                      disabled={undoing === r.id}
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      {undoing === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />} Undo
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-auto p-3 space-y-3">
            {messages.length === 0 && (
              <div className="space-y-2">
                <p className="text-[12px] text-muted-foreground leading-relaxed">
                  {canEdit
                    ? "Tell me what to fix in this deal's data room. I can remove articles, investors or people that aren't relevant, correct fields, add people and notes, edit the memo, and re-run research."
                    : "Only the deal's owner can change its data. You can still read everything and use the chat in the Data Room tab."}
                </p>
                {canEdit && SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setInput(s)}
                    className="block w-full text-left rounded-[5px] border border-border bg-background px-2.5 py-1.5 text-[11.5px] text-muted-foreground hover:text-foreground hover:border-brand/40 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                <div className={`max-w-[92%] ${m.role === "user" ? "rounded-lg bg-primary text-primary-foreground px-3 py-2" : ""}`}>
                  {m.role === "assistant" && m.actions && m.actions.length > 0 && (
                    <ul className="mb-1.5 space-y-1" aria-label="Changes made">
                      {m.actions.map((a, i) => (
                        <ActionChip key={`${m.id}-${i}`} action={a} canUndo={canEdit} undoing={undoing === a.revisionId} onUndo={handleUndo} />
                      ))}
                    </ul>
                  )}
                  <p className={`text-[12.5px] leading-relaxed whitespace-pre-wrap break-words ${m.error ? "text-destructive" : m.role === "user" ? "" : "text-foreground"}`}>
                    {m.content}
                  </p>
                  {m.role === "assistant" && m.turnId && !m.error && (
                    <div className="mt-1 flex items-center gap-1">
                      <button
                        onClick={() => handleRate(m.turnId!, 1)}
                        aria-label="Good response"
                        aria-pressed={m.rating === 1}
                        className={`p-1 rounded transition-colors ${m.rating === 1 ? "text-success" : "text-muted-foreground/60 hover:text-foreground"}`}
                      >
                        <ThumbsUp className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => handleRate(m.turnId!, -1)}
                        aria-label="Bad response"
                        aria-pressed={m.rating === -1}
                        className={`p-1 rounded transition-colors ${m.rating === -1 ? "text-destructive" : "text-muted-foreground/60 hover:text-foreground"}`}
                      >
                        <ThumbsDown className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {isWorking && (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working on it…
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form
            className="border-t border-border p-2.5 shrink-0"
            onSubmit={(e) => { e.preventDefault(); submit(input); }}
          >
            <div className="flex items-end gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-primary">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(input); }
                }}
                rows={2}
                disabled={!canEdit || !dealId}
                placeholder={canEdit ? "e.g. “This news article is not relevant”" : "Read-only for shared deals"}
                aria-label="Message the deal agent"
                className="flex-1 resize-none bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!input.trim() || !canEdit || isWorking || !dealId}
                aria-label="Send to deal agent"
                className="rounded-[5px] bg-primary p-1.5 text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="mt-1.5 text-[10.5px] text-muted-foreground/80 leading-snug">
              Changes are saved to the deal, can be undone, and are logged to improve the agent.
            </p>
          </form>
        </>
      )}
    </aside>
  );
}

function ActionChip({
  action, canUndo, undoing, onUndo,
}: {
  action: AgentAction;
  canUndo: boolean;
  undoing: boolean;
  onUndo: (revisionId: string) => void;
}) {
  return (
    <li className={`flex items-start gap-1.5 rounded-[5px] border px-2 py-1.5 text-[11.5px] leading-snug ${
      action.ok ? "border-success/30 bg-success-muted/40" : "border-destructive/30 bg-destructive/5"
    }`}>
      {action.ok ? <Check className="h-3 w-3 text-success shrink-0 mt-0.5" /> : <AlertCircle className="h-3 w-3 text-destructive shrink-0 mt-0.5" />}
      <span className={`flex-1 min-w-0 break-words ${action.undone ? "line-through text-muted-foreground" : "text-foreground"}`}>{action.summary}</span>
      {action.ok && action.revisionId && canUndo && !action.undone && action.tool !== "undo_last_change" && (
        <button
          onClick={() => onUndo(action.revisionId!)}
          disabled={undoing}
          aria-label={`Undo: ${action.summary}`}
          className="shrink-0 inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {undoing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />} Undo
        </button>
      )}
      {action.undone && <span className="shrink-0 text-[10.5px] text-muted-foreground">undone</span>}
    </li>
  );
}
