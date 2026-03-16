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
  manual: { label: "Manual Upload", colorClass: "text-badge-amber", bgClass: "bg-badge-amber-muted" },
  "deal-desk": { label: "Deal Desk", colorClass: "text-badge-purple", bgClass: "bg-badge-purple-muted" },
  "personal-gmail": { label: "Personal Gmail", colorClass: "text-badge-blue", bgClass: "bg-badge-blue-muted" },
  docusend: { label: "DocSend", colorClass: "text-badge-green", bgClass: "bg-badge-green-muted" },
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



function WorkflowProgress({ deal, onPause, onResume, isPausing, isResuming }: {
  deal: Deal;
  onPause: () => void;
  onResume: () => void;
  isPausing: boolean;
  isResuming: boolean;
}) {
  const isPaused = deal.status === "paused";
  const activeStatus = isPaused ? deal.paused_at_step : deal.status;
  const activeSteps = WORKFLOW_STEPS.filter((s) => s.key !== "memo-ready");
  const currentIdx = activeSteps.findIndex((s) => s.key === activeStatus);

  if (currentIdx === -1 && !isPaused) return null;

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
                ) : isActive && !isPaused ? (
                  <Loader2 className="h-3.5 w-3.5 text-primary animate-spin shrink-0" />
                ) : isActive && isPaused ? (
                  <Pause className="h-3.5 w-3.5 text-warning shrink-0" />
                ) : (
                  <Icon className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0" />
                )}
              </div>
              <span
                className={`text-[11px] leading-none ${
                  isActive && isPaused
                    ? "text-warning font-semibold"
                    : isActive
                    ? "text-primary font-semibold"
                    : isDone
                    ? "text-success font-medium"
                    : "text-muted-foreground/30"
                }`}
              >
                {step.label}
                {isActive && isPaused && " (paused)"}
              </span>
              {isActive && !isPaused && (
                <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden ml-1">
                  <div className="h-full bg-primary/60 rounded-full animate-pulse w-2/3" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2.5 flex gap-1.5">
        {!isPaused ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px] gap-1 px-2"
            onClick={(e) => { e.stopPropagation(); onPause(); }}
            disabled={isPausing}
          >
            {isPausing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
            Stop
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px] gap-1 px-2 opacity-50 cursor-not-allowed"
            disabled
          >
            <Play className="h-3 w-3" />
            Resume
            <span className="ml-1 text-[9px] rounded bg-muted px-1 py-0.5 text-muted-foreground">Soon</span>
          </Button>
        )}
      </div>
    </div>
  );
}

function DealCard({ deal }: { deal: Deal }) {
  const source = sourceConfig[deal.source] ?? sourceConfig.manual;
  const isProcessing = PROCESSING_STATUSES.includes(deal.status);
  const isPaused = deal.status === "paused";
  const showWorkflow = isProcessing || isPaused;

  const pauseMutation = usePauseDeal();
  const resumeMutation = useResumeDeal();

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
        {isPaused && (
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
          onPause={() => pauseMutation.mutate(deal.id)}
          onResume={() => resumeMutation.mutate({ dealId: deal.id, pausedAtStep: deal.paused_at_step! })}
          isPausing={pauseMutation.isPending}
          isResuming={resumeMutation.isPending}
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
