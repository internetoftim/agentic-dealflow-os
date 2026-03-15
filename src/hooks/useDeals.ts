import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { compressDeck } from "@/lib/compressPdf";
import { extractTextFromPdf, type VisionProgress } from "@/lib/localVision";

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
  paused_at_step: string | null;
  created_at: string;
  updated_at: string;
}

/** Workflow steps in order */
export const WORKFLOW_STEPS = [
  { key: "uploading", label: "Uploading" },
  { key: "converting", label: "Converting to PDF" },
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

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("deals-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "deals", filter: `user_id=eq.${user.id}` },
        (_payload) => {
          queryClient.invalidateQueries({ queryKey: ["deals", user.id] });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
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

export function usePauseDeal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (dealId: string) => {
      const { error } = await supabase
        .from("deals")
        .update({ status: "paused" })
        .eq("id", dealId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
    },
  });
}

export function useResumeDeal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ dealId, pausedAtStep, storagePath }: { dealId: string; pausedAtStep: string; storagePath?: string }) => {
      // First get the source to find the storage path
      let path = storagePath;
      if (!path) {
        const { data: sources } = await supabase
          .from("sources")
          .select("storage_path")
          .eq("deal_id", dealId)
          .limit(1);
        path = sources?.[0]?.storage_path ?? undefined;
      }
      if (!path) throw new Error("No storage path found for this deal");

      // Set status back to the paused step so the edge function picks up
      await supabase
        .from("deals")
        .update({ status: pausedAtStep, paused_at_step: null })
        .eq("id", dealId);

      // Re-invoke process-deck with resumeFrom
      supabase.functions
        .invoke("process-deck", {
          body: { dealId, storagePath: path, resumeFrom: pausedAtStep },
        })
        .catch((e) => console.warn("Resume processing failed:", e));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
    },
  });
}

export function useCreateDealWithUpload() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      file,
      name,
      onVisionProgress,
    }: {
      file: File;
      name: string;
      onVisionProgress?: (p: VisionProgress) => void;
    }) => {
      if (!user) throw new Error("Not authenticated");

      // Check user's model preference
      const { data: settings } = await supabase
        .from("user_settings")
        .select("ai_model")
        .eq("user_id", user.id)
        .single();
      const isLocalModel = settings?.ai_model === "local-florence2";

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

      // 2. Compress (PDF) or pass-through (PPTX)
      await supabase.from("deals").update({ status: "compressing" }).eq("id", deal.id);

      const { compressed, pages, isPptx } = await compressDeck(file);

      await supabase
        .from("deals")
        .update({
          compressed_size: `${(compressed.size / (1024 * 1024)).toFixed(1)}MB`,
          pages: pages || null,
          status: "extracting",
        })
        .eq("id", deal.id);

      // 3. Upload file to storage
      const storagePath = `${user.id}/${deal.id}/${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("decks")
        .upload(storagePath, compressed);
      if (uploadError) throw uploadError;

      // 4. Local vision extraction (if local model selected & file is PDF)
      let localExtractedText = "";
      if (isLocalModel && !isPptx) {
        try {
          const pdfBuffer = await compressed.arrayBuffer();
          const result = await extractTextFromPdf(pdfBuffer, onVisionProgress);
          localExtractedText = result.text;
        } catch (e) {
          console.warn("Local vision extraction failed, will fall back to server:", e);
        }
      }

      // 5. Create source record (include local extracted text if available)
      const { error: sourceError } = await supabase
        .from("sources")
        .insert({
          deal_id: deal.id,
          user_id: user.id,
          file_name: file.name,
          original_size: `${(file.size / (1024 * 1024)).toFixed(1)}MB`,
          storage_path: storagePath,
          source_type: "upload",
          processing_status: localExtractedText ? "extracted" : "uploaded",
          ...(localExtractedText ? { extracted_text: localExtractedText } : {}),
        });
      if (sourceError) throw sourceError;

      // 6. Trigger processing pipeline (fire-and-forget)
      // Pass flag so edge function knows text was already extracted locally
      supabase.functions
        .invoke("process-deck", {
          body: {
            dealId: deal.id,
            storagePath,
            localExtracted: !!localExtractedText,
          },
        })
        .catch((e) => console.warn("Deck processing skipped:", e));

      return deal;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
    },
  });
}
