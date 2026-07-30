import { useState, useCallback, useRef, useEffect } from "react";
import { useSearchParams, useParams } from "react-router-dom";
import { Upload, Link, Cog, Check, Search, Send, FileText, Globe, Layers, Square, Linkedin, Loader2, FileUp, CircleDashed, CircleCheck, Circle, Pause, Clock, Download, Mail, ExternalLink, Users, Trash2, Share2, Bot, X, UserPlus, Save } from "lucide-react";
import { useDeals, useSources, useLatestCaptureJob, useCreateDealWithUpload, useProcessDocsend, useRetryDocsendCapture, useCancelDeal, useDeleteDeal, useUpdateDeal, useAddDealPerson, WORKFLOW_STEPS, PROCESSING_STATUSES, DOC_VIEWER_SOURCES } from "@/hooks/useDeals";
import { useAgentMode } from "@/hooks/useAgentMode";
import { decodePrefill, sanitizePrefill } from "@/lib/agentPrefill";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useDealChat } from "@/hooks/useDealChat";
import { useGenerateMemo } from "@/hooks/useGenerateMemo";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import { sourceConfig } from "@/data/mockDeals";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { ShareDealDialog } from "@/components/ShareDealDialog";
const quickActions = ["Extract Cap Table", "Calculate Burn Rate", "Team Background", "Market Size"];

export default function DealWorkspace() {
  const [activeTab, setActiveTab] = useState<"chat" | "data" | "memo">("chat");
  const [chatInput, setChatInput] = useState("");
  const [docSendUrl, setDocSendUrl] = useState("");
  const [selectedDealId, setSelectedDealId] = useState<string | undefined>();
  const [dealPendingDelete, setDealPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: deals } = useDeals();
  const activeDeal = deals?.find((d) => d.id === selectedDealId) ?? deals?.[0];
  const { data: sources } = useSources(activeDeal?.id);
  const createDeal = useCreateDealWithUpload();
  const processDocsend = useProcessDocsend();
  const retryDocsendCapture = useRetryDocsendCapture();
  const cancelDeal = useCancelDeal();
  const deleteDeal = useDeleteDeal();
  const generateMemo = useGenerateMemo();

  const { data: latestCaptureJob } = useLatestCaptureJob(activeDeal?.id, activeDeal?.source);
  const { messages, isStreaming, send, stop } = useDealChat(activeDeal?.id);
  const isDocViewerDeal = DOC_VIEWER_SOURCES.includes((activeDeal?.source ?? "") as (typeof DOC_VIEWER_SOURCES)[number]);
  const docsendUrl = latestCaptureJob?.url ?? null;
  const isCloudCaptureActive = activeDeal?.status === "scraping" && ["pending", "processing"].includes(latestCaptureJob?.status ?? "");
  const isCloudCaptureFailed = latestCaptureJob?.status === "failed";
  const captureFailureMessage = latestCaptureJob?.error_message?.trim() || null;
  const isOwnerOfActive = !!user && !!activeDeal && activeDeal.user_id === user.id;
  const isSharedWithMe = !!user && !!activeDeal && activeDeal.user_id !== user.id;

  // Sync ?deal=... URL param into selection (e.g. arriving from share accept)
  useEffect(() => {
    const dealParam = searchParams.get("deal");
    if (dealParam && deals?.some((d) => d.id === dealParam)) {
      setSelectedDealId(dealParam);
      searchParams.delete("deal");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, deals, setSearchParams]);

  // Fetch key people for active deal
  const { data: dealPeople } = useQuery({
    queryKey: ["deal-people", activeDeal?.id],
    queryFn: async () => {
      if (!activeDeal?.id) return [];
      const { data, error } = await supabase
        .from("deal_people")
        .select("*")
        .eq("deal_id", activeDeal.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!activeDeal?.id,
  });

  // ---- Agent Mode: assisted-edit surface (gated; default DOM unchanged) ----
  const { id: routeDealId } = useParams();
  const { agentMode } = useAgentMode();
  const updateDeal = useUpdateDeal();
  const addPerson = useAddDealPerson();

  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [agentDeal, setAgentDeal] = useState({ name: "", linkedin_url: "", website: "" });
  const [agentPerson, setAgentPerson] = useState({ name: "", title: "", linkedin_url: "" });

  // Latest-value refs so the imperative window.easyvc bridge reads current
  // state/mutations without being re-created on every render.
  const activeDealRef = useRef(activeDeal);
  const agentDealRef = useRef(agentDeal);
  const agentPersonRef = useRef(agentPerson);
  const updateDealRef = useRef(updateDeal);
  const addPersonRef = useRef(addPerson);
  const nonceRef = useRef<string | null>(null);
  activeDealRef.current = activeDeal;
  agentDealRef.current = agentDeal;
  agentPersonRef.current = agentPerson;
  updateDealRef.current = updateDeal;
  addPersonRef.current = addPerson;
  nonceRef.current = searchParams.get("nonce");

  // Select the deal named in /agent/deal/:id
  useEffect(() => {
    if (routeDealId && deals?.some((d) => d.id === routeDealId)) {
      setSelectedDealId(routeDealId);
    }
  }, [routeDealId, deals]);

  // Seed the edit drafts from the active deal whenever it changes.
  useEffect(() => {
    setAgentDeal({
      name: activeDeal?.name ?? "",
      linkedin_url: (activeDeal as any)?.linkedin_url ?? "",
      website: activeDeal?.website ?? "",
    });
  }, [activeDeal?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open the panel automatically on the agent deep-link route.
  useEffect(() => {
    if (agentMode && routeDealId) setAgentPanelOpen(true);
  }, [agentMode, routeDealId]);

  // Consume ?prefill=<base64-json> once, merging on top of the seeded drafts.
  const prefillAppliedRef = useRef(false);
  useEffect(() => {
    if (!agentMode || prefillAppliedRef.current) return;
    const raw = searchParams.get("prefill");
    if (!raw) return;
    if (!deals) return; // wait until deals (and the seed effect) resolve
    prefillAppliedRef.current = true;
    const prefill = decodePrefill(raw);
    searchParams.delete("prefill");
    setSearchParams(searchParams, { replace: true });
    if (!prefill) return;
    if (prefill.deal) {
      setAgentDeal((prev) => ({
        name: prefill.deal!.name ?? prev.name,
        linkedin_url: prefill.deal!.linkedin_url ?? prev.linkedin_url,
        website: prefill.deal!.website ?? prev.website,
      }));
    }
    if (prefill.person) {
      setAgentPerson((prev) => ({
        name: prefill.person!.name ?? prev.name,
        title: prefill.person!.title ?? prev.title,
        linkedin_url: prefill.person!.linkedin_url ?? prev.linkedin_url,
      }));
    }
    setAgentPanelOpen(true);
  }, [agentMode, deals, searchParams, setSearchParams]);

  // Persist the deal-name / LinkedIn / website drafts.
  const handleAgentSaveDeal = useCallback(async () => {
    const dealId = activeDealRef.current?.id;
    if (!dealId) throw new Error("No active deal to save");
    const d = agentDealRef.current;
    await updateDealRef.current.mutateAsync({
      dealId,
      patch: { name: d.name, linkedin_url: d.linkedin_url, website: d.website },
    });
  }, []);

  // Add the drafted key person and clear the sub-form.
  const handleAgentAddPerson = useCallback(async () => {
    const dealId = activeDealRef.current?.id;
    if (!dealId) throw new Error("No active deal");
    const p = agentPersonRef.current;
    if (!p.name.trim()) throw new Error("Person name is required");
    await addPersonRef.current.mutateAsync({
      dealId,
      name: p.name.trim(),
      title: p.title.trim() || null,
      linkedin_url: p.linkedin_url.trim() || null,
    });
    setAgentPerson({ name: "", title: "", linkedin_url: "" });
  }, []);

  // Mount the window.easyvc bridge ONLY while Agent Mode is on.
  useEffect(() => {
    if (!agentMode) return;
    const applyDealPatch = (patch: unknown) => {
      const { deal } = sanitizePrefill({ deal: patch });
      if (!deal) return;
      setAgentDeal((prev) => ({
        name: deal.name ?? prev.name,
        linkedin_url: deal.linkedin_url ?? prev.linkedin_url,
        website: deal.website ?? prev.website,
      }));
      setAgentPanelOpen(true);
    };
    const applyPerson = (person: unknown) => {
      const { person: p } = sanitizePrefill({ person });
      if (!p) return;
      setAgentPerson((prev) => ({
        name: p.name ?? prev.name,
        title: p.title ?? prev.title,
        linkedin_url: p.linkedin_url ?? prev.linkedin_url,
      }));
      setAgentPanelOpen(true);
    };
    const bridge = {
      getCurrentDealId: () => activeDealRef.current?.id ?? null,
      prefill: applyDealPatch,
      fillPerson: applyPerson,
      save: () => handleAgentSaveDeal(),
      addPerson: () => handleAgentAddPerson(),
      open: () => setAgentPanelOpen(true),
    };
    (window as any).easyvc = bridge;

    // Cross-origin agents can postMessage the same verbs, but ONLY with the
    // one-time nonce carried in the /agent/deal/:id?nonce= URL they opened.
    // (Same-origin check alone is insufficient for cross-origin agents.)
    const onMessage = (e: MessageEvent) => {
      const data = e.data as any;
      if (!data || data.type !== "EASYVC_AGENT") return;
      const expected = nonceRef.current;
      if (!expected || data.nonce !== expected) return;
      switch (data.action) {
        case "prefill": applyDealPatch(data.payload); break;
        case "fillPerson": applyPerson(data.payload); break;
        case "save": void handleAgentSaveDeal().catch((err) => toast.error(err?.message ?? "Save failed")); break;
        case "addPerson": void handleAgentAddPerson().catch((err) => toast.error(err?.message ?? "Add failed")); break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if ((window as any).easyvc === bridge) delete (window as any).easyvc;
    };
  }, [agentMode, handleAgentSaveDeal, handleAgentAddPerson]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    if (!chatInput.trim()) return;
    send(chatInput);
    setChatInput("");
  };

  const handleQuickAction = (action: string) => {
    send(action);
  };

  const handleFileDrop = useCallback(
    async (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const name = file.name.replace(/\.(pdf|pptx?|ppt)$/i, "").replace(/[_-]/g, " ");
      toast.promise(createDeal.mutateAsync({ file, name }), {
        loading: `Uploading ${file.name}…`,
        success: "Deal created & syncing to Drive!",
        error: (err) => `Upload failed: ${err.message}`,
      });
    },
    [createDeal]
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const name = file.name.replace(/\.(pdf|pptx?|ppt)$/i, "").replace(/[_-]/g, " ");
      toast.promise(createDeal.mutateAsync({ file, name }), {
        loading: `Uploading ${file.name}…`,
        success: "Deal created & syncing to Drive!",
        error: (err) => `Upload failed: ${err.message}`,
      });
    },
    [createDeal]
  );

  const handleFetchUrl = useCallback(() => {
    const trimmed = docSendUrl.trim();
    if (!trimmed) return;
    toast.promise(
      processDocsend.mutateAsync(trimmed).then((result) => {
        setDocSendUrl("");
        if (result?.dealId) {
          setSelectedDealId(result.dealId);
        }
      }),
      {
        loading: "Starting deck capture…",
        success: "Capture started — this may take a minute. Progress will update automatically.",
        error: (err) => `Fetch failed: ${err.message}`,
      }
    );
  }, [docSendUrl, processDocsend]);

  const handleRetryCapture = useCallback(() => {
    if (!activeDeal?.id || !latestCaptureJob?.url) return;

    toast.promise(
      retryDocsendCapture.mutateAsync({
        dealId: activeDeal.id,
        url: latestCaptureJob.url,
      }),
      {
        loading: "Retrying cloud capture…",
        success: "Cloud capture restarted — progress will update automatically.",
        error: (err) => `Retry failed: ${err.message}`,
      }
    );
  }, [activeDeal?.id, latestCaptureJob?.url, retryDocsendCapture]);

  const tabs = [
    { key: "chat" as const, label: "Chat", icon: Send },
    { key: "data" as const, label: "Structured Data", icon: Layers },
    { key: "memo" as const, label: "Memo", icon: FileText },
  ];

  const loadedSources = sources ?? [];

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      {/* LEFT PANEL */}
      <div className="w-[30%] border-r border-border p-5 flex flex-col gap-5 overflow-auto">
        <div>
          <h2 className="text-sm font-semibold text-foreground mb-3">Ingest Sources</h2>
          <label
            className="rounded-lg border-2 border-dashed border-border hover:border-primary/40 transition-colors p-6 text-center cursor-pointer group mb-3 block"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleFileDrop}
          >
            <Upload className="h-5 w-5 mx-auto text-muted-foreground group-hover:text-primary transition-colors mb-2" />
            <p className="text-xs text-muted-foreground">
              {createDeal.isPending ? "Uploading…" : "Upload Deck (PDF/PPT)"}
            </p>
            <input type="file" accept=".pdf,.ppt,.pptx" className="hidden" onChange={handleFileSelect} />
          </label>
          <div className="flex gap-2">
            <div className="flex-1 flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2">
              <Link className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                value={docSendUrl}
                onChange={(e) => setDocSendUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleFetchUrl()}
                placeholder="Paste DocSend / PandaDoc / Papermark link…"
                className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground"
              />
            </div>
            <button
              onClick={handleFetchUrl}
              disabled={!docSendUrl.trim() || processDocsend.isPending}
              className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
            >
              {processDocsend.isPending ? "Fetching…" : "Fetch"}
            </button>
          </div>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">Loaded Sources</h3>
          <div className="flex flex-col gap-2">
            {loadedSources.length === 0 && (
              <p className="text-xs text-muted-foreground">No sources uploaded yet.</p>
            )}
            {loadedSources.map((src: any) => (
              <div key={src.id} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-center gap-2 mb-1">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground truncate">{src.file_name}</span>
                </div>
                {src.processing_status === "uploaded" ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-success-muted px-2 py-0.5 text-[11px] font-medium text-success">
                    <Check className="h-3 w-3" />
                    {src.original_size} uploaded ⚡
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Cog className="h-3 w-3 animate-spin-slow" />
                    Processing…
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Processing Pipeline Status — always visible */}
        {activeDeal && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">Pipeline Status</h3>
            <div className="rounded-md border border-border bg-card p-3 flex flex-col gap-1.5">
              {activeDeal.status === "queued" ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  <span className="text-xs font-medium">Queued — waiting for active job</span>
                </div>
              ) : activeDeal.status === "cancelled" ? (
                <div className="flex items-center gap-2">
                  <Pause className="h-3.5 w-3.5 text-destructive shrink-0" />
                  <span className="text-xs font-medium text-destructive">Cancelled</span>
                </div>
              ) : activeDeal.status === "error" ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-start gap-2">
                    <Circle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-destructive">
                        {isCloudCaptureFailed ? "Cloud capture failed" : "Processing failed"}
                      </p>
                      {captureFailureMessage && (
                        <p className="text-[11px] text-muted-foreground break-words">{captureFailureMessage}</p>
                      )}
                    </div>
                  </div>
                  {isCloudCaptureFailed && latestCaptureJob?.url && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[11px] gap-1 px-2 w-fit"
                      onClick={handleRetryCapture}
                      disabled={retryDocsendCapture.isPending}
                    >
                      {retryDocsendCapture.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
                      Retry Cloud Capture
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  {isCloudCaptureActive && (
                    <div className="flex items-center gap-2 rounded-md bg-accent/40 px-2 py-1.5 mb-1">
                      <Loader2 className="h-3.5 w-3.5 text-primary animate-spin shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground">Cloud capture in progress</p>
                        <p className="text-[11px] text-muted-foreground">
                          {latestCaptureJob?.status === "pending"
                            ? "Preparing the Cloud Run PDF capture job…"
                            : "Rendering the deck to PDF via the backend service…"}
                        </p>
                      </div>
                    </div>
                  )}
                  {WORKFLOW_STEPS.map((step) => {
                    const stepIndex = WORKFLOW_STEPS.findIndex(s => s.key === step.key);
                    const currentIndex = WORKFLOW_STEPS.findIndex(s => s.key === activeDeal.status);
                    const isTerminal = activeDeal.status === "memo-ready" || activeDeal.status === "inbox";

                    // Deep Research step uses its own status field
                    let isCompleted: boolean;
                    let isActive: boolean;

                    if (step.key === "deep-research") {
                      isCompleted = activeDeal.deep_research_status === "completed";
                      isActive = ["queued", "running", "pending"].includes(activeDeal.deep_research_status) && (isTerminal || currentIndex >= stepIndex) && activeDeal.deep_research_status !== "skipped";
                    } else if (step.key === "memo-ready") {
                      isCompleted = activeDeal.status === "memo-ready";
                      isActive = false;
                    } else if (isTerminal) {
                      isCompleted = true;
                      isActive = false;
                    } else {
                      isCompleted = currentIndex > stepIndex;
                      isActive = activeDeal.status === step.key;
                    }

                    const allDone = isCompleted;
                    const stepLabel = step.key === "scraping" && isDocViewerDeal ? "Cloud Capture" : step.label;

                    // For Drive sync step, link to Google Drive if available
                    const isDriveStep = step.key === "syncing" && activeDeal.gdrive_file_id;
                    const driveUrl = isDriveStep ? `https://drive.google.com/file/d/${activeDeal.gdrive_file_id}/view` : null;

                    const content = (
                      <div key={step.key} className="flex items-center gap-2">
                        {allDone || (isCompleted && !isActive) ? (
                          <CircleCheck className="h-3.5 w-3.5 text-success shrink-0" />
                        ) : isActive ? (
                          <Loader2 className="h-3.5 w-3.5 text-primary animate-spin shrink-0" />
                        ) : (
                          <CircleDashed className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0" />
                        )}
                        <span className={`text-xs font-medium ${
                          allDone || isCompleted ? "text-success" : isActive ? "text-primary" : "text-muted-foreground/30"
                        }`}>
                          {stepLabel}
                        </span>
                        {driveUrl && allDone && (
                          <ExternalLink className="h-3 w-3 text-success ml-auto" />
                        )}
                      </div>
                    );

                    if (driveUrl && allDone) {
                      return (
                        <a key={step.key} href={driveUrl} target="_blank" rel="noopener noreferrer" className="hover:bg-accent rounded-sm px-0.5 -mx-0.5 transition-colors">
                          {content}
                        </a>
                      );
                    }

                    return content;
                  })}
                  {PROCESSING_STATUSES.includes(activeDeal.status) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 h-7 text-[11px] gap-1 px-2 w-fit"
                      onClick={() => activeDeal && cancelDeal.mutate(activeDeal.id)}
                      disabled={cancelDeal.isPending}
                    >
                      {cancelDeal.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
                      Stop
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {deals && deals.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">Deals</h3>
            <div className="flex flex-col gap-1">
              {deals.map((d) => (
                <div
                  key={d.id}
                  className={`group flex items-center gap-1 rounded-md transition-colors ${
                    activeDeal?.id === d.id
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-accent"
                  }`}
                >
                  <button
                    onClick={() => setSelectedDealId(d.id)}
                    className="flex-1 text-left px-3 py-2 text-xs font-medium truncate flex items-center gap-1.5"
                  >
                    <span className="truncate">{d.name}</span>
                    {user && d.user_id !== user.id && (
                      <Share2 className="h-3 w-3 text-info shrink-0" aria-label="Shared with you" />
                    )}
                  </button>
                  {user && d.user_id === user.id && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDealPendingDelete({ id: d.id, name: d.name });
                      }}
                      aria-label={`Delete ${d.name}`}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 mr-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-opacity"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* RIGHT PANEL */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Quick Facts bar */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border bg-card shrink-0 flex-wrap">
          {/* Source badge */}
          {activeDeal && (() => {
            const src = sourceConfig[activeDeal.source] ?? sourceConfig.manual;
            return (
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${src.bgClass} ${src.colorClass}`}>
                {activeDeal.source === "email" ? <Mail className="h-3 w-3" /> : 
                 activeDeal.source === "docsend" ? <ExternalLink className="h-3 w-3" /> :
                 <Upload className="h-3 w-3" />}
                {src.label}
              </span>
            );
          })()}
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
            <FileText className="h-3 w-3 text-muted-foreground" /> Pages: {activeDeal?.pages ?? "—"}
          </span>
          {/* Download raw file */}
          {loadedSources.length > 0 && loadedSources[0]?.storage_path && (
            <button
              onClick={async () => {
                const path = loadedSources[0].storage_path;
                const { data, error } = await supabase.storage.from("decks").download(path);
                if (error || !data) {
                  toast.error("Failed to download deck");
                  return;
                }
                const url = URL.createObjectURL(data);
                const a = document.createElement("a");
                a.href = url;
                a.download = loadedSources[0].file_name || "deck.pdf";
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              <Download className="h-3 w-3 text-muted-foreground" /> Download Deck
            </button>
          )}
          {/* Doc viewer source link */}
          {isDocViewerDeal && docsendUrl && (
            <a
              href={docsendUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-badge-green-muted px-2.5 py-1 text-xs font-medium text-badge-green hover:underline"
            >
              <ExternalLink className="h-3 w-3" /> {activeDeal?.source === "docsend" ? "DocSend" : activeDeal?.source === "pandadoc" ? "PandaDoc" : "Papermark"} Link
            </a>
          )}
          {isCloudCaptureActive && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-muted px-2.5 py-1 text-xs font-medium text-warning">
              <Loader2 className="h-3 w-3 animate-spin" /> Cloud capturing…
            </span>
          )}
          {isCloudCaptureFailed && captureFailureMessage && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">
              <Circle className="h-3 w-3" /> Capture failed
            </span>
          )}
          {activeDeal?.website ? (
            <a
              href={activeDeal.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-info-muted px-2.5 py-1 text-xs font-medium text-info hover:underline"
            >
              <Globe className="h-3 w-3" /> {activeDeal.website.replace("https://", "")}
            </a>
          ) : activeDeal?.website_searching ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-muted px-2.5 py-1 text-xs font-medium text-warning">
              <Search className="h-3 w-3 animate-pulse" /> Deep searching web…
            </span>
          ) : null}
          {activeDeal?.crunchbase_url && (
            <button
              onClick={() => window.open(activeDeal.crunchbase_url!, '_blank', 'noopener,noreferrer')}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground hover:underline cursor-pointer"
            >
              <Globe className="h-3 w-3" /> Crunchbase
            </button>
          )}
          {activeDeal?.linkedin_url && (
            <button
              onClick={() => window.open(activeDeal.linkedin_url!, '_blank', 'noopener,noreferrer')}
              className="inline-flex items-center gap-1.5 rounded-full bg-info-muted px-2.5 py-1 text-xs font-medium text-info hover:underline cursor-pointer"
            >
              <Linkedin className="h-3 w-3" /> LinkedIn
            </button>
          )}
          {activeDeal?.funding_total && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              💰 Funding: {activeDeal.funding_total}
            </span>
          )}
          {activeDeal?.last_funding_round && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              🏷️ {activeDeal.last_funding_round}
            </span>
          )}
          {activeDeal?.num_employees && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              👥 {activeDeal.num_employees} employees
            </span>
          )}
          {activeDeal?.investors && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">
              🏦 Investors: {activeDeal.investors}
            </span>
          )}
          {(activeDeal as any)?.deep_research_status === "researching" && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-muted px-2.5 py-1 text-xs font-medium text-warning">
              <Search className="h-3 w-3 animate-pulse" /> Deep researching…
            </span>
          )}
          {activeDeal?.gdrive_file_id && (
            <a
              href={`https://drive.google.com/file/d/${activeDeal.gdrive_file_id}/view`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-success-muted px-2.5 py-1 text-xs font-medium text-success hover:underline"
            >
              <Check className="h-3 w-3" /> Synced to Drive
            </a>
          )}
          {isSharedWithMe && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-info-muted px-2.5 py-1 text-xs font-medium text-info">
              <Share2 className="h-3 w-3" /> Shared with you
            </span>
          )}
          {activeDeal && isOwnerOfActive && (
            <button
              onClick={() => setShareOpen(true)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent transition-colors"
            >
              <Share2 className="h-3 w-3" /> Share
            </button>
          )}
        </div>

        {/* Agent-assisted edit panel — rendered ONLY in Agent Mode */}
        {agentMode && agentPanelOpen && (
          <div data-testid="agent-edit-panel" className="border-b border-primary/30 bg-primary/5 px-5 py-4 shrink-0">
            <div className="flex items-center gap-2 mb-3">
              <Bot className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold text-foreground">Agent-assisted edit — review &amp; save</span>
              <button
                onClick={() => setAgentPanelOpen(false)}
                aria-label="Close agent panel"
                className="ml-auto p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {activeDeal ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Deal fields */}
                <div className="flex flex-col gap-2">
                  <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Deal name</label>
                  <input
                    data-testid="deal-name-input"
                    type="text"
                    value={agentDeal.name}
                    onChange={(e) => setAgentDeal((d) => ({ ...d, name: e.target.value }))}
                    className="rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                  />
                  <label className="text-[11px] uppercase tracking-wider text-muted-foreground mt-1">LinkedIn URL</label>
                  <input
                    data-testid="linkedin-url-input"
                    type="text"
                    value={agentDeal.linkedin_url}
                    onChange={(e) => setAgentDeal((d) => ({ ...d, linkedin_url: e.target.value }))}
                    placeholder="https://linkedin.com/company/…"
                    className="rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                  />
                  <label className="text-[11px] uppercase tracking-wider text-muted-foreground mt-1">Website</label>
                  <input
                    data-testid="website-input"
                    type="text"
                    value={agentDeal.website}
                    onChange={(e) => setAgentDeal((d) => ({ ...d, website: e.target.value }))}
                    placeholder="https://…"
                    className="rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button
                    data-testid="save-deal-btn"
                    onClick={() => {
                      toast.promise(handleAgentSaveDeal(), {
                        loading: "Saving deal…",
                        success: "Deal updated",
                        error: (err) => `Save failed: ${err?.message ?? "unknown error"}`,
                      });
                    }}
                    disabled={updateDeal.isPending}
                    className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 w-fit"
                  >
                    {updateDeal.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save deal
                  </button>
                </div>

                {/* Add key person */}
                <div className="flex flex-col gap-2">
                  <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Add key person</label>
                  <input
                    data-testid="person-name-input"
                    type="text"
                    value={agentPerson.name}
                    onChange={(e) => setAgentPerson((p) => ({ ...p, name: e.target.value }))}
                    placeholder="Full name"
                    className="rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                  />
                  <input
                    data-testid="person-title-input"
                    type="text"
                    value={agentPerson.title}
                    onChange={(e) => setAgentPerson((p) => ({ ...p, title: e.target.value }))}
                    placeholder="Title (e.g. CEO)"
                    className="rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                  />
                  <input
                    data-testid="person-linkedin-input"
                    type="text"
                    value={agentPerson.linkedin_url}
                    onChange={(e) => setAgentPerson((p) => ({ ...p, linkedin_url: e.target.value }))}
                    placeholder="LinkedIn URL"
                    className="rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button
                    data-testid="add-person-btn"
                    onClick={() => {
                      toast.promise(handleAgentAddPerson(), {
                        loading: "Adding person…",
                        success: "Person added",
                        error: (err) => `Add failed: ${err?.message ?? "unknown error"}`,
                      });
                    }}
                    disabled={addPerson.isPending || !agentPerson.name.trim()}
                    className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-background px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50 w-fit"
                  >
                    {addPerson.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                    Add person
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Select or create a deal to edit.</p>
            )}
          </div>
        )}

        {activeDeal && isOwnerOfActive && (
          <ShareDealDialog
            open={shareOpen}
            onOpenChange={setShareOpen}
            dealId={activeDeal.id}
            dealName={activeDeal.name}
            ownerId={activeDeal.user_id}
          />
        )}

        {/* Tabs */}
        <div className="flex items-center gap-0 px-5 border-b border-border bg-card shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 flex flex-col overflow-auto">
          {activeTab === "chat" && (
            <div className="flex-1 flex flex-col">
              <div className="flex-1 p-5 space-y-4 overflow-auto">
                {messages.map((msg, i) => (
                  <div key={i} className={`max-w-[80%] ${msg.role === "assistant" ? "" : "ml-auto"}`}>
                    <div className={`rounded-lg p-3.5 text-sm leading-relaxed ${
                      msg.role === "assistant"
                        ? "bg-muted text-foreground"
                        : "bg-primary text-primary-foreground"
                    }`}>
                      {msg.role === "assistant" ? (
                        <div className="prose prose-sm max-w-none dark:prose-invert">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                      ) : (
                        msg.content
                      )}
                    </div>
                  </div>
                ))}
                {isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
                  <div className="max-w-[80%]">
                    <div className="rounded-lg p-3.5 bg-muted text-foreground">
                      <div className="flex gap-1">
                        <span className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
                        <span className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "150ms" }} />
                        <span className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "300ms" }} />
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>
              <div className="px-5 pb-2 flex gap-2 flex-wrap">
                {quickActions.map((a) => (
                  <button
                    key={a}
                    onClick={() => handleQuickAction(a)}
                    disabled={isStreaming}
                    className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                  >
                    {a}
                  </button>
                ))}
              </div>
              <div className="px-5 pb-5">
                <div className="flex items-center gap-2 rounded-lg border border-input bg-card px-3 py-2.5">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                    placeholder="Ask about the deck…"
                    className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
                    disabled={isStreaming}
                  />
                  {isStreaming ? (
                    <button
                      onClick={stop}
                      className="p-1.5 rounded-md bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity"
                    >
                      <Square className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={handleSend}
                      disabled={!chatInput.trim()}
                      className="p-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          {activeTab === "data" && (
            <div className="p-5">
              <div className="rounded-lg border border-border bg-card p-5">
                <h3 className="text-sm font-semibold text-foreground mb-4">Extracted Data</h3>
                {activeDeal ? (
                  <div className="grid grid-cols-2 gap-4">
                    {[
                      ["Company", activeDeal.name],
                      ["Stage", activeDeal.stage],
                      ["Sector", activeDeal.sector],
                      ["Pages", activeDeal.pages ? String(activeDeal.pages) : "—"],
                      ["Ask", activeDeal.ask_amount ?? "—"],
                      ["Valuation", activeDeal.valuation ?? "—"],
                      ["Revenue", activeDeal.revenue ?? "—"],
                      ["Growth", activeDeal.growth ?? "—"],
                      ["NRR", activeDeal.nrr ?? "—"],
                      ["Team Size", activeDeal.team_size ?? "—"],
                    ].map(([k, v]) => (
                      <div key={k} className="flex flex-col">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground mb-0.5">{k}</span>
                        <span className="text-sm font-medium text-foreground">{v}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No deal selected.</p>
                )}
              </div>

              {activeDeal && (
                <div className="rounded-lg border border-border bg-card p-5 mt-4">
                  <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                    <Search className="h-3.5 w-3.5" />
                    Deep Research Data
                    {(activeDeal as any)?.deep_research_status === "researching" && (
                      <span className="text-[11px] font-normal text-warning animate-pulse">Researching…</span>
                    )}
                    {(activeDeal as any)?.deep_research_status === "completed" && (
                      <span className="text-[11px] font-normal text-success">✓ Complete</span>
                    )}
                  </h3>
                  <div className="grid grid-cols-1 gap-3">
                    <div className="flex flex-col">
                      <span className="text-[11px] uppercase tracking-wider text-muted-foreground mb-0.5">Website</span>
                      {activeDeal.website ? (
                        <a href={activeDeal.website} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-info hover:underline">
                          {activeDeal.website}
                        </a>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[11px] uppercase tracking-wider text-muted-foreground mb-0.5">LinkedIn</span>
                      {(activeDeal as any)?.linkedin_url ? (
                        <a href={(activeDeal as any).linkedin_url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-info hover:underline flex items-center gap-1.5">
                          <Linkedin className="h-3.5 w-3.5" />
                          {(activeDeal as any).linkedin_url}
                        </a>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[11px] uppercase tracking-wider text-muted-foreground mb-0.5">Deck Verification</span>
                      {Array.isArray((activeDeal as any)?.research_verification) && (activeDeal as any).research_verification.length > 0 ? (
                        <div className="flex flex-col gap-1.5">
                          {(activeDeal as any).research_verification.map((item: any, idx: number) => (
                            <div key={`${item.field}-${idx}`} className="text-xs text-foreground flex items-center gap-1.5">
                              <span className={item.matched ? "text-success" : "text-warning"}>{item.matched ? "✓" : "!"}</span>
                              <span className="font-medium">{item.field}:</span>
                              <span className="truncate">{item.value}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {activeDeal && Array.isArray((activeDeal as any)?.investor_research) && (activeDeal as any).investor_research.length > 0 && (
                <div className="rounded-lg border border-border bg-card p-5 mt-4">
                  <h3 className="text-sm font-semibold text-foreground mb-4">Investor Research (Crunchbase, Tracxn, LinkedIn)</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(activeDeal as any).investor_research.map((investor: any, idx: number) => (
                      <div key={`${investor.name}-${idx}`} className="rounded-md border border-border bg-background p-3">
                        <div className="text-sm font-medium text-foreground mb-2">{investor.name}</div>
                        <div className="space-y-1 text-xs">
                          {investor.linkedin_url && <a className="text-info hover:underline block" href={investor.linkedin_url} target="_blank" rel="noopener noreferrer">LinkedIn</a>}
                          {investor.crunchbase_url && <a className="text-info hover:underline block" href={investor.crunchbase_url} target="_blank" rel="noopener noreferrer">Crunchbase</a>}
                          {investor.tracxn_url && <a className="text-info hover:underline block" href={investor.tracxn_url} target="_blank" rel="noopener noreferrer">Tracxn</a>}
                          {!investor.linkedin_url && !investor.crunchbase_url && !investor.tracxn_url && (
                            <span className="text-muted-foreground">No profile links found</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeDeal && Array.isArray((activeDeal as any)?.latest_articles) && (activeDeal as any).latest_articles.length > 0 && (
                <div className="rounded-lg border border-border bg-card p-5 mt-4">
                  <h3 className="text-sm font-semibold text-foreground mb-4">Latest 3 Articles</h3>
                  <div className="space-y-3">
                    {(activeDeal as any).latest_articles.slice(0, 3).map((article: any, idx: number) => (
                      <div key={`${article.url}-${idx}`} className="rounded-md border border-border bg-background p-3">
                        <a href={article.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-info hover:underline">
                          {article.title}
                        </a>
                        {article.preview && <p className="text-xs text-muted-foreground mt-1 line-clamp-3">{article.preview}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeDeal && Array.isArray((activeDeal as any)?.deck_preview) && (activeDeal as any).deck_preview.length > 0 && (
                <div className="rounded-lg border border-border bg-card p-5 mt-4">
                  <h3 className="text-sm font-semibold text-foreground mb-4">Deck Preview (Traction / Ask / Team)</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {(activeDeal as any).deck_preview.map((preview: any, idx: number) => (
                      <div key={`${preview.section}-${idx}`} className="rounded-md border border-border bg-background p-3">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">{preview.section}</div>
                        <div className="text-xs text-foreground mb-2">{preview.slide > 0 ? `Slide ${preview.slide}` : "Slide not found"}</div>
                        {preview.preview_image ? (
                          <img src={preview.preview_image} alt={`${preview.section} slide preview`} className="w-full rounded border border-border mb-2" />
                        ) : null}
                        <p className="text-xs text-muted-foreground line-clamp-4">{preview.snippet || "No slide snippet available."}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Key People */}
              {activeDeal && dealPeople && dealPeople.length > 0 && (
                <div className="rounded-lg border border-border bg-card p-5 mt-4">
                  <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                    <Users className="h-3.5 w-3.5" />
                    Key People
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {dealPeople.map((person: any) => (
                      <div key={person.id} className="flex items-start gap-2.5 rounded-md border border-border bg-background p-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-foreground truncate">{person.name}</div>
                          {person.title && (
                            <div className="text-xs text-muted-foreground truncate">{person.title}</div>
                          )}
                        </div>
                        {person.linkedin_url && (
                          <a
                            href={person.linkedin_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-info hover:text-info/80 transition-colors"
                          >
                            <Linkedin className="h-4 w-4" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {activeTab === "memo" && (
            <div className="p-5">
              <div className="rounded-lg border border-border bg-card p-5 prose prose-sm max-w-none">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-foreground m-0">Investment Memo Draft</h3>
                  {activeDeal && (
                    <button
                      onClick={() => {
                        if (!activeDeal) return;
                        toast.promise(
                          generateMemo.mutateAsync(activeDeal.id),
                          {
                            loading: "Generating memo (deep research + AI)…",
                            success: (data) =>
                              data.driveFileId
                                ? `Memo generated & uploaded to Drive as "${data.driveFileName}"`
                                : "Memo generated successfully!",
                            error: (err) => `Memo failed: ${err.message}`,
                          }
                        );
                      }}
                      disabled={generateMemo.isPending}
                      className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      {generateMemo.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FileUp className="h-3.5 w-3.5" />
                      )}
                      {generateMemo.isPending ? "Generating…" : activeDeal.memo_draft ? "Regenerate Memo" : "Generate Memo"}
                    </button>
                  )}
                </div>
                {activeDeal?.memo_draft ? (
                  <div className="text-sm text-muted-foreground leading-relaxed">
                    <ReactMarkdown>{activeDeal.memo_draft}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground leading-relaxed italic">
                    {generateMemo.isPending
                      ? "Generating memo… This may take a minute."
                      : "No memo generated yet. Click \"Generate Memo\" to create one using deep research and deck content."}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <AlertDialog
        open={!!dealPendingDelete}
        onOpenChange={(open) => {
          if (!open) setDealPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this deal?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <span className="font-medium text-foreground">{dealPendingDelete?.name}</span>, along with its sources, capture jobs, key people, and uploaded files. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteDeal.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteDeal.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!dealPendingDelete) return;
                const { id, name } = dealPendingDelete;
                toast.promise(
                  deleteDeal.mutateAsync(id).then(() => {
                    if (selectedDealId === id) setSelectedDealId(undefined);
                    setDealPendingDelete(null);
                  }),
                  {
                    loading: `Deleting ${name}…`,
                    success: `Deleted ${name}`,
                    error: (err) => `Failed to delete: ${err?.message ?? "unknown error"}`,
                  }
                );
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteDeal.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
