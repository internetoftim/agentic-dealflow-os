import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { captureSync } from "../_shared/docsend-capture-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function scheduleBackgroundTask(task: Promise<unknown>) {
  const edgeRuntime = (globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(task);
  else void task;
}

async function processJob(jobId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const captureUrl = Deno.env.get("DOCSEND_CAPTURE_SERVICE_URL");
  const captureKey = Deno.env.get("DOCSEND_CAPTURE_SERVICE_API_KEY");
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: job, error: jobErr } = await admin
    .from("conversion_jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (jobErr || !job) {
    console.error("Job not found:", jobId, jobErr);
    return;
  }

  if (!captureUrl || !captureKey) {
    await admin
      .from("conversion_jobs")
      .update({ status: "failed", error_message: "Capture service not configured" })
      .eq("id", jobId);
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
        page_count: result.pageCount ?? 0,
        title: result.title ?? job.company_name ?? null,
        error_message: null,
      })
      .eq("id", jobId);

    // Fire notification (non-blocking best-effort)
    try {
      await fetch(`${supabaseUrl}/functions/v1/send-conversion-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ jobId }),
      });
    } catch (e) {
      console.error("Notification dispatch failed:", e);
    }
  } catch (e) {
    console.error(`run-conversion job ${jobId} failed:`, e);
    await admin
      .from("conversion_jobs")
      .update({
        status: "failed",
        error_message: e instanceof Error ? e.message : "Capture failed",
      })
      .eq("id", jobId);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const { jobId } = await req.json();
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
