import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let eventsState: any[] = [];
vi.mock("@/hooks/useIngestEvents", () => ({ useIngestEvents: () => ({ events: eventsState, isLoading: false }) }));
vi.mock("@/hooks/useReceiverAccounts", () => ({
  useReceiverAccounts: () => ({
    accounts: [], invites: [], isLoading: false,
    connect: { mutateAsync: vi.fn(), isPending: false }, setEnabled: { mutateAsync: vi.fn() }, disconnect: { mutateAsync: vi.fn() },
    createInvite: { mutateAsync: vi.fn(), isPending: false }, revokeInvite: { mutateAsync: vi.fn() },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), promise: (p: unknown) => Promise.resolve(p).catch(() => {}) } }));

import { ReceiverInboxSection } from "@/components/ReceiverInboxSection";

const now = new Date().toISOString();
beforeEach(() => {
  eventsState = [
    { id: "1", created_at: now, channel: "receiver", outcome: "uploaded", reason: null, sender: "Ana <ana@x.com>", subject: "Deck", file_name: "deck.pdf", deal_id: "d1" },
    { id: "2", created_at: now, channel: "receiver", outcome: "attached", reason: null, sender: "Ana <ana@x.com>", subject: "Deck", file_name: "model.xlsx", deal_id: "d1" },
    { id: "3", created_at: now, channel: "label", outcome: "duplicate", reason: 'Identical to "deck.pdf" already on a deal', sender: "Bob", subject: "Fwd: Deck", file_name: "deck (1).pdf", deal_id: "d1" },
    { id: "4", created_at: now, channel: "agent", outcome: "unsupported", reason: "File type not handled (zip)", sender: "Cy", subject: "Data", file_name: "data.zip", deal_id: null },
  ];
});

describe("Deal inbox recent activity (ledger)", () => {
  it("renders every outcome with file, reason, channel, and a deal link where one exists", () => {
    render(<MemoryRouter><ReceiverInboxSection /></MemoryRouter>);
    expect(screen.getAllByTestId("ingest-event")).toHaveLength(4);
    expect(screen.getByText(/Identical to "deck.pdf"/)).toBeInTheDocument();
    expect(screen.getByText(/File type not handled \(zip\)/)).toBeInTheDocument();
    const links = screen.getAllByText("open deal");
    expect(links).toHaveLength(2); // uploaded + attached only
    expect(links[0].closest("a")?.getAttribute("href")).toBe("/?deal=d1");
  });

  it("filters by outcome", () => {
    render(<MemoryRouter><ReceiverInboxSection /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "duplicate" }));
    expect(screen.getAllByTestId("ingest-event")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "all" }));
    expect(screen.getAllByTestId("ingest-event")).toHaveLength(4);
  });
});

describe("ingest ledger migration contract", () => {
  const sql = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260912150000_ingest_ledger.sql"), "utf8");
  it("constrains channel and outcome to the vocabulary the agents and UI use", () => {
    expect(sql).toMatch(/channel IN \('label', 'receiver', 'intake', 'agent', 'manual'\)/);
    expect(sql).toMatch(/outcome IN \('uploaded', 'attached', 'duplicate', 'unsupported', 'skipped', 'failed'\)/);
  });
  it("is owner-readable only and indexed for idempotency lookups", () => {
    expect(sql).toMatch(/"Owners can view their ingest events"[\s\S]*?USING \(user_id = auth\.uid\(\)\)/);
    expect(sql).toMatch(/REVOKE ALL ON public\.ingest_events FROM anon/);
    expect(sql).toMatch(/idx_ingest_events_user_message ON public\.ingest_events\(user_id, gmail_message_id\)/);
    expect(sql).toMatch(/ALTER TABLE public\.sources ADD COLUMN IF NOT EXISTS content_hash/);
  });
});

describe("agent surface stays in sync", () => {
  const mcp = readFileSync(resolve(__dirname, "../../../supabase/functions/mcp-server/index.ts"), "utf8");
  const skill = readFileSync(resolve(__dirname, "../../../skills/deal-inbox-triage/SKILL.md"), "utf8");
  const toolNames = [...mcp.matchAll(/^\s+name: "([a-z_]+)",$/gm)].map((m) => m[1]);

  it("exposes the inbox workflow tools and the ChatGPT search/fetch pair", () => {
    for (const t of ["scan_deal_inbox", "ingest_inbox_messages", "run_inbox_sweep", "get_ingest_report", "list_receiver_inboxes", "create_receiver_invite", "search", "fetch"]) {
      expect(toolNames, t).toContain(t);
    }
    expect(mcp).toMatch(/capabilities: \{ tools: \{\}, prompts: \{\} \}/);
    expect(mcp).toMatch(/name: "deal_inbox_triage"/);
  });

  it("every tool the skill tells the agent to call actually exists on the server", () => {
    const referenced = [...skill.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => n.includes("_") && !n.startsWith("since") && !n.startsWith("message") && !n.startsWith("receiver_email") && !n.startsWith("thread") && !n.startsWith("deep_research"));
    for (const t of new Set(referenced)) expect(toolNames, t).toContain(t);
  });
});
