import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface ReceiverInvite {
  id: string;
  note: string | null;
  expires_at: string;
  used_at: string | null;
  used_by_email: string | null;
  created_at: string;
}

export interface ReceiverAccount {
  id: string;
  email: string;
  enabled: boolean;
  last_polled_at: string | null;
  last_error: string | null;
  created_at: string;
}

const RECEIVER_OAUTH = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/receiver-oauth`;

/** Receiver ("deal inbox") Gmail accounts connected to the current user. */
export function useReceiverAccounts() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["receiver-accounts", user?.id],
    queryFn: async (): Promise<ReceiverAccount[]> => {
      // Credentials are column-revoked for clients; select only status fields.
      const { data, error } = await supabase
        .from("receiver_accounts")
        .select("id, email, enabled, last_polled_at, last_error, created_at")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ReceiverAccount[];
    },
    enabled: !!user,
  });

  const invitesQuery = useQuery({
    queryKey: ["receiver-invites", user?.id],
    queryFn: async (): Promise<ReceiverInvite[]> => {
      const { data, error } = await supabase
        .from("receiver_invites")
        .select("id, note, expires_at, used_at, used_by_email, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ReceiverInvite[];
    },
    enabled: !!user,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["receiver-accounts"] });
    queryClient.invalidateQueries({ queryKey: ["receiver-invites"] });
  };

  /** Mint a link for whoever controls the mailbox; they complete Google consent themselves. */
  const createInvite = useMutation({
    mutationFn: async (note?: string) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not signed in");
      const res = await fetch(`${RECEIVER_OAUTH}/invite`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ note: note ?? null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) throw new Error(body.error || "Could not create invite");
      return body as { id: string; url: string; expires_at: string };
    },
    onSuccess: invalidate,
  });

  const revokeInvite = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("receiver_invites").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  /** Begin Google consent for a new receiver mailbox; the browser leaves the app. */
  const connect = useMutation({
    mutationFn: async (returnTo: string) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not signed in");
      const res = await fetch(`${RECEIVER_OAUTH}/start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ returnTo }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) throw new Error(body.error || "Could not start Google sign-in");
      return body.url as string;
    },
  });

  const setEnabled = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase.from("receiver_accounts").update({ enabled }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const disconnect = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("receiver_accounts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  return {
    accounts: query.data ?? [],
    invites: invitesQuery.data ?? [],
    isLoading: query.isLoading,
    connect,
    setEnabled,
    disconnect,
    createInvite,
    revokeInvite,
  };
}
