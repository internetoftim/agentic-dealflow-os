import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  authorizationServerMetadata, protectedResourceMetadata, routeMcpRequest, functionPath,
} from "../../../supabase/functions/_shared/mcp-oauth";

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");
const APP = "https://www.onepointsix.ai";
const FN = "https://fbiigltzcxkqjjadqzgl.supabase.co/functions/v1/mcp-server";

// Regression: Claude/Codex connector pages failed with "Dynamic Client
// Registration rejected (HTTP 404)" when the issuer was the Supabase function
// URL. These pin the discovery chain that fixed it.
describe("MCP OAuth discovery", () => {
  const as = authorizationServerMetadata({ appOrigin: APP, functionBase: FN });
  const prm = protectedResourceMetadata({ appOrigin: APP, functionBase: FN });

  it("uses the app origin (no path) as issuer so RFC 8414 discovery hits a host we control", () => {
    expect(as.issuer).toBe(APP);
    expect(new URL(as.issuer).pathname).toBe("/");
    expect(prm.authorization_servers).toEqual([APP]);
  });

  it("points authorize at the in-app consent page and token/register at the function", () => {
    expect(as.authorization_endpoint).toBe(`${APP}/mcp/authorize`);
    expect(as.token_endpoint).toBe(`${FN}/token`);
    expect(as.registration_endpoint).toBe(`${FN}/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(prm.resource).toBe(FN);
  });

  it("the static well-known files served from the app domain match the function's documents", () => {
    const staticAs = JSON.parse(read("public/.well-known/oauth-authorization-server"));
    const staticOidc = JSON.parse(read("public/.well-known/openid-configuration"));
    const staticPrm = JSON.parse(read("public/.well-known/oauth-protected-resource"));
    expect(staticAs).toEqual(as);
    expect(staticOidc).toEqual(as);
    expect(staticPrm).toEqual(prm);
  });

  it("the function wires the shared builders (no drift between code and static files)", () => {
    const src = read("supabase/functions/mcp-server/index.ts");
    expect(src).toMatch(/_shared\/mcp-oauth\.ts/);
    expect(src).toMatch(/authorizationServerMetadata\(/);
    expect(src).toMatch(/protectedResourceMetadata\(/);
    expect(src).toMatch(/routeMcpRequest\(/);
  });
});

describe("MCP function routing", () => {
  it("strips the Supabase function prefix", () => {
    expect(functionPath("/functions/v1/mcp-server")).toBe("/");
    expect(functionPath("/functions/v1/mcp-server/token")).toBe("/token");
  });

  it("serves both well-known names and every OAuth endpoint", () => {
    expect(routeMcpRequest("GET", "/functions/v1/mcp-server/.well-known/oauth-authorization-server")).toBe("oauth_metadata");
    expect(routeMcpRequest("GET", "/functions/v1/mcp-server/.well-known/openid-configuration")).toBe("oauth_metadata");
    expect(routeMcpRequest("GET", "/functions/v1/mcp-server/.well-known/oauth-protected-resource")).toBe("resource_metadata");
    expect(routeMcpRequest("POST", "/functions/v1/mcp-server/register")).toBe("register");
    expect(routeMcpRequest("GET", "/functions/v1/mcp-server/authorize")).toBe("authorize");
    expect(routeMcpRequest("POST", "/functions/v1/mcp-server/authorize/approve")).toBe("authorize_approve");
    expect(routeMcpRequest("POST", "/functions/v1/mcp-server/token")).toBe("token");
  });

  it("exposes the Settings → AI Agents connections endpoints", () => {
    expect(routeMcpRequest("GET", "/functions/v1/mcp-server/connections")).toBe("connections_list");
    expect(routeMcpRequest("POST", "/functions/v1/mcp-server/connections/revoke")).toBe("connections_revoke");
    expect(routeMcpRequest("POST", "/functions/v1/mcp-server/connections")).toBe("not_found");
  });

  it("JSON-RPC at the root; Streamable HTTP GET streams and DELETE get 405, plain GET gets info", () => {
    expect(routeMcpRequest("POST", "/functions/v1/mcp-server")).toBe("mcp_rpc");
    expect(routeMcpRequest("GET", "/functions/v1/mcp-server", "text/event-stream")).toBe("method_not_allowed");
    expect(routeMcpRequest("DELETE", "/functions/v1/mcp-server")).toBe("method_not_allowed");
    expect(routeMcpRequest("GET", "/functions/v1/mcp-server", "application/json")).toBe("info");
    expect(routeMcpRequest("GET", "/functions/v1/mcp-server/nope")).toBe("not_found");
  });
});
