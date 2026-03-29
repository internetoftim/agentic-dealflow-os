import { useDeals, useCancelDeal, type Deal, WORKFLOW_STEPS, PROCESSING_STATUSES } from "@/hooks/useDeals";
import { sourceConfig as mockSourceConfig } from "@/data/mockDeals";
import { Loader2, Check, Globe, Upload, FileArchive, FileSearch, CloudUpload, ArrowRightLeft, Pause, Play, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

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

function DealCard({ deal }: { deal: Deal }) {
  const source = sourceConfig[deal.source] ?? sourceConfig.manual;
  const isProcessing = PROCESSING_STATUSES.includes(deal.status);
  const isQueued = deal.status === "queued";
  const isCancelled = deal.status === "cancelled";
  const showWorkflow = isProcessing || isQueued || isCancelled;

  const cancelMutation = useCancelDeal();

  return (
    <div className="rounded-lg border border-border bg-card p-3.5 shadow-surface hover:shadow-surface-md transition-shadow cursor-pointer group">
      <div className="flex items-start justify-between mb-2">
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
      <p className="text-xs text-muted-foreground mb-2.5">{deal.stage} · {deal.sector}</p>
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${source.bgClass} ${source.colorClass}`}>
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

  const grouped = columns.map((col) => ({
    ...col,
    deals: (deals ?? []).filter((d) =>
      "matchFn" in col && col.matchFn ? col.matchFn(d.status) : d.status === col.key
    ),
  }));

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">Deal Pipeline</h1>
        <p className="text-sm text-muted-foreground mt-1">Track deals across your ingestion pipeline</p>
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
                  <DealCard key={deal.id} deal={deal} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
