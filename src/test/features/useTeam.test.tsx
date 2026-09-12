import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { makeSupabaseMock } from "./supabaseMock";

let mock = makeSupabaseMock({});
vi.mock("@/integrations/supabase/client", () => ({ get supabase() { return mock.supabase; } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "me", email: "me@fund.com" } }) }));

import { useTeam } from "@/hooks/useTeam";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

beforeEach(() => vi.clearAllMocks());

describe("useTeam", () => {
  it("resolves to no team when the user has no membership", async () => {
    mock = makeSupabaseMock({ tables: { team_members: { data: null } } });
    const { result } = renderHook(() => useTeam(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.team).toBeNull();
    expect(result.current.members).toEqual([]);
    expect(result.current.isOwner).toBe(false);
    expect(result.current.memberLabel("anyone")).toBeNull();
    // never asks for a roster without a team
    expect(mock.supabase.rpc).not.toHaveBeenCalledWith("get_team_roster");
  });

  it("loads the team and roster, and labels members by display name then email", async () => {
    mock = makeSupabaseMock({
      tables: {
        team_members: { data: { team_id: "t1" } },
        teams: { data: { id: "t1", name: "Fund I", owner_id: "me", invite_code: "c", created_at: "" } },
      },
      rpc: {
        get_team_roster: {
          data: [
            { user_id: "me", role: "owner", joined_at: "", email: "me@fund.com", display_name: "Tim" },
            { user_id: "ana", role: "member", joined_at: "", email: "ana@fund.com", display_name: null },
          ],
        },
      },
    });
    const { result } = renderHook(() => useTeam(), { wrapper });
    await waitFor(() => expect(result.current.members).toHaveLength(2));
    expect(result.current.team?.name).toBe("Fund I");
    expect(result.current.isOwner).toBe(true);
    expect(result.current.memberLabel("me")).toBe("Tim");
    expect(result.current.memberLabel("ana")).toBe("ana");
    expect(result.current.memberLabel("stranger")).toBeNull();
  });

  it("routes create / join / leave / remove through the security-definer RPCs", async () => {
    mock = makeSupabaseMock({
      tables: { team_members: { data: null } },
      rpc: { create_team: { data: { id: "t9", name: "New" } }, join_team: { data: { id: "t1", name: "Fund I" } } },
    });
    const { result } = renderHook(() => useTeam(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await result.current.createTeam.mutateAsync("New");
    expect(mock.supabase.rpc).toHaveBeenCalledWith("create_team", { _name: "New" });
    await result.current.joinTeam.mutateAsync("code");
    expect(mock.supabase.rpc).toHaveBeenCalledWith("join_team", { _invite_code: "code" });
    await result.current.leaveTeam.mutateAsync();
    expect(mock.supabase.rpc).toHaveBeenCalledWith("leave_team");
    await result.current.removeMember.mutateAsync("ana");
    expect(mock.supabase.rpc).toHaveBeenCalledWith("remove_team_member", { _member_user_id: "ana" });
  });

  it("surfaces RPC errors (e.g. invalid invite code) to the caller", async () => {
    mock = makeSupabaseMock({
      tables: { team_members: { data: null } },
      rpc: { join_team: { data: null, error: new Error("Invalid invite code") } },
    });
    const { result } = renderHook(() => useTeam(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await expect(result.current.joinTeam.mutateAsync("bad")).rejects.toThrow("Invalid invite code");
  });
});
