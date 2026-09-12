// Receiver (deal-inbox) Gmail OAuth.
//   POST /start        — user JWT; returns { url } to send the browser to Google (self-connect)
//   POST /invite       — user JWT; mints a single-use invite link for the mailbox's owner
//   GET  /invite?t=    — landing page for the invitee (no app account needed)
//   GET  /authorize?t= — invitee clicked Connect; redirects to Google
//   GET  /callback     — Google redirects here; exchanges the code, stores tokens,
//                        registers a Gmail watch, and bounces back (app or /done page)
//   GET  /done         — plain result page for invitees
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
const FUNCTION_BASE = `${SUPABASE_URL}/functions/v1/receiver-oauth`;
const REDIRECT_URI = `${FUNCTION_BASE}/callback`;
const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
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

type State = { uid: string; ret: string; inv?: string };
async function signState(data: State): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ ...data, exp: Date.now() + 10 * 60_000 })));
  return `${payload}.${await hmac(payload)}`;
}
async function verifyState(state: string): Promise<State | null> {
  const [payload, sig] = state.split(".");
  if (!payload || !sig || (await hmac(payload)) !== sig) return null;
  const data = JSON.parse(b64urlDecode(payload));
  if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
  return { uid: data.uid, ret: data.ret, inv: data.inv };
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

/** Resolve a raw invite token to a live (unused, unexpired) invite row. */
async function loadInvite(rawToken: string) {
  if (!rawToken) return null;
  const { data } = await admin.from("receiver_invites")
    .select("id, user_id, note, expires_at, used_at")
    .eq("token_hash", await sha256Hex(rawToken)).maybeSingle();
  if (!data || data.used_at || new Date(data.expires_at) < new Date()) return null;
  return data;
}

async function inviterLabel(userId: string): Promise<string> {
  const { data } = await admin.from("profiles").select("email, display_name").eq("user_id", userId).maybeSingle();
  return (data as any)?.display_name || (data as any)?.email || "A OnePointSix workspace owner";
}

/** Only bounce back to origins we own (prod, local dev, Lovable previews). */
function safeReturn(ret: unknown): string {
  const fallback = `${APP_ORIGIN}/settings`;
  if (typeof ret !== "string") return fallback;
  try {
    const u = new URL(ret);
    const host = u.hostname;
    const ok = u.origin === APP_ORIGIN
      || ret.startsWith(`${FUNCTION_BASE}/done`)
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

function googleAuthUrl(state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

// ---------------------------------------------------------------- html pages
function page(title: string, body: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;background:#f7f6f3;color:#15181f;font:15px/1.6 Inter,system-ui,-apple-system,sans-serif}
  main{max-width:520px;margin:12vh auto;padding:0 24px}
  .card{background:#fff;border:1px solid #e3dfd7;border-radius:6px;padding:28px 30px}
  h1{font:600 20px/1.3 Inter,system-ui,sans-serif;letter-spacing:-.01em;margin:0 0 8px}
  p{margin:0 0 12px;color:#55585f} .muted{font-size:12px;color:#8a8d94}
  .btn{display:inline-block;margin-top:14px;background:#1b2436;color:#f7f6f3;text-decoration:none;padding:10px 16px;border-radius:5px;font-weight:500;font-size:14px}
  .brand{font-weight:600;color:#15181f} .ok{color:#2f6b4e} .err{color:#9b3a30}
  ul{padding-left:18px;color:#55585f}
</style></head><body><main><div class="card">${body}</div>
<p class="muted" style="margin-top:14px">OnePointSix · EasyVC deal inbox</p></main></body></html>`;
  return new Response(html, { headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } });
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// ---------------------------------------------------------------- handlers
async function authedUser(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error } = await userClient.auth.getUser();
  return error ? null : user;
}

/** Owner mints a link to hand to whoever controls the mailbox. */
async function handleInvite(req: Request): Promise<Response> {
  const user = await authedUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 200) : null;
  const raw = randomToken();
  const expires_at = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const { data, error } = await admin.from("receiver_invites")
    .insert({ user_id: user.id, token_hash: await sha256Hex(raw), note, expires_at })
    .select("id, expires_at").single();
  if (error || !data) return json({ error: error?.message ?? "Could not create invite" }, 500);
  return json({ id: data.id, url: `${FUNCTION_BASE}/invite?t=${raw}`, expires_at: data.expires_at });
}

/** Invitee landing page: who is asking, what will happen, one button. */
async function handleInvitePage(req: Request): Promise<Response> {
  const t = new URL(req.url).searchParams.get("t") ?? "";
  const invite = await loadInvite(t);
  if (!invite) {
    return page("Invite unavailable", `<h1 class="err">This link is no longer valid</h1>
      <p>It may have expired, been revoked, or already been used. Ask the person who sent it for a new one.</p>`);
  }
  const who = esc(await inviterLabel(invite.user_id));
  const note = invite.note ? `<p><em>“${esc(invite.note)}”</em></p>` : "";
  return page("Connect a deal inbox", `
    <h1>Connect this mailbox as a deal inbox</h1>
    <p><span class="brand">${who}</span> is asking to connect a Gmail mailbox you control to their EasyVC deal workspace.</p>
    ${note}
    <p>What this does:</p>
    <ul>
      <li>Any email that arrives in the mailbox with a pitch deck attached (PDF/PowerPoint) is ingested into <span class="brand">${who}</span>'s workspace.</li>
      <li>Processed emails are marked as read. Nothing is sent from the mailbox and no email is deleted.</li>
      <li>You can revoke access at any time from your Google account's connected apps.</li>
    </ul>
    <p>On the next screen, sign in with the Google account of <strong>the mailbox to connect</strong> — not your personal one, unless they're the same.</p>
    <a class="btn" href="${FUNCTION_BASE}/authorize?t=${encodeURIComponent(t)}">Connect with Google</a>
    <p class="muted" style="margin-top:14px">Link expires ${esc(new Date(invite.expires_at).toUTCString())}.</p>`);
}

/** Invitee clicked Connect: send them to Google with state bound to the inviter. */
async function handleAuthorize(req: Request): Promise<Response> {
  const t = new URL(req.url).searchParams.get("t") ?? "";
  const invite = await loadInvite(t);
  if (!invite) return page("Invite unavailable", `<h1 class="err">This link is no longer valid</h1><p>Ask for a new invite.</p>`);
  if (!CLIENT_ID) return page("Not configured", `<h1 class="err">Google sign-in is not configured</h1>`);
  const state = await signState({ uid: invite.user_id, ret: `${FUNCTION_BASE}/done`, inv: invite.id });
  return new Response(null, { status: 302, headers: { ...corsHeaders, Location: googleAuthUrl(state) } });
}

function handleDone(req: Request): Response {
  const p = new URL(req.url).searchParams;
  if (p.get("receiver") === "connected") {
    return page("Inbox connected", `<h1 class="ok">Connected</h1>
      <p><strong>${esc(p.get("email") ?? "The mailbox")}</strong> is now a deal inbox. Decks sent to it will be picked up automatically — you can close this page.</p>`);
  }
  return page("Connection failed", `<h1 class="err">Couldn't connect the mailbox</h1>
    <p>${esc(p.get("reason") ?? "Unknown error")}</p><p>You can go back to the invite link and try again.</p>`);
}

async function handleStart(req: Request): Promise<Response> {
  const user = await authedUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!CLIENT_ID) return json({ error: "GOOGLE_CLIENT_ID is not configured" }, 500);
  const body = await req.json().catch(() => ({}));
  const state = await signState({ uid: user.id, ret: safeReturn(body?.returnTo) });
  return json({ url: googleAuthUrl(state) });
}

async function handleCallback(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const state = await verifyState(params.get("state") ?? "");
  const ret = safeReturn(state?.ret);
  if (!state) return redirect(ret, { receiver: "error", reason: "Invalid or expired state" });
  if (state.inv) {
    const { data: inv } = await admin.from("receiver_invites").select("used_at, expires_at").eq("id", state.inv).maybeSingle();
    if (!inv || inv.used_at || new Date(inv.expires_at) < new Date()) {
      return redirect(ret, { receiver: "error", reason: "This invite is no longer valid" });
    }
  }
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

  if (state.inv) {
    await admin.from("receiver_invites")
      .update({ used_at: new Date().toISOString(), used_by_email: email }).eq("id", state.inv);
  }
  return redirect(ret, { receiver: "connected", email });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const path = new URL(req.url).pathname;
  try {
    if (req.method === "POST" && path.endsWith("/start")) return await handleStart(req);
    if (req.method === "POST" && path.endsWith("/invite")) return await handleInvite(req);
    if (req.method === "GET" && path.endsWith("/invite")) return await handleInvitePage(req);
    if (req.method === "GET" && path.endsWith("/authorize")) return await handleAuthorize(req);
    if (req.method === "GET" && path.endsWith("/callback")) return await handleCallback(req);
    if (req.method === "GET" && path.endsWith("/done")) return handleDone(req);
    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error("receiver-oauth error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
