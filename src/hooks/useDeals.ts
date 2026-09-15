import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { compressDeck } from "@/lib/compressPdf";
import { extractTextFromPdf, type VisionProgress } from "@/lib/localVision";
import { useAiModelSetting, useLocalLlm } from "@/contexts/LocalLlmContext";
import { getPreset } from "@/lib/localModels";

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
  team_id: string | null;
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
    // A busy pipeline emits a burst of row updates; coalesce them into one
    // refetch per second instead of one per event.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel("deals-realtime")
      .on(
        "postgres_changes",
        // No user filter: team deals change under other user_ids; RLS still
        // gates what this client can actually read.
        { event: "*", schema: "public", table: "deals" },
        () => {
          if (timer) return;
          timer = setTimeout(() => {
            timer = null;
            queryClient.invalidateQueries({ queryKey: ["deals", user.id] });
          }, REALTIME_DEBOUNCE_MS);
        }
      )
      .subscribe();
    return () => { if (timer) clearTimeout(timer); supabase.removeChannel(channel); };
  }, [user, queryClient]);

  const query = useQuery({
    queryKey: ["deals", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deals")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as unknown as Deal[];
    },
    enabled: !!user,
    // Poll only while something is in flight, and only in the visible tab
    // (react-query pauses intervals in background tabs) — background tabs
    // used to poll every 3s each, multiplying load exactly when the backend
    // was busiest.
    refetchInterval: (q) => (hasInFlight(q.state.data) ? PROCESSING_POLL_MS : false),
  });

  return query;
}

/** Realtime bursts are coalesced into at most one refetch per this window. */
export const REALTIME_DEBOUNCE_MS = 1_000;
/** Poll cadence while a deal is processing (visible tab only). */
export const PROCESSING_POLL_MS = 5_000;

export function hasInFlight(deals?: Deal[]): boolean {
  return !!deals?.some(
    (d) =>
      PROCESSING_STATUSES.includes(d.status) ||
      d.status === "queued" ||
      d.deep_research_status === "researching",
  );
}

export function useSources(dealId?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["sources", dealId],
    queryFn: async () => {
      // preview_images (base64) and extracted_text make a single deal's
      // sources megabytes; the UI needs neither — chat grounding happens
      // server-side and previews are fetched on demand.
      const { data, error } = await supabase
        .from("sources")
        .select(SOURCE_LIST_COLUMNS)
        .eq("deal_id", dealId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!user && !!dealId,
  });
}

export const SOURCE_LIST_COLUMNS =
  "id, deal_id, user_id, file_name, original_size, compressed_size, storage_path, source_type, processing_status, gmail_message_id, content_hash, created_at";

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

export function useDeleteDeals() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (dealIds: string[]) => {
      if (!user) throw new Error("Not authenticated");
      if (dealIds.length === 0) return { dealIds };

      // 1. Gather all source storage paths across selected deals
      const { data: sourceRows, error: sourcesFetchError } = await supabase
        .from("sources")
        .select("storage_path")
        .in("deal_id", dealIds);
      if (sourcesFetchError) throw sourcesFetchError;

      const storagePaths = (sourceRows ?? [])
        .map((s) => s.storage_path)
        .filter((p): p is string => !!p);

      // 2. Remove files from storage (best-effort)
      if (storagePaths.length > 0) {
        const { error: removeError } = await supabase.storage
          .from("decks")
          .remove(storagePaths);
        if (removeError) {
          console.warn("Failed to remove some deck files from storage:", removeError);
        }
      }

      // 3. Delete dependent rows
      const [capRes, srcRes, peopleRes] = await Promise.all([
        supabase.from("capture_jobs").delete().in("deal_id", dealIds),
        supabase.from("sources").delete().in("deal_id", dealIds),
        supabase.from("deal_people").delete().in("deal_id", dealIds),
      ]);
      if (capRes.error) throw capRes.error;
      if (srcRes.error) throw srcRes.error;
      if (peopleRes.error) throw peopleRes.error;

      // 4. Delete the deals
      const { error: dealError } = await supabase
        .from("deals")
        .delete()
        .in("id", dealIds);
      if (dealError) throw dealError;

      return { dealIds };
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
  const { isLocal, localModelId } = useAiModelSetting();
  const localLlm = useLocalLlm();
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
      // Local extraction only makes sense with a vision-capable local model (Gemma 3n / Gemma 4).
      const localPreset = getPreset(localModelId ?? "");
      const isLocalModel = settings?.ai_model === "local-florence2" || (isLocal && !!localPreset?.vision);

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
          const ocr = isLocal && localPreset?.vision
            ? async (dataUrl: string) => {
                await localLlm.ensureLoaded(localPreset.id);
                const r = await localLlm.generate([{ role: "user", content: "Extract ALL text visible in this slide. Return only the text, in reading order, including numbers and chart labels. No commentary." }], [{ dataUrl }]);
                return r.text;
              }
            : undefined;
          const result = await extractTextFromPdf(pdfBuffer, onVisionProgress, ocr);
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

/**
 * Re-run the whole ingestion/research workflow on an existing deal.
 * Doc-viewer deals (DocSend/Papermark) go back through cloud capture;
 * uploaded decks are re-fed to process-deck from their stored file.
 */
export function useRerunWorkflow() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ dealId, source }: { dealId: string; source?: string }) => {
      if (!user) throw new Error("Not authenticated");

      // Doc-viewer deals: re-capture from the original link.
      if (isDocViewerSource(source)) {
        const { data: job, error: jobError } = await supabase
          .from("capture_jobs")
          .select("url")
          .eq("deal_id", dealId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (jobError) throw jobError;
        if (!job?.url) throw new Error("No original link found for this deal");

        await supabase
          .from("deals")
          .update({ status: "scraping", paused_at_step: null, deep_research_status: "pending" })
          .eq("id", dealId);

        return await runDocsendCapture({ dealId, url: job.url });
      }

      // Uploaded decks: find the most recent stored file and re-process it.
      const { data: src, error: srcError } = await supabase
        .from("sources")
        .select("storage_path")
        .eq("deal_id", dealId)
        .not("storage_path", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (srcError) throw srcError;
      if (!src?.storage_path) throw new Error("No stored deck found for this deal");

      const { error: updateError } = await supabase
        .from("deals")
        .update({ status: "extracting", paused_at_step: null, deep_research_status: "pending" })
        .eq("id", dealId);
      if (updateError) throw updateError;

      const { data, error } = await supabase.functions.invoke("process-deck", {
        body: { dealId, storagePath: src.storage_path, skipCompression: true },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      queryClient.invalidateQueries({ queryKey: ["sources", variables.dealId] });
      queryClient.invalidateQueries({ queryKey: ["latest-capture-job", variables.dealId] });
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
