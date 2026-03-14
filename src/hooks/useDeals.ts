import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

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

export function useDeals() {
  const { user } = useAuth();
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

      // 1. Create the deal
      const { data: deal, error: dealError } = await supabase
        .from("deals")
        .insert({
          user_id: user.id,
          name,
          source: "manual",
          status: "extracting",
          deck_size: `${(file.size / (1024 * 1024)).toFixed(1)}MB`,
        })
        .select()
        .single();
      if (dealError) throw dealError;

      // 2. Upload file to storage
      const storagePath = `${user.id}/${deal.id}/${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("decks")
        .upload(storagePath, file);
      if (uploadError) throw uploadError;

      // 3. Create source record
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

      // 4. Trigger Google Drive sync
      try {
        await supabase.functions.invoke("sync-to-drive", {
          body: { dealId: deal.id, storagePath, fileName: file.name },
        });
      } catch (e) {
        console.warn("Drive sync skipped:", e);
      }

      // 5. Trigger AI deck analysis (fire-and-forget)
      supabase.functions.invoke("process-deck", {
        body: { dealId: deal.id, storagePath },
      }).catch((e) => console.warn("Deck processing skipped:", e));

      return deal;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
    },
  });
}
