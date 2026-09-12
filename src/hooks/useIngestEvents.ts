import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export type IngestOutcome = "uploaded" | "attached" | "duplicate" | "unsupported" | "skipped" | "failed";

export interface IngestEvent {
  id: string;
  created_at: string;
  channel: string;
  outcome: IngestOutcome;
  reason: string | null;
  sender: string | null;
  subject: string | null;
  file_name: string | null;
  deal_id: string | null;
}

/** The ingestion ledger — what came in and what happened to it, across every path. */
export function useIngestEvents(limit = 30) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("ingest-events")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ingest_events" },
        () => queryClient.invalidateQueries({ queryKey: ["ingest-events"] }))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, queryClient]);

  const query = useQuery({
    queryKey: ["ingest-events", user?.id, limit],
    queryFn: async (): Promise<IngestEvent[]> => {
      const { data, error } = await supabase
        .from("ingest_events")
        .select("id, created_at, channel, outcome, reason, sender, subject, file_name, deal_id")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as IngestEvent[];
    },
    enabled: !!user,
  });

  return { events: query.data ?? [], isLoading: query.isLoading };
}
