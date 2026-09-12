/**
 * Google OAuth tokens: encrypted at rest, refreshed on demand, never handed
 * to the browser.
 *
 *  - Ciphertext format: `enc:v1:<base64url iv>:<base64url ciphertext+tag>`
 *    (AES-256-GCM, key = TOKEN_ENCRYPTION_KEY, base64, 32 bytes).
 *  - Legacy plaintext values are still accepted and re-encrypted on first
 *    read, so the migration completes itself as tokens are used.
 *  - One accessor per token owner: user_settings (the signed-in Google
 *    account) and receiver_accounts (deal inboxes).
 */

const ENC_PREFIX = "enc:v1:";
const TOKENINFO = "https://oauth2.googleapis.com/tokeninfo";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

let cachedKey: CryptoKey | null = null;
async function key(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const raw = Deno.env.get("TOKEN_ENCRYPTION_KEY");
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (base64)");
  cachedKey = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return cachedKey;
}
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

export async function encryptToken(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(plain));
  return `${ENC_PREFIX}${b64u(iv)}:${b64u(new Uint8Array(ct))}`;
}

export function isEncrypted(v: string | null | undefined): boolean {
  return typeof v === "string" && v.startsWith(ENC_PREFIX);
}

/** Decrypt; legacy plaintext passes through unchanged. Returns null for empty. */
export async function decryptToken(v: string | null | undefined): Promise<string | null> {
  if (!v) return null;
  if (!isEncrypted(v)) return v;
  const [ivB64, ctB64] = v.slice(ENC_PREFIX.length).split(":");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(ivB64) }, await key(), unb64u(ctB64));
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------- google
export async function refreshGoogleAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number } | null> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET");
    return null;
  }
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) {
    console.error("Google token refresh failed:", res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = await res.json();
  return data.access_token ? { access_token: data.access_token, expires_in: Number(data.expires_in ?? 3600) } : null;
}

/** Seconds of validity left (0 if invalid/expired), plus the granted scopes. */
export async function inspectAccessToken(accessToken: string): Promise<{ valid: boolean; expires_in: number; scope: string; email?: string }> {
  const res = await fetch(`${TOKENINFO}?access_token=${encodeURIComponent(accessToken)}`);
  if (!res.ok) return { valid: false, expires_in: 0, scope: "" };
  const d = await res.json();
  const exp = Number(d.expires_in ?? 0);
  return { valid: exp > 0, expires_in: exp, scope: String(d.scope ?? ""), email: d.email };
}

/** Best-effort revocation at Google (used on disconnect / account deletion). */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  const res = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => null);
  return !!res?.ok;
}

// ---------------------------------------------------------------- user_settings
export interface StoredGoogleTokens { access_token: string; refresh_token: string | null; scope?: string | null }

/** Encrypt and persist the signed-in Google account's tokens. */
export async function storeUserGoogleTokens(adminClient: any, userId: string, t: StoredGoogleTokens): Promise<void> {
  const row: Record<string, unknown> = {
    user_id: userId,
    google_provider_token: await encryptToken(t.access_token),
  };
  if (t.refresh_token) row.google_provider_refresh_token = await encryptToken(t.refresh_token);
  if (t.scope !== undefined) row.google_scopes = t.scope;
  const { error } = await adminClient.from("user_settings").upsert(row, { onConflict: "user_id" });
  if (error) throw new Error(`token store failed: ${error.message}`);
}

/**
 * A valid access token for the user's Google account, refreshing (and
 * re-encrypting legacy plaintext) as needed. Null when the user has no
 * usable Google connection — callers should treat that as "feature off".
 */
export async function getUserGoogleAccessToken(adminClient: any, userId: string): Promise<string | null> {
  const { data } = await adminClient.from("user_settings")
    .select("google_provider_token, google_provider_refresh_token").eq("user_id", userId).maybeSingle();
  if (!data) return null;
  const access = await decryptToken(data.google_provider_token);
  const refresh = await decryptToken(data.google_provider_refresh_token);
  const legacy = (data.google_provider_token && !isEncrypted(data.google_provider_token))
    || (data.google_provider_refresh_token && !isEncrypted(data.google_provider_refresh_token));

  if (access) {
    const info = await inspectAccessToken(access);
    if (info.valid && info.expires_in > 120) {
      if (legacy) await storeUserGoogleTokens(adminClient, userId, { access_token: access, refresh_token: refresh, scope: info.scope });
      return access;
    }
  }
  if (!refresh) return null;
  const fresh = await refreshGoogleAccessToken(refresh);
  if (!fresh) return null;
  await storeUserGoogleTokens(adminClient, userId, { access_token: fresh.access_token, refresh_token: refresh });
  return fresh.access_token;
}

/** Revoke at Google and wipe the stored tokens; Gmail/Drive features switch off. */
export async function disconnectUserGoogle(adminClient: any, userId: string): Promise<void> {
  const { data } = await adminClient.from("user_settings")
    .select("google_provider_token, google_provider_refresh_token").eq("user_id", userId).maybeSingle();
  const refresh = await decryptToken(data?.google_provider_refresh_token);
  const access = await decryptToken(data?.google_provider_token);
  if (refresh) await revokeGoogleToken(refresh); else if (access) await revokeGoogleToken(access);
  await adminClient.from("user_settings").update({
    google_provider_token: null, google_provider_refresh_token: null, google_scopes: null,
    gmail_label_enabled: false, drive_sync_enabled: false, gmail_history_id: null,
  }).eq("user_id", userId);
}

// ---------------------------------------------------------------- receiver_accounts
export async function storeReceiverTokens(adminClient: any, accountId: string, access: string, refresh?: string | null): Promise<void> {
  const row: Record<string, unknown> = { google_access_token: await encryptToken(access) };
  if (refresh) row.google_refresh_token = await encryptToken(refresh);
  const { error } = await adminClient.from("receiver_accounts").update(row).eq("id", accountId);
  if (error) throw new Error(`receiver token store failed: ${error.message}`);
}

export async function getReceiverAccessToken(adminClient: any, account: { id: string; google_access_token: string | null; google_refresh_token: string | null }): Promise<string | null> {
  const access = await decryptToken(account.google_access_token);
  const refresh = await decryptToken(account.google_refresh_token);
  const legacy = (account.google_access_token && !isEncrypted(account.google_access_token))
    || (account.google_refresh_token && !isEncrypted(account.google_refresh_token));
  if (access) {
    const info = await inspectAccessToken(access);
    if (info.valid && info.expires_in > 120) {
      if (legacy) await storeReceiverTokens(adminClient, account.id, access, refresh);
      return access;
    }
  }
  if (!refresh) return null;
  const fresh = await refreshGoogleAccessToken(refresh);
  if (!fresh) return null;
  await storeReceiverTokens(adminClient, account.id, fresh.access_token, refresh);
  return fresh.access_token;
}
