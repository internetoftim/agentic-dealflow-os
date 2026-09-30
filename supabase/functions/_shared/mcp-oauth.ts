// Pure pieces of the MCP server's OAuth surface, kept free of Deno/Supabase so
// the regression suite (vitest) can import them. index.ts wires them up.

export type OAuthUrls = {
  /** App origin that acts as the OAuth issuer, e.g. https://www.onepointsix.ai */
  appOrigin: string;
  /** The MCP function URL, e.g. https://<ref>.supabase.co/functions/v1/mcp-server */
  functionBase: string;
};

/**
 * RFC 8414 authorization-server metadata. The issuer is the *app* origin so
 * clients resolve `<issuer>/.well-known/oauth-authorization-server` against a
 * host we control (a static copy of this document lives in public/.well-known).
 * The Supabase gateway owns its own origin root and answers 401/404 there,
 * which is what made Claude/Codex fall back to `<supabase>/register` and fail.
 */
export function authorizationServerMetadata({ appOrigin, functionBase }: OAuthUrls) {
  return {
    issuer: appOrigin,
    authorization_endpoint: `${appOrigin}/mcp/authorize`,
    token_endpoint: `${functionBase}/token`,
    registration_endpoint: `${functionBase}/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
    service_documentation: `${appOrigin}/llms.txt`,
  };
}

/** RFC 9728 protected-resource metadata, advertised via WWW-Authenticate. */
export function protectedResourceMetadata({ appOrigin, functionBase }: OAuthUrls) {
  return {
    resource: functionBase,
    authorization_servers: [appOrigin],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_name: "EasyVC",
  };
}

export type McpRoute =
  | "oauth_metadata"
  | "resource_metadata"
  | "register"
  | "authorize"
  | "authorize_approve"
  | "token"
  | "connections_list"
  | "connections_revoke"
  | "mcp_rpc"
  | "method_not_allowed"
  | "info"
  | "not_found";

/** Strip the function prefix: /functions/v1/mcp-server/foo -> /foo */
export function functionPath(pathname: string): string {
  return pathname.replace(/^.*\/mcp-server/, "") || "/";
}

/**
 * Route table for the function. Streamable HTTP clients may open a GET
 * event-stream or DELETE the session; this server is stateless, so both get
 * 405 (the spec allows it) instead of the human-readable info JSON.
 */
export function routeMcpRequest(method: string, pathname: string, accept = ""): McpRoute {
  const path = functionPath(pathname);
  const root = path === "/" || path === "";
  if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") return "oauth_metadata";
  if (path === "/.well-known/oauth-protected-resource") return "resource_metadata";
  if (path === "/register" && method === "POST") return "register";
  if (path === "/authorize" && method === "GET") return "authorize";
  if (path === "/authorize/approve" && method === "POST") return "authorize_approve";
  if (path === "/token" && method === "POST") return "token";
  if (path === "/connections" && method === "GET") return "connections_list";
  if (path === "/connections/revoke" && method === "POST") return "connections_revoke";
  if (root && method === "POST") return "mcp_rpc";
  if (root && method === "GET" && accept.includes("text/event-stream")) return "method_not_allowed";
  if (root && method === "DELETE") return "method_not_allowed";
  if (root && method === "GET") return "info";
  return "not_found";
}
