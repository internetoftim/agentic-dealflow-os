import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface DealShare {
  id: string;
  deal_id: string;
  owner_id: string;
  token: string;
  permission: string;
  created_at: string;
  revoked_at: string | null;
}

export interface DealShareAccess {
  id: string;
  deal_id: string;
  user_id: string;
  share_id: string;
  owner_id: string;
  permission: string;
  accepted_at: string;
  revoked_at: string | null;
  recipient_name?: string | null;
  recipient_email?: string | null;
}

/** One collaborator's view permission on one Drive file of the deal. */
export interface DealShareDriveGrant {
  id: string;
  access_id: string;
  recipient_id: string;
  recipient_email: string | null;
  drive_file_id: string;
  status: "pending" | "granted" | "failed" | "revoked";
  error: string | null;
  granted_at: string | null;
}

export type DriveSyncResult = {
  success?: boolean;
  files?: number;
  granted?: number;
  revoked?: number;
  failed?: number;
  driveConnected?: boolean;
  error?: string;
};

/**
 * Brings the deal's Google Drive permissions in line with who it is shared
 * with (idempotent). Optionally revokes one collaborator first, which also
 * removes their Drive access.
 */
export async function syncDealDriveAccess(dealId: string, revokeAccessId?: string): Promise<DriveSyncResult> {
  const { data, error } = await supabase.functions.invoke("deal-share-drive", {
    body: revokeAccessId ? { dealId, revokeAccessId } : { dealId },
  });
  if (error) throw error;
  return (data ?? {}) as DriveSyncResult;
}

function buildShareUrl(token: string) {
  return `${window.location.origin}/share/${token}`;
}

/** Active (non-revoked) share link for a deal — auto-creates one if missing. */
export function useDealShareLink(dealId?: string, ownerId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isOwner = !!user && !!ownerId && user.id === ownerId;

  const query = useQuery({
    queryKey: ["deal-share", dealId],
    queryFn: async () => {
      if (!dealId) return null;
      const { data, error } = await supabase
        .from("deal_shares")
        .select("*")
        .eq("deal_id", dealId)
        .is("revoked_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as DealShare | null;
    },
    enabled: !!user && !!dealId && isOwner,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!user || !dealId) throw new Error("Missing context");
      const token = `${crypto.randomUUID()}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const { data, error } = await supabase
        .from("deal_shares")
        .insert({ deal_id: dealId, owner_id: user.id, token, permission: "view_chat" })
        .select()
        .single();
      if (error) throw error;
      return data as DealShare;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deal-share", dealId] });
    },
  });

  const revokeLinkMutation = useMutation({
    mutationFn: async (shareId: string) => {
      const { error } = await supabase
        .from("deal_shares")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", shareId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deal-share", dealId] });
      queryClient.invalidateQueries({ queryKey: ["deal-share-access", dealId] });
    },
  });

  return {
    share: query.data,
    isLoading: query.isLoading,
    isOwner,
    shareUrl: query.data ? buildShareUrl(query.data.token) : null,
    create: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    revokeLink: revokeLinkMutation.mutateAsync,
    isRevoking: revokeLinkMutation.isPending,
  };
}

/** List of users who joined a shared deal (owner-only view). */
export function useDealShareAccessList(dealId?: string, ownerId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isOwner = !!user && !!ownerId && user.id === ownerId;

  const query = useQuery({
    queryKey: ["deal-share-access", dealId],
    queryFn: async () => {
      if (!dealId) return [];
      const { data, error } = await supabase
        .from("deal_share_access")
        .select("*")
        .eq("deal_id", dealId)
        .order("accepted_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as DealShareAccess[];
      // Best-effort enrich with profile info
      const userIds = rows.map((r) => r.user_id);
      if (userIds.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("user_id, display_name, email")
          .in("user_id", userIds);
        const map = new Map((profs ?? []).map((p) => [p.user_id, p]));
        for (const r of rows) {
          const p = map.get(r.user_id);
          r.recipient_name = p?.display_name ?? null;
          r.recipient_email = p?.email ?? null;
        }
      }
      return rows;
    },
    enabled: !!user && !!dealId && isOwner,
  });

  // Revoking goes through the server so the collaborator's Drive permissions
  // are removed together with their EasyVC access.
  const revokeAccessMutation = useMutation({
    mutationFn: async (accessId: string) => {
      if (!dealId) throw new Error("Missing deal");
      const result = await syncDealDriveAccess(dealId, accessId);
      if (result.error) throw new Error(result.error);
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deal-share-access", dealId] });
      queryClient.invalidateQueries({ queryKey: ["deal-share-drive", dealId] });
    },
  });

  return {
    accessList: query.data ?? [],
    isLoading: query.isLoading,
    revokeAccess: revokeAccessMutation.mutateAsync,
    isRevoking: revokeAccessMutation.isPending,
  };
}

/** Drive permissions granted to the deal's collaborators (owner view). */
export function useDealShareDriveGrants(dealId?: string, ownerId?: string, enabled = true) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isOwner = !!user && !!ownerId && user.id === ownerId;

  const grants = useQuery({
    queryKey: ["deal-share-drive", dealId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deal_share_drive_grants")
        .select("id, access_id, recipient_id, recipient_email, drive_file_id, status, error, granted_at")
        .eq("deal_id", dealId!);
      if (error) throw error;
      return (data ?? []) as DealShareDriveGrant[];
    },
    enabled: !!dealId && isOwner && enabled,
  });

  const sync = useMutation({
    mutationFn: () => syncDealDriveAccess(dealId!),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["deal-share-drive", dealId] }),
  });

  return { grants: grants.data ?? [], isLoading: grants.isLoading, sync: sync.mutateAsync, isSyncing: sync.isPending, lastSync: sync.data };
}

/** Summary of one collaborator's Drive access, for the share dialog. */
export function driveAccessFor(accessId: string, grants: DealShareDriveGrant[]) {
  const mine = grants.filter((g) => g.access_id === accessId && g.status !== "revoked");
  const granted = mine.filter((g) => g.status === "granted").length;
  const failed = mine.filter((g) => g.status === "failed");
  return { granted, failed: failed.length, error: failed[0]?.error ?? null, total: mine.length };
}

export async function lookupShareToken(token: string) {
  const { data, error } = await supabase.rpc("lookup_share_token", { _token: token });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as { deal_id: string; deal_name: string; owner_display_name: string; revoked: boolean } | null;
}

export async function acceptShareToken(token: string) {
  const { data, error } = await supabase.rpc("accept_share_token", { _token: token });
  if (error) throw error;
  const dealId = data as string;
  // Joining also grants view access to the deal's Google Drive files. Best
  // effort: the owner's share dialog and every later Drive sync retry it.
  await syncDealDriveAccess(dealId).catch(() => undefined);
  return dealId;
}
