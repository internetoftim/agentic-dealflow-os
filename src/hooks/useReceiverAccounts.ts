import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

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

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["receiver-accounts"] });

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

  return { accounts: query.data ?? [], isLoading: query.isLoading, connect, setEnabled, disconnect };
}
