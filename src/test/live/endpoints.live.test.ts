import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Live contract checks against the deployed endpoints end users hit. They make
 * only unauthenticated, read-only requests plus one throwaway dynamic client
 * registration (the same call every connector page makes). Enabled with
 * EASYVC_LIVE=1 (`npm run test:live`); skipped otherwise so `npm test` stays
 * offline.
 */
const LIVE = process.env.EASYVC_LIVE === "1";
const APP = "https://www.onepointsix.ai";
const FN = "https://fbiigltzcxkqjjadqzgl.supabase.co/functions/v1";
const MCP = `${FN}/mcp-server`;
const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");

describe.skipIf(!LIVE)("live: MCP connector discovery chain (what claude.ai / Codex do when you click Connect)", () => {
  it("the MCP endpoint demands auth and advertises its protected-resource document", async () => {
    const r = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${MCP}/.well-known/oauth-protected-resource"`);
  });

  it("the protected-resource document names the app origin as authorization server", async () => {
    const prm = await (await fetch(`${MCP}/.well-known/oauth-protected-resource`)).json();
    expect(prm.resource).toBe(MCP);
    expect(prm.authorization_servers).toEqual([APP]);
  });

  it("the issuer's well-known metadata is live on the app domain and matches the repo", async () => {
    const r = await fetch(`${APP}/.well-known/oauth-authorization-server`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(JSON.parse(read("public/.well-known/oauth-authorization-server")));
    const oidc = await fetch(`${APP}/.well-known/openid-configuration`);
    expect(oidc.status).toBe(200);
  });

  it("the function serves the same metadata under both well-known names", async () => {
    const a = await (await fetch(`${MCP}/.well-known/oauth-authorization-server`)).json();
    const b = await (await fetch(`${MCP}/.well-known/openid-configuration`)).json();
    expect(a).toEqual(b);
    expect(a.issuer).toBe(APP);
  });

  it("dynamic client registration works with a claude.ai-style redirect", async () => {
    const r = await fetch(`${MCP}/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "easyvc-regression-test", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.client_id).toMatch(/^mcpc_/);
    expect(j.token_endpoint_auth_method).toBe("none");
  });

  it("the consent page is reachable and the token endpoint rejects a bad grant cleanly", async () => {
    expect((await fetch(`${APP}/mcp/authorize?client_id=x&redirect_uri=y&code_challenge=z`)).status).toBe(200);
    const t = await fetch(`${MCP}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code" });
    expect(t.status).toBe(400);
    expect((await t.json()).error).toBe("invalid_request");
  });

  it("Streamable HTTP niceties: GET event-stream and DELETE answer 405", async () => {
    expect((await fetch(MCP, { headers: { accept: "text/event-stream" } })).status).toBe(405);
    expect((await fetch(MCP, { method: "DELETE" })).status).toBe(405);
  });

  it("Settings → AI Agents connection endpoints require a user session", async () => {
    expect((await fetch(`${MCP}/connections`)).status).toBe(401);
    expect((await fetch(`${MCP}/connections/revoke`, { method: "POST" })).status).toBe(401);
  });
});

describe.skipIf(!LIVE)("live: deal agent", () => {
  it("refuses to act without a signed-in user, in every mode", async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${FN}/deal-agent`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const noAuth = await post({ dealId: "00000000-0000-0000-0000-000000000000", messages: [{ role: "user", content: "remove article 1" }] });
    expect(noAuth.status).toBe(401);
    const badToken = await post({ dealId: "00000000-0000-0000-0000-000000000000", undoRevisionId: "x" }, { authorization: "Bearer not-a-real-token" });
    expect(badToken.status).toBe(401);
    expect((await fetch(`${FN}/deal-agent`)).status).toBe(405);
  });
});

describe.skipIf(!LIVE)("live: deal sharing → Google Drive access", () => {
  it("refuses to touch Drive permissions without a signed-in user", async () => {
    const post = (headers: Record<string, string> = {}) =>
      fetch(`${FN}/deal-share-drive`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ dealId: "00000000-0000-0000-0000-000000000000", revokeAccessId: "x" }) });
    expect((await post()).status).toBe(401);
    expect((await post({ authorization: "Bearer not-a-real-token" })).status).toBe(401);
    expect((await fetch(`${FN}/deal-share-drive`)).status).toBe(405);
  });
});

describe.skipIf(!LIVE)("live: Sign in with ChatGPT bridge", () => {
  it("reports whether it is configured and refuses to start when it is not", async () => {
    const s = await (await fetch(`${FN}/siwc-auth/status`)).json();
    expect(typeof s.enabled).toBe("boolean");
    if (!s.enabled) expect((await fetch(`${FN}/siwc-auth/start`, { redirect: "manual" })).status).toBe(503);
  });
});
