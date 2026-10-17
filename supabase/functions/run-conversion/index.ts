import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { captureSync } from "../_shared/docsend-capture-client.ts";
import { parseCaptureReport } from "../_shared/agent-sessions-core.ts";
import { downloadOutput, listOutputs, startCaptureSession } from "../_shared/managed-agents.ts";
import { captureBackend } from "../_shared/agent-flags.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * The public converter is unauthenticated and each capture session costs
 * money, so agent captures are capped per hour across all visitors.
 */
const DEFAULT_HOURLY_CAP = 20;

function scheduleBackgroundTask(task: Promise<unknown>) {
  const edgeRuntime = (globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(task);
  else void task;
}

function adminClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

/** Stores the PDF, completes the job and emails the submitter. Shared by both capture backends. */
async function completeJob(job: { id: string; token: string; company_name?: string | null }, pdfBytes: Uint8Array, pageCount: number, title: string | null) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = adminClient();
  const storagePath = `conversions/${job.token}.pdf`;

  const { error: uploadErr } = await admin.storage
    .from("decks")
    .upload(storagePath, new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" }), {
      upsert: true,
    });

  if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);

  await admin
    .from("conversion_jobs")
    .update({
      status: "complete",
      pdf_storage_path: storagePath,
      page_count: pageCount ?? 0,
      title: title ?? job.company_name ?? null,
      error_message: null,
    })
    .eq("id", job.id);

  // Fire notification (non-blocking best-effort)
  try {
    await fetch(`${supabaseUrl}/functions/v1/send-conversion-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ jobId: job.id }),
    });
  } catch (e) {
    console.error("Notification dispatch failed:", e);
  }
}

async function failJob(jobId: string, message: string) {
  await adminClient().from("conversion_jobs").update({ status: "failed", error_message: message }).eq("id", jobId);
}

async function processJob(jobId: string) {
  const captureUrl = Deno.env.get("DOCSEND_CAPTURE_SERVICE_URL");
  const captureKey = Deno.env.get("DOCSEND_CAPTURE_SERVICE_API_KEY");
  const admin = adminClient();

  const { data: job, error: jobErr } = await admin
    .from("conversion_jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (jobErr || !job) {
    console.error("Job not found:", jobId, jobErr);
    return;
  }

  if (captureBackend() === "agent") {
    const cap = Number(Deno.env.get("CONVERSION_HOURLY_CAP") ?? DEFAULT_HOURLY_CAP);
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from("conversion_jobs").select("id", { count: "exact", head: true })
      .not("agent_session_id", "is", null).gte("created_at", since);
    if ((count ?? 0) >= cap) {
      await failJob(jobId, "The converter is busy right now. Please try again in an hour.");
      return;
    }
    try {
      const { sessionId } = await startCaptureSession({
        kind: "conversion",
        url: job.source_url,
        gateEmail: Deno.env.get("DOC_VIEWER_GATE_EMAIL") ?? null,
        maxPages: 50,
        ids: { conversion_job_id: job.id },
        title: `Convert ${job.company_name ?? job.token}`,
      });
      await admin.from("conversion_jobs").update({ status: "capturing", agent_session_id: sessionId }).eq("id", jobId);
    } catch (e) {
      console.error(`run-conversion job ${jobId} could not start the capture agent:`, e);
      await failJob(jobId, "Capture could not be started.");
    }
    return;
  }

  if (!captureUrl || !captureKey) {
    await failJob(jobId, "Capture service not configured");
    return;
  }

  await admin.from("conversion_jobs").update({ status: "capturing" }).eq("id", jobId);

  try {
    const result = await captureSync({
      apiKey: captureKey,
      baseUrl: captureUrl,
      url: job.source_url,
      maxPages: 50,
    });
    const pdfBytes = Uint8Array.from(atob(result.pdfBase64), (c) => c.charCodeAt(0));
    await completeJob(job, pdfBytes, result.pageCount, result.title);
  } catch (e) {
    console.error(`run-conversion job ${jobId} failed:`, e);
    await failJob(jobId, e instanceof Error ? e.message : "Capture failed");
  }
}

/** agent-webhook: the capture session for a conversion went idle. */
async function completeAgentJob(sessionId: string, failureReason: string | null) {
  const admin = adminClient();
  const { data: job } = await admin.from("conversion_jobs").select("*").eq("agent_session_id", sessionId).maybeSingle();
  if (!job) return { error: "No conversion job for this session" };
  if (job.status === "complete" || job.status === "failed") return { already: job.status };
  try {
    if (failureReason) throw new Error(failureReason);
    const outputs = await listOutputs(sessionId);
    const reportId = outputs.get("capture.json");
    if (!reportId) throw new Error("Capture finished without a report.");
    const report = parseCaptureReport(new TextDecoder().decode(await downloadOutput(reportId)));
    if (report.status === "failed") throw new Error(report.reason);
    const pdfId = outputs.get("deck.pdf");
    if (!pdfId) throw new Error("Capture finished without a PDF.");
    await completeJob(job, await downloadOutput(pdfId), report.page_count, report.title);
    return { success: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Capture failed";
    await failJob(job.id, message);
    return { success: false, error: message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  // Only submit-conversion and agent-webhook call this; both use the service-role key.
  if (req.headers.get("Authorization") !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  try {
    const { jobId, completeSessionId, failureReason } = await req.json();
    if (completeSessionId) {
      const result = await completeAgentJob(completeSessionId, failureReason ?? null);
      return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!jobId) {
      return new Response(JSON.stringify({ error: "jobId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    scheduleBackgroundTask(processJob(jobId));
    return new Response(JSON.stringify({ scheduled: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
