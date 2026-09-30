// Pure helpers for Sign in with ChatGPT (siwc-auth). No Deno/Supabase imports
// so the regression suite can exercise the URL, cookie and redirect logic.

export const OPENAI_ISSUER = "https://auth.openai.com";
export const OPENAI_AUTHORIZE_URL = `${OPENAI_ISSUER}/api/accounts/authorize`;
export const OPENAI_TOKEN_URL = `${OPENAI_ISSUER}/api/accounts/oauth/token`;
export const OPENAI_JWKS_URL = `${OPENAI_ISSUER}/.well-known/jwks.json`;
export const SIWC_SCOPES = "openid profile email";
export const SIWC_COOKIE = "siwc_pkce";
export const SIWC_COOKIE_PATH = "/functions/v1/siwc-auth";

/** Only same-app relative paths may be a post-login destination. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export type PkceState = { state: string; nonce: string; verifier: string; next: string };

export function pkceCookie(state: PkceState): string {
  const payload = encodeURIComponent(JSON.stringify(state));
  return `${SIWC_COOKIE}=${payload}; Path=${SIWC_COOKIE_PATH}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

export function clearPkceCookie(): string {
  return `${SIWC_COOKIE}=; Path=${SIWC_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function parsePkceCookie(raw: string | null): PkceState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v?.state !== "string" || typeof v?.nonce !== "string" || typeof v?.verifier !== "string") return null;
    return { state: v.state, nonce: v.nonce, verifier: v.verifier, next: safeNext(v.next) };
  } catch {
    return null;
  }
}

export function buildAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; nonce: string; codeChallenge: string }): string {
  const u = new URL(OPENAI_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("scope", SIWC_SCOPES);
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", p.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** Where the app redeems the one-time token. Fragment, not query: never in server logs. */
export function buildAppCallbackUrl(appOrigin: string, tokenHash: string, next: string): string {
  const dest = new URL(`${appOrigin}/auth/callback`);
  dest.hash = new URLSearchParams({ token_hash: tokenHash, type: "magiclink", next: safeNext(next) }).toString();
  return dest.toString();
}

export function buildLoginErrorUrl(appOrigin: string, reason: string): string {
  const u = new URL(`${appOrigin}/login`);
  u.searchParams.set("siwc_error", reason);
  return u.toString();
}

/** Identity checks on verified ID-token claims. Returns an error code or null. */
export function validateClaims(claims: Record<string, unknown>, expectedNonce: string): string | null {
  if (claims.nonce !== expectedNonce) return "nonce_mismatch";
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  if (!email) return "email_required";
  if (claims.email_verified === false) return "email_unverified";
  return null;
}
