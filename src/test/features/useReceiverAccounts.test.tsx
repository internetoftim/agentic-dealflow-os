import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { makeSupabaseMock } from "./supabaseMock";

let mock = makeSupabaseMock({});
vi.mock("@/integrations/supabase/client", () => ({ get supabase() { return mock.supabase; } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "me", email: "me@fund.com" } }) }));

import { useReceiverAccounts } from "@/hooks/useReceiverAccounts";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("useReceiverAccounts", () => {
  it("lists receivers selecting only status columns — never credentials", async () => {
    mock = makeSupabaseMock({ tables: { receiver_accounts: { data: [{ id: "r1", email: "inbox@fund.com", enabled: true }] } } });
    const { result } = renderHook(() => useReceiverAccounts(), { wrapper });
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));
    const b = mock.supabase.from.mock.results[0].value;
    const selected = b.select.mock.calls[0][0] as string;
    expect(selected).toContain("email");
    expect(selected).not.toMatch(/token/);
  });

  it("starts Google consent through the edge function with the user's JWT and returns the URL", async () => {
    mock = makeSupabaseMock({ tables: { receiver_accounts: { data: [] } } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ url: "https://accounts.google.com/x" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useReceiverAccounts(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const url = await result.current.connect.mutateAsync("https://app/settings");
    expect(url).toBe("https://accounts.google.com/x");
    const [calledUrl, init] = fetchMock.mock.calls[0] as any;
    expect(calledUrl).toMatch(/\/functions\/v1\/receiver-oauth\/start$/);
    expect(init.headers.Authorization).toBe("Bearer jwt-123");
    expect(JSON.parse(init.body)).toEqual({ returnTo: "https://app/settings" });
  });

  it("surfaces the edge function's error message when consent cannot start", async () => {
    mock = makeSupabaseMock({ tables: { receiver_accounts: { data: [] } } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "GOOGLE_CLIENT_ID is not configured" }), { status: 500 })));
    const { result } = renderHook(() => useReceiverAccounts(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await expect(result.current.connect.mutateAsync("https://app/settings")).rejects.toThrow("GOOGLE_CLIENT_ID is not configured");
  });

  it("pauses and disconnects by id", async () => {
    mock = makeSupabaseMock({ tables: { receiver_accounts: { data: [] } } });
    const { result } = renderHook(() => useReceiverAccounts(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await result.current.setEnabled.mutateAsync({ id: "r1", enabled: false });
    expect(mock.updates.receiver_accounts?.[0]).toEqual({ enabled: false });
    await result.current.disconnect.mutateAsync("r1");
    // invalidate() triggers a refetch, so find the builder that received delete()
    const b = mock.supabase.from.mock.results.map((r: any) => r.value).find((v: any) => v.delete.mock.calls.length > 0);
    expect(b).toBeDefined();
    expect(b.eq).toHaveBeenCalledWith("id", "r1");
  });

  it("mints an invite through /invite with the user's JWT and returns the link", async () => {
    mock = makeSupabaseMock({ tables: { receiver_accounts: { data: [] }, receiver_invites: { data: [] } } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "i1", url: "https://x/invite?t=abc", expires_at: "2026-09-19T00:00:00Z" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useReceiverAccounts(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const inv = await result.current.createInvite.mutateAsync("ops inbox");
    expect(inv.url).toBe("https://x/invite?t=abc");
    const [calledUrl, init] = fetchMock.mock.calls[0] as any;
    expect(calledUrl).toMatch(/\/receiver-oauth\/invite$/);
    expect(init.headers.Authorization).toBe("Bearer jwt-123");
    expect(JSON.parse(init.body)).toEqual({ note: "ops inbox" });
  });

  it("never selects the invite token hash from the client", async () => {
    mock = makeSupabaseMock({ tables: { receiver_accounts: { data: [] }, receiver_invites: { data: [] } } });
    const { result } = renderHook(() => useReceiverAccounts(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const invitesBuilder = mock.supabase.from.mock.results.map((r: any) => r.value)[mock.supabase.from.mock.calls.findIndex((c: any) => c[0] === "receiver_invites")];
    expect(invitesBuilder.select.mock.calls[0][0]).not.toMatch(/token/);
  });
});
