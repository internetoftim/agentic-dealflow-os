// Receives Claude Managed Agents webhooks (Console -> Manage -> Webhooks,
// subscribed to session.status_idled and session.status_terminated) and
// finishes whatever the session was doing:
//   capture    -> run-docsend-capture { completeSessionId } stores the PDF and continues the pipeline
//   conversion -> run-conversion { completeSessionId } stores the PDF and emails the visitor
//   diligence  -> saved here: deal fields, researched people, the full report and memo
// Unattended sessions never wait on a person: a tool call the server paused for
// review is denied. Deliveries can repeat and arrive out of order, so every
// step re-reads state and is safe to run twice.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  dealPatchFromDiligence, diligenceMetrics, DILIGENCE_VERSION, failureMessage, idleAction, parseDiligence,
  peopleRowsFromDiligence, readSessionKind, type IdleAction,
} from "../_shared/agent-sessions-core.ts";
import { denyPendingToolCalls, downloadOutput, latestIdleStop, listOutputs, retrieveSession, unwrapWebhook } from "../_shared/managed-agents.ts";
import { logPipelineRun } from "../_shared/run-log.ts";

const HANDLED = new Set(["session.status_idled", "session.status_terminated"]);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await req.text();

  let event: { id: string; data: { type: string; id: string } };
  try {
    event = unwrapWebhook(body, req.headers) as unknown as typeof event;
  } catch (e) {
    console.warn("agent-webhook: rejected delivery:", e instanceof Error ? e.message : e);
    return new Response("invalid signature", { status: 400 });
  }
  if (!HANDLED.has(event.data.type)) return new Response(null, { status: 204 });

  const sessionId = event.data.id;
  try {
    const session = await retrieveSession(sessionId);
    const kind = readSessionKind(session.metadata);
    if (!kind) return new Response(null, { status: 204 }); // not one of EasyVC's sessions

    let action: IdleAction;
    let stopType: string | null = null;
    if (event.data.type === "session.status_terminated") {
      // Terminated after an idle we already collected is a no-op below; otherwise try to salvage outputs.
      action = "collect";
    } else {
      const stop = await latestIdleStop(sessionId);
      stopType = stop.type;
      action = idleAction(stop.type);
      if (action === "deny_pending") {
        await denyPendingToolCalls(sessionId, stop.eventIds);
        return new Response(null, { status: 204 });
      }
    }
    const failureReason = action === "collect" ? null : failureMessage(action, stopType);

    if (kind === "capture" || kind === "conversion") {
      await callInternal(kind === "capture" ? "run-docsend-capture" : "run-conversion", { completeSessionId: sessionId, failureReason });
    } else {
      await finishDiligence(sessionId, session, action, failureReason);
    }
    return new Response(null, { status: 204 });
  } catch (e) {
    // A 5xx makes Anthropic retry the delivery (up to three attempts).
    console.error(`agent-webhook: ${event.data.type} for ${sessionId} failed:`, e);
    return new Response("error", { status: 500 });
  }
});

async function callInternal(fn: string, payload: Record<string, unknown>) {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${fn}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 404) throw new Error(`${fn} returned ${res.status}: ${await res.text()}`);
}

type SessionLike = Awaited<ReturnType<typeof retrieveSession>>;

async function finishDiligence(sessionId: string, session: SessionLike, action: IdleAction, failureReason: string | null) {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = () => new Date().toISOString();
  const listCost = (session as { usage?: { list_cost?: { amount?: string } | null } }).usage?.list_cost?.amount;
  const listCostCents = listCost ? Number(listCost) : null;

  // Claim the run so a duplicate delivery doesn't save it twice.
  const { data: run } = await admin.from("deal_diligence_runs")
    .update({ status: "collecting", updated_at: now() })
    .eq("session_id", sessionId).in("status", ["starting", "running"])
    .select("id, deal_id, user_id").maybeSingle();
  if (!run) return; // already collected, or not ours

  const fail = async (status: "failed" | "budget_reached", error: string) => {
    await Promise.all([
      admin.from("deal_diligence_runs").update({ status, error, list_cost_cents: listCostCents, updated_at: now() }).eq("id", run.id),
      admin.from("deals").update({ deep_research_status: "failed", updated_at: now() }).eq("id", run.deal_id),
    ]);
    await logPipelineRun(admin, {
      deal_id: run.deal_id, user_id: run.user_id, stage: "research", version: DILIGENCE_VERSION,
      provider: "anthropic-managed-agents", model: "claude-opus-5-5", status: "failed", error,
      input: { session_id: sessionId }, metrics: { list_cost_cents: listCostCents },
    });
  };

  const outputs = await listOutputs(sessionId);
  const reportId = outputs.get("diligence.json");
  if (!reportId) {
    await fail(action === "budget_reached" ? "budget_reached" : "failed", failureReason ?? "The agent finished without writing diligence.json.");
    return;
  }

  let report;
  try {
    report = parseDiligence(new TextDecoder().decode(await downloadOutput(reportId)));
  } catch (e) {
    await fail("failed", e instanceof Error ? e.message : "diligence.json could not be read");
    return;
  }
  const memoId = outputs.get("memo.md");
  const memo = memoId ? new TextDecoder().decode(await downloadOutput(memoId)) : null;
  const metrics = { ...diligenceMetrics(report), list_cost_cents: listCostCents, partial: action !== "collect" };

  const { data: deal } = await admin.from("deals").select("website, team_size, research_exclusions, memo_draft").eq("id", run.deal_id).single();
  const dealPatch: Record<string, unknown> = { ...dealPatchFromDiligence(report, deal ?? {}), updated_at: now() };
  // The memo only fills an empty draft; a memo the investor already has is never overwritten.
  if (memo && !deal?.memo_draft) dealPatch.memo_draft = memo;
  await admin.from("deals").update(dealPatch).eq("id", run.deal_id).eq("user_id", run.user_id);

  // Replace researched people only; people the investor added by hand stay.
  const { data: manualPeople } = await admin.from("deal_people").select("name").eq("deal_id", run.deal_id).eq("manual", true);
  const rows = peopleRowsFromDiligence(report, (manualPeople ?? []).map((p) => p.name as string), deal?.research_exclusions, { dealId: run.deal_id, userId: run.user_id });
  if (rows.length > 0) {
    await admin.from("deal_people").delete().eq("deal_id", run.deal_id).eq("manual", false);
    const { error } = await admin.from("deal_people").insert(rows);
    if (error) console.error("agent-webhook: could not store researched people:", error.message);
  }

  await admin.from("deal_diligence_runs").update({
    status: action === "collect" ? "completed" : action === "budget_reached" ? "budget_reached" : "failed",
    error: failureReason,
    report, memo_md: memo, metrics, list_cost_cents: listCostCents,
    updated_at: now(), completed_at: now(),
  }).eq("id", run.id);

  await logPipelineRun(admin, {
    deal_id: run.deal_id, user_id: run.user_id, stage: "research", version: DILIGENCE_VERSION,
    provider: "anthropic-managed-agents", model: "claude-opus-5-5",
    status: action === "collect" ? "completed" : "failed", error: failureReason,
    input: { session_id: sessionId, run_id: run.id },
    output: {
      company: report.company, recommendation: report.recommendation,
      people: report.founders.map((f) => ({ name: f.name, title: f.title })),
      articles: report.news.map((n) => ({ title: n.title, url: n.url, source: n.source ?? null })),
    },
    metrics,
  });
  console.log(`Diligence run ${run.id} saved for deal ${run.deal_id}:`, JSON.stringify(metrics));
}
