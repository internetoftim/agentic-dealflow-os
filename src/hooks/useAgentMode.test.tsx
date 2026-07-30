import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// --- Mocks ---------------------------------------------------------------
const maybeSingle = vi.fn();
const authState = { user: { id: "user-1" } as { id: string } | null };

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => authState }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    }),
  },
}));

import { useAgentMode } from "./useAgentMode";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useAgentMode", () => {
  beforeEach(() => {
    maybeSingle.mockReset();
    authState.user = { id: "user-1" };
  });

  it("defaults agentMode to false when the settings row is missing", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(() => useAgentMode(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.agentMode).toBe(false);
  });

  it("reflects agentMode=true when the row has the flag set", async () => {
    maybeSingle.mockResolvedValue({ data: { agent_mode_enabled: true }, error: null });
    const { result } = renderHook(() => useAgentMode(), { wrapper });
    await waitFor(() => expect(result.current.agentMode).toBe(true));
  });

  it("defaults to false for a logged-out user (query disabled)", async () => {
    authState.user = null;
    const { result } = renderHook(() => useAgentMode(), { wrapper });
    expect(result.current.agentMode).toBe(false);
  });
});
