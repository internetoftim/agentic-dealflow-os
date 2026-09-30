import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  safeNext, readCookie, pkceCookie, clearPkceCookie, parsePkceCookie, buildAuthorizeUrl,
  buildAppCallbackUrl, buildLoginErrorUrl, validateClaims, OPENAI_AUTHORIZE_URL, SIWC_COOKIE,
} from "../../../supabase/functions/_shared/siwc-core";

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");
const APP = "https://www.onepointsix.ai";

describe("Sign in with ChatGPT: open-redirect and state handling", () => {
  it("only allows same-app relative paths as the post-login destination", () => {
    expect(safeNext("/mcp/authorize?client_id=x")).toBe("/mcp/authorize?client_id=x");
    expect(safeNext("https://evil.example/")).toBe("/");
    expect(safeNext("//evil.example/")).toBe("/");
    expect(safeNext(null)).toBe("/");
    expect(safeNext("")).toBe("/");
  });

  it("round-trips the PKCE state through an HttpOnly, path-scoped, Lax cookie", () => {
    const state = { state: "s", nonce: "n", verifier: "v", next: "/settings" };
    const cookie = pkceCookie(state);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/functions\/v1\/siwc-auth/);
    const header = cookie.split(";")[0];
    expect(parsePkceCookie(readCookie(`other=1; ${header}`, SIWC_COOKIE))).toEqual(state);
    expect(clearPkceCookie()).toMatch(/Max-Age=0/);
  });

  it("rejects malformed or incomplete state cookies and sanitises next", () => {
    expect(parsePkceCookie(null)).toBeNull();
    expect(parsePkceCookie("not json")).toBeNull();
    expect(parsePkceCookie(JSON.stringify({ state: "s" }))).toBeNull();
    expect(parsePkceCookie(JSON.stringify({ state: "s", nonce: "n", verifier: "v", next: "https://evil.example" }))?.next).toBe("/");
  });
});

describe("Sign in with ChatGPT: OpenAI OIDC request and app hand-off", () => {
  it("builds a code+PKCE authorize URL with identity scopes only", () => {
    const u = new URL(buildAuthorizeUrl({ clientId: "oaiapp_1", redirectUri: "https://x/cb", state: "s", nonce: "n", codeChallenge: "c" }));
    expect(u.origin + u.pathname).toBe(OPENAI_AUTHORIZE_URL);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid profile email");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("nonce")).toBe("n");
  });

  it("hands the one-time token to the app in the URL fragment, never the query", () => {
    const u = new URL(buildAppCallbackUrl(APP, "th_123", "/pipeline"));
    expect(u.pathname).toBe("/auth/callback");
    expect(u.search).toBe("");
    const frag = new URLSearchParams(u.hash.slice(1));
    expect(frag.get("token_hash")).toBe("th_123");
    expect(frag.get("type")).toBe("magiclink");
    expect(frag.get("next")).toBe("/pipeline");
  });

  it("sends failures back to /login with a reason the page can explain", () => {
    expect(buildLoginErrorUrl(APP, "email_required")).toBe(`${APP}/login?siwc_error=email_required`);
    const login = read("src/pages/LoginPage.tsx");
    for (const code of ["access_denied", "email_required", "email_unverified", "account_create_failed"]) {
      expect(login, code).toContain(code);
    }
  });

  it("validates nonce and email on the verified claims", () => {
    expect(validateClaims({ nonce: "n", email: "a@b.c", email_verified: true }, "n")).toBeNull();
    expect(validateClaims({ nonce: "x", email: "a@b.c" }, "n")).toBe("nonce_mismatch");
    expect(validateClaims({ nonce: "n" }, "n")).toBe("email_required");
    expect(validateClaims({ nonce: "n", email: "a@b.c", email_verified: false }, "n")).toBe("email_unverified");
  });

  it("the function is wired to the shared helpers and is exempt from JWT verification", () => {
    expect(read("supabase/functions/siwc-auth/index.ts")).toMatch(/_shared\/siwc-core\.ts/);
    expect(read("supabase/config.toml")).toMatch(/\[functions\.siwc-auth\]\nverify_jwt = false/);
    expect(read("src/App.tsx")).toMatch(/path="\/auth\/callback"/);
  });
});
