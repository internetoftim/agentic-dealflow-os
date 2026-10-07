import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dealDriveFileIds, planDriveGrants, needsNotification, type DriveGrant, type ShareAccess } from "../../../supabase/functions/_shared/share-drive";

// Sharing a deal must grant the collaborator everything needed to review it:
// the database rows, the stored deck files, and view access to the deal's
// Google Drive files. Revoking takes all of it back.

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");

const sb = vi.hoisted(() => {
  const state = {
    rpc: vi.fn(async (_n: string, _a: unknown) => ({ data: "deal-1", error: null as null | { message: string } })),
    invoke: vi.fn(async (_n: string, _o: unknown) => ({ data: { success: true, granted: 2 }, error: null })),
  };
  return { state, supabase: { rpc: state.rpc, functions: { invoke: state.invoke }, from: vi.fn() } };
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: sb.supabase }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "owner-1" }, loading: false }) }));

beforeEach(() => {
  sb.state.rpc.mockClear();
  sb.state.invoke.mockClear();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>
);

describe("which Drive files a collaborator gets, and when access is taken back", () => {
  it("covers every deck copy, the legacy deal-level copy and the memo PDF, once each", () => {
    expect(dealDriveFileIds({ gdrive_file_id: "f1", memo_gdrive_file_id: "memo" }, [{ gdrive_file_id: "f1" }, { gdrive_file_id: "f2" }, { gdrive_file_id: null }]))
      .toEqual(["f1", "f2", "memo"]);
    expect(dealDriveFileIds(null, [])).toEqual([]);
  });

  const alice: ShareAccess = { id: "a1", user_id: "u-alice", revoked_at: null, email: "alice@fund.com" };
  const bob: ShareAccess = { id: "a2", user_id: "u-bob", revoked_at: "2026-10-07T00:00:00Z", email: null };
  const g = (access_id: string, drive_file_id: string, status: DriveGrant["status"], permission_id: string | null = "p"): DriveGrant =>
    ({ access_id, drive_file_id, status, permission_id });

  it("grants reader on every file an active collaborator does not already have, retrying failures and re-shares", () => {
    const plan = planDriveGrants([alice], ["f1", "f2", "f3"], [g("a1", "f1", "granted"), g("a1", "f2", "failed", null), g("a1", "f3", "revoked")]);
    expect(plan.grant).toEqual([
      { access_id: "a1", email: "alice@fund.com", drive_file_id: "f2" },
      { access_id: "a1", email: "alice@fund.com", drive_file_id: "f3" },
    ]);
    expect(plan.revoke).toEqual([]);
  });

  it("removes every permission held by a revoked collaborator and nothing else", () => {
    const plan = planDriveGrants([alice, bob], ["f1"], [g("a1", "f1", "granted"), g("a2", "f1", "granted", "perm-bob"), g("a2", "f9", "failed", null)]);
    expect(plan.grant).toEqual([]);
    expect(plan.revoke.map((r) => r.permission_id)).toEqual(["perm-bob"]);
  });

  it("flags an active collaborator without an email instead of guessing", () => {
    const plan = planDriveGrants([{ ...alice, email: null }], ["f1"], []);
    expect(plan.grant).toEqual([]);
    expect(plan.missingEmail).toEqual(["a1"]);
  });

  it("retries with a notification only when Drive demands one", () => {
    expect(needsNotification(400, '{"error":{"reason":"invalidSharingRequest"}}')).toBe(true);
    expect(needsNotification(403, "insufficientPermissions")).toBe(false);
  });
});

describe("schema: a collaborator can read what they were shared", () => {
  const mig = read("supabase/migrations/20261007090000_share_privileges_drive.sql");

  it("lets collaborators download the deal's stored files, keyed on the source row", () => {
    expect(mig).toMatch(/CREATE POLICY "Deal collaborators can read deck files"\s+ON storage\.objects FOR SELECT TO authenticated\s+USING \(bucket_id = 'decks' AND public\.can_read_deck_object\(name, auth\.uid\(\)\)\)/);
    expect(mig).toMatch(/s\.storage_path = _name\s+AND public\.can_access_deal\(s\.deal_id, _user_id\)/);
    expect(mig).toMatch(/SECURITY DEFINER/);
  });

  it("lets the owner see who joined, and the collaborator see the owner, only while access is active", () => {
    expect(mig).toMatch(/ON public\.profiles FOR SELECT[\s\S]*a\.revoked_at IS NULL[\s\S]*a\.owner_id = auth\.uid\(\) AND a\.user_id = profiles\.user_id[\s\S]*a\.user_id = auth\.uid\(\) AND a\.owner_id = profiles\.user_id/);
  });

  it("tracks each Drive grant, readable by owner and recipient, written only by the server", () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS public\.deal_share_drive_grants/);
    expect(mig).toMatch(/UNIQUE \(access_id, drive_file_id\)/);
    expect(mig).toMatch(/USING \(auth\.uid\(\) = owner_id OR auth\.uid\(\) = recipient_id\)/);
    expect(mig).toMatch(/GRANT SELECT ON public\.deal_share_drive_grants TO authenticated;/);
    expect(mig).not.toMatch(/deal_share_drive_grants FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS memo_gdrive_file_id text/);
  });
});

describe("edge function: deal-share-drive", () => {
  const fn = read("supabase/functions/deal-share-drive/index.ts");

  it("grants view-only access with the owner's Google token", () => {
    expect(fn).toMatch(/getUserGoogleAccessToken\(admin, deal\.user_id\)/);
    expect(fn).toMatch(/role: "reader", type: "user", emailAddress: email/);
    expect(fn).not.toMatch(/role: "(writer|commenter|owner)"/);
  });

  it("lets a collaborator trigger a reconcile but only the owner revoke", () => {
    expect(fn).toMatch(/if \(!mine \|\| revokeAccessId\) return json\(\{ error: "Forbidden" \}, 403\)/);
    expect(fn).toMatch(/if \(!isOwner && !isService\) return json\(\{ error: "Forbidden" \}, 403\)/);
  });

  it("revokes EasyVC access and removes the Drive permissions in the same call", () => {
    expect(fn).toMatch(/from\("deal_share_access"\)\.update\(\{ revoked_at: now \}\)/);
    expect(fn).toMatch(/method: "DELETE"/);
    expect(fn).toMatch(/status: "revoked", revoked_at: now/);
  });

  it("records failures (e.g. owner's Google disconnected) so the dialog can show them, and is registered", () => {
    expect(fn).toMatch(/status: "failed"/);
    expect(fn).toMatch(/Reconnect Google in Settings/);
    expect(read("supabase/config.toml")).toMatch(/\[functions\.deal-share-drive\]\nverify_jwt = false/);
  });

  it("new deck copies and memo PDFs are shared with existing collaborators as they land", () => {
    expect(read("supabase/functions/sync-to-drive/index.ts")).toMatch(/await syncSharedDriveAccess\(supabaseUrl, supabaseServiceKey, dealId\)/);
    const memo = read("supabase/functions/generate-memo/index.ts");
    expect(memo).toMatch(/update\(\{ memo_gdrive_file_id: driveFileId \}\)/);
    expect(memo).toMatch(/await syncSharedDriveAccess\(supabaseUrl, supabaseServiceKey, dealId\)/);
  });
});

import { acceptShareToken, syncDealDriveAccess, driveAccessFor, useDealShareAccessList, type DealShareDriveGrant } from "@/hooks/useDealShare";

describe("client: accept and revoke carry Drive access with them", () => {
  it("joining a deal grants Drive access right away", async () => {
    await expect(acceptShareToken("tok")).resolves.toBe("deal-1");
    expect(sb.state.rpc).toHaveBeenCalledWith("accept_share_token", { _token: "tok" });
    expect(sb.state.invoke).toHaveBeenCalledWith("deal-share-drive", { body: { dealId: "deal-1" } });
  });

  it("a Drive hiccup never blocks opening the deal", async () => {
    sb.state.invoke.mockRejectedValueOnce(new Error("network"));
    await expect(acceptShareToken("tok")).resolves.toBe("deal-1");
  });

  it("revoking goes through the server with the access id", async () => {
    const { result } = renderHook(() => useDealShareAccessList("deal-1", "owner-1"), { wrapper });
    await result.current.revokeAccess("acc-9");
    expect(sb.state.invoke).toHaveBeenCalledWith("deal-share-drive", { body: { dealId: "deal-1", revokeAccessId: "acc-9" } });
    await expect(syncDealDriveAccess("deal-1")).resolves.toMatchObject({ granted: 2 });
  });

  it("summarises one collaborator's Drive access", () => {
    const grants = [
      { access_id: "a1", status: "granted" }, { access_id: "a1", status: "granted" },
      { access_id: "a1", status: "failed", error: "owner disconnected" }, { access_id: "a1", status: "revoked" },
      { access_id: "a2", status: "granted" },
    ] as DealShareDriveGrant[];
    expect(driveAccessFor("a1", grants)).toEqual({ granted: 2, failed: 1, error: "owner disconnected", total: 3 });
  });
});

const dialog = vi.hoisted(() => ({
  access: [] as any[],
  grants: [] as any[],
  sync: vi.fn(async () => ({})),
  revoke: vi.fn(async () => ({})),
}));
vi.mock("@/hooks/useDealShare", async () => {
  const actual = await vi.importActual<any>("@/hooks/useDealShare");
  return {
    ...actual,
    useDealShareLink: () => ({ share: { id: "s1" }, shareUrl: "https://x/share/t", isLoading: false, create: vi.fn(), isCreating: false, revokeLink: vi.fn(), isRevoking: false }),
    useDealShareDriveGrants: () => ({ grants: dialog.grants, sync: dialog.sync, isSyncing: false }),
    useDealShareAccessList: (...args: unknown[]) =>
      args[0] === "deal-1" && dialog.access.length
        ? { accessList: dialog.access, revokeAccess: dialog.revoke, isRevoking: false }
        : actual.useDealShareAccessList(...args),
  };
});

import { ShareDealDialog } from "@/components/ShareDealDialog";

describe("share dialog", () => {
  beforeEach(() => {
    dialog.access = [
      { id: "a1", user_id: "u1", recipient_name: "Alice", recipient_email: "alice@fund.com", revoked_at: null },
      { id: "a2", user_id: "u2", recipient_name: "Bob", recipient_email: "bob@fund.com", revoked_at: null },
    ];
    dialog.grants = [
      { access_id: "a1", status: "granted" }, { access_id: "a1", status: "granted" },
      { access_id: "a2", status: "failed", error: "The deal owner's Google Drive is not connected. Reconnect Google in Settings." },
    ];
    dialog.sync.mockClear();
    dialog.revoke.mockClear();
  });

  it("says what sharing grants, shows each person's Drive access, and reconciles on open", async () => {
    render(<ShareDealDialog open onOpenChange={() => {}} dealId="deal-1" dealName="Acme" ownerId="owner-1" />);
    expect(screen.getByText(/view access to its Google Drive files/)).toBeInTheDocument();
    expect(screen.getByLabelText("Google Drive access for Alice")).toHaveTextContent("Drive: can view 2 files");
    expect(screen.getByLabelText("Google Drive access for Bob")).toHaveTextContent(/1 file not shared — The deal owner's Google Drive is not connected/);
    await waitFor(() => expect(dialog.sync).toHaveBeenCalled());
  });

  it("warns that revoking also removes Drive access", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ShareDealDialog open onOpenChange={() => {}} dealId="deal-1" dealName="Acme" ownerId="owner-1" />);
    fireEvent.click(screen.getAllByText("Revoke")[0]);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Google Drive files is removed too/));
    expect(dialog.revoke).toHaveBeenCalledWith("a1");
    confirm.mockRestore();
  });
});

describe("self-healing: the one-minute cron keeps Drive access in step", () => {
  const mig = read("supabase/migrations/20261007100000_shared_drive_backlog.sql");
  it("finds deals with a missing grant or a revoked collaborator still holding one, server-only", () => {
    expect(mig).toMatch(/a\.revoked_at IS NULL\s+AND \(g\.id IS NULL/);
    expect(mig).toMatch(/g\.status = 'failed' AND g\.updated_at < now\(\) - interval '1 hour'/);
    expect(mig).toMatch(/a\.revoked_at IS NOT NULL AND g\.status = 'granted'/);
    expect(mig).toMatch(/REVOKE ALL ON FUNCTION public\.shared_deals_needing_drive_sync\(int\) FROM public, anon, authenticated/);
  });
  it("gmail-listener reconciles them every minute, after the queue reaper", () => {
    const gl = read("supabase/functions/gmail-listener/index.ts");
    expect(gl).toMatch(/rpc\("shared_deals_needing_drive_sync"/);
    expect(gl.indexOf("shared_deals_needing_drive_sync")).toBeGreaterThan(gl.indexOf("healQueues({"));
    expect(gl).toMatch(/await syncSharedDriveAccess\(supabaseUrl, supabaseServiceKey, row\.deal_id\)/);
  });
});
