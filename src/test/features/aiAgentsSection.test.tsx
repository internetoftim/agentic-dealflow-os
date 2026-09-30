import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// Regression coverage for Settings → AI Agents "Connect an agent" and the
// connected-agents list backed by GET /connections and POST /connections/revoke.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", async () => {
  const { makeSupabaseMock } = await import("./supabaseMock");
  return { supabase: makeSupabaseMock({ tables: { user_settings: { data: { agent_mode_enabled: false } } } }).supabase };
});

import { AIAgentsSection } from "@/components/AIAgentsSection";

const MCP = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mcp-server`;

function fetchMock(connections: unknown[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `${MCP}/connections`) return new Response(JSON.stringify({ connections }), { status: 200 });
    if (url === `${MCP}/connections/revoke`) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`);
  });
}

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

describe("Connect an agent", () => {
  it("shows the server URL and one card per client, with real deep links where they exist", () => {
    vi.stubGlobal("fetch", fetchMock([]));
    render(<AIAgentsSection userId="u1" />);
    expect(screen.getAllByText(MCP).length).toBeGreaterThan(0);
    for (const name of ["Claude", "Codex", "Claude Code", "Codex CLI", "Cursor", "VS Code"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getByText(/open claude connectors/i).closest("a")).toHaveAttribute("href", "https://claude.ai/settings/connectors");
    expect(screen.getByText(/add to cursor/i).closest("a")?.getAttribute("href")).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=easyvc&config=/);
    expect(screen.getByText(/add to vs code/i).closest("a")?.getAttribute("href")).toMatch(/^vscode:mcp\/install\?/);
    expect(screen.getByText(`claude mcp add --transport http easyvc ${MCP}`)).toBeInTheDocument();
  });

  it("the Cursor deep link carries the MCP URL as base64 JSON", () => {
    vi.stubGlobal("fetch", fetchMock([]));
    render(<AIAgentsSection userId="u1" />);
    const href = screen.getByText(/add to cursor/i).closest("a")!.getAttribute("href")!;
    const config = JSON.parse(atob(new URL(href).searchParams.get("config")!));
    expect(config).toEqual({ url: MCP });
  });
});

describe("Connected agents", () => {
  it("lists agents that hold a live grant, fetched with the user's JWT", async () => {
    const fetchSpy = fetchMock([{ client_id: "mcpc_1", client_name: "Claude", redirect_host: "claude.ai", first_connected_at: "2026-09-30T10:00:00Z", last_issued_at: "2026-09-30T10:00:00Z" }]);
    vi.stubGlobal("fetch", fetchSpy);
    render(<AIAgentsSection userId="u1" />);
    expect(await screen.findByText("Claude", { selector: "p" })).toBeInTheDocument();
    const call = fetchSpy.mock.calls.find((c) => c[0] === `${MCP}/connections`)!;
    expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer jwt-123" });
  });

  it("disconnect revokes that client and refreshes", async () => {
    const fetchSpy = fetchMock([{ client_id: "mcpc_1", client_name: "Codex", redirect_host: "chatgpt.com", first_connected_at: "2026-09-30T10:00:00Z", last_issued_at: "2026-09-30T10:00:00Z" }]);
    vi.stubGlobal("fetch", fetchSpy);
    render(<AIAgentsSection userId="u1" />);
    fireEvent.click(await screen.findByTitle("Disconnect"));
    await waitFor(() => {
      const revoke = fetchSpy.mock.calls.find((c) => c[0] === `${MCP}/connections/revoke`);
      expect(revoke).toBeTruthy();
      expect(JSON.parse((revoke![1] as RequestInit).body as string)).toEqual({ client_id: "mcpc_1" });
    });
    expect(fetchSpy.mock.calls.filter((c) => c[0] === `${MCP}/connections`).length).toBeGreaterThanOrEqual(2);
  });

  it("stays quiet when the endpoint is unavailable (e.g. not yet deployed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not found", { status: 404 })));
    render(<AIAgentsSection userId="u1" />);
    expect(await screen.findByText(/no agents have signed in yet/i)).toBeInTheDocument();
  });
});
