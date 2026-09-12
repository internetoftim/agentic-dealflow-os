import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeSupabaseMock } from "./supabaseMock";

// ---------------------------------------------------------------- ProtectedRoute
let authState: any = { user: null, loading: true, bootTimedOut: false };
vi.mock("@/contexts/AuthContext", async () => {
  const actual = await vi.importActual<any>("@/contexts/AuthContext");
  return { ...actual, useAuth: () => authState };
});
let mock = makeSupabaseMock({});
vi.mock("@/integrations/supabase/client", () => ({ get supabase() { return mock.supabase; } }));

import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useSources, hasInFlight, PROCESSING_POLL_MS, SOURCE_LIST_COLUMNS } from "@/hooks/useDeals";

// ProtectedRoute's approval gate reads profiles via react-query.
const app = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/login" element={<p>login page</p>} />
        <Route path="/" element={<ProtectedRoute><p>dashboard</p></ProtectedRoute>} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);

describe("ProtectedRoute under auth-lock contention", () => {
  beforeEach(() => { authState = { user: null, loading: true, bootTimedOut: false }; });

  it("shows a spinner while the session is loading", () => {
    app();
    expect(screen.queryByText("dashboard")).toBeNull();
    expect(screen.queryByText("login page")).toBeNull();
  });

  it("offers a retry instead of bouncing to login when the session lookup timed out", () => {
    authState = { user: null, loading: false, bootTimedOut: true };
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload }, writable: true });
    app();
    expect(screen.getByText("Still connecting…")).toBeInTheDocument();
    expect(screen.queryByText("login page")).toBeNull();
    fireEvent.click(screen.getByText("Retry"));
    expect(reload).toHaveBeenCalled();
  });

  it("redirects to login only on a genuine no-session result", () => {
    authState = { user: null, loading: false, bootTimedOut: false };
    app();
    expect(screen.getByText("login page")).toBeInTheDocument();
  });

  it("renders the app when signed in and approved", async () => {
    authState = { user: { id: "me" }, loading: false, bootTimedOut: false };
    mock = makeSupabaseMock({ tables: { profiles: { data: { approval_status: "approved" } } } });
    app();
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
  });

  it("holds unapproved accounts at a waiting screen instead of the app", async () => {
    authState = { user: { id: "me" }, loading: false, bootTimedOut: false };
    mock = makeSupabaseMock({ tables: { profiles: { data: { approval_status: "pending" } } } });
    app();
    expect(await screen.findByText(/awaiting approval/)).toBeInTheDocument();
    expect(screen.queryByText("dashboard")).toBeNull();
  });

  it("fails open when the profile lookup returns nothing (backfilled users are approved)", async () => {
    authState = { user: { id: "me" }, loading: false, bootTimedOut: false };
    mock = makeSupabaseMock({ tables: { profiles: { data: null } } });
    app();
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- polling policy
describe("dashboard polling policy", () => {
  it("polls only while something is in flight", () => {
    expect(hasInFlight([{ status: "inbox", deep_research_status: "pending" } as any])).toBe(false);
    expect(hasInFlight([{ status: "extracting", deep_research_status: "pending" } as any])).toBe(true);
    expect(hasInFlight([{ status: "queued", deep_research_status: "pending" } as any])).toBe(true);
    expect(hasInFlight([{ status: "memo-ready", deep_research_status: "researching" } as any])).toBe(true);
    expect(hasInFlight(undefined)).toBe(false);
    expect(PROCESSING_POLL_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("uses react-query's interval (paused in background tabs), not a raw setInterval", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/hooks/useDeals.ts"), "utf8");
    const body = src.slice(src.indexOf("export function useDeals()"), src.indexOf("export function useSources"));
    expect(body).toMatch(/refetchInterval:/);
    expect(body).not.toMatch(/setInterval\(/);
  });

  it("disables refetch-on-focus and background intervals globally", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/App.tsx"), "utf8");
    expect(src).toMatch(/refetchOnWindowFocus: false/);
    expect(src).toMatch(/refetchIntervalInBackground: false/);
    expect(src).toMatch(/staleTime: 10_000/);
  });
});

// ---------------------------------------------------------------- payload weight
describe("sources list never carries preview images or extracted text", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
  );
  it("selects an explicit light column list", async () => {
    authState = { user: { id: "me" }, loading: false, bootTimedOut: false };
    mock = makeSupabaseMock({ tables: { sources: { data: [] } } });
    const { result } = renderHook(() => useSources("d1"), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const selected = mock.supabase.from.mock.results[0].value.select.mock.calls[0][0] as string;
    expect(selected).toBe(SOURCE_LIST_COLUMNS);
    expect(selected).not.toMatch(/preview_images|extracted_text|\*/);
  });
});

// ---------------------------------------------------------------- auth callback discipline
describe("AuthContext never awaits Supabase inside onAuthStateChange", () => {
  const src = readFileSync(resolve(__dirname, "../../../src/contexts/AuthContext.tsx"), "utf8");
  const cb = src.slice(src.indexOf("onAuthStateChange("), src.indexOf("return () =>"));
  it("defers the token upsert and bounds the boot lookup", () => {
    expect(cb).not.toMatch(/await supabase/);
    expect(cb).toMatch(/setTimeout\(/);
    expect(cb).toMatch(/event === "SIGNED_IN"/);
    expect(src).toMatch(/Promise\.race\(\[supabase\.auth\.getSession\(\)/);
  });
});

// ---------------------------------------------------------------- schema
describe("perf index migration", () => {
  const sql = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260912170000_perf_indexes.sql"), "utf8");
  it("indexes every column the dashboard filters or RLS joins on", () => {
    for (const idx of ["deals(user_id, created_at DESC)", "deals(user_id, status)", "sources(deal_id", "deal_people(deal_id)", "capture_jobs(deal_id"]) {
      expect(sql).toContain(idx);
    }
  });
});
