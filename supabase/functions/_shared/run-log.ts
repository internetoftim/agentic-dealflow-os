// Records one row per model run in pipeline_runs: what the stage was given,
// what it produced, and which provider/model/version did it. Human feedback
// (feedback_events) points back at these rows, which is what lets us say later
// which versions worked. Logging must never break the pipeline: failures are
// swallowed and reported to the function log.

import { boundedJson, type Stage } from "./feedback-log.ts";

export type PipelineRun = {
  deal_id: string;
  user_id: string;
  stage: Stage;
  version: string;
  provider?: string | null;
  model?: string | null;
  status?: "completed" | "failed" | "unreadable" | "skipped";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  error?: string | null;
};

/** The slice of the Supabase client this module needs. */
type RunStore = {
  from(table: string): {
    insert(row: Record<string, unknown>): {
      select(columns: string): { single(): PromiseLike<{ data: { id: string } | null; error: { message: string } | null }> };
    };
  };
};

export async function logPipelineRun(adminClient: RunStore, run: PipelineRun): Promise<string | null> {
  try {
    const { data, error } = await adminClient.from("pipeline_runs").insert({
      deal_id: run.deal_id,
      user_id: run.user_id,
      stage: run.stage,
      version: run.version,
      provider: run.provider ?? null,
      model: run.model ?? null,
      status: run.status ?? "completed",
      input: boundedJson(run.input ?? {}),
      output: boundedJson(run.output ?? {}),
      metrics: boundedJson(run.metrics ?? {}),
      error: run.error ? String(run.error).slice(0, 1000) : null,
    }).select("id").single();
    if (error || !data) {
      console.warn(`pipeline run (${run.stage}) not logged:`, error?.message ?? "no row returned");
      return null;
    }
    return data.id;
  } catch (e) {
    console.warn(`pipeline run (${run.stage}) not logged:`, e instanceof Error ? e.message : e);
    return null;
  }
}
