import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { captureSync } from "../_shared/docsend-capture-client.ts";
import { capturedDeckPath } from "../_shared/deck-sources.ts";
import { parseCaptureReport } from "../_shared/agent-sessions-core.ts";
import { downloadOutput, listOutputs, retrieveSession, startCaptureSession } from "../_shared/managed-agents.ts";
import { captureBackend } from "../_shared/agent-flags.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DEFAULT_MAX_PAGES = 50;

type RunDocsendCaptureRequest = {
  /** Link an additional deck to an existing deal instead of (re)capturing its primary deck. */
  attach?: boolean;
  dealId?: string;
  gateEmail?: string | null;
  jobId?: string;
  maxPages?: number;
  passcode?: string | null;
  url?: string;
  /** Internal (agent-webhook): finish the capture produced by this Managed Agents session. */
  completeSessionId?: string;
  failureReason?: string | null;
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

function pdfBytesFromBase64(pdfBase64: string): Uint8Array {
  return Uint8Array.from(atob(pdfBase64), (char) => char.charCodeAt(0));
}

async function markCaptureFailure(
  supabaseUrl: string,
  supabaseServiceKey: string,
  dealId: string,
  jobId: string | null,
  message: string,
  attach = false,
) {
  const adminClient = createClient(supabaseUrl, supabaseServiceKey);
  const updatedAt = new Date().toISOString();

  if (jobId) {
    await adminClient
      .from("capture_jobs")
      .update({ status: "failed", error_message: message, updated_at: updatedAt })
      .eq("id", jobId);
  }

  // A failed *additional* deck must not flip a healthy deal to "error".
  if (attach) return;

  await adminClient
    .from("deals")
    .update({ status: "error", updated_at: updatedAt })
    .eq("id", dealId);
}

/** Attached capture: always a NEW, non-primary source row; returns its id. */
async function insertAttachedSource(
  adminClient: any,
  dealId: string,
  userId: string,
  sourceType: string,
  storagePath: string,
  fileName: string,
  originalSize: string,
  previewImages?: string[] | null,
): Promise<string> {
  const { data, error } = await adminClient.from("sources").insert({
    deal_id: dealId,
    user_id: userId,
    source_type: sourceType,
    file_name: fileName,
    original_size: originalSize,
    storage_path: storagePath,
    processing_status: "uploaded",
    is_primary: false,
    ...(previewImages?.length ? { preview_images: previewImages } : {}),
  }).select("id").single();
  if (error || !data) throw new Error(`Failed to create attached source: ${error?.message ?? "unknown"}`);
  return data.id as string;
}

async function prepareCaptureJob(
  adminClient: any,
  dealId: string,
  userId: string,
  url: string,
  jobId?: string,
  attach = false,
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
      attach,
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
  previewImages?: string[] | null,
) {
  const { data: existingSource, error: existingSourceError } = await adminClient
    .from("sources")
    .select("id")
    .eq("deal_id", dealId)
    .eq("user_id", userId)
    .eq("source_type", sourceType)
    // Re-capturing the deal's own link must refresh its primary deck, not an
    // attached deck that happens to be newer.
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingSourceError) {
    throw new Error(`Failed to look up source record: ${existingSourceError.message}`);
  }

  const payload: Record<string, unknown> = {
    file_name: fileName,
    original_size: originalSize,
    storage_path: storagePath,
    processing_status: "uploaded",
  };

  if (previewImages?.length) {
    payload.preview_images = previewImages;
  }

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
  attachSourceId?: string,
) {
  const response = await fetch(`${supabaseUrl}/functions/v1/process-deck`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseServiceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      attachSourceId
        ? { dealId, storagePath, attach: true, sourceId: attachSourceId }
        : { dealId, storagePath, skipCompression: true },
    ),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ProcessDeckHandoffError(`process-deck failed [${response.status}]: ${errorText}`);
  }
}

async function processCaptureInBackground(args: {
  attach: boolean;
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
  const captureResult = await captureSync({
    apiKey: args.captureServiceApiKey,
    baseUrl: args.captureServiceUrl,
    gateEmail: args.gateEmail,
    maxPages: args.maxPages,
    url: args.url,
  });
  await finishCapture(args, {
    pdfBytes: pdfBytesFromBase64(captureResult.pdfBase64),
    pageCount: captureResult.pageCount,
    previewImages: captureResult.previewImages,
  });
}

type CapturedDeck = { pdfBytes: Uint8Array; pageCount: number; previewImages: string[] };

/**
 * Everything after the PDF exists: store it, record the source, complete the
 * job and hand off to process-deck. Shared by the Cloud Run path and the
 * Managed Agents capture session (completed via agent-webhook).
 */
async function finishCapture(
  args: {
    attach: boolean;
    dealId: string;
    dealSource?: string | null;
    jobId: string;
    supabaseServiceKey: string;
    supabaseUrl: string;
    url: string;
    userId: string;
  },
  captureResult: CapturedDeck,
) {
  const adminClient = createClient(args.supabaseUrl, args.supabaseServiceKey);
  const pdfBytes = captureResult.pdfBytes;
  const sizeMB = `${(pdfBytes.length / (1024 * 1024)).toFixed(1)}MB`;
  // The primary capture keeps deck.pdf; an attached deck gets its own file so
  // it can never overwrite the primary.
  const storagePath = capturedDeckPath(args.userId, args.dealId, args.attach ? args.jobId : null);
  const updatedAt = new Date().toISOString();
  const sourceType = deriveSourceType(args.url, args.dealSource);
  const fileName = `${sourceType}-${extractSlug(args.url)}.pdf`;
  if (captureResult.previewImages.length > 0) {
    console.log(`Captured ${captureResult.previewImages.length} preview slide image(s) for multimodal analysis`);
  }

  const { error: uploadError } = await adminClient.storage
    .from("decks")
    .upload(storagePath, new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" }), {
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Failed to upload captured PDF: ${uploadError.message}`);
  }

  let attachSourceId: string | undefined;
  if (args.attach) {
    attachSourceId = await insertAttachedSource(
      adminClient, args.dealId, args.userId, sourceType, storagePath, fileName, sizeMB, captureResult.previewImages,
    );
  } else {
    await upsertCapturedSource(
      adminClient,
      args.dealId,
      args.userId,
      sourceType,
      storagePath,
      fileName,
      sizeMB,
      captureResult.previewImages,
    );

    // Deck size and page count describe the PRIMARY deck; an attached deck
    // leaves them alone.
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
    await handOffToProcessDeck(args.supabaseUrl, args.supabaseServiceKey, args.dealId, storagePath, attachSourceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "process-deck handoff failed";
    if (!args.attach) {
      await adminClient
        .from("deals")
        .update({ status: "error", updated_at: new Date().toISOString() })
        .eq("id", args.dealId);
    }
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
 * Completes a capture whose Managed Agents session has gone idle. Called by
 * agent-webhook with the service-role key: { completeSessionId, failureReason? }.
 */
async function completeAgentCapture(
  supabaseUrl: string,
  supabaseServiceKey: string,
  sessionId: string,
  failureReason: string | null,
): Promise<Response> {
  const adminClient = createClient(supabaseUrl, supabaseServiceKey);
  const { data: job } = await adminClient
    .from("capture_jobs")
    .select("id, deal_id, user_id, status")
    .eq("agent_session_id", sessionId)
    .maybeSingle();
  if (!job) return jsonResponse({ error: "No capture job for this session" }, 404);
  if (job.status === "completed" || job.status === "failed") return jsonResponse({ success: true, already: job.status });

  const session = await retrieveSession(sessionId);
  const meta = (session.metadata ?? {}) as Record<string, string>;
  const attach = meta.attach === "1";
  const url = meta.url ?? "";

  try {
    if (failureReason) throw new Error(failureReason);
    const outputs = await listOutputs(sessionId);
    const reportId = outputs.get("capture.json");
    if (!reportId) throw new Error("The capture agent finished without writing capture.json.");
    const report = parseCaptureReport(new TextDecoder().decode(await downloadOutput(reportId)));
    if (report.status === "failed") throw new Error(report.reason);
    const pdfId = outputs.get("deck.pdf");
    if (!pdfId) throw new Error("The capture agent reported success but wrote no deck.pdf.");

    const previewImages: string[] = [];
    for (const name of report.previews) {
      const id = outputs.get(name);
      if (id) previewImages.push(`data:image/${name.endsWith(".png") ? "png" : "jpeg"};base64,${bytesToBase64(await downloadOutput(id))}`);
    }

    await finishCapture(
      {
        attach,
        dealId: job.deal_id as string,
        dealSource: meta.deal_source ?? null,
        jobId: job.id as string,
        supabaseServiceKey,
        supabaseUrl,
        url,
        userId: job.user_id as string,
      },
      { pdfBytes: await downloadOutput(pdfId), pageCount: report.page_count, previewImages },
    );
    return jsonResponse({ success: true, jobId: job.id, pages: report.page_count });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Capture failed";
    if (!(error instanceof ProcessDeckHandoffError)) {
      await markCaptureFailure(supabaseUrl, supabaseServiceKey, job.deal_id as string, job.id as string, message, attach);
    }
    return jsonResponse({ success: false, error: message }, 200);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/**
 * Run DocSend Capture — background orchestration
 *
 * By default the deck is captured by a Claude Managed Agents session
 * (managed-agents/agents/deck-capture.md) and finished by agent-webhook.
 * CAPTURE_BACKEND=cloud-run keeps the old Cloud Run /capture service until it
 * is retired. All job tracking, storage writes, and pipeline handoff stay in Supabase.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let scheduledJobId: string | null = null;
  let scheduledDealId: string | null = null;
  let scheduledAttach = false;

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

    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    const isInternalCall = bearer === supabaseServiceKey;

    const requestBody = (await req.json()) as RunDocsendCaptureRequest;
    if (requestBody?.completeSessionId) {
      if (!isInternalCall) return jsonResponse({ error: "Unauthorized" }, 401);
      return await completeAgentCapture(supabaseUrl, supabaseServiceKey, requestBody.completeSessionId, requestBody.failureReason ?? null);
    }
    const dealId = requestBody?.dealId?.trim();
    const url = requestBody?.url?.trim();
    const requestedMaxPages = typeof requestBody?.maxPages === "number" ? requestBody.maxPages : DEFAULT_MAX_PAGES;
    const maxPages = Math.max(1, Math.min(100, requestedMaxPages));
    const gateEmail = requestBody?.gateEmail ?? null;
    const attach = requestBody?.attach === true;

    let actorId: string | null = null;
    if (isInternalCall) {
      // Trusted server-to-server call (e.g. public-intake); owner comes from the deal row.
      actorId = null;
    } else {
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
      actorId = user.id;
    }

    if (!dealId || !url) {
      return new Response(JSON.stringify({ error: "Missing dealId or url" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let dealQuery = adminClient
      .from("deals")
      .select("id, source, user_id")
      .eq("id", dealId);
    if (actorId) dealQuery = dealQuery.eq("user_id", actorId);

    const { data: deal, error: dealError } = await dealQuery.single();

    if (dealError || !deal) {
      return new Response(JSON.stringify({ error: "Deal not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ownerId = actorId ?? (deal as { user_id: string }).user_id;

    const captureJob = await prepareCaptureJob(
      adminClient,
      dealId,
      ownerId,
      url,
      requestBody?.jobId?.trim(),
      attach,
    );
    scheduledJobId = captureJob.id;
    scheduledDealId = dealId;
    scheduledAttach = attach;

    // Attaching a deck leaves the deal's status alone: the deal stays usable
    // (and "memo-ready") while the extra deck is captured in the background.
    if (!attach) {
      await adminClient
        .from("deals")
        .update({ status: "scraping", updated_at: new Date().toISOString() })
        .eq("id", dealId);
    }

    if (captureBackend() === "agent") {
      try {
        const { sessionId, consoleUrl } = await startCaptureSession({
          kind: "capture",
          url,
          gateEmail: gateEmail || Deno.env.get("DOC_VIEWER_GATE_EMAIL") || null,
          passcode: requestBody?.passcode ?? null,
          maxPages,
          ids: { job_id: captureJob.id, deal_id: dealId, user_id: ownerId, attach: attach ? "1" : "", deal_source: deal.source, url },
          title: `Capture ${extractSlug(url)}`,
        });
        await adminClient.from("capture_jobs").update({ agent_session_id: sessionId, updated_at: new Date().toISOString() }).eq("id", captureJob.id);
        console.log(`Capture session ${sessionId} for job ${captureJob.id}: ${consoleUrl}`);
        return jsonResponse({ success: true, dealId, jobId: captureJob.id, scheduled: true, attach, sessionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not start the capture agent";
        await markCaptureFailure(supabaseUrl, supabaseServiceKey, dealId, captureJob.id, message, attach);
        return jsonResponse({ error: message }, 502);
      }
    }

    if (!captureServiceUrl || !captureServiceApiKey) {
      const errorMessage = "DocSend capture service is not configured";
      await markCaptureFailure(supabaseUrl, supabaseServiceKey, dealId, captureJob.id, errorMessage, attach);
      return new Response(
        JSON.stringify({ error: errorMessage }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const backgroundTask = processCaptureInBackground({
      attach,
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
      userId: ownerId,
    }).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Unknown capture error";
      console.error(`run-docsend-capture background error for job ${captureJob.id}:`, error);
      if (error instanceof ProcessDeckHandoffError) {
        return;
      }
      await markCaptureFailure(supabaseUrl, supabaseServiceKey, dealId, captureJob.id, message, attach);
    });

    scheduleBackgroundTask(backgroundTask);

    return new Response(
      JSON.stringify({ success: true, dealId, jobId: captureJob.id, scheduled: true, attach }),
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
        scheduledAttach,
      );
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
