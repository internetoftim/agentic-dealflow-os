// Account self-service required for a published Google app:
//   POST { action: "disconnect_google" } — revoke at Google, wipe tokens, switch Gmail/Drive features off
//   POST { action: "delete_account", confirm: "DELETE" } — remove every row and file, then the auth user
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { disconnectUserGoogle, decryptToken, revokeGoogleToken } from "../_shared/google-tokens.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function deleteAccount(admin: any, userId: string) {
  const removed: Record<string, number> = {};
  const count = async (table: string, col = "user_id") => {
    const { data } = await admin.from(table).delete().eq(col, userId).select("id");
    removed[table] = data?.length ?? 0;
  };

  // Storage first, while we can still see the paths.
  const { data: sources } = await admin.from("sources").select("storage_path").eq("user_id", userId);
  const paths = (sources ?? []).map((s: any) => s.storage_path).filter(Boolean);
  if (paths.length) await admin.storage.from("decks").remove(paths).catch(() => {});
  removed.storage_objects = paths.length;

  // Receiver inboxes: revoke their Google grants too.
  const { data: receivers } = await admin.from("receiver_accounts").select("google_refresh_token, google_access_token").eq("user_id", userId);
  for (const r of receivers ?? []) {
    const t = (await decryptToken(r.google_refresh_token)) ?? (await decryptToken(r.google_access_token));
    if (t) await revokeGoogleToken(t);
  }

  // Team: leave (or dissolve) so teammates aren't left with a ghost member.
  const { data: membership } = await admin.from("team_members").select("team_id, role").eq("user_id", userId).maybeSingle();
  if (membership) {
    const { data: others } = await admin.from("team_members").select("id").eq("team_id", membership.team_id).neq("user_id", userId);
    await admin.from("team_members").delete().eq("user_id", userId);
    if (!others?.length) await admin.from("teams").delete().eq("id", membership.team_id);
    else if (membership.role === "owner") {
      // Hand ownership to the longest-standing remaining member.
      const { data: next } = await admin.from("team_members").select("user_id").eq("team_id", membership.team_id).order("created_at").limit(1);
      if (next?.[0]) {
        await admin.from("teams").update({ owner_id: next[0].user_id }).eq("id", membership.team_id);
        await admin.from("team_members").update({ role: "owner" }).eq("team_id", membership.team_id).eq("user_id", next[0].user_id);
      }
    }
  }

  // Deal graph. Deals owned by the user go entirely; notes/shares they made on others' deals go too.
  const { data: deals } = await admin.from("deals").select("id").eq("user_id", userId);
  const dealIds = (deals ?? []).map((d: any) => d.id);
  if (dealIds.length) {
    for (const table of ["capture_jobs", "sources", "deal_people", "deal_notes", "deal_shares", "deal_share_access", "ingest_events"]) {
      const { data } = await admin.from(table).delete().in("deal_id", dealIds).select("id");
      removed[`${table}(by deal)`] = data?.length ?? 0;
    }
  }
  for (const table of ["deal_notes", "deal_share_access", "ingest_events", "receiver_invites", "receiver_accounts",
                       "mcp_tool_calls", "mcp_oauth_tokens", "mcp_oauth_codes", "mcp_access_tokens", "user_roles"]) {
    await count(table).catch(() => { removed[table] = -1; });
  }
  await count("deal_shares", "owner_id").catch(() => {});
  await count("deals");
  await disconnectUserGoogle(admin, userId).catch(() => {});
  await count("user_settings");
  await count("profiles");

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(`auth user deletion failed: ${error.message}`);
  return removed;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error || !user) return json({ error: "Unauthorized" }, 401);
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));

    if (body?.action === "disconnect_google") {
      await disconnectUserGoogle(admin, user.id);
      return json({ ok: true });
    }
    if (body?.action === "delete_account") {
      if (body?.confirm !== "DELETE") return json({ error: "Pass confirm: \"DELETE\"" }, 400);
      const removed = await deleteAccount(admin, user.id);
      return json({ ok: true, removed });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("account error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
