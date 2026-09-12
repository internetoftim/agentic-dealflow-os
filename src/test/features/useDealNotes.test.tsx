import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { makeSupabaseMock } from "./supabaseMock";

let mock = makeSupabaseMock({});
vi.mock("@/integrations/supabase/client", () => ({ get supabase() { return mock.supabase; } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "me", email: "me@fund.com" } }) }));

import { useDealNotes } from "@/hooks/useDealNotes";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

beforeEach(() => vi.clearAllMocks());

describe("useDealNotes", () => {
  it("stamps new notes with the author's id and email", async () => {
    mock = makeSupabaseMock({ tables: { deal_notes: { data: [] } } });
    const { result } = renderHook(() => useDealNotes("d1"), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await result.current.addNote.mutateAsync("hello");
    expect(mock.inserts.deal_notes?.[0]).toMatchObject({
      deal_id: "d1", user_id: "me", author_email: "me@fund.com", content: "hello",
    });
  });

  it("subscribes to realtime changes for the open deal and unsubscribes on unmount", async () => {
    mock = makeSupabaseMock({ tables: { deal_notes: { data: [] } } });
    const { unmount } = renderHook(() => useDealNotes("d1"), { wrapper });
    await waitFor(() => expect(mock.subscribe).toHaveBeenCalledTimes(1));
    expect(mock.supabase.channel).toHaveBeenCalledWith("deal-notes-d1");
    unmount();
    expect(mock.removedChannels).toHaveLength(1);
  });

  it("does nothing without a deal", async () => {
    mock = makeSupabaseMock({});
    renderHook(() => useDealNotes(undefined), { wrapper });
    expect(mock.supabase.channel).not.toHaveBeenCalled();
    expect(mock.supabase.from).not.toHaveBeenCalled();
  });

  it("orders pinned notes first, newest after", async () => {
    mock = makeSupabaseMock({ tables: { deal_notes: { data: [] } } });
    const { result } = renderHook(() => useDealNotes("d1"), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const b = mock.supabase.from.mock.results[0].value;
    expect(b.order).toHaveBeenNthCalledWith(1, "pinned", { ascending: false });
    expect(b.order).toHaveBeenNthCalledWith(2, "created_at", { ascending: false });
  });
});
