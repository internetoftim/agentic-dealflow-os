/**
 * Agent Mode authorization gate — the single source of truth for "may this
 * caller use this MCP tool?".
 *
 * The Supabase edge function `supabase/functions/mcp-server/index.ts` runs on
 * Deno and cannot import this Vite (`@/`) module, so it inlines a byte-for-byte
 * copy of `parseScopes` + `isAccessAllowed`. Keep the two in sync — this file is
 * the reference implementation and is the one covered by unit tests.
 */

export type ToolAccess =
  | "public" // read-only; available to every authenticated MCP caller
  | "agent-read" // requires agent mode, but no write scope (agent conveniences)
  | "agent-write"; // requires agent mode AND (for OAuth callers) the mcp:write scope

export type AgentAuth = {
  via: "pat" | "oauth" | "jwt";
  agentMode: boolean;
  scope: string | null;
};

/** Split an OAuth scope string ("mcp mcp:write") into individual scopes. */
export function parseScopes(scope: string | null | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Core predicate. Given the caller's auth context and a tool's access tier,
 * decide whether the call is permitted.
 *
 * - public tools: always allowed.
 * - agent-read / agent-write: require `agentMode`.
 * - agent-write additionally requires the `mcp:write` scope, but ONLY for OAuth
 *   callers. Personal access tokens (PATs) have no scope column and are a
 *   full-account credential the user minted themselves, so a PAT is gated by
 *   `agentMode` alone.
 */
export function isAccessAllowed(auth: AgentAuth, access: ToolAccess): boolean {
  if (access === "public") return true;
  if (!auth.agentMode) return false;
  if (access === "agent-write" && auth.via === "oauth") {
    return parseScopes(auth.scope).includes("mcp:write");
  }
  return true;
}

/** Classification of every MCP tool. Unknown names default to the most
 *  restrictive tier so a newly-added tool is never exposed by omission. */
export const TOOL_ACCESS: Record<string, ToolAccess> = {
  // Public read-only (unchanged default surface)
  list_deals: "public",
  get_deal: "public",
  search_deals: "public",
  get_deal_context: "public",
  // Agent-mode read helpers
  list_deal_people: "agent-read",
  list_sources: "agent-read",
  get_job_status: "agent-read",
  // Agent-mode writes
  create_deal: "agent-write",
  update_deal: "agent-write",
  delete_deal: "agent-write",
  add_deal_person: "agent-write",
  update_deal_person: "agent-write",
  remove_deal_person: "agent-write",
  attach_source_url: "agent-write",
  attach_source_text: "agent-write",
  attach_deck_from_url: "agent-write",
  delete_source: "agent-write",
  append_note: "agent-write",
  update_memo_draft: "agent-write",
  run_deep_research: "agent-write",
  run_process_deck: "agent-write",
  generate_memo: "agent-write",
};

export function accessOf(toolName: string): ToolAccess {
  return TOOL_ACCESS[toolName] ?? "agent-write";
}

export function isToolAllowed(auth: AgentAuth, toolName: string): boolean {
  return isAccessAllowed(auth, accessOf(toolName));
}
