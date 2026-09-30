// Sign in with ChatGPT → Supabase session bridge.
//
// OpenAI's "Sign in with ChatGPT" is a standard OpenID Connect provider
// (issuer https://auth.openai.com) but Supabase Auth has no built-in provider
// for it, so this function runs the OIDC code+PKCE flow itself and then mints a
// Supabase session for the verified identity via an admin magic-link token,
// which the app redeems with verifyOtp(). Requires an OpenAI client id
// (OPENAI_SIWC_CLIENT_ID; OPENAI_SIWC_CLIENT_SECRET for confidential clients).
//
//   GET /status          → { enabled }
//   GET /start?next=/x   → sets a PKCE cookie, 302 to auth.openai.com
//   GET /callback        → exchanges the code, verifies the ID token, 302 to
//                          APP_ORIGIN/auth/callback#token_hash=…&type=magiclink&next=/x

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("OPENAI_SIWC_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("OPENAI_SIWC_CLIENT_SECRET") ?? "";
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "https://www.onepointsix.ai";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

const FUNCTION_BASE = `${SUPABASE_URL}/functions/v1/siwc-auth`;
const REDIRECT_URI = `${FUNCTION_BASE}/callback`;
const COOKIE = "siwc_pkce";
const COOKIE_PATH = "/functions/v1/siwc-auth";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function random(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64url(b);
}
async function s256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return b64url(new Uint8Array(buf));
}
function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
// Only allow same-app relative paths as the post-login destination.
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}
function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { ...corsHeaders, Location: location, ...extraHeaders } });
}
function failToApp(reason: string): Response {
  const u = new URL(`${APP_ORIGIN}/login`);
  u.searchParams.set("siwc_error", reason);
  return redirect(u.toString());
}

async function handleStart(req: Request): Promise<Response> {
  if (!CLIENT_ID) return Response.json({ error: "siwc_not_configured" }, { status: 503, headers: corsHeaders });
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  const state = random(16);
  const nonce = random(16);
  const verifier = random(48);
  const challenge = await s256(verifier);

  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("scope", "openid profile email");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");

  // The callback is a top-level navigation from auth.openai.com, so a
  // SameSite=Lax cookie scoped to this function's path is sent with it.
  const payload = encodeURIComponent(JSON.stringify({ state, nonce, verifier, next }));
  const cookie = `${COOKIE}=${payload}; Path=${COOKIE_PATH}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
  return redirect(u.toString(), { "Set-Cookie": cookie });
}

async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const clearCookie = { "Set-Cookie": `${COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax` };
  const oauthError = url.searchParams.get("error");
  if (oauthError) return failToApp(oauthError);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const raw = readCookie(req, COOKIE);
  if (!code || !state || !raw) return failToApp("missing_state");
  let saved: { state: string; nonce: string; verifier: string; next: string };
  try { saved = JSON.parse(raw); } catch { return failToApp("bad_state"); }
  if (saved.state !== state) return failToApp("state_mismatch");

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: saved.verifier,
  });
  if (CLIENT_SECRET) form.set("client_secret", CLIENT_SECRET);
  const tokenResp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!tokenResp.ok) {
    console.error("siwc token exchange failed", tokenResp.status, await tokenResp.text());
    return failToApp("token_exchange_failed");
  }
  const tokens = await tokenResp.json();
  if (!tokens.id_token) return failToApp("no_id_token");

  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(tokens.id_token, JWKS, { issuer: ISSUER, audience: CLIENT_ID });
    claims = verified.payload as Record<string, unknown>;
  } catch (e) {
    console.error("siwc id_token verification failed", e);
    return failToApp("invalid_id_token");
  }
  if (claims.nonce !== saved.nonce) return failToApp("nonce_mismatch");
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (!email) return failToApp("email_required");
  if (claims.email_verified === false) return failToApp("email_unverified");

  const meta = {
    full_name: claims.name ?? null,
    avatar_url: claims.picture ?? null,
    chatgpt_sub: claims.sub ?? null,
    signed_in_with: "chatgpt",
  };

  // Mint a Supabase session for this identity. generateLink() only works for
  // existing users, so create the account first if needed (the profiles
  // trigger then puts it in the invite-only approval queue like any sign-up).
  let link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error) {
    const created = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: meta });
    if (created.error && !/already/i.test(created.error.message)) {
      console.error("siwc createUser failed", created.error);
      return failToApp("account_create_failed");
    }
    link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (link.error) {
      console.error("siwc generateLink failed", link.error);
      return failToApp("session_failed");
    }
  } else {
    // Keep the profile in sync on repeat sign-ins.
    const uid = link.data.user?.id;
    if (uid) admin.auth.admin.updateUserById(uid, { user_metadata: meta }).then(() => {});
  }

  const tokenHash = link.data.properties?.hashed_token;
  if (!tokenHash) return failToApp("session_failed");
  const dest = new URL(`${APP_ORIGIN}/auth/callback`);
  // Fragment, not query: never lands in server logs or referrers.
  dest.hash = new URLSearchParams({ token_hash: tokenHash, type: "magiclink", next: saved.next }).toString();
  return redirect(dest.toString(), clearCookie);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const path = new URL(req.url).pathname.replace(/^.*\/siwc-auth/, "") || "/";
  try {
    if (path === "/status") return Response.json({ enabled: Boolean(CLIENT_ID) }, { headers: corsHeaders });
    if (path === "/start") return await handleStart(req);
    if (path === "/callback") return await handleCallback(req);
    return new Response("Not found", { status: 404, headers: corsHeaders });
  } catch (e) {
    console.error("siwc-auth error", e);
    return failToApp("internal");
  }
});
