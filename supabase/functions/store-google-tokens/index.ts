// Called by the browser right after Google sign-in with the provider tokens
// Supabase hands to the client. Tokens are encrypted here and never become
// readable through PostgREST (column grants revoked). Also records granted
// scopes so Settings can offer incremental Gmail authorization.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { storeUserGoogleTokens, inspectAccessToken } from "../_shared/google-tokens.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const access = typeof body?.provider_token === "string" ? body.provider_token : "";
    const refresh = typeof body?.provider_refresh_token === "string" ? body.provider_refresh_token : null;
    if (!access) return json({ error: "provider_token required" }, 400);

    // Only accept a token that Google confirms belongs to this user's account.
    const info = await inspectAccessToken(access);
    if (!info.valid) return json({ error: "Token is not valid" }, 400);
    if (info.email && user.email && info.email.toLowerCase() !== user.email.toLowerCase()) {
      return json({ error: "Token does not belong to the signed-in account" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    await storeUserGoogleTokens(admin, user.id, { access_token: access, refresh_token: refresh, scope: info.scope });
    return json({ ok: true, scopes: info.scope.split(" ").filter(Boolean) });
  } catch (e) {
    console.error("store-google-tokens error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
