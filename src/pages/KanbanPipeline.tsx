import { useState } from "react";
import { useDeals, useCancelDeal, useDeleteDeals, type Deal, WORKFLOW_STEPS, PROCESSING_STATUSES } from "@/hooks/useDeals";
import { sourceConfig as mockSourceConfig } from "@/data/mockDeals";
import { Loader2, Check, Globe, Upload, FileArchive, FileSearch, CloudUpload, ArrowRightLeft, Pause, Clock, Trash2, X, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

type DealFilter = "all" | "mine" | "shared";

const columns = [
  { key: "inbox", title: "Inbox" },
  { key: "processing", title: "Processing", matchFn: (s: string) => [...PROCESSING_STATUSES, "queued", "cancelled"].includes(s) },
  { key: "memo-ready", title: "Memo Ready" },
];

const sourceConfig = { ...mockSourceConfig };

const stepIcons: Record<string, React.ElementType> = {
  uploading: Upload,
  converting: ArrowRightLeft,
  compressing: FileArchive,
  extracting: FileSearch,
  "searching-website": Globe,
  syncing: CloudUpload,
  "memo-ready": Check,
};



function WorkflowProgress({ deal, onCancel, isCancelling }: {
  deal: Deal;
  onCancel: () => void;
  isCancelling: boolean;
}) {
  const isQueued = deal.status === "queued";
  const isCancelled = deal.status === "cancelled";
  const activeStatus = deal.status;
  const activeSteps = WORKFLOW_STEPS.filter((s) => s.key !== "memo-ready");
  const currentIdx = activeSteps.findIndex((s) => s.key === activeStatus);

  if (isQueued) {
    return (
      <div className="mt-3 flex items-center gap-1.5 text-muted-foreground">
        <Clock className="h-3 w-3" />
        <span className="text-[11px]">Queued — waiting for active job</span>
      </div>
    );
  }

  if (isCancelled) {
    return (
      <div className="mt-3 flex items-center gap-1.5 text-destructive">
        <Pause className="h-3 w-3" />
        <span className="text-[11px] font-medium">Cancelled</span>
      </div>
    );
  }

  if (currentIdx === -1) return null;

  const currentStep = activeSteps[currentIdx];
  const pct = Math.round(((currentIdx + 0.5) / activeSteps.length) * 100);

  // A card in a column shows *where* a deal is, not every step it has passed.
  // The full checklist lives in the workspace.
  return (
    <div className="mt-3 pt-3 border-t border-border">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground min-w-0">
          <Loader2 className="h-3 w-3 animate-spin shrink-0 text-brand" />
          <span className="truncate">{currentStep?.label}</span>
        </span>
        <span className="text-[10px] tabular-figures text-muted-foreground shrink-0">
          {currentIdx + 1}/{activeSteps.length}
        </span>
      </div>
      <div className="h-[3px] rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-brand rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      <Button
        variant="ghost"
        size="sm"
        className="mt-2 h-6 text-[11px] gap-1 px-1.5 -ml-1.5 text-muted-foreground hover:text-destructive"
        onClick={(e) => { e.stopPropagation(); onCancel(); }}
        disabled={isCancelling}
      >
        {isCancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
        Stop
      </Button>
    </div>
  );
}

function DealCard({
  deal,
  selected,
  onToggleSelect,
  selectionActive,
  isShared,
}: {
  deal: Deal;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  selectionActive: boolean;
  isShared: boolean;
}) {
  const source = sourceConfig[deal.source] ?? sourceConfig.manual;
  const isProcessing = PROCESSING_STATUSES.includes(deal.status);
  const isQueued = deal.status === "queued";
  const isCancelled = deal.status === "cancelled";
  const showWorkflow = (isProcessing || isQueued || isCancelled) && !isShared;

  const cancelMutation = useCancelDeal();

  const handleCardClick = (e: React.MouseEvent) => {
    if (selectionActive && !isShared) {
      e.preventDefault();
      onToggleSelect(deal.id);
    }
  };

  return (
    <div
      className={`relative rounded-md border bg-card px-3.5 py-3 transition-colors cursor-pointer group ${
        selected
          ? "border-brand ring-1 ring-brand/25"
          : "border-border hover:border-foreground/20"
      }`}
      onClick={handleCardClick}
    >
      {!isShared && (
        <div
          className={`absolute top-3 left-3 transition-opacity ${
            selected || selectionActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          onClick={(e) => { e.stopPropagation(); onToggleSelect(deal.id); }}
        >
          <Checkbox checked={selected} onCheckedChange={() => onToggleSelect(deal.id)} className="h-3.5 w-3.5" />
        </div>
      )}

      <div
        className={`transition-[padding] ${
          !isShared && (selected || selectionActive) ? "pl-6" : "pl-0 group-hover:pl-6"
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[13px] font-semibold leading-5 text-card-foreground flex items-center gap-1.5 min-w-0">
            <span className="truncate">{deal.name}</span>
            {isShared && (
              <Share2 className="h-3 w-3 text-muted-foreground shrink-0" aria-label="Shared with you" />
            )}
          </h3>
          {(deal.auto_ingested || isProcessing) && !isShared && (
            <span className="relative flex h-1.5 w-1.5 shrink-0 mt-1.5" title="Auto-ingested">
              <span className="animate-pulse-dot absolute inline-flex h-full w-full rounded-full bg-success opacity-70" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" />
            </span>
          )}
          {isQueued && !isShared && (
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="Queued" />
          )}
        </div>

        <p className="mt-1 text-[11px] text-muted-foreground">
          {deal.stage} <span className="text-muted-foreground/40">·</span> {deal.sector}
        </p>

        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${source.dotClass}`} />
            {source.label}
          </span>
          {isShared && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className="text-muted-foreground/40">·</span> Shared
            </span>
          )}
        </div>

        {showWorkflow && (
          <WorkflowProgress
            deal={deal}
            onCancel={() => cancelMutation.mutate(deal.id)}
            isCancelling={cancelMutation.isPending}
          />
        )}
      </div>
    </div>
  );
}

export default function KanbanPipeline() {
  const { user } = useAuth();
  const { data: deals, isLoading } = useDeals();
  const deleteDeals = useDeleteDeals();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [filter, setFilter] = useState<DealFilter>("all");

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const isOwn = (d: Deal) => !!user && d.user_id === user.id;

  const sharedCount = (deals ?? []).filter((d) => !isOwn(d)).length;

  const visibleDeals = (deals ?? []).filter((d) => {
    if (filter === "mine") return isOwn(d);
    if (filter === "shared") return !isOwn(d);
    return true;
  });

  const grouped = columns.map((col) => ({
    ...col,
    deals: visibleDeals.filter((d) =>
      "matchFn" in col && col.matchFn ? col.matchFn(d.status) : d.status === col.key
    ),
  }));

  const handleDelete = () => {
    const ids = Array.from(selected);
    deleteDeals.mutateAsync(ids).then(() => {
      toast({ title: "Deals deleted", description: `${ids.length} deal${ids.length === 1 ? "" : "s"} removed.` });
      clearSelection();
      setConfirmOpen(false);
    }).catch((err) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    });
  };

  const selectionActive = selected.size > 0;

  const totalDeals = visibleDeals.length;

  const filterButton = (key: DealFilter, label: string, count?: number) => (
    <button
      onClick={() => setFilter(key)}
      className={`px-2.5 py-1 rounded-[4px] text-[12px] transition-colors ${
        filter === key
          ? "bg-card text-foreground font-medium shadow-surface"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}{typeof count === "number" && count > 0 ? ` (${count})` : ""}
    </button>
  );

  return (
    <div className="px-6 py-6 lg:px-8">
      <div className="mb-6 flex items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Deal Pipeline</h1>
          <p className="text-[13px] text-muted-foreground mt-0.5">
            {totalDeals} {totalDeals === 1 ? "deal" : "deals"} across ingestion, research, and memo
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-[5px] border border-border p-0.5 bg-muted">
            {filterButton("all", "All")}
            {filterButton("mine", "Mine")}
            {filterButton("shared", "Shared", sharedCount)}
          </div>
          {selectionActive && (
            <>
              <span className="text-sm text-muted-foreground">{selected.size} selected</span>
              <Button variant="ghost" size="sm" onClick={clearSelection} className="gap-1">
                <X className="h-4 w-4" /> Clear
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmOpen(true)}
                disabled={deleteDeals.isPending}
                className="gap-1"
              >
                {deleteDeals.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <div className="animate-spin-slow h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {grouped.map((col) => (
            <div key={col.key} className="flex flex-col">
              <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border">
                <h2 className="eyebrow">{col.title}</h2>
                <span className="text-[11px] tabular-figures text-muted-foreground">
                  {col.deals.length}
                </span>
              </div>
              <div className="flex flex-col gap-2 min-h-[200px]">
                {col.deals.length === 0 && (
                  <div className="rounded-md border border-dashed border-border py-10 text-center">
                    <p className="text-[11px] text-muted-foreground">No deals</p>
                  </div>
                )}
                {col.deals.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    selected={selected.has(deal.id)}
                    onToggleSelect={toggleSelect}
                    selectionActive={selectionActive}
                    isShared={!isOwn(deal)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selected.size} deal{selected.size === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected deals along with their sources, capture jobs, and uploaded files. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteDeals.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              disabled={deleteDeals.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteDeals.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
