// EasyVC MCP Server
// - MCP Streamable HTTP (JSON-RPC) at POST /
// - OAuth 2.1 endpoints (PKCE, dynamic client registration)
// - Bearer auth: Personal Access Token (pat_*) OR OAuth access token (oauth_*) OR Supabase JWT
// Read-only tools v1: list_deals, get_deal, search_deals, get_deal_context

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

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
type AuthResult = { userId: string; via: "pat" | "oauth" | "jwt" } | null;

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
    return { userId: data.user_id, via: "pat" };
  }

  if (token.startsWith("oauth_")) {
    const hash = await sha256Hex(token);
    const { data } = await admin
      .from("mcp_oauth_tokens")
      .select("user_id, revoked_at, expires_at")
      .eq("access_token_hash", hash)
      .maybeSingle();
    if (!data || data.revoked_at) return null;
    if (new Date(data.expires_at) < new Date()) return null;
    return { userId: data.user_id, via: "oauth" };
  }

  // Fallback: Supabase JWT
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: header } },
  });
  const { data, error } = await userClient.auth.getClaims(token);
  if (error || !data?.claims?.sub) return null;
  return { userId: data.claims.sub as string, via: "jwt" };
}

// ---------------- tool definitions ----------------
const TOOLS = [
  {
    name: "list_deals",
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
];

// Write tools — only exposed when the user has Agent Mode enabled.
const WRITE_TOOLS = [
  {
    name: "create_deal",
    description:
      "Create a new deal in the user's EasyVC workspace. Requires Agent Mode. Use when your own research surfaced a company worth tracking.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Company name" },
        stage: { type: "string" },
        sector: { type: "string" },
        status: { type: "string", description: "Pipeline status (default: inbox)" },
        website: { type: "string" },
        linkedin_url: { type: "string" },
        crunchbase_url: { type: "string" },
        ask_amount: { type: "string" },
        valuation: { type: "string" },
        revenue: { type: "string" },
        growth: { type: "string" },
        nrr: { type: "string" },
        team_size: { type: "string" },
        funding_total: { type: "string" },
        last_funding_round: { type: "string" },
        num_employees: { type: "string" },
        investors: { type: "string" },
        memo_draft: { type: "string", description: "Initial memo text or research notes" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_deal",
    description:
      "Update fields on an existing deal (metrics, links, stage, status, funding data). Requires Agent Mode. Only provided fields change.",
    inputSchema: {
      type: "object",
      properties: {
        deal_id: { type: "string" },
        name: { type: "string" },
        stage: { type: "string" },
        sector: { type: "string" },
        status: { type: "string" },
        website: { type: "string" },
        linkedin_url: { type: "string" },
        crunchbase_url: { type: "string" },
        ask_amount: { type: "string" },
        valuation: { type: "string" },
        revenue: { type: "string" },
        growth: { type: "string" },
        nrr: { type: "string" },
        team_size: { type: "string" },
        funding_total: { type: "string" },
        last_funding_round: { type: "string" },
        num_employees: { type: "string" },
        investors: { type: "string" },
      },
      required: ["deal_id"],
    },
  },
  {
    name: "upsert_deal_person",
    description:
      "Add or update a founder / key person on a deal (name, title, LinkedIn URL). Requires Agent Mode. Matches an existing person by name on the same deal.",
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
    name: "delete_deal_person",
    description: "Remove a key person from a deal by person id. Requires Agent Mode.",
    inputSchema: {
      type: "object",
      properties: { person_id: { type: "string" } },
      required: ["person_id"],
    },
  },
  {
    name: "update_memo",
    description:
      "Write or amend the investment memo draft for a deal. Requires Agent Mode. Use mode=append to add to the existing memo instead of replacing it.",
    inputSchema: {
      type: "object",
      properties: {
        deal_id: { type: "string" },
        memo: { type: "string", description: "Memo markdown" },
        mode: { type: "string", enum: ["replace", "append"], default: "replace" },
      },
      required: ["deal_id", "memo"],
    },
  },
  {
    name: "get_agent_mode",
    description:
      "Check whether Agent Mode (write access) is enabled for the authenticated user, and list which write tools are available.",
    inputSchema: { type: "object", properties: {} },
  },
];

const DEAL_WRITE_FIELDS = [
  "name", "stage", "sector", "status", "website", "linkedin_url", "crunchbase_url",
  "ask_amount", "valuation", "revenue", "growth", "nrr", "team_size",
  "funding_total", "last_funding_round", "num_employees", "investors", "memo_draft",
];

function pickDealFields(args: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DEAL_WRITE_FIELDS) {
    if (args?.[key] !== undefined && args[key] !== null && args[key] !== "") out[key] = args[key];
  }
  return out;
}

async function isAgentModeEnabled(userId: string): Promise<boolean> {
  const { data } = await admin
    .from("user_settings")
    .select("agent_mode_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean((data as any)?.agent_mode_enabled);
}

async function logToolCall(
  userId: string,
  toolName: string,
  args: any,
  success: boolean,
  errorMessage?: string,
) {
  try {
    await admin.from("mcp_tool_calls").insert({
      user_id: userId,
      tool_name: toolName,
      deal_id: typeof args?.deal_id === "string" ? args.deal_id : null,
      arguments: args ?? {},
      success,
      error_message: errorMessage ?? null,
    } as any);
  } catch (_) { /* logging must never break a tool call */ }
}

async function assertOwnedDeal(dealId: string, userId: string) {
  const { data } = await admin.from("deals")
    .select("id, memo_draft").eq("id", dealId).eq("user_id", userId).maybeSingle();
  if (!data) throw new Error("Deal not found");
  return data as any;
}

// ---------------- tool handlers ----------------
async function runTool(name: string, args: any, userId: string) {

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

    // ---------- write tools (Agent Mode) ----------
    case "get_agent_mode": {
      const enabled = await isAgentModeEnabled(userId);
      return {
        agent_mode_enabled: enabled,
        write_tools: enabled ? WRITE_TOOLS.map((t) => t.name).filter((n) => n !== "get_agent_mode") : [],
        hint: enabled
          ? "Write access is on."
          : "Write access is off. The workspace owner can enable Agent Mode in EasyVC Settings → AI Agents.",
      };
    }
    case "create_deal":
    case "update_deal":
    case "upsert_deal_person":
    case "delete_deal_person":
    case "update_memo": {
      if (!(await isAgentModeEnabled(userId))) {
        await logToolCall(userId, name, args, false, "Agent Mode disabled");
        throw new Error(
          "Agent Mode is disabled for this workspace. Enable it in EasyVC Settings → AI Agents to allow write access.",
        );
      }
      try {
        const out = await runWriteTool(name, args, userId);
        await logToolCall(userId, name, args, true);
        return out;
      } catch (err: any) {
        await logToolCall(userId, name, args, false, err?.message);
        throw err;
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function runWriteTool(name: string, args: any, userId: string) {
  switch (name) {
    case "create_deal": {
      const dealName = String(args?.name ?? "").trim();
      if (!dealName) throw new Error("name required");
      const payload = {
        ...pickDealFields(args),
        name: dealName,
        user_id: userId,
        source: "agent",
        status: args?.status ?? "inbox",
        stage: args?.stage ?? "Unknown",
        sector: args?.sector ?? "Unknown",
        deep_research_status: "skipped",
      };
      const { data, error } = await admin.from("deals").insert(payload as any).select("*").single();
      if (error) throw new Error(error.message);
      return { created: true, deal: data };
    }
    case "update_deal": {
      const id = String(args?.deal_id ?? "");
      if (!id) throw new Error("deal_id required");
      await assertOwnedDeal(id, userId);
      const updates = pickDealFields(args);
      if (Object.keys(updates).length === 0) throw new Error("No updatable fields provided");
      const { data, error } = await admin.from("deals")
        .update({ ...updates, updated_at: new Date().toISOString() } as any)
        .eq("id", id).eq("user_id", userId).select("*").single();
      if (error) throw new Error(error.message);
      return { updated: Object.keys(updates), deal: data };
    }
    case "upsert_deal_person": {
      const id = String(args?.deal_id ?? "");
      const personName = String(args?.name ?? "").trim();
      if (!id || !personName) throw new Error("deal_id and name required");
      await assertOwnedDeal(id, userId);
      const { data: existing } = await admin.from("deal_people")
        .select("id").eq("deal_id", id).eq("user_id", userId).ilike("name", personName).maybeSingle();
      const fields: Record<string, unknown> = { name: personName };
      if (args?.title) fields.title = args.title;
      if (args?.linkedin_url) fields.linkedin_url = args.linkedin_url;
      if (existing) {
        const { data, error } = await admin.from("deal_people")
          .update(fields as any).eq("id", (existing as any).id).select("*").single();
        if (error) throw new Error(error.message);
        return { action: "updated", person: data };
      }
      const { data, error } = await admin.from("deal_people")
        .insert({ ...fields, deal_id: id, user_id: userId } as any).select("*").single();
      if (error) throw new Error(error.message);
      return { action: "created", person: data };
    }
    case "delete_deal_person": {
      const personId = String(args?.person_id ?? "");
      if (!personId) throw new Error("person_id required");
      const { error } = await admin.from("deal_people")
        .delete().eq("id", personId).eq("user_id", userId);
      if (error) throw new Error(error.message);
      return { deleted: true, person_id: personId };
    }
    case "update_memo": {
      const id = String(args?.deal_id ?? "");
      const memo = String(args?.memo ?? "");
      if (!id || !memo) throw new Error("deal_id and memo required");
      const deal = await assertOwnedDeal(id, userId);
      const next = args?.mode === "append" && deal.memo_draft
        ? `${deal.memo_draft}\n\n${memo}`
        : memo;
      const { error } = await admin.from("deals")
        .update({ memo_draft: next, updated_at: new Date().toISOString() } as any)
        .eq("id", id).eq("user_id", userId);
      if (error) throw new Error(error.message);
      return { updated: true, deal_id: id, mode: args?.mode ?? "replace", length: next.length };
    }
    default:
      throw new Error(`Unknown write tool: ${name}`);
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
        const agentMode = await isAgentModeEnabled(auth.userId);
        const tools = agentMode
          ? [...TOOLS, ...WRITE_TOOLS]
          : [...TOOLS, WRITE_TOOLS.find((t) => t.name === "get_agent_mode")!];
        return { jsonrpc: "2.0", id, result: { tools } };
      }

      }
      if (method === "tools/call") {
        const out = await runTool(params?.name, params?.arguments ?? {}, auth.userId);
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
    scopes_supported: ["mcp"],
  }, { headers: corsHeaders });
}

async function handleProtectedResourceMetadata(): Promise<Response> {
  return Response.json({
    resource: FUNCTION_BASE,
    authorization_servers: [FUNCTION_BASE],
    scopes_supported: ["mcp"],
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
  const code = randomToken("mcpac", 24);
  await admin.from("mcp_oauth_codes").insert({
    code, client_id, user_id: auth.userId, redirect_uri,
    code_challenge, code_challenge_method: "S256", scope: scope ?? "mcp",
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
        tools: TOOLS.map((t) => t.name),
        write_tools: WRITE_TOOLS.map((t) => t.name),
        write_tools_note: "Write tools require the workspace owner to enable Agent Mode in EasyVC Settings → AI Agents.",

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
