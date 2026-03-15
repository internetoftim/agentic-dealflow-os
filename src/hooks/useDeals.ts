import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { compressPdf } from "@/lib/compressPdf";

export interface Deal {
  id: string;
  user_id: string;
  name: string;
  stage: string;
  sector: string;
  source: string;
  auto_ingested: boolean;
  status: string;
  deck_size: string | null;
  compressed_size: string | null;
  pages: number | null;
  website: string | null;
  website_searching: boolean | null;
  linkedin_url: string | null;
  deep_research_status: string;
  ask_amount: string | null;
  valuation: string | null;
  revenue: string | null;
  growth: string | null;
  nrr: string | null;
  team_size: string | null;
  memo_draft: string | null;
  gdrive_file_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Workflow steps in order */
export const WORKFLOW_STEPS = [
  { key: "uploading", label: "Uploading" },
  { key: "compressing", label: "Compressing" },
  { key: "extracting", label: "Extracting" },
  { key: "searching-website", label: "Finding Website" },
  { key: "syncing", label: "Syncing to Drive" },
  { key: "memo-ready", label: "Ready" },
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STEPS)[number]["key"];

export function useDeals() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Subscribe to realtime updates on deals table
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("deals-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "deals", filter: `user_id=eq.${user.id}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ["deals", user.id] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, queryClient]);

  return useQuery({
    queryKey: ["deals", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deals")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Deal[];
    },
    enabled: !!user,
  });
}

export function useSources(dealId?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["sources", dealId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sources")
        .select("*")
        .eq("deal_id", dealId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!user && !!dealId,
  });
}

export function useCreateDealWithUpload() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ file, name }: { file: File; name: string }) => {
      if (!user) throw new Error("Not authenticated");

      // 1. Create the deal with "uploading" status
      const { data: deal, error: dealError } = await supabase
        .from("deals")
        .insert({
          user_id: user.id,
          name,
          source: "manual",
          status: "uploading",
          deck_size: `${(file.size / (1024 * 1024)).toFixed(1)}MB`,
        })
        .select()
        .single();
      if (dealError) throw dealError;

      // 2. Compress → update status
      await supabase.from("deals").update({ status: "compressing" }).eq("id", deal.id);

      const { compressed, pages } = await compressPdf(file);

      await supabase
        .from("deals")
        .update({
          compressed_size: `${(compressed.size / (1024 * 1024)).toFixed(1)}MB`,
          pages,
          status: "extracting",
        })
        .eq("id", deal.id);

      // 3. Upload compressed file to storage
      const storagePath = `${user.id}/${deal.id}/${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("decks")
        .upload(storagePath, compressed);
      if (uploadError) throw uploadError;

      // 4. Create source record
      const { error: sourceError } = await supabase
        .from("sources")
        .insert({
          deal_id: deal.id,
          user_id: user.id,
          file_name: file.name,
          original_size: `${(file.size / (1024 * 1024)).toFixed(1)}MB`,
          storage_path: storagePath,
          source_type: "upload",
          processing_status: "uploaded",
        });
      if (sourceError) throw sourceError;

      // 5. Trigger AI deck analysis + lite website search (fire-and-forget)
      // The edge function will update status through: extracting → searching-website → syncing → memo-ready
      supabase.functions
        .invoke("process-deck", {
          body: { dealId: deal.id, storagePath },
        })
        .catch((e) => console.warn("Deck processing skipped:", e));

      return deal;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
    },
  });
}
