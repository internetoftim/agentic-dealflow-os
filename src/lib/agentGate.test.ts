import { describe, it, expect } from "vitest";
import {
  parseScopes,
  isAccessAllowed,
  isToolAllowed,
  accessOf,
  type AgentAuth,
} from "./agentGate";

const pat = (agentMode: boolean, scope: string | null = null): AgentAuth => ({
  via: "pat",
  agentMode,
  scope,
});
const oauth = (agentMode: boolean, scope: string | null): AgentAuth => ({
  via: "oauth",
  agentMode,
  scope,
});

describe("parseScopes", () => {
  it("splits on whitespace and drops empties", () => {
    expect(parseScopes("mcp mcp:write")).toEqual(["mcp", "mcp:write"]);
    expect(parseScopes("  mcp   ")).toEqual(["mcp"]);
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe("isAccessAllowed", () => {
  it("public tools are always allowed regardless of agent mode/scope", () => {
    expect(isAccessAllowed(pat(false), "public")).toBe(true);
    expect(isAccessAllowed(oauth(false, "mcp"), "public")).toBe(true);
  });

  it("agent tiers require agent mode", () => {
    expect(isAccessAllowed(pat(false), "agent-read")).toBe(false);
    expect(isAccessAllowed(pat(false), "agent-write")).toBe(false);
    expect(isAccessAllowed(pat(true), "agent-read")).toBe(true);
  });

  it("PAT writes need only agent mode (no scope column)", () => {
    expect(isAccessAllowed(pat(true, null), "agent-write")).toBe(true);
    expect(isAccessAllowed(pat(true, "mcp"), "agent-write")).toBe(true);
  });

  it("OAuth writes additionally require the mcp:write scope", () => {
    expect(isAccessAllowed(oauth(true, "mcp"), "agent-write")).toBe(false);
    expect(isAccessAllowed(oauth(true, "mcp mcp:write"), "agent-write")).toBe(true);
    // OAuth agent-read only needs agent mode, not write scope
    expect(isAccessAllowed(oauth(true, "mcp"), "agent-read")).toBe(true);
  });

  it("OAuth write is still blocked when agent mode is off even with scope", () => {
    expect(isAccessAllowed(oauth(false, "mcp mcp:write"), "agent-write")).toBe(false);
  });
});

describe("accessOf / isToolAllowed", () => {
  it("classifies the known tools", () => {
    expect(accessOf("list_deals")).toBe("public");
    expect(accessOf("get_deal_context")).toBe("public");
    expect(accessOf("list_deal_people")).toBe("agent-read");
    expect(accessOf("create_deal")).toBe("agent-write");
    expect(accessOf("add_deal_person")).toBe("agent-write");
  });

  it("defaults unknown tools to the most restrictive tier", () => {
    expect(accessOf("totally_new_tool")).toBe("agent-write");
    expect(isToolAllowed(pat(false), "totally_new_tool")).toBe(false);
  });

  it("default (non-agent) PAT sees only public tools", () => {
    const caller = pat(false);
    expect(isToolAllowed(caller, "list_deals")).toBe(true);
    expect(isToolAllowed(caller, "create_deal")).toBe(false);
    expect(isToolAllowed(caller, "add_deal_person")).toBe(false);
  });

  it("agent-mode PAT sees public + agent tools", () => {
    const caller = pat(true);
    expect(isToolAllowed(caller, "list_deals")).toBe(true);
    expect(isToolAllowed(caller, "create_deal")).toBe(true);
    expect(isToolAllowed(caller, "list_deal_people")).toBe(true);
  });
});
