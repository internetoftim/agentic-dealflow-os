import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SourcesRail } from "@/components/SourcesRail";

// The workspace has two tabs: Structured Data (opens first) and Data Room &
// Memo (memo beside its sources). Conversation lives only in the Deal Agent
// panel; the old in-tab chat and the deck preview are gone.

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");
const ws = read("src/pages/DealWorkspace.tsx");

describe("deal workspace tabs", () => {
  it("opens on Structured Data and offers Data Room & Memo as the only other tab", () => {
    expect(ws).toMatch(/useState<"data" \| "room">\("data"\)/);
    expect(ws).toMatch(/\{ key: "data" as const, label: "Structured Data"/);
    expect(ws).toMatch(/\{ key: "room" as const, label: "Data Room & Memo"/);
    expect(ws).not.toMatch(/key: "chat"|key: "memo"/);
  });

  it("the memo sits in the Data Room tab between the sources rail and the notes, and the agent stays on the right", () => {
    const room = ws.slice(ws.indexOf('{activeTab === "room" && ('), ws.indexOf("{/* AGENT PANEL"));
    expect(room.indexOf("<SourcesRail")).toBeGreaterThan(0);
    expect(room.indexOf("Investment Memo")).toBeGreaterThan(room.indexOf("<SourcesRail"));
    expect(room.indexOf("<DealNotesPanel")).toBeGreaterThan(room.indexOf("Investment Memo"));
    expect(ws).toMatch(/<DealAgentPanel/);
    expect(ws).toMatch(/run: \(\) => setActiveTab\("room"\)/);
  });

  it("has no chat of its own and no deck preview", () => {
    expect(ws).not.toMatch(/useDealChat|quickActions|Ask about the deck|chatEndRef/);
    expect(ws).not.toMatch(/deck_preview|Deck Preview/);
  });
});

describe("sources rail without a chat to ground", () => {
  const sources = [{ id: "s1", file_name: "deck.pdf" }, { id: "s2", file_name: "update.pdf" }];
  it("lists sources plainly: no checkboxes, no bulk toggle, and the hint names the memo and agent", () => {
    const onToggle = vi.fn();
    render(<SourcesRail sources={sources} selectable={false} selected={new Set()} onToggle={onToggle} onToggleAll={() => {}} />);
    expect(screen.queryByText("All")).toBeNull();
    fireEvent.click(screen.getByText("deck.pdf"));
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByText(/grounds the memo and the Deal Agent/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing checked/)).toBeNull();
  });
});
