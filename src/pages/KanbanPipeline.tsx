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

const sourceConfig: Record<string, { label: string; colorClass: string; bgClass: string }> = {
  ...mockSourceConfig,
};

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
      <div className="mt-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span className="text-[11px] font-medium">Queued — waiting for active job</span>
        </div>
      </div>
    );
  }

  if (isCancelled) {
    return (
      <div className="mt-3">
        <div className="flex items-center gap-2 text-destructive">
          <Pause className="h-3.5 w-3.5" />
          <span className="text-[11px] font-medium">Cancelled</span>
        </div>
      </div>
    );
  }

  if (currentIdx === -1) return null;

  return (
    <div className="mt-3">
      <div className="space-y-1.5">
        {activeSteps.map((step, idx) => {
          const Icon = stepIcons[step.key] || Loader2;
          const isActive = idx === currentIdx;
          const isDone = idx < currentIdx;

          return (
            <div key={step.key} className="flex items-center gap-2">
              <div className="flex items-center justify-center w-4 h-4">
                {isDone ? (
                  <Check className="h-3.5 w-3.5 text-success shrink-0" />
                ) : isActive ? (
                  <Loader2 className="h-3.5 w-3.5 text-primary animate-spin shrink-0" />
                ) : (
                  <Icon className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0" />
                )}
              </div>
              <span
                className={`text-[11px] leading-none ${
                  isActive
                    ? "text-primary font-semibold"
                    : isDone
                    ? "text-success font-medium"
                    : "text-muted-foreground/30"
                }`}
              >
                {step.label}
              </span>
              {isActive && (
                <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden ml-1">
                  <div className="h-full bg-primary/60 rounded-full animate-pulse w-2/3" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2.5 flex gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px] gap-1 px-2"
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
          disabled={isCancelling}
        >
          {isCancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
          Stop
        </Button>
      </div>
    </div>
  );
}

function DealCard({
  deal,
  selected,
  onToggleSelect,
  selectionActive,
}: {
  deal: Deal;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  selectionActive: boolean;
}) {
  const source = sourceConfig[deal.source] ?? sourceConfig.manual;
  const isProcessing = PROCESSING_STATUSES.includes(deal.status);
  const isQueued = deal.status === "queued";
  const isCancelled = deal.status === "cancelled";
  const showWorkflow = isProcessing || isQueued || isCancelled;

  const cancelMutation = useCancelDeal();

  const handleCardClick = (e: React.MouseEvent) => {
    if (selectionActive) {
      e.preventDefault();
      onToggleSelect(deal.id);
    }
  };

  return (
    <div
      className={`relative rounded-lg border bg-card p-3.5 shadow-surface hover:shadow-surface-md transition-all cursor-pointer group ${
        selected ? "border-primary ring-2 ring-primary/30" : "border-border"
      }`}
      onClick={handleCardClick}
    >
      <div
        className={`absolute top-2.5 left-2.5 transition-opacity ${
          selected || selectionActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        onClick={(e) => { e.stopPropagation(); onToggleSelect(deal.id); }}
      >
        <Checkbox checked={selected} onCheckedChange={() => onToggleSelect(deal.id)} />
      </div>

      <div className="flex items-start justify-between mb-2 pl-6">
        <h3 className="text-sm font-semibold text-card-foreground group-hover:text-primary transition-colors">
          {deal.name}
        </h3>
        {(deal.auto_ingested || isProcessing) && (
          <span className="relative flex h-2.5 w-2.5 shrink-0 mt-1">
            <span className="animate-pulse-dot absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-success" />
          </span>
        )}
        {isQueued && (
          <span className="relative flex h-2.5 w-2.5 shrink-0 mt-1">
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-warning" />
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-2.5 pl-6">{deal.stage} · {deal.sector}</p>
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ml-6 ${source.bgClass} ${source.colorClass}`}>
        {source.label}
      </span>
      {showWorkflow && (
        <WorkflowProgress
          deal={deal}
          onCancel={() => cancelMutation.mutate(deal.id)}
          isCancelling={cancelMutation.isPending}
        />
      )}
    </div>
  );
}

export default function KanbanPipeline() {
  const { data: deals, isLoading } = useDeals();
  const deleteDeals = useDeleteDeals();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const grouped = columns.map((col) => ({
    ...col,
    deals: (deals ?? []).filter((d) =>
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

  return (
    <div className="p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Deal Pipeline</h1>
          <p className="text-sm text-muted-foreground mt-1">Track deals across your ingestion pipeline</p>
        </div>
        {selectionActive && (
          <div className="flex items-center gap-2">
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
          </div>
        )}
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <div className="animate-spin-slow h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {grouped.map((col) => (
            <div key={col.key} className="flex flex-col">
              <div className="flex items-center justify-between mb-3 px-1">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{col.title}</h2>
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                  {col.deals.length}
                </span>
              </div>
              <div className="flex flex-col gap-2.5 min-h-[200px] rounded-lg bg-muted/50 p-2">
                {col.deals.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center mt-8">No deals</p>
                )}
                {col.deals.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    selected={selected.has(deal.id)}
                    onToggleSelect={toggleSelect}
                    selectionActive={selectionActive}
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
