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
  crunchbase_url: string | null;
  funding_total: string | null;
  last_funding_round: string | null;
  num_employees: string | null;
  investors: string | null;
  investor_research: Array<{ name: string; linkedin_url: string | null; crunchbase_url: string | null; tracxn_url: string | null }> | null;
  latest_articles: Array<{ title: string; url: string; source: string | null; preview: string | null }> | null;
  research_verification: Array<{ field: string; value: string; matched: boolean }> | null;
  deck_preview: Array<{ section: "traction" | "ask" | "team"; slide: number; preview_image: string | null; snippet: string }> | null;
  created_at: string;
  updated_at: string;
}

export interface CaptureJob {
  created_at: string;
  deal_id: string;
  error_message: string | null;
  id: string;
  status: string;
  updated_at: string;
  url: string;
  user_id: string;
}

export const DOC_VIEWER_SOURCES = ["docsend", "pandadoc", "papermark"] as const;

function isDocViewerSource(source?: string) {
  return DOC_VIEWER_SOURCES.includes((source ?? "") as (typeof DOC_VIEWER_SOURCES)[number]);
}

/** Active processing statuses (not terminal) */
export const PROCESSING_STATUSES = ["uploading", "converting", "compressing", "scraping", "extracting", "searching-website", "syncing"];

/** Workflow steps in order */
export const WORKFLOW_STEPS = [
  { key: "uploading", label: "Uploading" },
  { key: "converting", label: "Converting to PDF" },
  { key: "compressing", label: "Compressing" },
  { key: "scraping", label: "Scraping Link" },
  { key: "extracting", label: "Extracting" },
  { key: "searching-website", label: "Finding Website" },
  { key: "syncing", label: "Syncing to Drive" },
  { key: "deep-research", label: "Deep Research" },
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

  const query = useQuery({
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

  // Poll every 3s when any deal is actively processing (realtime can be unreliable)
  const hasProcessing = query.data?.some((d) => PROCESSING_STATUSES.includes(d.status) || d.status === "queued");
  useEffect(() => {
    if (!hasProcessing) return;
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["deals", user?.id] });
    }, 3000);
    return () => clearInterval(interval);
  }, [hasProcessing, queryClient, user?.id]);

  return query;
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

export function useLatestCaptureJob(dealId?: string, source?: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["latest-capture-job", dealId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("capture_jobs")
        .select("*")
        .eq("deal_id", dealId!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as CaptureJob | null;
    },
    enabled: !!user && !!dealId && isDocViewerSource(source),
    refetchInterval: (query) => {
      const job = query.state.data as CaptureJob | null | undefined;
      return job && ["pending", "processing"].includes(job.status) ? 3000 : false;
    },
  });
}

export function useDocsendUrl(dealId?: string, source?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["capture-job-url", dealId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("capture_jobs")
        .select("url")
        .eq("deal_id", dealId!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data?.url ?? null;
    },
    enabled: !!user && !!dealId && isDocViewerSource(source),
  });
}

export function useCancelDeal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (dealId: string) => {
      const { error } = await supabase
        .from("deals")
        .update({ status: "cancelled" })
        .eq("id", dealId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
    },
  });
}

export function useDeleteDeal() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (dealId: string) => {
      if (!user) throw new Error("Not authenticated");

      // 1. Gather source storage paths so we can clean up files in the decks bucket
      const { data: sourceRows, error: sourcesFetchError } = await supabase
        .from("sources")
        .select("storage_path")
        .eq("deal_id", dealId);
      if (sourcesFetchError) throw sourcesFetchError;

      const storagePaths = (sourceRows ?? [])
        .map((s) => s.storage_path)
        .filter((p): p is string => !!p);

      // 2. Remove files from storage (best-effort — don't block delete on storage errors)
      if (storagePaths.length > 0) {
        const { error: removeError } = await supabase.storage
          .from("decks")
          .remove(storagePaths);
        if (removeError) {
          console.warn("Failed to remove some deck files from storage:", removeError);
        }
      }

      // 3. Delete dependent rows (no FK cascade defined, so remove manually)
      const [capRes, srcRes, peopleRes] = await Promise.all([
        supabase.from("capture_jobs").delete().eq("deal_id", dealId),
        supabase.from("sources").delete().eq("deal_id", dealId),
        supabase.from("deal_people").delete().eq("deal_id", dealId),
      ]);
      if (capRes.error) throw capRes.error;
      if (srcRes.error) throw srcRes.error;
      if (peopleRes.error) throw peopleRes.error;

      // 4. Finally delete the deal itself
      const { error: dealError } = await supabase
        .from("deals")
        .delete()
        .eq("id", dealId);
      if (dealError) throw dealError;

      return { dealId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      queryClient.invalidateQueries({ queryKey: ["latest-capture-job"] });
      queryClient.invalidateQueries({ queryKey: ["capture-job-url"] });
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

      // Check if there's already an active job for this user
      const { data: activeDeals } = await supabase
        .from("deals")
        .select("id")
        .eq("user_id", user.id)
        .in("status", PROCESSING_STATUSES);
      const hasActiveJob = (activeDeals?.length ?? 0) > 0;

      // Check user's model preference
      const { data: settings } = await supabase
        .from("user_settings")
        .select("ai_model")
        .eq("user_id", user.id)
        .single();
      const isLocalModel = settings?.ai_model === "local-florence2";

      // 1. Create the deal — if another job is active, set status to "queued"
      const initialStatus = hasActiveJob ? "queued" : "uploading";
      const { data: deal, error: dealError } = await supabase
        .from("deals")
        .insert({
          user_id: user.id,
          name,
          source: "manual",
          status: initialStatus,
          deck_size: `${(file.size / (1024 * 1024)).toFixed(1)}MB`,
        })
        .select()
        .single();
      if (dealError) throw dealError;

      // If queued, still upload the file + create source but don't start processing
      if (hasActiveJob) {
        const storagePath = `${user.id}/${deal.id}/${file.name}`;
        const { error: uploadError } = await supabase.storage
          .from("decks")
          .upload(storagePath, file);
        if (uploadError) throw uploadError;

        await supabase.from("sources").insert({
          deal_id: deal.id,
          user_id: user.id,
          file_name: file.name,
          original_size: `${(file.size / (1024 * 1024)).toFixed(1)}MB`,
          storage_path: storagePath,
          source_type: "upload",
          processing_status: "queued",
        });

        return deal;
      }

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

type RunDocsendCaptureArgs = {
  dealId: string;
  gateEmail?: string | null;
  jobId?: string;
  maxPages?: number;
  url: string;
};

async function runDocsendCapture(args: RunDocsendCaptureArgs) {
  const { data, error } = await supabase.functions.invoke("run-docsend-capture", {
    body: args,
  });

  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export function useProcessDocsend() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (url: string) => {
      if (!user) throw new Error("Not authenticated");

      // Step 1: Create deal (fast)
      const { data, error } = await supabase.functions.invoke("process-docsend", {
        body: { url },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const dealId = data.dealId;
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      queryClient.invalidateQueries({ queryKey: ["latest-capture-job", dealId] });

      // Step 2: Schedule capture and return once the background orchestration is accepted.
      await runDocsendCapture({
        dealId,
        jobId: data.jobId,
        url: data.url,
      });

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      queryClient.invalidateQueries({ queryKey: ["latest-capture-job"] });
    },
  });
}

export function useRetryDocsendCapture() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ dealId, url }: { dealId: string; url: string }) => {
      if (!user) throw new Error("Not authenticated");
      return await runDocsendCapture({ dealId, url });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      queryClient.invalidateQueries({ queryKey: ["latest-capture-job", variables.dealId] });
      queryClient.invalidateQueries({ queryKey: ["capture-job-url", variables.dealId] });
      queryClient.invalidateQueries({ queryKey: ["sources", variables.dealId] });
    },
  });
}
