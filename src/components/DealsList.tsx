import { useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw, Share2, Trash2 } from "lucide-react";

const STORAGE_KEY = "easyvc.dealsList.collapsed";

function readCollapsed(): boolean {
  try { return window.localStorage.getItem(STORAGE_KEY) === "1"; } catch { return false; }
}

export type DealsListItem = { id: string; name: string; user_id: string; status: string; source?: string | null };

/**
 * The deals list in the workspace's left panel. It sits BELOW Add a deal,
 * Loaded Sources and Pipeline Status, and collapses to a single header row
 * (the choice is remembered per browser).
 */
export function DealsList({
  deals,
  activeId,
  currentUserId,
  onSelect,
  onRerun,
  onDelete,
  canRerun,
  rerunPending = false,
  memberLabel,
}: {
  deals: DealsListItem[];
  activeId?: string;
  currentUserId?: string;
  onSelect: (id: string) => void;
  onRerun: (deal: DealsListItem) => void;
  onDelete: (deal: DealsListItem) => void;
  /** Whether a deal may be re-run right now (not while it is processing). */
  canRerun: (deal: DealsListItem) => boolean;
  rerunPending?: boolean;
  memberLabel?: (userId: string) => string | null | undefined;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggle = () =>
    setCollapsed((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });

  if (deals.length === 0) return null;
  const active = deals.find((d) => d.id === activeId);

  return (
    <section className="border-t border-border px-3 py-3" aria-label="Deals">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls="deals-list-items"
        className="w-full flex items-center gap-1 px-1.5 pb-1.5 text-left group/head"
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <span className="eyebrow group-hover/head:text-foreground transition-colors">Deals · {deals.length}</span>
        {collapsed && active && (
          <span className="ml-auto truncate text-[11px] text-muted-foreground max-w-[150px]">{active.name}</span>
        )}
      </button>
      {!collapsed && (
        <div id="deals-list-items" className="flex flex-col gap-px">
          {deals.map((d) => {
            const isActive = activeId === d.id;
            const mine = !!currentUserId && d.user_id === currentUserId;
            const label = !mine && currentUserId ? memberLabel?.(d.user_id) : null;
            return (
              <div
                key={d.id}
                className={`group flex items-center rounded-[5px] transition-colors ${isActive ? "bg-card shadow-surface" : "hover:bg-accent/60"}`}
              >
                <button onClick={() => onSelect(d.id)} className="flex-1 min-w-0 text-left px-2.5 py-1.5 flex items-center gap-1.5">
                  <span className={`h-3.5 w-[2px] rounded-full shrink-0 ${isActive ? "bg-brand" : "bg-transparent"}`} />
                  <span className={`truncate text-[12.5px] ${isActive ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground"}`}>
                    {d.name}
                  </span>
                  {!mine && currentUserId && (
                    label ? (
                      <span className="text-[10px] text-muted-foreground shrink-0">{label}</span>
                    ) : (
                      <Share2 className="h-3 w-3 text-muted-foreground shrink-0" aria-label="Shared with you" />
                    )
                  )}
                </button>
                {mine && canRerun(d) && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onRerun(d); }}
                    aria-label={`Re-run workflow for ${d.name}`}
                    disabled={rerunPending}
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 rounded text-muted-foreground hover:text-foreground transition-opacity"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                )}
                {mine && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(d); }}
                    aria-label={`Delete ${d.name}`}
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 mr-1 rounded text-muted-foreground hover:text-destructive transition-opacity"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
