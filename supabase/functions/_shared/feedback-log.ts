// Logging and versioning rules for everything a model produces and everything a
// human then says about it. The aim is that, months from now, we can answer
// "which model/prompt/extractor version worked, and which didn't" and build
// training or evaluation sets from real corrections:
//
//   pipeline_runs    what each run was given and produced, with model + version
//   agent_turns      (state, instruction) → (actions, reply) + rating
//   deal_revisions   numbered before/after of every change; undo is a signal
//   feedback_events  human labels on model output, tied to the producing run
//
// Pure (no Deno/Supabase imports) so the rules are unit-tested. The edge
// functions do the inserts.

// Bump when the corresponding prompt or logic changes in a way that should be
// distinguishable in the data.
export const AGENT_PROMPT_VERSION = "deal-agent/2026-10-02.1";
export const EXTRACTION_VERSION = "extraction/2026-10-02.1";
export const RESEARCH_VERSION = "research/2026-10-02.1";
export const MEMO_VERSION = "memo/2026-10-02.1";

export type Stage = "extraction" | "research" | "memo";

/** Which pipeline stage is responsible for a deal field's value. */
const EXTRACTION_FIELDS = new Set(["name", "stage", "sector", "ask_amount", "valuation", "revenue", "growth", "nrr", "team_size"]);
export function producerStage(kindOrField: string): Stage {
  if (kindOrField === "memo") return "memo";
  if (EXTRACTION_FIELDS.has(kindOrField)) return "extraction";
  // website, linkedin_url, crunchbase_url, funding_total, last_funding_round,
  // num_employees, investors, articles, people.
  return "research";
}

export type RunRef = { id: string; stage: string; version: string; provider?: string | null; model?: string | null };
export type Producer = { stage: Stage | "agent"; version?: string; provider?: string | null; model?: string | null; run_id?: string };

/** Attribute a judged item to the latest run of the stage that produced it. */
export function producerFor(kindOrField: string, latestRuns: RunRef[]): Producer {
  const stage = producerStage(kindOrField);
  const run = latestRuns.find((r) => r.stage === stage);
  return run
    ? { stage, version: run.version, provider: run.provider ?? null, model: run.model ?? null, run_id: run.id }
    : { stage };
}

// ------------------------------------------------------------------ revisions
/** before/after restricted to the keys that actually changed. */
export function diffPatch(current: Record<string, unknown>, patch: Record<string, unknown>): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "updated_at") continue;
    const prev = current[key] ?? null;
    if (JSON.stringify(prev) === JSON.stringify(value ?? null)) continue;
    before[key] = prev;
    after[key] = value ?? null;
  }
  return { before, after };
}

export type Revision = {
  id: string;
  target: "deal" | "person" | "note";
  target_id?: string | null;
  tool: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reverts?: string | null;
  reverted_at?: string | null;
};

export type UndoOp =
  | { kind: "patch_deal"; patch: Record<string, unknown> }
  | { kind: "delete_person"; id: string }
  | { kind: "insert_person"; row: Record<string, unknown> }
  | { kind: "update_person"; id: string; patch: Record<string, unknown> }
  | { kind: "delete_note"; id: string };

/**
 * How to undo a revision. A deal change is undone by writing back `before`.
 * A person that was added is deleted; one that was removed is re-inserted; one
 * that was edited gets its old values back. Returns an error for revisions
 * that cannot or should not be undone.
 */
export function planUndo(rev: Revision): { op?: UndoOp; error?: string } {
  if (rev.reverted_at) return { error: "That change was already undone" };
  if (rev.reverts) return { error: "An undo cannot itself be undone; make the change again instead" };
  const hasBefore = Object.keys(rev.before ?? {}).length > 0;
  const hasAfter = Object.keys(rev.after ?? {}).length > 0;

  if (rev.target === "deal") {
    if (!hasBefore) return { error: "Nothing to undo for that change" };
    return { op: { kind: "patch_deal", patch: rev.before } };
  }
  if (rev.target === "person") {
    if (!hasBefore && hasAfter && rev.target_id) return { op: { kind: "delete_person", id: rev.target_id } };
    if (hasBefore && !hasAfter) return { op: { kind: "insert_person", row: rev.before } };
    if (hasBefore && hasAfter && rev.target_id) return { op: { kind: "update_person", id: rev.target_id, patch: rev.before } };
    return { error: "Nothing to undo for that change" };
  }
  if (rev.target === "note") {
    if (rev.target_id) return { op: { kind: "delete_note", id: rev.target_id } };
    return { error: "Nothing to undo for that change" };
  }
  return { error: "That change cannot be undone" };
}

// ------------------------------------------------------------------ feedback
export type FeedbackKind = "article" | "investor" | "person" | "field" | "memo" | "agent_turn" | "agent_action";
export type FeedbackLabel = "irrelevant" | "relevant" | "corrected" | "added" | "thumbs_up" | "thumbs_down" | "reverted";

export type FeedbackEvent = {
  kind: FeedbackKind;
  label: FeedbackLabel;
  item: Record<string, unknown>;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  producer: Producer | Record<string, never>;
};

const cleanReason = (reason: unknown) => (typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null);

/** "This article/investor/person is not relevant" → one labelled example per item. */
export function relevanceFeedback(
  kind: "article" | "investor" | "person",
  items: Array<Record<string, unknown>>,
  label: "irrelevant" | "relevant" | "added",
  reason: unknown,
  latestRuns: RunRef[],
): FeedbackEvent[] {
  // Something the human added was not produced by a model: no producer.
  const producer = label === "added" ? {} : producerFor(kind, latestRuns);
  return items.map((item) => ({ kind, label, item, reason: cleanReason(reason), producer }));
}

/** A field the human corrected: the model's value and the human's value. */
export function fieldCorrectionFeedback(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  latestRuns: RunRef[],
): FeedbackEvent[] {
  return Object.keys(after).map((field) => ({
    kind: "field" as const,
    // Filling an empty field is an addition, not a correction of the model.
    label: (before[field] === null || before[field] === undefined || before[field] === "" ? "added" : "corrected") as FeedbackLabel,
    item: { field },
    before: before[field] ?? null,
    after: after[field] ?? null,
    producer: producerFor(field, latestRuns),
  }));
}

export function ratingFeedback(rating: number, comment: unknown, turn: { prompt_version?: string; provider?: string | null; model?: string | null; id: string }): FeedbackEvent {
  return {
    kind: "agent_turn",
    label: rating > 0 ? "thumbs_up" : "thumbs_down",
    item: { turn_id: turn.id },
    reason: cleanReason(comment),
    producer: agentProducer(turn),
  };
}

/** An undone agent action: the strongest implicit negative signal we get. */
export function revertFeedback(rev: Revision & { summary?: string; turn?: { prompt_version?: string; provider?: string | null; model?: string | null; id: string } | null }): FeedbackEvent {
  return {
    kind: "agent_action",
    label: "reverted",
    item: { revision_id: rev.id, tool: rev.tool, summary: rev.summary ?? null },
    before: rev.after,
    after: rev.before,
    producer: rev.turn ? agentProducer(rev.turn) : {},
  };
}

function agentProducer(turn: { prompt_version?: string; provider?: string | null; model?: string | null; id: string }): Producer {
  return { stage: "agent", version: turn.prompt_version ?? AGENT_PROMPT_VERSION, provider: turn.provider ?? null, model: turn.model ?? null, run_id: turn.id };
}

// ------------------------------------------------------------------ reward
/**
 * The scalar the rlhf_agent_turns view computes, mirrored here so exports and
 * tests agree with the database: an explicit rating wins; otherwise an undo is
 * a strong negative, an error or failed action a weak negative, and a change
 * that stood a weak positive.
 */
export function turnReward(t: { rating?: number | null; revertedChanges: number; error?: string | null; failedActions: number; changed: boolean }): { reward: number; source: "explicit_rating" | "undo" | "error" | "implicit" } {
  if (t.rating === 1 || t.rating === -1) return { reward: t.rating, source: "explicit_rating" };
  if (t.revertedChanges > 0) return { reward: -1, source: "undo" };
  if (t.error) return { reward: -0.5, source: "error" };
  if (t.failedActions > 0) return { reward: -0.25, source: "implicit" };
  return { reward: t.changed ? 0.25 : 0, source: "implicit" };
}

/** Keep logged payloads bounded: no megabyte blobs in a log row. */
export function boundedJson<T>(value: T, maxChars = 20_000): T | { truncated: true; preview: string } {
  const s = JSON.stringify(value ?? null);
  return s.length <= maxChars ? value : { truncated: true, preview: s.slice(0, maxChars) };
}
