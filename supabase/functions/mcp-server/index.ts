// EasyVC MCP Server
// - MCP Streamable HTTP (JSON-RPC) at POST /
// - OAuth 2.1 endpoints (PKCE, dynamic client registration)
// - Bearer auth: Personal Access Token (pat_*) OR OAuth access token (oauth_*) OR Supabase JWT
//
// Tool tiers:
//   public       — read-only, available to every authenticated caller
//                  (list_deals, get_deal, search_deals, get_deal_context)
//   agent-read   — extra read helpers, require Agent Mode
//   agent-write  — mutations, require Agent Mode AND (for OAuth callers) mcp:write
//
// "Agent Mode" = the per-user user_settings.agent_mode_enabled opt-in flag.
// The whole write surface is gated on it: toggling it off is an instant kill
// switch. Gating logic mirrors src/lib/agentGate.ts (kept in sync by hand).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const FUNCTION_BASE = `${SUPABASE_URL}/functions/v1/mcp-server`;
const APP_ORIGIN = "https://onepointsix.ai";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, mcp-protocol-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
};

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------- crypto helpers ----------------
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256B64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomToken(prefix: string, bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  const b64 = btoa(String.fromCharCode(...arr))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${prefix}_${b64}`;
}

// ---------------- auth ----------------
type Auth = {
  userId: string;
  via: "pat" | "oauth" | "jwt";
  agentMode: boolean;
  scope: string | null;
};
type AuthResult = Auth | null;

/** Whether the user has opted into Agent Mode. One lookup per request. */
async function readAgentMode(userId: string): Promise<boolean> {
  const { data } = await admin
    .from("user_settings")
    .select("agent_mode_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean((data as { agent_mode_enabled?: boolean } | null)?.agent_mode_enabled);
}

async function authenticate(req: Request): Promise<AuthResult> {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  if (token.startsWith("pat_")) {
    const hash = await sha256Hex(token);
    const { data } = await admin
      .from("mcp_access_tokens")
      .select("user_id, revoked_at")
      .eq("token_hash", hash)
      .maybeSingle();
    if (!data || data.revoked_at) return null;
    admin.from("mcp_access_tokens").update({ last_used_at: new Date().toISOString() })
      .eq("token_hash", hash).then(() => {});
    // PATs have no scope column — they are gated by agent mode alone.
    return { userId: data.user_id, via: "pat", agentMode: await readAgentMode(data.user_id), scope: null };
  }

  if (token.startsWith("oauth_")) {
    const hash = await sha256Hex(token);
    const { data } = await admin
      .from("mcp_oauth_tokens")
      .select("user_id, revoked_at, expires_at, scope")
      .eq("access_token_hash", hash)
      .maybeSingle();
    if (!data || data.revoked_at) return null;
    if (new Date(data.expires_at) < new Date()) return null;
    return { userId: data.user_id, via: "oauth", agentMode: await readAgentMode(data.user_id), scope: (data as { scope?: string | null }).scope ?? null };
  }

  // Fallback: Supabase JWT
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: header } },
  });
  const { data, error } = await userClient.auth.getClaims(token);
  if (error || !data?.claims?.sub) return null;
  const userId = data.claims.sub as string;
  return { userId, via: "jwt", agentMode: await readAgentMode(userId), scope: null };
}

// ---------------- agent-mode gate (mirrors src/lib/agentGate.ts) ----------------
type ToolAccess = "public" | "agent-read" | "agent-write";

function parseScopes(scope: string | null | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter(Boolean);
}

function isAccessAllowed(auth: Auth, access: ToolAccess): boolean {
  if (access === "public") return true;
  if (!auth.agentMode) return false;
  if (access === "agent-write" && auth.via === "oauth") {
    return parseScopes(auth.scope).includes("mcp:write");
  }
  return true;
}

function accessOf(name: string): ToolAccess {
  const t = TOOLS.find((x) => x.name === name);
  return (t?.access as ToolAccess) ?? "agent-write";
}

function isToolAllowed(auth: Auth, name: string): boolean {
  return isAccessAllowed(auth, accessOf(name));
}

function isWriteTool(name: string): boolean {
  return accessOf(name) === "agent-write";
}

// ---------------- tool definitions ----------------
const TOOLS: Array<{ name: string; access: ToolAccess; description: string; inputSchema: any }> = [
  // ---- public (read-only) ----
  {
    name: "list_deals",
    access: "public",
    description:
      "List venture capital deals in the authenticated user's EasyVC workspace. Filter optionally by stage, status, or sector.",
    inputSchema: {
      type: "object",
      properties: {
        stage: { type: "string", description: "e.g. pre-seed, seed, series-a" },
        status: { type: "string", description: "Deal status (e.g. new, reviewing, passed)" },
        sector: { type: "string", description: "Sector or industry filter" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      },
    },
  },
  {
    name: "get_deal",
    access: "public",
    description:
      "Get full details for a single deal by id, including metadata, uploaded sources, and key people.",
    inputSchema: {
      type: "object",
      properties: { deal_id: { type: "string" } },
      required: ["deal_id"],
    },
  },
  {
    name: "search_deals",
    access: "public",
    description:
      "Search the user's deals by free-text query against company name, sector, and notes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_deal_context",
    access: "public",
    description:
      "Get the extracted text content of all sources (pitch deck pages, web pages) for a deal. Useful for grounded Q&A.",
    inputSchema: {
      type: "object",
      properties: {
        deal_id: { type: "string" },
        max_chars: { type: "integer", minimum: 1000, maximum: 200000, default: 50000 },
      },
      required: ["deal_id"],
    },
  },

  // ---- agent-read (require Agent Mode) ----
  {
    name: "list_deal_people",
    access: "agent-read",
    description: "List the key people (founders/team) recorded on a deal.",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" } }, required: ["deal_id"] },
  },
  {
    name: "list_sources",
    access: "agent-read",
    description: "List the sources (uploaded decks, attached URLs/text) on a deal.",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" } }, required: ["deal_id"] },
  },
  {
    name: "get_job_status",
    access: "agent-read",
    description: "Poll a deal's pipeline state: status (ingestion) and deep_research_status.",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" } }, required: ["deal_id"] },
  },

  // ---- agent-write (require Agent Mode + mcp:write for OAuth) ----
  {
    name: "create_deal",
    access: "agent-write",
    description: "Create a new deal in the workspace. Returns the new deal id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        sector: { type: "string" },
        website: { type: "string" },
        linkedin_url: { type: "string" },
        stage: { type: "string", description: "funding round, e.g. seed, series-a" },
        ask_amount: { type: "string" },
        valuation: { type: "string" },
        revenue: { type: "string" },
        growth: { type: "string" },
        nrr: { type: "string" },
        team_size: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_deal",
    access: "agent-write",
    description:
      "Update whitelisted fields on a deal. Cannot change pipeline status or stage (use the app for movement).",
    inputSchema: {
      type: "object",
      properties: {
        deal_id: { type: "string" },
        name: { type: "string" },
        sector: { type: "string" },
        website: { type: "string" },
        linkedin_url: { type: "string" },
        ask_amount: { type: "string" },
        valuation: { type: "string" },
        revenue: { type: "string" },
        growth: { type: "string" },
        nrr: { type: "string" },
        team_size: { type: "string" },
      },
      required: ["deal_id"],
    },
  },
  {
    name: "delete_deal",
    access: "agent-write",
    description: "Delete a deal and its people, sources, notes, and capture jobs.",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" } }, required: ["deal_id"] },
  },
  {
    name: "add_deal_person",
    access: "agent-write",
    description: "Add a key person (e.g. a founder) to a deal, with an optional title and LinkedIn URL.",
    inputSchema: {
      type: "object",
      properties: {
        deal_id: { type: "string" },
        name: { type: "string" },
        title: { type: "string" },
        linkedin_url: { type: "string" },
      },
      required: ["deal_id", "name"],
    },
  },
  {
    name: "update_deal_person",
    access: "agent-write",
    description: "Update a person's name, title, or LinkedIn URL.",
    inputSchema: {
      type: "object",
      properties: {
        person_id: { type: "string" },
        name: { type: "string" },
        title: { type: "string" },
        linkedin_url: { type: "string" },
      },
      required: ["person_id"],
    },
  },
  {
    name: "remove_deal_person",
    access: "agent-write",
    description: "Remove a person from a deal.",
    inputSchema: { type: "object", properties: { person_id: { type: "string" } }, required: ["person_id"] },
  },
  {
    name: "attach_source_url",
    access: "agent-write",
    description: "Attach a reference URL to a deal as a source.",
    inputSchema: {
      type: "object",
      properties: { deal_id: { type: "string" }, url: { type: "string" }, label: { type: "string" } },
      required: ["deal_id", "url"],
    },
  },
  {
    name: "attach_source_text",
    access: "agent-write",
    description: "Attach freeform text to a deal as a source (becomes part of deal context).",
    inputSchema: {
      type: "object",
      properties: { deal_id: { type: "string" }, text: { type: "string" }, label: { type: "string" } },
      required: ["deal_id", "text"],
    },
  },
  {
    name: "attach_deck_from_url",
    access: "agent-write",
    description:
      "Record a deck/document URL on a deal as a pending source. Note: automated capture of gated viewers (DocSend/Papermark) is completed from the app; this records the reference.",
    inputSchema: {
      type: "object",
      properties: { deal_id: { type: "string" }, url: { type: "string" } },
      required: ["deal_id", "url"],
    },
  },
  {
    name: "delete_source",
    access: "agent-write",
    description: "Delete a source from a deal.",
    inputSchema: { type: "object", properties: { source_id: { type: "string" } }, required: ["source_id"] },
  },
  {
    name: "append_note",
    access: "agent-write",
    description: "Append a note to a deal's running notes log.",
    inputSchema: {
      type: "object",
      properties: { deal_id: { type: "string" }, body: { type: "string" } },
      required: ["deal_id", "body"],
    },
  },
  {
    name: "update_memo_draft",
    access: "agent-write",
    description: "Replace the deal's investment memo draft with agent-authored markdown.",
    inputSchema: {
      type: "object",
      properties: { deal_id: { type: "string" }, memo_draft: { type: "string" } },
      required: ["deal_id", "memo_draft"],
    },
  },
  {
    name: "run_deep_research",
    access: "agent-write",
    description: "Kick off EasyVC deep research on a deal (async). Poll get_job_status for progress.",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" } }, required: ["deal_id"] },
  },
  {
    name: "run_process_deck",
    access: "agent-write",
    description: "Run the deck-processing pipeline for a deal with an uploaded deck at storage_path (async).",
    inputSchema: {
      type: "object",
      properties: { deal_id: { type: "string" }, storage_path: { type: "string" } },
      required: ["deal_id", "storage_path"],
    },
  },
  {
    name: "generate_memo",
    access: "agent-write",
    description: "Generate the investment memo for a deal from its sources (async). Poll deal.memo_draft.",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" } }, required: ["deal_id"] },
  },
];

// ---------------- write-tool helpers ----------------
const WRITE_RATE_LIMIT = 120; // agent write actions per rolling hour per user
const WRITE_RATE_WINDOW_MS = 60 * 60 * 1000;

async function assertDealOwned(dealId: string, userId: string) {
  if (!dealId) throw new Error("deal_id required");
  const { data, error } = await admin
    .from("deals").select("id").eq("id", dealId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Deal not found");
}

async function enforceWriteRateLimit(userId: string) {
  const since = new Date(Date.now() - WRITE_RATE_WINDOW_MS).toISOString();
  const { count } = await admin
    .from("mcp_tool_calls")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);
  if ((count ?? 0) >= WRITE_RATE_LIMIT) {
    throw new Error(
      `Rate limit exceeded: more than ${WRITE_RATE_LIMIT} agent write actions in the last hour. Try again later.`,
    );
  }
}

async function auditToolCall(auth: Auth, tool: string, args: any) {
  const dealId = typeof args?.deal_id === "string" ? args.deal_id : null;
  let argsHash: string | null = null;
  try { argsHash = await sha256Hex(JSON.stringify(args ?? {})); } catch { /* best-effort */ }
  await admin.from("mcp_tool_calls").insert({
    user_id: auth.userId, tool, args_hash: argsHash, deal_id: dealId, via: auth.via,
  });
}

/** Fire-and-forget invoke of another edge function with the service-role key. */
function invokeEdgeFunction(fn: string, payload: unknown) {
  const p = fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify(payload),
  }).then(() => {}).catch((e) => console.error(`invoke ${fn} failed:`, e));
  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(p);
}

// ---------------- tool handlers ----------------
async function runTool(name: string, args: any, auth: Auth) {
  // Single gate for every tool: public tools always pass; agent tools require
  // Agent Mode (a thrown Error surfaces to the client as an MCP tool error and
  // is the kill switch when the flag is toggled off).
  if (!isToolAllowed(auth, name)) {
    throw new Error(
      "Agent Mode is required for this tool but is not enabled for this account. " +
        "Enable it in EasyVC → Settings → Agent Mode." +
        (auth.via === "oauth" ? " OAuth clients additionally need the mcp:write scope." : ""),
    );
  }
  const userId = auth.userId;

  if (isWriteTool(name)) {
    await enforceWriteRateLimit(userId);
    await auditToolCall(auth, name, args);
  }

  switch (name) {
    case "list_deals": {
      let q = admin.from("deals").select("id, name, stage, sector, status, ask_amount, valuation, revenue, growth, website, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(Math.min(args?.limit ?? 25, 100));
      if (args?.stage) q = q.eq("stage", args.stage);
      if (args?.status) q = q.eq("status", args.status);
      if (args?.sector) q = q.eq("sector", args.sector);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return { deals: data ?? [], count: data?.length ?? 0 };
    }
    case "get_deal": {
      const id = String(args?.deal_id ?? "");
      if (!id) throw new Error("deal_id required");
      const [{ data: deal, error: e1 }, { data: sources }, { data: people }] = await Promise.all([
        admin.from("deals").select("*").eq("id", id).eq("user_id", userId).maybeSingle(),
        admin.from("sources").select("id, file_name, source_type, created_at").eq("deal_id", id).eq("user_id", userId),
        admin.from("deal_people").select("*").eq("deal_id", id).eq("user_id", userId),
      ]);
      if (e1) throw new Error(e1.message);
      if (!deal) throw new Error("Deal not found");
      return { deal, sources: sources ?? [], people: people ?? [] };
    }
    case "search_deals": {
      const query = String(args?.query ?? "").trim();
      if (!query) throw new Error("query required");
      const limit = Math.min(args?.limit ?? 10, 50);
      const like = `%${query}%`;
      const { data, error } = await admin
        .from("deals")
        .select("id, name, stage, sector, status, website")
        .eq("user_id", userId)
        .or(`name.ilike.${like},sector.ilike.${like},memo_draft.ilike.${like}`)
        .limit(limit);
      if (error) throw new Error(error.message);
      return { matches: data ?? [], count: data?.length ?? 0 };
    }
    case "get_deal_context": {
      const id = String(args?.deal_id ?? "");
      if (!id) throw new Error("deal_id required");
      const maxChars = Math.min(args?.max_chars ?? 50000, 200000);
      const { data: deal, error: e1 } = await admin.from("deals")
        .select("id, name").eq("id", id).eq("user_id", userId).maybeSingle();
      if (e1) throw new Error(e1.message);
      if (!deal) throw new Error("Deal not found");
      const { data: sources } = await admin.from("sources")
        .select("file_name, extracted_text").eq("deal_id", id).eq("user_id", userId);
      const combined = (sources ?? [])
        .filter((s: any) => s.extracted_text)
        .map((s: any) => `=== ${s.file_name} ===\n${s.extracted_text}`)
        .join("\n\n")
        .slice(0, maxChars);
      return { deal_id: id, deal_name: deal.name, text: combined, truncated: combined.length >= maxChars };
    }

    // ---------------- agent-read ----------------
    case "list_deal_people": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      const { data, error } = await admin
        .from("deal_people").select("*").eq("deal_id", id).eq("user_id", userId)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return { people: data ?? [], count: data?.length ?? 0 };
    }
    case "list_sources": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      const { data, error } = await admin
        .from("sources").select("id, file_name, source_type, processing_status, created_at")
        .eq("deal_id", id).eq("user_id", userId).order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return { sources: data ?? [], count: data?.length ?? 0 };
    }
    case "get_job_status": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      const { data, error } = await admin
        .from("deals").select("status, deep_research_status").eq("id", id).eq("user_id", userId).maybeSingle();
      if (error) throw new Error(error.message);
      return { deal_id: id, status: data?.status ?? null, deep_research_status: data?.deep_research_status ?? null };
    }

    // ---------------- agent-write ----------------
    case "create_deal": {
      const dealName = String(args?.name ?? "").trim();
      if (!dealName) throw new Error("name required");
      const insert: Record<string, unknown> = { user_id: userId, name: dealName, source: "agent", status: "inbox" };
      for (const f of ["sector", "website", "linkedin_url", "stage", "ask_amount", "valuation", "revenue", "growth", "nrr", "team_size"]) {
        if (typeof args?.[f] === "string" && args[f].trim()) insert[f] = args[f];
      }
      const { data, error } = await admin.from("deals").insert(insert).select("id, name, status, stage, sector").maybeSingle();
      if (error) throw new Error(error.message);
      return { created: true, deal: data };
    }
    case "update_deal": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      const patch: Record<string, unknown> = {};
      for (const f of ["name", "sector", "website", "linkedin_url", "ask_amount", "valuation", "revenue", "growth", "nrr", "team_size"]) {
        if (f in (args ?? {})) patch[f] = args[f] === "" ? null : args[f];
      }
      if (Object.keys(patch).length === 0) throw new Error("No updatable fields provided");
      const { error } = await admin.from("deals").update(patch).eq("id", id).eq("user_id", userId);
      if (error) throw new Error(error.message);
      return { updated: true, deal_id: id, fields: Object.keys(patch) };
    }
    case "delete_deal": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      await Promise.all([
        admin.from("capture_jobs").delete().eq("deal_id", id).eq("user_id", userId),
        admin.from("sources").delete().eq("deal_id", id).eq("user_id", userId),
        admin.from("deal_people").delete().eq("deal_id", id).eq("user_id", userId),
        admin.from("deal_notes").delete().eq("deal_id", id).eq("user_id", userId),
      ]);
      const { error } = await admin.from("deals").delete().eq("id", id).eq("user_id", userId);
      if (error) throw new Error(error.message);
      return { deleted: true, deal_id: id };
    }
    case "add_deal_person": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      const personName = String(args?.name ?? "").trim();
      if (!personName) throw new Error("name required");
      const { data, error } = await admin.from("deal_people").insert({
        deal_id: id, user_id: userId, name: personName,
        title: args?.title ?? null, linkedin_url: args?.linkedin_url ?? null,
      }).select("id, name, title, linkedin_url").maybeSingle();
      if (error) throw new Error(error.message);
      return { added: true, person: data };
    }
    case "update_deal_person": {
      const personId = String(args?.person_id ?? "");
      if (!personId) throw new Error("person_id required");
      const { data: person } = await admin.from("deal_people").select("id").eq("id", personId).eq("user_id", userId).maybeSingle();
      if (!person) throw new Error("Person not found");
      const patch: Record<string, unknown> = {};
      for (const f of ["name", "title", "linkedin_url"]) {
        if (f in (args ?? {})) patch[f] = args[f] === "" ? null : args[f];
      }
      if (Object.keys(patch).length === 0) throw new Error("No updatable fields provided");
      const { error } = await admin.from("deal_people").update(patch).eq("id", personId).eq("user_id", userId);
      if (error) throw new Error(error.message);
      return { updated: true, person_id: personId };
    }
    case "remove_deal_person": {
      const personId = String(args?.person_id ?? "");
      if (!personId) throw new Error("person_id required");
      const { data: person } = await admin.from("deal_people").select("id").eq("id", personId).eq("user_id", userId).maybeSingle();
      if (!person) throw new Error("Person not found");
      const { error } = await admin.from("deal_people").delete().eq("id", personId).eq("user_id", userId);
      if (error) throw new Error(error.message);
      return { removed: true, person_id: personId };
    }
    case "attach_source_url": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      const url = String(args?.url ?? "").trim();
      if (!url) throw new Error("url required");
      const { data, error } = await admin.from("sources").insert({
        deal_id: id, user_id: userId, source_type: "url",
        file_name: (args?.label ? String(args.label) : url).slice(0, 300),
        extracted_text: url, processing_status: "pending",
      }).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      return { attached: true, source: data };
    }
    case "attach_source_text": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      const text = String(args?.text ?? "");
      if (!text.trim()) throw new Error("text required");
      const { data, error } = await admin.from("sources").insert({
        deal_id: id, user_id: userId, source_type: "text",
        file_name: (args?.label ? String(args.label) : "Agent note").slice(0, 300),
        extracted_text: text, processing_status: "extracted",
      }).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      return { attached: true, source: data };
    }
    case "attach_deck_from_url": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      const url = String(args?.url ?? "").trim();
      if (!url) throw new Error("url required");
      const { data, error } = await admin.from("sources").insert({
        deal_id: id, user_id: userId, source_type: "url",
        file_name: url.slice(0, 300), extracted_text: url, processing_status: "pending",
      }).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      return {
        attached: true, source: data,
        note: "Deck URL recorded. Automated capture of gated viewers (DocSend/Papermark) is completed from the EasyVC app.",
      };
    }
    case "delete_source": {
      const sourceId = String(args?.source_id ?? "");
      if (!sourceId) throw new Error("source_id required");
      const { data: src } = await admin.from("sources").select("id").eq("id", sourceId).eq("user_id", userId).maybeSingle();
      if (!src) throw new Error("Source not found");
      const { error } = await admin.from("sources").delete().eq("id", sourceId).eq("user_id", userId);
      if (error) throw new Error(error.message);
      return { deleted: true, source_id: sourceId };
    }
    case "append_note": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      const noteBody = String(args?.body ?? "");
      if (!noteBody.trim()) throw new Error("body required");
      const { data, error } = await admin.from("deal_notes").insert({
        deal_id: id, user_id: userId, body: noteBody, source: "agent", via: auth.via,
      }).select("id, created_at").maybeSingle();
      if (error) throw new Error(error.message);
      return { appended: true, note: data };
    }
    case "update_memo_draft": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      const memo = String(args?.memo_draft ?? "");
      const { error } = await admin.from("deals").update({ memo_draft: memo }).eq("id", id).eq("user_id", userId);
      if (error) throw new Error(error.message);
      return { updated: true, deal_id: id, memo_length: memo.length };
    }
    case "run_deep_research": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      invokeEdgeFunction("deep-research", { dealId: id });
      return { started: true, deal_id: id, poll: "get_job_status → deep_research_status" };
    }
    case "run_process_deck": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      const storagePath = String(args?.storage_path ?? "").trim();
      if (!storagePath) throw new Error("storage_path required");
      invokeEdgeFunction("process-deck", { dealId: id, storagePath });
      return { started: true, deal_id: id, poll: "get_job_status → status" };
    }
    case "generate_memo": {
      const id = String(args?.deal_id ?? "");
      await assertDealOwned(id, userId);
      invokeEdgeFunction("generate-memo", { dealId: id });
      return { started: true, deal_id: id, poll: "get_deal → deal.memo_draft" };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------- MCP JSON-RPC ----------------
async function handleMcp(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }),
      {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${FUNCTION_BASE}/.well-known/oauth-protected-resource"`,
        },
      },
    );
  }

  let body: any;
  try { body = await req.json(); } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  const handle = async (msg: any) => {
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        return {
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "easyvc", version: "1.0.0" },
          },
        };
      }
      if (method === "tools/list") {
        // Only advertise the tools this caller may actually use. Default
        // (non-agent) callers see exactly the public read-only set.
        const visible = TOOLS
          .filter((t) => isToolAllowed(auth, t.name))
          .map(({ access: _access, ...rest }) => rest);
        return { jsonrpc: "2.0", id, result: { tools: visible } };
      }
      if (method === "tools/call") {
        const out = await runTool(params?.name, params?.arguments ?? {}, auth);
        return {
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] },
        };
      }
      if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (method?.startsWith("notifications/")) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (err: any) {
      return {
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
      };
    }
  };

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean);
    return new Response(JSON.stringify(out), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const out = await handle(body);
  if (out === null) return new Response(null, { status: 202, headers: corsHeaders });
  return new Response(JSON.stringify(out), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonRpcError(id: any, code: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------- OAuth 2.1 ----------------
async function handleOAuthMetadata(): Promise<Response> {
  return Response.json({
    issuer: FUNCTION_BASE,
    authorization_endpoint: `${FUNCTION_BASE}/authorize`,
    token_endpoint: `${FUNCTION_BASE}/token`,
    registration_endpoint: `${FUNCTION_BASE}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp", "mcp:write"],
  }, { headers: corsHeaders });
}

async function handleProtectedResourceMetadata(): Promise<Response> {
  return Response.json({
    resource: FUNCTION_BASE,
    authorization_servers: [FUNCTION_BASE],
    scopes_supported: ["mcp", "mcp:write"],
    bearer_methods_supported: ["header"],
  }, { headers: corsHeaders });
}

async function handleRegister(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400, headers: corsHeaders });
  }
  const clientId = randomToken("mcpc", 16);
  await admin.from("mcp_oauth_clients").insert({
    client_id: clientId,
    client_name: body.client_name ?? "MCP Client",
    redirect_uris: redirectUris,
    grant_types: body.grant_types ?? ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
  });
  return Response.json({
    client_id: clientId,
    client_name: body.client_name ?? "MCP Client",
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, { status: 201, headers: corsHeaders });
}

async function handleAuthorize(req: Request): Promise<Response> {
  // Redirect the user-agent to the in-app consent page; that page will POST to /authorize/approve
  const url = new URL(req.url);
  const params = url.searchParams;
  const target = new URL(`${APP_ORIGIN}/mcp/authorize`);
  for (const [k, v] of params.entries()) target.searchParams.set(k, v);
  return Response.redirect(target.toString(), 302);
}

// Called by the in-app consent page (authenticated user) to mint an auth code.
async function handleAuthorizeApprove(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  }
  const body = await req.json().catch(() => ({}));
  const { client_id, redirect_uri, code_challenge, code_challenge_method, scope, state } = body;
  if (!client_id || !redirect_uri || !code_challenge) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: corsHeaders });
  }
  if ((code_challenge_method ?? "S256") !== "S256") {
    return Response.json({ error: "invalid_request", message: "S256 required" }, { status: 400, headers: corsHeaders });
  }
  const { data: client } = await admin.from("mcp_oauth_clients").select("redirect_uris").eq("client_id", client_id).maybeSingle();
  if (!client) return Response.json({ error: "invalid_client" }, { status: 400, headers: corsHeaders });
  const allowed: string[] = client.redirect_uris as any;
  if (!allowed.includes(redirect_uri)) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400, headers: corsHeaders });
  }
  // The mcp:write scope is only grantable when the approving user has Agent
  // Mode enabled. Strip it otherwise (the consent UI hides the checkbox, this
  // is the server-side backstop).
  let grantedScope = (scope ?? "mcp").trim() || "mcp";
  if (parseScopes(grantedScope).includes("mcp:write") && !auth.agentMode) {
    grantedScope = parseScopes(grantedScope).filter((s) => s !== "mcp:write").join(" ") || "mcp";
  }
  const code = randomToken("mcpac", 24);
  await admin.from("mcp_oauth_codes").insert({
    code, client_id, user_id: auth.userId, redirect_uri,
    code_challenge, code_challenge_method: "S256", scope: grantedScope,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  const redirect = new URL(redirect_uri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  return Response.json({ redirect: redirect.toString() }, { headers: corsHeaders });
}

async function handleToken(req: Request): Promise<Response> {
  const ct = req.headers.get("content-type") ?? "";
  let params: URLSearchParams;
  if (ct.includes("application/x-www-form-urlencoded")) {
    params = new URLSearchParams(await req.text());
  } else {
    const body = await req.json().catch(() => ({}));
    params = new URLSearchParams(body);
  }
  const grant = params.get("grant_type");

  if (grant === "authorization_code") {
    const code = params.get("code");
    const verifier = params.get("code_verifier");
    const clientId = params.get("client_id");
    const redirectUri = params.get("redirect_uri");
    if (!code || !verifier || !clientId || !redirectUri) {
      return Response.json({ error: "invalid_request" }, { status: 400, headers: corsHeaders });
    }
    const { data: row } = await admin.from("mcp_oauth_codes").select("*").eq("code", code).maybeSingle();
    if (!row || row.consumed_at || new Date(row.expires_at) < new Date()) {
      return Response.json({ error: "invalid_grant" }, { status: 400, headers: corsHeaders });
    }
    if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      return Response.json({ error: "invalid_grant" }, { status: 400, headers: corsHeaders });
    }
    const computed = await sha256B64Url(verifier);
    if (computed !== row.code_challenge) {
      return Response.json({ error: "invalid_grant", message: "PKCE failure" }, { status: 400, headers: corsHeaders });
    }
    await admin.from("mcp_oauth_codes").update({ consumed_at: new Date().toISOString() }).eq("code", code);
    return await issueTokens(row.client_id, row.user_id, row.scope ?? "mcp");
  }

  if (grant === "refresh_token") {
    const refresh = params.get("refresh_token");
    if (!refresh) return Response.json({ error: "invalid_request" }, { status: 400, headers: corsHeaders });
    const hash = await sha256Hex(refresh);
    const { data: row } = await admin.from("mcp_oauth_tokens").select("*").eq("refresh_token_hash", hash).maybeSingle();
    if (!row || row.revoked_at) return Response.json({ error: "invalid_grant" }, { status: 400, headers: corsHeaders });
    await admin.from("mcp_oauth_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", row.id);
    return await issueTokens(row.client_id, row.user_id, row.scope ?? "mcp");
  }

  return Response.json({ error: "unsupported_grant_type" }, { status: 400, headers: corsHeaders });
}

async function issueTokens(clientId: string, userId: string, scope: string): Promise<Response> {
  const accessToken = randomToken("oauth", 32);
  const refreshToken = randomToken("oauthr", 32);
  const expiresIn = 60 * 60; // 1h
  await admin.from("mcp_oauth_tokens").insert({
    access_token_hash: await sha256Hex(accessToken),
    refresh_token_hash: await sha256Hex(refreshToken),
    client_id: clientId, user_id: userId, scope,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });
  return Response.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    scope,
  }, { headers: corsHeaders });
}

// ---------------- router ----------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  // Strip the function prefix so /functions/v1/mcp-server/foo -> /foo
  const path = url.pathname.replace(/^.*\/mcp-server/, "") || "/";

  try {
    if (path === "/.well-known/oauth-authorization-server") return handleOAuthMetadata();
    if (path === "/.well-known/oauth-protected-resource") return handleProtectedResourceMetadata();
    if (path === "/register" && req.method === "POST") return handleRegister(req);
    if (path === "/authorize" && req.method === "GET") return handleAuthorize(req);
    if (path === "/authorize/approve" && req.method === "POST") return handleAuthorizeApprove(req);
    if (path === "/token" && req.method === "POST") return handleToken(req);

    // MCP JSON-RPC at root
    if (req.method === "POST" && (path === "/" || path === "")) return handleMcp(req);

    // Helpful GET at root
    if (req.method === "GET" && (path === "/" || path === "")) {
      return Response.json({
        name: "easyvc-mcp",
        version: "1.0.0",
        endpoints: {
          mcp: FUNCTION_BASE,
          oauth_metadata: `${FUNCTION_BASE}/.well-known/oauth-authorization-server`,
          resource_metadata: `${FUNCTION_BASE}/.well-known/oauth-protected-resource`,
        },
        // Unauthenticated discovery only lists the public read-only tools;
        // write tools appear in tools/list once the caller has Agent Mode.
        tools: TOOLS.filter((t) => t.access === "public").map((t) => t.name),
        agent_mode_tools: TOOLS.filter((t) => t.access !== "public").map((t) => t.name),
        agent_mode_note: "Write/agent tools require the user to enable Agent Mode in EasyVC Settings.",
      }, { headers: corsHeaders });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  } catch (err: any) {
    console.error("mcp-server error:", err);
    return new Response(JSON.stringify({ error: err.message ?? "internal" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
