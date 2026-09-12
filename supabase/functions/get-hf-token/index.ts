// Hands the workspace's read-only Hugging Face token to a signed-in user so
// their browser can download gated Gemma builds. Only reachable with a valid
// EasyVC session (the approval gate applies), and only returns something when
// the operator has set HF_TOKEN. Users may instead paste their own token in
// Settings, which never leaves their browser.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "Unauthorized" }, 401);
  const token = Deno.env.get("HF_TOKEN")?.trim();
  if (!token) return json({ error: "No workspace Hugging Face token configured" }, 404);
  return json({ token });
});
