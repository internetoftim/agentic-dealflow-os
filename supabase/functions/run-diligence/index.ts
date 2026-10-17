// Starts a Claude Managed Agents diligence session for one deal: the Deal
// Analyst coordinator plus the Due Diligence and Market & Competition agents
// (managed-agents/agents/*.md). Called by process-deck after a new deck (when
// DILIGENCE_AGENT=on), by the MCP server's run_diligence tool, and by the app.
// The session runs in the background; agent-webhook saves its results.
//
// POST { dealId, trigger?: "pipeline" | "mcp" | "app" }
// Auth: the service-role key (internal callers) or the deal owner's JWT.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildDealInput, DILIGENCE_VERSION } from "../_shared/agent-sessions-core.ts";
import { startDiligenceSession } from "../_shared/managed-agents.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ACTIVE_STATUSES = ["starting", "running", "collecting"];
/** A run still "active" after this long is treated as stuck and may be replaced. */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const authHeader = req.headers.get("Authorization") ?? "";
  const body = await req.json().catch(() => ({}));
  const dealId = typeof body?.dealId === "string" ? body.dealId : "";
  const trigger = ["pipeline", "mcp", "app"].includes(body?.trigger) ? body.trigger : "app";
  if (!dealId) return respond({ error: "Missing dealId" }, 400);

  // Resolve the owner: internal callers pass the service-role key, the app passes the user's JWT.
  let userId: string | null = null;
  if (authHeader === `Bearer ${serviceKey}`) {
    const { data } = await admin.from("deals").select("user_id").eq("id", dealId).maybeSingle();
    userId = (data?.user_id as string | undefined) ?? null;
  } else if (authHeader) {
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    userId = user?.id ?? null;
  }
  if (!userId) return respond({ error: "Unauthorized" }, 401);

  const { data: deal } = await admin.from("deals").select("*").eq("id", dealId).eq("user_id", userId).maybeSingle();
  if (!deal) return respond({ error: "Deal not found" }, 404);

  // One live run per deal: return the active one instead of paying twice.
  const { data: active } = await admin.from("deal_diligence_runs")
    .select("id, session_id, status, created_at")
    .eq("deal_id", dealId).in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (active && Date.now() - new Date(active.created_at as string).getTime() < STALE_AFTER_MS) {
    return respond({ started: false, already_running: true, run_id: active.id, session_id: active.session_id, status: active.status });
  }

  const { data: run, error: runError } = await admin.from("deal_diligence_runs")
    .insert({ deal_id: dealId, user_id: userId, trigger, version: DILIGENCE_VERSION, status: "starting" })
    .select("id").single();
  if (runError || !run) return respond({ error: `Could not record the run: ${runError?.message}` }, 500);

  try {
    const [{ data: people }, { data: sources }, { data: notes }] = await Promise.all([
      admin.from("deal_people").select("name, title, linkedin_url, manual").eq("deal_id", dealId),
      admin.from("sources").select("storage_path, extracted_text, is_primary, source_type, created_at")
        .eq("deal_id", dealId).eq("user_id", userId)
        .order("is_primary", { ascending: false }).order("created_at", { ascending: false }),
      admin.from("deal_notes").select("content").eq("deal_id", dealId).order("created_at", { ascending: true }),
    ]);

    // The primary deck goes in as a PDF so the agent can read the slides, not just the extracted text.
    let deckPdf: Uint8Array | null = null;
    const primaryPdf = (sources ?? []).find((s) => typeof s.storage_path === "string" && s.storage_path.toLowerCase().endsWith(".pdf"));
    if (primaryPdf) {
      const { data: file } = await admin.storage.from("decks").download(primaryPdf.storage_path as string);
      if (file) deckPdf = new Uint8Array(await file.arrayBuffer());
    }

    const dealInput = buildDealInput(deal, people ?? [], sources ?? [], (notes ?? []).map((n) => String(n.content ?? "")));
    const { sessionId, consoleUrl } = await startDiligenceSession({
      dealInput,
      deckPdf,
      ids: { deal_id: dealId, user_id: userId, run_id: run.id },
      title: `Diligence: ${deal.name ?? dealId}`,
    });

    await Promise.all([
      admin.from("deal_diligence_runs").update({ session_id: sessionId, status: "running", updated_at: new Date().toISOString() }).eq("id", run.id),
      admin.from("deals").update({ deep_research_status: "researching", updated_at: new Date().toISOString() }).eq("id", dealId),
    ]);
    console.log(`Diligence session ${sessionId} started for deal ${dealId}: ${consoleUrl}`);
    return respond({ started: true, run_id: run.id, session_id: sessionId, console_url: consoleUrl });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("run-diligence failed:", message);
    await Promise.all([
      admin.from("deal_diligence_runs").update({ status: "failed", error: message.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", run.id),
      admin.from("deals").update({ deep_research_status: "failed", updated_at: new Date().toISOString() }).eq("id", dealId),
    ]);
    return respond({ error: message, run_id: run.id }, 502);
  }
});
