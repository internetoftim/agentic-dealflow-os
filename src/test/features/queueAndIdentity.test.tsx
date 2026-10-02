import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as queue from "../../../supabase/functions/_shared/job-queue";
import * as browserQueue from "@/lib/jobQueue";
import { isPlaceholderName, hasReadableContent, identityUpdate } from "../../../supabase/functions/_shared/deal-identity";
import { formatSlides, naivePdfText, betterExtraction } from "../../../supabase/functions/_shared/deck-text";

// Regression: a deck sat "Queued — waiting for active job" with nothing
// running, because three deals stuck in "extracting" since July held the
// per-user queue forever. When it finally ran, the PDF text extractor returned
// nothing and the model's "Unknown" overwrote the deal's name.

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");
const NOW = Date.parse("2026-10-02T14:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

// ------------------------------------------------------------------ queue rules
describe("processing queue: a dead job never holds the queue", () => {
  it("a job is live only while it keeps touching its deal", () => {
    expect(queue.isLiveJob({ id: "a", status: "extracting", updated_at: ago(2) }, NOW)).toBe(true);
    expect(queue.isLiveJob({ id: "a", status: "extracting", updated_at: ago(21) }, NOW)).toBe(false);
    expect(queue.isLiveJob({ id: "a", status: "extracting", updated_at: ago(60 * 24 * 70) }, NOW)).toBe(false);
    expect(queue.isLiveJob({ id: "a", status: "memo-ready", updated_at: ago(1) }, NOW)).toBe(false);
    expect(queue.isLiveJob({ id: "a", status: "queued", updated_at: ago(1) }, NOW)).toBe(false);
    expect(queue.isLiveJob({ id: "a", status: "extracting", updated_at: null }, NOW)).toBe(false);
    expect(queue.isStaleJob({ id: "a", status: "scraping", updated_at: ago(45) }, NOW)).toBe(true);
    expect(queue.isStaleJob({ id: "a", status: "error", updated_at: ago(45) }, NOW)).toBe(false);
  });

  it("the exact incident: zombies from July + three queued deals → fail the zombies, start the oldest queued", () => {
    const deals = [
      { id: "synrg", status: "extracting", updated_at: ago(60 * 24 * 70), created_at: "2026-07-23" },
      { id: "metadesk", status: "extracting", updated_at: ago(60 * 24 * 72), created_at: "2026-07-22" },
      { id: "protico", status: "queued", updated_at: ago(60 * 24 * 10), created_at: "2026-09-21" },
      { id: "cauldron", status: "queued", updated_at: ago(60 * 38), created_at: "2026-09-30" },
      { id: "pitchdeck", status: "queued", updated_at: ago(12), created_at: "2026-10-02" },
    ];
    expect(queue.hasLiveJob(deals, NOW)).toBe(false);
    const plan = queue.planQueueHeal(deals, NOW);
    expect(plan.failIds.sort()).toEqual(["metadesk", "synrg"]);
    expect(plan.start?.id).toBe("protico");
  });

  it("does not start a second job while one is really running, and leaves a healthy queue alone", () => {
    const deals = [
      { id: "running", status: "searching-website", updated_at: ago(1), created_at: "2026-10-02T13:00:00Z" },
      { id: "waiting", status: "queued", updated_at: ago(1), created_at: "2026-10-02T13:30:00Z" },
    ];
    const plan = queue.planQueueHeal(deals, NOW);
    expect(plan.failIds).toEqual([]);
    expect(plan.start).toBeUndefined();
    expect(queue.planQueueHeal([{ id: "x", status: "memo-ready", updated_at: ago(5) }], NOW)).toEqual({ failIds: [], start: undefined });
  });

  it("the browser mirror matches the edge-function rules", () => {
    expect([...browserQueue.PROCESSING_STATUSES]).toEqual([...queue.PROCESSING_STATUSES]);
    expect(browserQueue.JOB_STALE_MS).toBe(queue.JOB_STALE_MS);
    for (const d of [
      { id: "a", status: "extracting", updated_at: ago(2) },
      { id: "b", status: "extracting", updated_at: ago(500) },
      { id: "c", status: "queued", updated_at: ago(2) },
    ]) expect(browserQueue.isLiveJob(d, NOW)).toBe(queue.isLiveJob(d, NOW));
  });

  it("every place that decides 'is a job running?' uses the live rule, and the cron reaps", () => {
    const upload = read("src/hooks/useDeals.ts");
    expect(upload).toMatch(/const hasActiveJob = hasLiveJob\(activeDeals \?\? \[\]\)/);
    expect(read("supabase/functions/_shared/gmail-ingest.ts")).toMatch(/let hasActiveJob = hasLiveJob\(active \?\? \[\]\)/);
    expect(read("supabase/functions/public-intake/index.ts")).toMatch(/hasActiveJob = hasLiveJob\(activeDeals \?\? \[\]\)/);

    const listener = read("supabase/functions/gmail-listener/index.ts");
    expect(listener).toMatch(/await healQueues\(\{ adminClient, supabaseUrl, serviceKey: supabaseServiceKey \}\)/);
    // The reaper runs before mail polling so a slow inbox cannot starve it.
    expect(listener.indexOf("await healQueues(")).toBeLessThan(listener.indexOf('.eq("gmail_label_enabled", true)'));

    const pd = read("supabase/functions/process-deck/index.ts");
    expect(pd).toMatch(/await healQueues\(\{ adminClient, supabaseUrl, serviceKey: supabaseServiceKey \}, userId\)/);
    const heal = read("supabase/functions/_shared/queue-heal.ts");
    // The next job is dispatched, not awaited: awaiting a whole pipeline is what got runs killed mid-flight.
    expect(heal).toMatch(/EdgeRuntime\?\.waitUntil\?\.\(dispatch\)/);
    expect(heal).not.toMatch(/await fetch\(/);
  });

  it("the recovery endpoint that starts processing is not open to the world", () => {
    const listener = read("supabase/functions/gmail-listener/index.ts");
    const recovery = listener.slice(listener.indexOf("if (body?.retryDealId)"), listener.indexOf("Queue reaper"));
    expect(recovery).toMatch(/let allowed = bearer === supabaseServiceKey/);
    expect(recovery).toMatch(/allowed = !!user && user\.id === deal\.user_id/);
    expect(recovery.indexOf("if (!allowed)")).toBeLessThan(recovery.indexOf("functions/v1/process-deck"));
  });
});

// ------------------------------------------------------------------ identity + extraction
describe("deal identity: a model's 'Unknown' never overwrites a real name", () => {
  it("recognises placeholders", () => {
    for (const n of ["Unknown", " unknown ", "Untitled", "N/A", "", "Pitch Deck", "Unknown.", null, undefined, 42]) {
      expect(isPlaceholderName(n), String(n)).toBe(true);
    }
    for (const n of ["Protico", "Cauldron", "PitchDeck 2309 2", "Unknown Labs", "Acme"]) {
      expect(isPlaceholderName(n), n).toBe(false);
    }
  });

  it("the incident: empty extraction → model says Unknown → the deal keeps its name, stage and sector", () => {
    const current = { name: "Protico", stage: "Seed", sector: "Web3" };
    const update = identityUpdate(current, { startup_name: "Unknown", stage: "Unknown", sector: "Unknown", ask_amount: null });
    expect(update).toEqual({});
  });

  it("a real read of the deck still updates the deal, cleaned", () => {
    const update = identityUpdate(
      { name: "PitchDeck 2309 2", stage: "Unknown", sector: null },
      { startup_name: " Acme / Robotics ", stage: "Seed", sector: "Robotics", ask_amount: "$2M", valuation: "unknown" },
      (n) => n.replace(/[/]/g, "").replace(/\s+/g, " ").trim(),
    );
    expect(update).toEqual({ name: "Acme Robotics", stage: "Seed", sector: "Robotics", ask_amount: "$2M" });
  });

  it("'Unknown' may fill an empty stage but never erases a known one", () => {
    expect(identityUpdate({ stage: null }, { stage: "Unknown" })).toEqual({ stage: "Unknown" });
    expect(identityUpdate({ stage: "Series A" }, { stage: "Unknown" })).toEqual({});
  });

  it("no text and no slide images means there is nothing to identify", () => {
    expect(hasReadableContent("", 0)).toBe(false);
    expect(hasReadableContent("   \n ", 0)).toBe(false);
    expect(hasReadableContent("", 3)).toBe(true);
    expect(hasReadableContent("Acme Robotics — warehouse automation for mid-market 3PLs. Seed.", 0)).toBe(true);
  });
});

describe("deck text extraction", () => {
  it("formats pages as [Slide N] blocks (what research and chat grounding parse) and drops empty pages", () => {
    expect(formatSlides(["Acme  Robotics\n  Seed", "", "Team\nJane"])).toBe("[Slide 1] Acme Robotics\nSeed\n\n[Slide 3] Team\nJane");
    expect(formatSlides([])).toBe("");
  });

  it("the old regex reader finds nothing in a compressed PDF — the reason a real parser is required", () => {
    const compressed = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Filter /FlateDecode /Length 20 >>\nstream\nx\x9c\x0b\xc9\xc8,V\x00\xa2D\x85\x92\xd4\xe2\x12\x00\nendstream\nendobj");
    const r = naivePdfText(compressed.buffer);
    expect(r.text).toBe("");
    expect(r.pageCount).toBe(1);
    const plain = new TextEncoder().encode("BT (Acme Robotics) Tj ET");
    expect(naivePdfText(plain.buffer).text).toBe("Acme Robotics");
  });

  it("keeps the richer extraction and a known page count", () => {
    expect(betterExtraction({ text: "", pageCount: 0 }, { text: "abc", pageCount: 3 })).toEqual({ text: "abc", pageCount: 3 });
    expect(betterExtraction({ text: "[Slide 1] long text", pageCount: 12 }, { text: "", pageCount: 0 })).toEqual({ text: "[Slide 1] long text", pageCount: 12 });
  });

  it("process-deck uses the real parser everywhere, guards identity, and never searches the web for a placeholder name", () => {
    const pd = read("supabase/functions/process-deck/index.ts");
    expect(pd).not.toMatch(/function extractPdfText\(/);
    expect(pd.match(/await extractPdfTextRobust\(/g)?.length).toBe(2);
    expect(read("supabase/functions/_shared/pdf-text.ts")).toMatch(/from "npm:unpdf@/);
    expect(pd).toMatch(/const unreadable = !hasReadableContent\(extractedText, previewImages\.length\)/);
    expect(pd).toMatch(/if \(isLocalModel \|\| unreadable\)/);
    expect(pd).toMatch(/\.\.\.identityUpdate\(identityNow \?\? \{\}, metadata, sanitizeCompanyName\)/);
    expect(pd).not.toMatch(/updatePayload\.name = sanitizeCompanyName\(metadata\.startup_name\)/);
    expect(pd).toMatch(/if \(currentDeal\?\.name && !isPlaceholderName\(currentDeal\.name\)\)/);
  });
});

// ------------------------------------------------------------------ start now
const sb = vi.hoisted(() => {
  const state = {
    invoke: vi.fn(async () => ({ data: { success: true }, error: null })),
    updates: [] as any[],
    source: { data: { id: "s1", storage_path: "u/d1/deck.pdf" } as any, error: null },
  };
  const supabase = {
    functions: { invoke: state.invoke },
    from: vi.fn((table: string) => {
      const b: any = {};
      for (const m of ["select", "not", "order", "limit"]) b[m] = vi.fn(() => b);
      b.eq = vi.fn(() => b);
      b.maybeSingle = vi.fn(async () => state.source);
      b.update = vi.fn((row: unknown) => { state.updates.push({ table, row }); return { eq: vi.fn(async () => ({ error: null })) }; });
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

import { useStartQueuedDeal } from "@/hooks/useDeals";
import { DealsList } from "@/components/DealsList";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>
);

describe("Start now on a queued deal", () => {
  beforeEach(() => {
    sb.state.invoke.mockClear();
    sb.state.updates.length = 0;
    sb.state.source = { data: { id: "s1", storage_path: "u/d1/deck.pdf" }, error: null };
  });

  it("moves the deal out of queued and starts processing its stored deck", async () => {
    const { result } = renderHook(() => useStartQueuedDeal(), { wrapper });
    await result.current.mutateAsync({ dealId: "d1" });
    expect(sb.state.updates[0]).toMatchObject({ table: "deals", row: { status: "uploading", paused_at_step: null } });
    expect(sb.state.invoke).toHaveBeenCalledWith("process-deck", { body: { dealId: "d1", storagePath: "u/d1/deck.pdf" } });
  });

  it("refuses when the deal has no stored deck, without changing its status", async () => {
    sb.state.source = { data: null, error: null };
    const { result } = renderHook(() => useStartQueuedDeal(), { wrapper });
    await expect(result.current.mutateAsync({ dealId: "d1" })).rejects.toThrow(/No stored deck/);
    expect(sb.state.updates).toHaveLength(0);
    expect(sb.state.invoke).not.toHaveBeenCalled();
  });

  it("the workspace explains what a queued deal is waiting for and offers Start now only when nothing is running", () => {
    const page = read("src/pages/DealWorkspace.tsx");
    expect(page).not.toMatch(/Queued — waiting for active job/);
    expect(page).toMatch(/Queued — starts when/);
    expect(page).toMatch(/Queued — nothing else is running; starting shortly/);
    expect(page).toMatch(/isOwnerOfActive && !runningDeal &&/);
    expect(page).toMatch(/d\.user_id === user\.id && isLiveJob\(d\)/);
  });
});

// ------------------------------------------------------------------ left panel
describe("workspace left panel", () => {
  const deals = [
    { id: "d1", name: "Protico", user_id: "me", status: "memo-ready", source: "inbound" },
    { id: "d2", name: "Cauldron", user_id: "me", status: "extracting", source: "inbound" },
    { id: "d3", name: "Shared Co", user_id: "someone-else", status: "memo-ready", source: "manual" },
  ];
  const props = {
    deals, activeId: "d1", currentUserId: "me",
    onSelect: vi.fn(), onRerun: vi.fn(), onDelete: vi.fn(),
    canRerun: (d: { status: string }) => d.status !== "extracting",
    memberLabel: () => null,
  };

  beforeEach(() => {
    window.localStorage.clear();
    props.onSelect.mockClear(); props.onRerun.mockClear(); props.onDelete.mockClear();
  });

  it("order is Add a deal → Loaded Sources → Pipeline Status → Deals", () => {
    const page = read("src/pages/DealWorkspace.tsx");
    const left = page.slice(page.indexOf("{/* LEFT PANEL"), page.indexOf("{/* RIGHT PANEL */}"));
    const add = left.indexOf("Add a deal</h2>");
    const sources = left.indexOf('"Loaded Sources"');
    const pipeline = left.indexOf("Pipeline Status</h3>");
    const list = left.indexOf("<DealsList");
    expect(add).toBeGreaterThan(0);
    expect(add).toBeLessThan(sources);
    expect(sources).toBeLessThan(pipeline);
    expect(pipeline).toBeLessThan(list);
    // The old inline list at the top is gone.
    expect(left).not.toMatch(/deal list first/);
    expect(left.match(/Deals · /g)).toBeNull();
  });

  it("lists deals, selects, re-runs and deletes only what the user owns", () => {
    render(<DealsList {...props} />);
    expect(screen.getByText("Deals · 3")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cauldron"));
    expect(props.onSelect).toHaveBeenCalledWith("d2");
    fireEvent.click(screen.getByLabelText("Re-run workflow for Protico"));
    expect(props.onRerun).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }));
    expect(screen.queryByLabelText("Re-run workflow for Cauldron")).toBeNull(); // processing
    expect(screen.queryByLabelText("Delete Shared Co")).toBeNull(); // not mine
    fireEvent.click(screen.getByLabelText("Delete Cauldron"));
    expect(props.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "d2" }));
    expect(screen.getByLabelText("Shared with you")).toBeInTheDocument();
  });

  it("collapses to its header, keeps showing the active deal, and remembers the choice", () => {
    const { unmount } = render(<DealsList {...props} />);
    const header = screen.getByRole("button", { name: /Deals · 3/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Cauldron")).toBeNull();
    expect(screen.getByText("Protico")).toBeInTheDocument(); // active deal name stays visible in the header
    expect(window.localStorage.getItem("easyvc.dealsList.collapsed")).toBe("1");
    unmount();

    render(<DealsList {...props} />);
    expect(screen.getByRole("button", { name: /Deals · 3/ })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: /Deals · 3/ }));
    expect(screen.getByText("Cauldron")).toBeInTheDocument();
    expect(window.localStorage.getItem("easyvc.dealsList.collapsed")).toBe("0");
  });

  it("renders nothing when there are no deals", () => {
    const { container } = render(<DealsList {...props} deals={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
