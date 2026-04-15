import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { captureSync } from "../_shared/docsend-capture-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DEFAULT_MAX_PAGES = 50;

type RunDocsendCaptureRequest = {
  dealId?: string;
  gateEmail?: string | null;
  jobId?: string;
  maxPages?: number;
  url?: string;
};

type CaptureJobRecord = {
  id: string;
};

class ProcessDeckHandoffError extends Error {}

function extractSlug(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  } catch {
    return "unknown";
  }
}

function deriveSourceType(url: string, fallbackSource?: string | null): string {
  if (/docsend\.com/i.test(url)) return "docsend";
  if (/pandadoc\.com/i.test(url)) return "pandadoc";
  if (/papermark\.(com|io)/i.test(url)) return "papermark";
  return fallbackSource || "docsend";
}

/** Decode base64 in aligned chunks to avoid massive intermediate strings. */
function pdfBytesFromBase64(pdfBase64: string): Uint8Array {
  // Each 4 base64 chars = 3 bytes; decode in ~48KB chunks (must be multiple of 4)
  const CHUNK = 65536 - (65536 % 4); // 65536 aligned to 4
  const parts: Uint8Array[] = [];
  let totalLen = 0;
  for (let i = 0; i < pdfBase64.length; i += CHUNK) {
    const slice = pdfBase64.slice(i, i + CHUNK);
    const decoded = atob(slice);
    const chunk = new Uint8Array(decoded.length);
    for (let j = 0; j < decoded.length; j++) {
      chunk[j] = decoded.charCodeAt(j);
    }
    parts.push(chunk);
    totalLen += chunk.length;
  }
  // Merge into single array
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function markCaptureFailure(
  supabaseUrl: string,
  supabaseServiceKey: string,
  dealId: string,
  jobId: string | null,
  message: string,
) {
  const adminClient = createClient(supabaseUrl, supabaseServiceKey);
  const updatedAt = new Date().toISOString();

  if (jobId) {
    await adminClient
      .from("capture_jobs")
      .update({ status: "failed", error_message: message, updated_at: updatedAt })
      .eq("id", jobId);
  }

  await adminClient
    .from("deals")
    .update({ status: "error", updated_at: updatedAt })
    .eq("id", dealId);
}

async function prepareCaptureJob(
  adminClient: any,
  dealId: string,
  userId: string,
  url: string,
  jobId?: string,
): Promise<CaptureJobRecord> {
  const updatedAt = new Date().toISOString();

  if (jobId) {
    const { data, error } = await adminClient
      .from("capture_jobs")
      .update({
        status: "processing",
        error_message: null,
        updated_at: updatedAt,
        url,
      })
      .eq("id", jobId)
      .eq("deal_id", dealId)
      .eq("user_id", userId)
      .select("id")
      .single();

    if (error || !data) {
      throw new Error(`Failed to prepare capture job: ${error?.message ?? "Missing capture job"}`);
    }

    return data as CaptureJobRecord;
  }

  const { data, error } = await adminClient
    .from("capture_jobs")
    .insert({
      deal_id: dealId,
      user_id: userId,
      url,
      status: "processing",
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create capture job: ${error?.message ?? "Unknown error"}`);
  }

  return data as CaptureJobRecord;
}

async function upsertCapturedSource(
  adminClient: any,
  dealId: string,
  userId: string,
  sourceType: string,
  storagePath: string,
  fileName: string,
  originalSize: string,
) {
  const { data: existingSource, error: existingSourceError } = await adminClient
    .from("sources")
    .select("id")
    .eq("deal_id", dealId)
    .eq("user_id", userId)
    .eq("source_type", sourceType)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingSourceError) {
    throw new Error(`Failed to look up source record: ${existingSourceError.message}`);
  }

  const payload = {
    file_name: fileName,
    original_size: originalSize,
    storage_path: storagePath,
    processing_status: "uploaded",
  };

  if (existingSource?.id) {
    const { error } = await adminClient
      .from("sources")
      .update(payload)
      .eq("id", existingSource.id);
    if (error) {
      throw new Error(`Failed to update captured source: ${error.message}`);
    }
    return;
  }

  const { error } = await adminClient.from("sources").insert({
    deal_id: dealId,
    user_id: userId,
    source_type: sourceType,
    ...payload,
  });
  if (error) {
    throw new Error(`Failed to create captured source: ${error.message}`);
  }
}

async function handOffToProcessDeck(
  supabaseUrl: string,
  supabaseServiceKey: string,
  dealId: string,
  storagePath: string,
) {
  const response = await fetch(`${supabaseUrl}/functions/v1/process-deck`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseServiceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ dealId, storagePath, skipCompression: true }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ProcessDeckHandoffError(`process-deck failed [${response.status}]: ${errorText}`);
  }
}

async function processCaptureInBackground(args: {
  captureServiceApiKey: string;
  captureServiceUrl: string;
  dealId: string;
  dealSource?: string | null;
  gateEmail?: string | null;
  jobId: string;
  maxPages: number;
  supabaseServiceKey: string;
  supabaseUrl: string;
  url: string;
  userId: string;
}) {
  const adminClient = createClient(args.supabaseUrl, args.supabaseServiceKey);
  const captureResult = await captureSync({
    apiKey: args.captureServiceApiKey,
    baseUrl: args.captureServiceUrl,
    gateEmail: args.gateEmail,
    maxPages: args.maxPages,
    url: args.url,
  });

  const pdfBytes = pdfBytesFromBase64(captureResult.pdfBase64);
  const sizeMB = `${(pdfBytes.length / (1024 * 1024)).toFixed(1)}MB`;
  const storagePath = `${args.userId}/${args.dealId}/deck.pdf`;
  const updatedAt = new Date().toISOString();
  const sourceType = deriveSourceType(args.url, args.dealSource);
  const fileName = `${sourceType}-${extractSlug(args.url)}.pdf`;

  const { error: uploadError } = await adminClient.storage
    .from("decks")
    .upload(storagePath, new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" }), {
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Failed to upload captured PDF: ${uploadError.message}`);
  }

  await upsertCapturedSource(
    adminClient,
    args.dealId,
    args.userId,
    sourceType,
    storagePath,
    fileName,
    sizeMB,
  );

  const { error: dealUpdateError } = await adminClient
    .from("deals")
    .update({
      deck_size: sizeMB,
      pages: captureResult.pageCount || 0,
      updated_at: updatedAt,
    })
    .eq("id", args.dealId);

  if (dealUpdateError) {
    throw new Error(`Failed to update deal after capture: ${dealUpdateError.message}`);
  }

  const { error: jobCompleteError } = await adminClient
    .from("capture_jobs")
    .update({
      status: "completed",
      error_message: null,
      updated_at: updatedAt,
    })
    .eq("id", args.jobId);

  if (jobCompleteError) {
    throw new Error(`Failed to complete capture job: ${jobCompleteError.message}`);
  }

  try {
    await handOffToProcessDeck(args.supabaseUrl, args.supabaseServiceKey, args.dealId, storagePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "process-deck handoff failed";
    await adminClient
      .from("deals")
      .update({ status: "error", updated_at: new Date().toISOString() })
      .eq("id", args.dealId);
    throw new ProcessDeckHandoffError(message);
  }
}

function scheduleBackgroundTask(task: Promise<unknown>) {
  const edgeRuntime = (globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).EdgeRuntime;

  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(task);
    return;
  }

  void task;
}

/**
 * Run DocSend Capture — background orchestration
 *
 * Uses the existing Cloud Run /capture endpoint as a pure print service.
 * All job tracking, storage writes, and pipeline handoff stay in Supabase.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let scheduledJobId: string | null = null;
  let scheduledDealId: string | null = null;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const captureServiceUrl = Deno.env.get("DOCSEND_CAPTURE_SERVICE_URL");
    const captureServiceApiKey = Deno.env.get("DOCSEND_CAPTURE_SERVICE_API_KEY");

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const requestBody = (await req.json()) as RunDocsendCaptureRequest;
    const dealId = requestBody?.dealId?.trim();
    const url = requestBody?.url?.trim();
    const requestedMaxPages = typeof requestBody?.maxPages === "number" ? requestBody.maxPages : DEFAULT_MAX_PAGES;
    const maxPages = Math.max(1, Math.min(100, requestedMaxPages));
    const gateEmail = requestBody?.gateEmail ?? null;

    if (!dealId || !url) {
      return new Response(JSON.stringify({ error: "Missing dealId or url" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: deal, error: dealError } = await adminClient
      .from("deals")
      .select("id, source")
      .eq("id", dealId)
      .eq("user_id", user.id)
      .single();

    if (dealError || !deal) {
      return new Response(JSON.stringify({ error: "Deal not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const captureJob = await prepareCaptureJob(
      adminClient,
      dealId,
      user.id,
      url,
      requestBody?.jobId?.trim(),
    );
    scheduledJobId = captureJob.id;
    scheduledDealId = dealId;

    await adminClient
      .from("deals")
      .update({ status: "scraping", updated_at: new Date().toISOString() })
      .eq("id", dealId);

    if (!captureServiceUrl || !captureServiceApiKey) {
      const errorMessage = "DocSend capture service is not configured";
      await markCaptureFailure(supabaseUrl, supabaseServiceKey, dealId, captureJob.id, errorMessage);
      return new Response(
        JSON.stringify({ error: errorMessage }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const backgroundTask = processCaptureInBackground({
      captureServiceApiKey,
      captureServiceUrl,
      dealId,
      dealSource: deal.source,
      gateEmail,
      jobId: captureJob.id,
      maxPages,
      supabaseServiceKey,
      supabaseUrl,
      url,
      userId: user.id,
    }).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Unknown capture error";
      console.error(`run-docsend-capture background error for job ${captureJob.id}:`, error);
      if (error instanceof ProcessDeckHandoffError) {
        return;
      }
      await markCaptureFailure(supabaseUrl, supabaseServiceKey, dealId, captureJob.id, message);
    });

    scheduleBackgroundTask(backgroundTask);

    return new Response(
      JSON.stringify({ success: true, dealId, jobId: captureJob.id, scheduled: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("run-docsend-capture error:", error);

    if (scheduledDealId) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await markCaptureFailure(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        scheduledDealId,
        scheduledJobId,
        message,
      );
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
