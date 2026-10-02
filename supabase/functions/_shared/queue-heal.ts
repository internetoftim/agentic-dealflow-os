// Queue reaper. Runs from the Gmail listener's one-minute cron (the only
// server-side scheduler the project has) and after every job, so the per-user
// processing queue heals itself: zombie jobs are failed and the next queued
// deal is started even though nothing "finished" to release it.

import { planQueueHeal, PROCESSING_STATUSES, type QueueDeal } from "./job-queue.ts";

type HealContext = { adminClient: any; supabaseUrl: string; serviceKey: string };
type Row = QueueDeal & { user_id: string };

const CAPTURED = new Set(["docsend", "pandadoc", "papermark"]);

/** Dispatch process-deck for a queued deal's primary deck. Returns false if it has no stored file. */
export async function startQueuedDeal(ctx: HealContext, dealId: string): Promise<boolean> {
  const { data: sources } = await ctx.adminClient
    .from("sources")
    .select("storage_path, source_type")
    .eq("deal_id", dealId)
    .not("storage_path", "is", null)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  const source = sources?.[0];
  if (!source?.storage_path) return false;

  await ctx.adminClient.from("deals").update({ status: "uploading", updated_at: new Date().toISOString() }).eq("id", dealId);
  const dispatch = fetch(`${ctx.supabaseUrl}/functions/v1/process-deck`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dealId,
      storagePath: source.storage_path,
      ...(CAPTURED.has(String(source.source_type ?? "").toLowerCase()) ? { skipCompression: true } : {}),
    }),
  }).then(async (res) => {
    if (!res.ok) console.error(`queue-heal: process-deck for ${dealId} failed:`, res.status, await res.text().catch(() => ""));
  }).catch((e) => console.error(`queue-heal: dispatch for ${dealId} failed:`, e));
  // Do not await the whole pipeline: the caller (a cron tick) must return.
  (globalThis as any).EdgeRuntime?.waitUntil?.(dispatch);
  return true;
}

/** Heal one user's queue, or every user's when userId is omitted. */
export async function healQueues(ctx: HealContext, userId?: string): Promise<{ failed: number; started: number }> {
  let query = ctx.adminClient
    .from("deals")
    .select("id, user_id, status, updated_at, created_at")
    .in("status", [...PROCESSING_STATUSES, "queued"])
    .limit(1000);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query;
  if (error) {
    console.error("queue-heal: could not list jobs:", error.message);
    return { failed: 0, started: 0 };
  }

  const byUser = new Map<string, Row[]>();
  for (const row of (data ?? []) as Row[]) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }

  let failed = 0, started = 0;
  for (const [uid, deals] of byUser) {
    const plan = planQueueHeal(deals);
    if (plan.failIds.length) {
      await ctx.adminClient.from("deals")
        .update({ status: "error", updated_at: new Date().toISOString() })
        .in("id", plan.failIds);
      failed += plan.failIds.length;
      console.warn(`queue-heal: failed ${plan.failIds.length} stale job(s) for user ${uid}`);
    }
    if (plan.start && (await startQueuedDeal(ctx, plan.start.id))) {
      started += 1;
      console.log(`queue-heal: started queued deal ${plan.start.id} for user ${uid}`);
    }
  }
  return { failed, started };
}
