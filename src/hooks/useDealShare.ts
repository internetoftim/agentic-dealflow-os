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

  const revokeAccessMutation = useMutation({
    mutationFn: async (accessId: string) => {
      const { error } = await supabase
        .from("deal_share_access")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", accessId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deal-share-access", dealId] });
    },
  });

  return {
    accessList: query.data ?? [],
    isLoading: query.isLoading,
    revokeAccess: revokeAccessMutation.mutateAsync,
    isRevoking: revokeAccessMutation.isPending,
  };
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
  return data as string; // deal_id
}
