import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, renderHook, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as shared from "../../../supabase/functions/_shared/deck-sources";
import * as browser from "@/lib/deckSources";

// A deal is a data room: several decks can be linked to it. These tests pin
// the rules (one primary, attached decks never disturb the deal) across the
// schema, the edge functions, the hooks and the UI.

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");

// ------------------------------------------------------------------ mocks
const sb = vi.hoisted(() => {
  const state = {
    upload: vi.fn(async () => ({ error: null })),
    removeFiles: vi.fn(async () => ({ error: null })),
    invoke: vi.fn(async (_name: string, _opts: unknown) => ({ data: { success: true, jobId: "job1", url: "https://docsend.com/view/abc" }, error: null })),
    rpc: vi.fn(async () => ({ error: null })),
    inserted: [] as any[],
    deleted: [] as string[],
    insertResult: { data: { id: "src-new" }, error: null as null | { message: string } },
  };
  const supabase = {
    storage: { from: vi.fn(() => ({ upload: state.upload, remove: state.removeFiles, download: vi.fn() })) },
    functions: { invoke: state.invoke },
    rpc: state.rpc,
    from: vi.fn((_table: string) => {
      const b: any = {};
      b.insert = vi.fn((row: unknown) => { state.inserted.push(row); return b; });
      b.select = vi.fn(() => b);
      b.single = vi.fn(async () => state.insertResult);
      b.delete = vi.fn(() => b);
      b.eq = vi.fn((_c: string, v: string) => { state.deleted.push(v); return Promise.resolve({ error: null }); });
      return b;
    }),
  };
  return { state, supabase };
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: sb.supabase }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "user-1" }, loading: false }) }));
vi.mock("@/contexts/LocalLlmContext", () => ({
  useAiModelSetting: () => ({ aiModel: "nyo-glm-5.3", isLocal: false, localModelId: null, memoPrompt: null, isLoading: false }),
  useLocalLlm: () => ({ ensureLoaded: vi.fn(), chat: vi.fn(), generate: vi.fn(), interrupt: vi.fn(), status: "idle" }),
  LOCAL_AI_MODEL: "local-webgpu",
  LEGACY_LOCAL_AI_MODEL: "local-florence2",
  DEFAULT_AI_MODEL: "nyo-glm-5.3",
}));

const dataRoom = vi.hoisted(() => ({ deals: [] as any[], sources: [] as any[] }));
vi.mock("@/hooks/useDeals", async () => {
  const actual = await vi.importActual<any>("@/hooks/useDeals");
  return {
    ...actual,
    useDeals: () => ({ data: dataRoom.deals, isLoading: false }),
    useAllSources: () => ({ data: dataRoom.sources, isLoading: false }),
  };
});

import { useAddDeckToDeal, useAddDeckLinkToDeal, useSetPrimarySource, useRemoveSource, SOURCE_LIST_COLUMNS } from "@/hooks/useDeals";
import { SourcesRail } from "@/components/SourcesRail";
import { AddDeckControl } from "@/components/AddDeckControl";
import DataRoom from "@/pages/DataRoom";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => {
  sb.state.upload.mockClear();
  sb.state.removeFiles.mockClear();
  sb.state.invoke.mockClear();
  sb.state.rpc.mockClear();
  sb.state.inserted.length = 0;
  sb.state.deleted.length = 0;
  sb.state.insertResult = { data: { id: "src-new" }, error: null };
});

// ------------------------------------------------------------------ rules
describe("deck/source rules (shared by edge functions and the app)", () => {
  const sources = [
    { id: "a", deal_id: "d", file_name: "seed.pdf", source_type: "upload", created_at: "2026-01-01", storage_path: "u/d/seed.pdf" },
    { id: "b", deal_id: "d", file_name: "model.xlsx", source_type: "attachment", created_at: "2026-01-02" },
    { id: "c", deal_id: "d", file_name: "series-a.pdf", source_type: "upload", created_at: "2026-03-01", storage_path: "u/d/decks/x-series-a.pdf" },
  ];

  it("an attached deck can never overwrite another file: unique path under decks/", () => {
    const p1 = shared.attachedDeckPath("u", "d", "Deck v2 (final).pdf", "k1");
    const p2 = shared.attachedDeckPath("u", "d", "Deck v2 (final).pdf", "k2");
    expect(p1).toBe("u/d/decks/k1-Deck_v2_final_.pdf");
    expect(p1).not.toBe(p2);
    expect(shared.capturedDeckPath("u", "d")).toBe("u/d/deck.pdf");
    expect(shared.capturedDeckPath("u", "d", "job9")).toBe("u/d/decks/job9.pdf");
  });

  it("the browser mirror agrees with the edge-function module", () => {
    for (const name of ["a b.pdf", "Ünïcode deck.PPTX", "../../etc/passwd", ""]) {
      expect(browser.safeFileName(name)).toBe(shared.safeFileName(name));
      expect(browser.attachedDeckPath("u", "d", name, "k")).toBe(shared.attachedDeckPath("u", "d", name, "k"));
      expect(browser.isDeckFileName(name)).toBe(shared.isDeckFileName(name));
    }
    expect(browser.pickPrimarySource(sources as any)?.id).toBe(shared.pickPrimarySource(sources)?.id);
  });

  it("the primary deck is the flagged one, else the earliest deck — never a supporting document", () => {
    expect(shared.pickPrimarySource(sources)?.id).toBe("a");
    expect(shared.pickPrimarySource([{ ...sources[0] }, { ...sources[2], is_primary: true }])?.id).toBe("c");
    expect(shared.pickPrimarySource([sources[1], sources[2]])?.id).toBe("c");
    expect(shared.isDeckSource(sources[1])).toBe(false);
    expect(browser.sourceKind(sources[1] as any, "a")).toBe("Document");
    expect(browser.sourceKind(sources[2] as any, "a")).toBe("Deck");
    expect(browser.sourceKind(sources[0] as any, "a")).toBe("Primary deck");
  });

  it("a processing run writes to exactly one source: by id, else by storage path, else the primary", () => {
    expect(shared.pickTargetSource(sources, { sourceId: "c" })?.id).toBe("c");
    expect(shared.pickTargetSource(sources, { storagePaths: ["u/d/decks/x-series-a.pdf"] })?.id).toBe("c");
    expect(shared.pickTargetSource(sources, { storagePaths: ["u/d/unknown.pdf"] })?.id).toBe("a");
    expect(shared.pickTargetSource([], {})).toBeUndefined();
  });
});

// ------------------------------------------------------------------ schema + backend contracts
describe("schema: one primary deck per deal", () => {
  const sql = read("supabase/migrations/20261002090000_multi_deck_sources.sql");
  it("adds is_primary/label, enforces a single primary, and backfills existing deals", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS label text/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_sources_one_primary_per_deal\s+ON public\.sources \(deal_id\) WHERE is_primary/);
    expect(sql).toMatch(/UPDATE public\.sources s\s+SET is_primary = true/);
  });
  it("makes the first deck primary automatically so no ingestion path needs changing, and never a supporting document", () => {
    expect(sql).toMatch(/BEFORE INSERT ON public\.sources/);
    expect(sql).toMatch(/NEW\.source_type <> 'attachment'/);
    expect(sql).toMatch(/AFTER DELETE ON public\.sources/);
  });
  it("promotes a deck atomically, owner-only", () => {
    expect(sql).toMatch(/FUNCTION public\.set_primary_source\(_source_id uuid\)/);
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).toMatch(/user_id = auth\.uid\(\)/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.set_primary_source\(uuid\) TO authenticated/);
  });
  it("marks capture jobs that belong to an attached deck", () => {
    expect(sql).toMatch(/ALTER TABLE public\.capture_jobs ADD COLUMN IF NOT EXISTS attach boolean NOT NULL DEFAULT false/);
  });
});

describe("edge functions: attaching a deck never disturbs the deal", () => {
  const pd = read("supabase/functions/process-deck/index.ts");
  const cap = read("supabase/functions/run-docsend-capture/index.ts");
  const link = read("supabase/functions/process-docsend/index.ts");
  const mcp = read("supabase/functions/mcp-server/index.ts");
  const dr = read("supabase/functions/deep-research/index.ts");

  it("process-deck handles attach before failCtx, so a failed extra deck cannot mark the deal errored", () => {
    const attachAt = pd.indexOf("return await handleAttachDeck(");
    const failCtxAt = pd.indexOf("failCtx = { adminClient, dealId, userId");
    expect(attachAt).toBeGreaterThan(0);
    expect(attachAt).toBeLessThan(failCtxAt);
    const handler = pd.slice(pd.indexOf("async function handleAttachDeck"), pd.indexOf("async function syncAttachedDeckToDrive"));
    expect(handler).not.toMatch(/setDealStatus|status: "error"[\s\S]*from\("deals"\)/);
    expect(handler).not.toMatch(/deep-research|updatePayload\.name/);
    expect(handler).toMatch(/\.eq\("id", source\.id\)/);
    // Drive sync of an attached deck goes through the attach-aware path only,
    // which never touches the deal's status or its primary Drive id.
    const driveSync = pd.slice(pd.indexOf("async function syncAttachedDeckToDrive"), pd.indexOf("/** Helper to update deal status */"));
    expect(driveSync).toMatch(/attach: true/);
    expect(driveSync).toMatch(/sourceId: args\.sourceId/);
    expect(driveSync).not.toMatch(/from\("deals"\)\.update/);
  });

  it("process-deck writes extracted text to ONE source, not every source of the deal", () => {
    expect(pd).toMatch(/pickTargetSource\(/);
    expect(pd).not.toMatch(/update\(\{ extracted_text: extractedText\.slice\(0, 100_000\) \}\)\s*\.eq\("deal_id", dealId\)/);
    expect(pd).toMatch(/update\(\{ extracted_text: extractedText\.slice\(0, 100_000\) \}\)\s*\.eq\("id", existingSource\.id\)/);
  });

  it("an attached link capture gets its own file and source, and leaves deal status and size alone", () => {
    expect(cap).toMatch(/capturedDeckPath\(args\.userId, args\.dealId, args\.attach \? args\.jobId : null\)/);
    expect(cap).toMatch(/is_primary: false/);
    expect(cap).toMatch(/if \(!attach\) \{\s*await adminClient\s*\.from\("deals"\)\s*\.update\(\{ status: "scraping"/);
    expect(cap).toMatch(/if \(attach\) return;/);
    expect(cap).toMatch(/attach: true, sourceId: attachSourceId/);
    // Re-capturing the deal's own link refreshes the primary, not a newer attached deck.
    expect(cap).toMatch(/\.order\("is_primary", \{ ascending: false \}\)/);
  });

  it("link ingest and the agent tool accept an existing deal", () => {
    expect(link).toMatch(/dealId: attachDealId/);
    expect(link).toMatch(/attach: true/);
    expect(mcp).toMatch(/deal_id: \{ type: "string", description: "Existing deal to link this deck to/);
    expect(mcp).toMatch(/await assertOwnedDeal\(attachDealId, userId\)/);
    expect(mcp).toMatch(/body: JSON\.stringify\(\{ dealId: attachDealId, url, attach: true \}\)/);
    expect(mcp).toMatch(/select\("id, file_name, source_type, is_primary, label, processing_status, created_at"\)/);
  });

  it("deep research is anchored on the primary deck", () => {
    expect(dr).toMatch(/\.order\("is_primary", \{ ascending: false \}\)\s*\.order\("created_at", \{ ascending: false \}\)/);
  });

  it("re-running a deal targets its primary deck and its own capture link", () => {
    const hooks = read("src/hooks/useDeals.ts");
    expect(hooks.match(/\.eq\("attach", false\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(hooks).toMatch(/\.not\("storage_path", "is", null\)\s*\.order\("is_primary", \{ ascending: false \}\)/);
    expect(SOURCE_LIST_COLUMNS).toContain("is_primary");
    expect(SOURCE_LIST_COLUMNS).not.toMatch(/extracted_text|preview_images/);
  });
});

// ------------------------------------------------------------------ hooks
describe("linking another deck to an existing deal", () => {
  const pdf = () => new File([new Uint8Array([1, 2, 3])], "Series A deck.pdf", { type: "application/pdf" });

  it("uploads to a unique path, inserts a NON-primary source on the SAME deal, and extracts in attach mode", async () => {
    const { result } = renderHook(() => useAddDeckToDeal(), { wrapper });
    await result.current.mutateAsync({ dealId: "deal-1", file: pdf(), label: " Series A " });

    const path = (sb.state.upload.mock.calls as unknown as string[][])[0][0];
    expect(path).toMatch(/^user-1\/deal-1\/decks\/[a-z0-9]+-Series_A_deck\.pdf$/);
    expect(sb.state.inserted[0]).toMatchObject({
      deal_id: "deal-1", user_id: "user-1", file_name: "Series A deck.pdf", storage_path: path,
      is_primary: false, processing_status: "processing", label: "Series A",
    });
    expect(sb.supabase.from).toHaveBeenCalledWith("sources");
    expect(sb.supabase.from).not.toHaveBeenCalledWith("deals");
    expect(sb.state.invoke).toHaveBeenCalledWith("process-deck", { body: { dealId: "deal-1", storagePath: path, sourceId: "src-new", attach: true } });
  });

  it("rejects non-deck files and cleans up the upload if the source row cannot be created", async () => {
    const { result } = renderHook(() => useAddDeckToDeal(), { wrapper });
    await expect(result.current.mutateAsync({ dealId: "deal-1", file: new File(["x"], "notes.txt") })).rejects.toThrow(/PDF or PowerPoint/);
    expect(sb.state.upload).not.toHaveBeenCalled();

    sb.state.insertResult = { data: null as any, error: { message: "denied" } };
    await expect(result.current.mutateAsync({ dealId: "deal-1", file: pdf() })).rejects.toBeTruthy();
    expect(sb.state.removeFiles).toHaveBeenCalledTimes(1);
    expect(sb.state.invoke).not.toHaveBeenCalled();
  });

  it("links a DocSend/Papermark/PandaDoc URL to the existing deal with attach=true end to end", async () => {
    const { result } = renderHook(() => useAddDeckLinkToDeal(), { wrapper });
    await result.current.mutateAsync({ dealId: "deal-1", url: " https://docsend.com/view/abc " });
    expect(sb.state.invoke).toHaveBeenNthCalledWith(1, "process-docsend", { body: { url: "https://docsend.com/view/abc", dealId: "deal-1" } });
    expect(sb.state.invoke).toHaveBeenNthCalledWith(2, "run-docsend-capture", { body: { dealId: "deal-1", jobId: "job1", url: "https://docsend.com/view/abc", attach: true } });
    await expect(result.current.mutateAsync({ dealId: "deal-1", url: "https://example.com/deck" })).rejects.toThrow(/DocSend, Papermark, or PandaDoc/);
  });

  it("promotes via the atomic RPC and removes a source together with its file", async () => {
    const promote = renderHook(() => useSetPrimarySource(), { wrapper });
    await promote.result.current.mutateAsync({ sourceId: "s2", dealId: "deal-1" });
    expect(sb.state.rpc).toHaveBeenCalledWith("set_primary_source", { _source_id: "s2" });

    const remove = renderHook(() => useRemoveSource(), { wrapper });
    await remove.result.current.mutateAsync({ sourceId: "s2", dealId: "deal-1", storagePath: "user-1/deal-1/decks/k-x.pdf" });
    expect(sb.state.deleted).toContain("s2");
    expect(sb.state.removeFiles).toHaveBeenCalledWith(["user-1/deal-1/decks/k-x.pdf"]);
  });
});

// ------------------------------------------------------------------ UI
describe("sources rail with several decks", () => {
  const rows = [
    { id: "s1", deal_id: "d", file_name: "seed.pdf", source_type: "upload", is_primary: true, created_at: "2026-01-01" },
    { id: "s2", deal_id: "d", file_name: "series-a.pdf", source_type: "upload", is_primary: false, created_at: "2026-03-01", processing_status: "processing" },
    { id: "s3", deal_id: "d", file_name: "model.xlsx", source_type: "attachment", created_at: "2026-03-02" },
  ];
  const base = { selected: new Set<string>(), onToggle: () => {}, onToggleAll: () => {} };

  it("marks the primary deck once there is more than one deck, and shows an attached deck being read", () => {
    render(<SourcesRail sources={rows} {...base} />);
    expect(screen.getByText("Primary")).toBeInTheDocument();
    expect(screen.getByText("Reading…")).toBeInTheDocument();
    expect(screen.queryByText("Add deck")).toBeNull();
  });

  it("does not badge a lone deck", () => {
    render(<SourcesRail sources={[rows[0], rows[2]]} {...base} />);
    expect(screen.queryByText("Primary")).toBeNull();
  });

  it("lets the owner promote and remove, without toggling the row", () => {
    const onToggle = vi.fn(), onMakePrimary = vi.fn(), onRemove = vi.fn();
    render(<SourcesRail sources={rows} {...base} onToggle={onToggle} canManage onAddFile={() => {}} onAddLink={() => {}} onMakePrimary={onMakePrimary} onRemove={onRemove} />);
    fireEvent.click(screen.getByLabelText("Make series-a.pdf the primary deck"));
    expect(onMakePrimary).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }));
    expect(screen.queryByLabelText("Make seed.pdf the primary deck")).toBeNull();
    expect(screen.queryByLabelText("Make model.xlsx the primary deck")).toBeNull();
    fireEvent.click(screen.getByLabelText("Remove series-a.pdf from this deal"));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }));
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByText("Add deck")).toBeInTheDocument();
  });

  it("viewers of a shared deal cannot manage decks", () => {
    render(<SourcesRail sources={rows} {...base} onMakePrimary={() => {}} onRemove={() => {}} />);
    expect(screen.queryByLabelText(/Make .* the primary deck/)).toBeNull();
    expect(screen.queryByLabelText(/Remove .* from this deal/)).toBeNull();
  });
});

describe("Add deck control", () => {
  it("links a file or a URL and closes", () => {
    const onAddFile = vi.fn(), onAddLink = vi.fn();
    render(<AddDeckControl onAddFile={onAddFile} onAddLink={onAddLink} />);
    fireEvent.click(screen.getByText("Add deck"));
    const file = new File(["x"], "v2.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Deck file to link to this deal"), { target: { files: [file] } });
    expect(onAddFile).toHaveBeenCalledWith(file);

    fireEvent.click(screen.getByText("Add deck"));
    fireEvent.change(screen.getByLabelText("Deck link to add to this deal"), { target: { value: " https://docsend.com/view/x " } });
    fireEvent.click(screen.getByText("Link"));
    expect(onAddLink).toHaveBeenCalledWith("https://docsend.com/view/x");
    expect(screen.getByText("Add deck")).toBeInTheDocument();
  });

  it("shows progress while a deck is being added", () => {
    render(<AddDeckControl onAddFile={() => {}} onAddLink={() => {}} busy />);
    expect(screen.getByText("Adding…")).toBeInTheDocument();
  });
});

describe("Data Room page", () => {
  beforeEach(() => {
    dataRoom.deals = [
      { id: "d1", name: "Acme Robotics", user_id: "user-1" },
      { id: "d2", name: "Beta Bio", user_id: "user-1" },
      { id: "d3", name: "Empty Co", user_id: "user-1" },
    ];
    dataRoom.sources = [
      { id: "a1", deal_id: "d1", file_name: "acme-seed.pdf", source_type: "upload", is_primary: true, original_size: "2.0MB", created_at: "2026-01-01T00:00:00Z", storage_path: "p/a1" },
      { id: "a2", deal_id: "d1", file_name: "acme-series-a.pdf", source_type: "docsend", is_primary: false, original_size: "3.1MB", created_at: "2026-06-01T00:00:00Z", storage_path: "p/a2" },
      { id: "a3", deal_id: "d1", file_name: "acme-model.xlsx", source_type: "attachment", created_at: "2026-06-02T00:00:00Z", storage_path: "p/a3" },
      { id: "b1", deal_id: "d2", file_name: "beta.pdf", source_type: "upload", is_primary: true, created_at: "2026-02-01T00:00:00Z", storage_path: "p/b1" },
    ];
  });
  const mount = () => render(<MemoryRouter><DataRoom /></MemoryRouter>);

  it("is real data: one folder per deal with every linked deck and document, primary first", () => {
    mount();
    expect(screen.queryByText(/NovaStar AI/)).toBeNull(); // the old hardcoded mock
    const acme = screen.getByLabelText("Acme Robotics data room");
    expect(within(acme).getByText(/2 decks · 1 document/)).toBeInTheDocument();
    const names = within(acme).getAllByRole("listitem").map((li) => li.textContent);
    expect(names[0]).toContain("acme-seed.pdf");
    expect(names[0]).toContain("Primary deck");
    expect(names[1]).toContain("acme-series-a.pdf");
    expect(names[2]).toContain("Document");
    expect(screen.getByLabelText("Beta Bio data room")).toBeInTheDocument();
    expect(screen.queryByLabelText("Empty Co data room")).toBeNull();
    expect(screen.getByText(/2 deals · 4 files/)).toBeInTheDocument();
    expect(within(acme).getByText("Open deal").closest("a")).toHaveAttribute("href", "/?deal=d1");
  });

  it("searches by deal or file name and collapses a folder", () => {
    mount();
    fireEvent.change(screen.getByLabelText("Search the data room"), { target: { value: "series-a" } });
    expect(screen.getByLabelText("Acme Robotics data room")).toBeInTheDocument();
    expect(screen.queryByLabelText("Beta Bio data room")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search the data room"), { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches that search")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search the data room"), { target: { value: "" } });
    const acme = screen.getByLabelText("Acme Robotics data room");
    fireEvent.click(within(acme).getByText("Acme Robotics"));
    expect(within(acme).queryByText("acme-seed.pdf")).toBeNull();
  });

  it("is reachable from the sidebar", () => {
    expect(read("src/components/AppSidebar.tsx")).toMatch(/title: "Data Room", url: "\/data-room"/);
  });
});
