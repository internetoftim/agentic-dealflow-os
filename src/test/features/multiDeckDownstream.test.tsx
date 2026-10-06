import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Downstream effects of a deal holding several decks: each deck is synced to
// Drive on its own, and every surface lets the partner download or open any
// version. Plus the header's one-glance status, which the prominence pass
// introduced for time-poor readers.

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");

const sb = vi.hoisted(() => {
  const state = { download: vi.fn(async (_p: string) => ({ data: new Blob(["pdf"]), error: null })) };
  return { state, supabase: { storage: { from: vi.fn(() => ({ download: state.download })) } } };
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: sb.supabase }));
const dataRoom = vi.hoisted(() => ({ deals: [] as any[], sources: [] as any[] }));
vi.mock("@/hooks/useDeals", async () => {
  const actual = await vi.importActual<any>("@/hooks/useDeals");
  return { ...actual, useDeals: () => ({ data: dataRoom.deals, isLoading: false }), useAllSources: () => ({ data: dataRoom.sources, isLoading: false }) };
});

import { driveFileUrl, sourceDriveUrl, describeSource, downloadSourceFile } from "@/lib/driveLinks";
import { summarizeDealStatus } from "@/lib/dealStatus";
import { DeckFilesMenu } from "@/components/DeckFilesMenu";
import { DealStatusBanner } from "@/components/DealStatusBanner";
import { SourcesRail } from "@/components/SourcesRail";
import DataRoom from "@/pages/DataRoom";
import { SOURCE_LIST_COLUMNS } from "@/hooks/useDeals";

beforeEach(() => {
  sb.state.download.mockClear();
  if (!window.URL.createObjectURL) {
    Object.assign(window.URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
  }
});

const seed = { id: "s1", deal_id: "d1", file_name: "acme-seed.pdf", is_primary: true, original_size: "2.0MB", created_at: "2026-01-05T00:00:00Z", storage_path: "u/d1/deck.pdf", gdrive_file_id: null as string | null };
const seriesA = { id: "s2", deal_id: "d1", file_name: "acme-series-a.pdf", label: "Series A", is_primary: false, original_size: "3.1MB", created_at: "2026-06-02T00:00:00Z", storage_path: "u/d1/decks/x-acme-series-a.pdf", gdrive_file_id: "drv-2" };
const model = { id: "s3", deal_id: "d1", file_name: "model.xlsx", source_type: "attachment", created_at: "2026-06-03T00:00:00Z", storage_path: "u/d1/model.xlsx" };

describe("schema and edge functions: every linked deck gets its own Drive copy", () => {
  const mig = read("supabase/migrations/20261006090000_source_drive_links.sql");
  const sync = read("supabase/functions/sync-to-drive/index.ts");

  it("sources carry their own Drive id, backfilled from the deal for the primary deck", () => {
    expect(mig).toMatch(/ALTER TABLE public\.sources ADD COLUMN IF NOT EXISTS gdrive_file_id text/);
    expect(mig).toMatch(/drive_synced_at timestamptz/);
    expect(mig).toMatch(/s\.is_primary[\s\S]*d\.gdrive_file_id IS NOT NULL/);
    expect(SOURCE_LIST_COLUMNS).toContain("gdrive_file_id");
  });

  it("sync-to-drive records the Drive file on the source and, for attached decks, leaves the deal alone", () => {
    expect(sync).toMatch(/const sourceId[^\n]*body\.sourceId/);
    expect(sync).toMatch(/const attach: boolean = body\.attach === true/);
    expect(sync).toMatch(/from\("sources"\)\.update\(\{ gdrive_file_id: driveFile\.id, drive_synced_at/);
    expect(sync).toMatch(/if \(!attach\) \{\s*await adminClient\s*\.from\("deals"\)\s*\.update\(\{ gdrive_file_id: driveFile\.id, status: "memo-ready" \}\)/);
  });

  it("attached link captures reach Drive through process-deck's attach mode", () => {
    const cap = read("supabase/functions/run-docsend-capture/index.ts");
    expect(cap).toMatch(/\{ dealId, storagePath, attach: true, sourceId: attachSourceId \}/);
    const pd = read("supabase/functions/process-deck/index.ts");
    expect(pd).toMatch(/await syncAttachedDeckToDrive\(adminClient/);
  });
});

describe("Drive links per deck", () => {
  it("uses the deck's own Drive id, falls back to the deal's id only for the primary deck", () => {
    expect(driveFileUrl("abc")).toBe("https://drive.google.com/file/d/abc/view");
    const deal = { gdrive_file_id: "deal-drive" };
    expect(sourceDriveUrl(seed, deal, "s1")).toBe(driveFileUrl("deal-drive"));
    expect(sourceDriveUrl(seriesA, deal, "s1")).toBe(driveFileUrl("drv-2"));
    expect(sourceDriveUrl(model, deal, "s1")).toBeNull();
    expect(sourceDriveUrl(seed, null, "s1")).toBeNull();
  });

  it("describes a deck in one scannable line and downloads under its own name", async () => {
    expect(describeSource(seriesA)).toMatch(/^Series A · 3\.1MB · /);
    expect(describeSource({})).toBe("");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await downloadSourceFile(seriesA);
    expect(sb.state.download).toHaveBeenCalledWith(seriesA.storage_path);
    expect(click).toHaveBeenCalled();
    await expect(downloadSourceFile({ ...seriesA, storage_path: null })).rejects.toThrow(/No stored file/);
    click.mockRestore();
  });
});

describe("deck files menu in the deal header", () => {
  const deal = { gdrive_file_id: "deal-drive" };
  const open = () => {
    const trigger = screen.getByLabelText(/Deck files/);
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.keyDown(trigger, { key: "Enter" });
  };

  it("lists every deck, primary first, with download and Drive actions per version", async () => {
    render(<DeckFilesMenu sources={[model, seriesA, seed] as any} deal={deal} />);
    expect(screen.getByLabelText("Deck files · 2 decks")).toHaveTextContent("Decks · 2");
    open();
    const items = await screen.findAllByRole("group");
    expect(items.map((g) => g.getAttribute("aria-label"))).toEqual(["acme-seed.pdf", "acme-series-a.pdf"]);
    expect(within(items[0]).getByText("Primary")).toBeInTheDocument();
    expect(screen.getByText(/2 decks linked to this deal · 2 in Drive/)).toBeInTheDocument();
    expect(screen.getByLabelText("Open acme-seed.pdf in Google Drive")).toHaveAttribute("href", driveFileUrl("deal-drive"));
    expect(screen.getByLabelText("Open acme-series-a.pdf in Google Drive")).toHaveAttribute("href", driveFileUrl("drv-2"));
    expect(screen.queryByText("model.xlsx")).toBeNull();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(screen.getByLabelText("Download acme-series-a.pdf"));
    await waitFor(() => expect(sb.state.download).toHaveBeenCalledWith(seriesA.storage_path));
    click.mockRestore();
  });

  it("collapses to a plain Deck button with one deck and marks an unsynced deck", async () => {
    render(<DeckFilesMenu sources={[seed] as any} deal={null} />);
    expect(screen.getByLabelText("Deck files")).toHaveTextContent("Deck");
    open();
    expect(await screen.findByText("Deck file")).toBeInTheDocument();
    expect(screen.queryByText("Primary")).toBeNull();
    expect(screen.getByLabelText("acme-seed.pdf is not in Google Drive")).not.toHaveAttribute("href");
  });

  it("renders nothing without a deck", () => {
    const { container } = render(<DeckFilesMenu sources={[model] as any} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("one-glance deal status for a partner in a hurry", () => {
  it("names the state and the single next action", () => {
    expect(summarizeDealStatus({ status: "memo-ready", memo_draft: "# Memo" })).toMatchObject({ tone: "ready", label: "Memo ready", action: "open-memo" });
    expect(summarizeDealStatus({ status: "memo-ready", memo_draft: null })).toMatchObject({ tone: "ready", label: "Ready" });
    expect(summarizeDealStatus({ status: "memo-ready", deep_research_status: "running" })).toMatchObject({ tone: "working", label: "Researching" });
    expect(summarizeDealStatus({ status: "extracting" })).toMatchObject({ tone: "working", label: "Reading deck", action: "stop" });
    expect(summarizeDealStatus({ status: "queued" }, { runningDealName: "Other Co" })).toMatchObject({ tone: "waiting", detail: expect.stringContaining("Other Co") });
    expect(summarizeDealStatus({ status: "queued" })).toMatchObject({ action: "start" });
    expect(summarizeDealStatus({ status: "cancelled" })).toMatchObject({ tone: "stopped", action: "rerun" });
    expect(summarizeDealStatus({ status: "error" })).toMatchObject({ tone: "attention", label: "Needs attention", action: "rerun" });
    expect(summarizeDealStatus({ status: "error" }, { captureFailed: true, captureError: "DocSend asked for a passcode", canRetryCapture: true }))
      .toMatchObject({ tone: "attention", detail: "DocSend asked for a passcode", action: "retry-capture" });
  });

  it("the banner shows the pill, the detail and the action", () => {
    const onAction = vi.fn();
    render(<DealStatusBanner summary={summarizeDealStatus({ status: "error" })} actionLabel="Re-run workflow" onAction={onAction} />);
    expect(screen.getByRole("status", { name: "Deal status: Needs attention" })).toHaveTextContent("Processing failed");
    fireEvent.click(screen.getByText("Re-run workflow"));
    expect(onAction).toHaveBeenCalled();
  });

  it("the workspace header carries the banner, the deck menu and no longer a primary-only download", () => {
    const ws = read("src/pages/DealWorkspace.tsx");
    expect(ws).toMatch(/<DealStatusBanner/);
    expect(ws).toMatch(/<DeckFilesMenu sources=\{loadedSources as DealSource\[\]\} deal=\{activeDeal\}/);
    expect(ws).not.toMatch(/Download deck/);
    expect(ws).toMatch(/All steps complete/);
    // Left panel source cards: download + Drive per source.
    expect(ws).toMatch(/aria-label=\{`Download \$\{src\.file_name\}`\}/);
    expect(ws).toMatch(/aria-label=\{`Open \$\{src\.file_name\} in Google Drive`\}/);
  });
});

describe("Drive links on the other surfaces", () => {
  it("sources rail links each synced deck to Drive without toggling the row", () => {
    const onToggle = vi.fn();
    render(<SourcesRail sources={[seed, seriesA] as any} deal={{ gdrive_file_id: "deal-drive" }} selected={new Set()} onToggle={onToggle} onToggleAll={() => {}} />);
    const link = screen.getByLabelText("Open acme-series-a.pdf in Google Drive");
    expect(link).toHaveAttribute("href", driveFileUrl("drv-2"));
    fireEvent.click(link);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Open acme-seed.pdf in Google Drive")).toHaveAttribute("href", driveFileUrl("deal-drive"));
  });

  it("the Data Room shows a Drive link per synced file", () => {
    dataRoom.deals = [{ id: "d1", name: "Acme Robotics", user_id: "u", gdrive_file_id: "deal-drive" }];
    dataRoom.sources = [seed, seriesA, model];
    render(<MemoryRouter><DataRoom /></MemoryRouter>);
    const room = screen.getByLabelText("Acme Robotics data room");
    expect(within(room).getByLabelText("Open acme-seed.pdf in Google Drive")).toHaveAttribute("href", driveFileUrl("deal-drive"));
    expect(within(room).getByLabelText("Open acme-series-a.pdf in Google Drive")).toHaveAttribute("href", driveFileUrl("drv-2"));
    expect(within(room).queryByLabelText("Open model.xlsx in Google Drive")).toBeNull();
    expect(within(room).getByTitle("Not synced to Google Drive")).toBeInTheDocument();
  });
});
