// Receiver (deal-inbox) Gmail OAuth.
//   POST /start     — user JWT required; returns { url } to send the browser to Google
//   GET  /callback  — Google redirects here; exchanges the code, stores tokens,
//                     registers a Gmail watch, and bounces back to the app.
//
// State is an HMAC-signed payload (user id, expiry, return URL) so the callback
// can trust who initiated the connection without any server-side session.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { registerReceiverWatch } from "../_shared/gmail-receiver.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "https://onepointsix.ai";
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/receiver-oauth/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ---------------------------------------------------------------- state signing
const enc = new TextEncoder();
async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(SERVICE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return b64url(new Uint8Array(sig));
}
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function b64urlDecode(s: string): string {
  return atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4));
}

async function signState(data: { uid: string; ret: string }): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ ...data, exp: Date.now() + 10 * 60_000 })));
  return `${payload}.${await hmac(payload)}`;
}
async function verifyState(state: string): Promise<{ uid: string; ret: string } | null> {
  const [payload, sig] = state.split(".");
  if (!payload || !sig || (await hmac(payload)) !== sig) return null;
  const data = JSON.parse(b64urlDecode(payload));
  if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
  return { uid: data.uid, ret: data.ret };
}

/** Only bounce back to origins we own (prod, local dev, Lovable previews). */
function safeReturn(ret: unknown): string {
  const fallback = `${APP_ORIGIN}/settings`;
  if (typeof ret !== "string") return fallback;
  try {
    const u = new URL(ret);
    const host = u.hostname;
    const ok = u.origin === APP_ORIGIN
      || host === "localhost" || host === "127.0.0.1"
      || host.endsWith(".lovable.app") || host.endsWith(".lovableproject.com");
    return ok ? ret : fallback;
  } catch { return fallback; }
}

function redirect(to: string, params: Record<string, string>): Response {
  const u = new URL(to);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { ...corsHeaders, Location: u.toString() } });
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------- handlers
async function handleStart(req: Request): Promise<Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "Unauthorized" }, 401);
  if (!CLIENT_ID) return json({ error: "GOOGLE_CLIENT_ID is not configured" }, 500);

  const body = await req.json().catch(() => ({}));
  const state = await signState({ uid: user.id, ret: safeReturn(body?.returnTo) });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return json({ url: url.toString() });
}

async function handleCallback(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const state = await verifyState(params.get("state") ?? "");
  const ret = safeReturn(state?.ret);
  if (!state) return redirect(ret, { receiver: "error", reason: "Invalid or expired state" });
  if (params.get("error")) return redirect(ret, { receiver: "error", reason: params.get("error")! });
  const code = params.get("code");
  if (!code) return redirect(ret, { receiver: "error", reason: "Missing code" });

  // Exchange the code
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI, grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    console.error("Receiver token exchange failed:", await tokenRes.text());
    return redirect(ret, { receiver: "error", reason: "Google token exchange failed" });
  }
  const tokens = await tokenRes.json();
  if (!tokens.refresh_token) {
    // Happens when the account had already granted this app without prompt=consent.
    return redirect(ret, { receiver: "error", reason: "Google did not return a refresh token — remove EasyVC from that account's connected apps and retry" });
  }

  // Which mailbox did we just get?
  const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const info = infoRes.ok ? await infoRes.json() : {};
  const email = String(info.email ?? "").toLowerCase();
  if (!email) return redirect(ret, { receiver: "error", reason: "Could not read the mailbox address" });

  // One receiver mailbox belongs to exactly one user.
  const { data: existing } = await admin.from("receiver_accounts").select("id, user_id").eq("email", email).maybeSingle();
  if (existing && existing.user_id !== state.uid) {
    return redirect(ret, { receiver: "error", reason: `${email} is already connected to another workspace` });
  }

  const { data: account, error: upsertError } = await admin.from("receiver_accounts").upsert({
    user_id: state.uid,
    email,
    google_access_token: tokens.access_token,
    google_refresh_token: tokens.refresh_token,
    enabled: true,
    last_error: null,
  }, { onConflict: "email" }).select("*").single();
  if (upsertError || !account) {
    console.error("Receiver upsert failed:", upsertError);
    return redirect(ret, { receiver: "error", reason: "Could not save the connection" });
  }

  // Push notifications are best-effort; the listener poll covers the gap.
  const topic = Deno.env.get("GMAIL_PUBSUB_TOPIC");
  if (topic) {
    try { await registerReceiverWatch(admin, tokens.access_token, account, topic); }
    catch (e) { console.warn("Receiver watch registration failed (poll still active):", e); }
  }

  return redirect(ret, { receiver: "connected", email });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const path = new URL(req.url).pathname;
  try {
    if (req.method === "POST" && path.endsWith("/start")) return await handleStart(req);
    if (req.method === "GET" && path.endsWith("/callback")) return await handleCallback(req);
    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error("receiver-oauth error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
