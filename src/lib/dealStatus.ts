// One line a busy partner can read at a glance: where this deal is, and what
// (if anything) they need to do. Pure so it is unit-tested.

export type DealStatusTone = "ready" | "working" | "waiting" | "attention" | "stopped";

export type DealStatusSummary = {
  tone: DealStatusTone;
  /** Short pill text: "Memo ready", "Researching", "Needs attention". */
  label: string;
  /** One sentence of context or the next step. */
  detail: string;
  /** The single most useful action right now. */
  action?: "rerun" | "retry-capture" | "start" | "open-memo" | "stop";
};

type DealLike = {
  status?: string | null;
  deep_research_status?: string | null;
  memo_draft?: string | null;
  website_searching?: boolean | null;
};

const WORKING_LABELS: Record<string, string> = {
  uploading: "Uploading",
  converting: "Converting",
  compressing: "Compressing",
  scraping: "Capturing deck",
  extracting: "Reading deck",
  "searching-website": "Finding website",
  syncing: "Syncing to Drive",
};

export function summarizeDealStatus(
  deal: DealLike,
  ctx: { captureFailed?: boolean; captureError?: string | null; runningDealName?: string | null; canRetryCapture?: boolean } = {},
): DealStatusSummary {
  const status = deal.status ?? "";
  if (status === "queued") {
    return ctx.runningDealName
      ? { tone: "waiting", label: "Queued", detail: `Starts when “${ctx.runningDealName}” finishes.` }
      : { tone: "waiting", label: "Queued", detail: "Nothing else is running; it starts shortly.", action: "start" };
  }
  if (status === "cancelled") {
    return { tone: "stopped", label: "Stopped", detail: "Processing was cancelled. Re-run to pick it up again.", action: "rerun" };
  }
  if (status === "error") {
    if (ctx.captureFailed) {
      return {
        tone: "attention",
        label: "Needs attention",
        detail: ctx.captureError?.trim() || "The deck link could not be captured.",
        action: ctx.canRetryCapture ? "retry-capture" : "rerun",
      };
    }
    return { tone: "attention", label: "Needs attention", detail: "Processing failed. Re-run the workflow or upload the deck again.", action: "rerun" };
  }
  if (WORKING_LABELS[status]) {
    return { tone: "working", label: WORKING_LABELS[status], detail: "The data room fills in as each step completes.", action: "stop" };
  }
  const research = deal.deep_research_status ?? "";
  if (["queued", "running", "pending", "researching"].includes(research)) {
    return { tone: "working", label: "Researching", detail: "Deck is read; deep research on the company and team is running." };
  }
  if (status === "memo-ready" || status === "inbox") {
    return deal.memo_draft
      ? { tone: "ready", label: "Memo ready", detail: "Research done and a memo draft is waiting.", action: "open-memo" }
      : { tone: "ready", label: "Ready", detail: "Deck read and research done. Generate the memo when you are ready.", action: "open-memo" };
  }
  return { tone: "working", label: "In progress", detail: "Processing the deck." };
}
