import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface DealNote {
  id: string;
  deal_id: string;
  user_id: string;
  author_email: string | null;
  content: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export function useDealNotes(dealId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Live-sync notes across the team while a deal is open.
  useEffect(() => {
    if (!dealId) return;
    const channel = supabase
      .channel(`deal-notes-${dealId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "deal_notes", filter: `deal_id=eq.${dealId}` },
        () => queryClient.invalidateQueries({ queryKey: ["deal-notes", dealId] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [dealId, queryClient]);

  const query = useQuery({
    queryKey: ["deal-notes", dealId],
    queryFn: async (): Promise<DealNote[]> => {
      const { data, error } = await supabase
        .from("deal_notes")
        .select("*")
        .eq("deal_id", dealId!)
        .order("pinned", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as DealNote[];
    },
    enabled: !!user && !!dealId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["deal-notes", dealId] });

  const addNote = useMutation({
    mutationFn: async (content: string) => {
      if (!user || !dealId) throw new Error("Missing context");
      const { data, error } = await supabase
        .from("deal_notes")
        .insert({
          deal_id: dealId,
          user_id: user.id,
          author_email: user.email ?? null,
          content,
        })
        .select()
        .single();
      if (error) throw error;
      return data as DealNote;
    },
    onSuccess: invalidate,
  });

  const updateNote = useMutation({
    mutationFn: async ({ id, content }: { id: string; content: string }) => {
      const { error } = await supabase.from("deal_notes").update({ content }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const togglePin = useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const { error } = await supabase.from("deal_notes").update({ pinned }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const deleteNote = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("deal_notes").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  return { notes: query.data ?? [], isLoading: query.isLoading, addNote, updateNote, togglePin, deleteNote };
}
