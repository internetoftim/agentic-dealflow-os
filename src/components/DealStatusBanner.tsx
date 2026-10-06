import { AlertCircle, CheckCircle2, Clock, Loader2, Pause } from "lucide-react";
import type { DealStatusSummary, DealStatusTone } from "@/lib/dealStatus";

const TONE: Record<DealStatusTone, { pill: string; icon: React.ComponentType<{ className?: string }>; spin?: boolean }> = {
  ready: { pill: "bg-success-muted text-success", icon: CheckCircle2 },
  working: { pill: "bg-brand-muted text-brand", icon: Loader2, spin: true },
  waiting: { pill: "bg-muted text-muted-foreground", icon: Clock },
  attention: { pill: "bg-destructive/10 text-destructive", icon: AlertCircle },
  stopped: { pill: "bg-muted text-muted-foreground", icon: Pause },
};

/**
 * The deal's state in one glance: a coloured pill with a label, one line of
 * context, and the one action that matters right now. Sits in the deal
 * header so a partner never has to read the pipeline list to know what to do.
 */
export function DealStatusBanner({
  summary,
  actionLabel,
  onAction,
  actionPending = false,
}: {
  summary: DealStatusSummary;
  actionLabel?: string | null;
  onAction?: () => void;
  actionPending?: boolean;
}) {
  const tone = TONE[summary.tone];
  const Icon = tone.icon;
  return (
    <div role="status" aria-label={`Deal status: ${summary.label}`} className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${tone.pill}`}>
        <Icon className={`h-3.5 w-3.5 ${tone.spin ? "animate-spin" : ""}`} />
        {summary.label}
      </span>
      <span className={`text-[12.5px] ${summary.tone === "attention" ? "text-destructive" : "text-muted-foreground"}`}>
        {summary.detail}
      </span>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          disabled={actionPending}
          className={`inline-flex items-center gap-1 rounded-[5px] px-2 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-50 ${
            summary.tone === "attention"
              ? "bg-destructive text-destructive-foreground hover:opacity-90"
              : "border border-border bg-background text-foreground hover:bg-accent"
          }`}
        >
          {actionPending && <Loader2 className="h-3 w-3 animate-spin" />}
          {actionLabel}
        </button>
      )}
    </div>
  );
}
