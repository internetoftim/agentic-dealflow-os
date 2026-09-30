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
//
// The URL/cookie/claim logic lives in _shared/siwc-core.ts so the regression
// suite can exercise it without Deno.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5.9.6";
import {
  OPENAI_ISSUER, OPENAI_TOKEN_URL, OPENAI_JWKS_URL, SIWC_COOKIE,
  safeNext, readCookie, pkceCookie, clearPkceCookie, parsePkceCookie,
  buildAuthorizeUrl, buildAppCallbackUrl, buildLoginErrorUrl, validateClaims,
} from "../_shared/siwc-core.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("OPENAI_SIWC_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("OPENAI_SIWC_CLIENT_SECRET") ?? "";
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "https://www.onepointsix.ai";

const JWKS = createRemoteJWKSet(new URL(OPENAI_JWKS_URL));
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/siwc-auth/callback`;

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
function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { ...corsHeaders, Location: location, ...extraHeaders } });
}
function failToApp(reason: string): Response {
  return redirect(buildLoginErrorUrl(APP_ORIGIN, reason));
}

async function handleStart(req: Request): Promise<Response> {
  if (!CLIENT_ID) return Response.json({ error: "siwc_not_configured" }, { status: 503, headers: corsHeaders });
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  const state = random(16);
  const nonce = random(16);
  const verifier = random(48);
  const codeChallenge = await s256(verifier);
  const location = buildAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, state, nonce, codeChallenge });
  // The callback is a top-level navigation from auth.openai.com, so the
  // SameSite=Lax cookie scoped to this function's path is sent with it.
  return redirect(location, { "Set-Cookie": pkceCookie({ state, nonce, verifier, next }) });
}

async function handleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const clearCookie = { "Set-Cookie": clearPkceCookie() };
  const oauthError = url.searchParams.get("error");
  if (oauthError) return failToApp(oauthError);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = parsePkceCookie(readCookie(req.headers.get("cookie"), SIWC_COOKIE));
  if (!code || !state || !saved) return failToApp("missing_state");
  if (saved.state !== state) return failToApp("state_mismatch");

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: saved.verifier,
  });
  if (CLIENT_SECRET) form.set("client_secret", CLIENT_SECRET);
  const tokenResp = await fetch(OPENAI_TOKEN_URL, {
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
    const verified = await jwtVerify(tokens.id_token, JWKS, { issuer: OPENAI_ISSUER, audience: CLIENT_ID });
    claims = verified.payload as Record<string, unknown>;
  } catch (e) {
    console.error("siwc id_token verification failed", e);
    return failToApp("invalid_id_token");
  }
  const claimError = validateClaims(claims, saved.nonce);
  if (claimError) return failToApp(claimError);
  const email = (claims.email as string).trim().toLowerCase();

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
  return redirect(buildAppCallbackUrl(APP_ORIGIN, tokenHash, saved.next), clearCookie);
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
