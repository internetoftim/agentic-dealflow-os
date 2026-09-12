import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { createEngine, detectCapabilities, getFallbackChain } from "@/lib/inference";
import type { ChatTurn, DeviceReport, EngineCapability, EngineStatus, EngineType, GenerationResult, ImageAttachment, InferenceEngine, StreamCallbacks } from "@/lib/inference/types";
import { fallbackModelFor, getPreset, type LocalModelPreset } from "@/lib/localModels";
import { registerModelCache, resolveHfToken } from "@/lib/modelCache";

export const LOCAL_AI_MODEL = "local-webgpu";
/** The pre-existing option name; treated as the local path with the Gemma 3n preset. */
export const LEGACY_LOCAL_AI_MODEL = "local-florence2";

interface LocalLlmState {
  report: DeviceReport | null;
  capabilities: EngineCapability[];
  status: EngineStatus;
  progress: number;
  statusMessage: string;
  activeEngine: EngineType | null;
  currentPreset: LocalModelPreset | null;
  /** True once a vision-capable model is loaded (deck pages can be read locally). */
  supportsVision: boolean;
  loadModel: (presetId: string) => Promise<void>;
  unloadModel: () => Promise<void>;
  /** Loads the preset if it isn't the active one; resolves to the ready engine. */
  ensureLoaded: (presetId: string) => Promise<InferenceEngine>;
  chat: (turns: ChatTurn[], callbacks: StreamCallbacks, images?: ImageAttachment[]) => Promise<void>;
  generate: (turns: ChatTurn[], images?: ImageAttachment[]) => Promise<GenerationResult>;
  interrupt: () => void;
}

const Ctx = createContext<LocalLlmState | undefined>(undefined);

/**
 * One engine per tab, loaded through a fallback chain: the requested preset
 * on its engine first, then each other available engine with its own
 * smallest ungated model, WASM last. Every switch is surfaced, never silent.
 */
export function LocalLlmProvider({ children }: { children: ReactNode }) {
  const [report, setReport] = useState<DeviceReport | null>(null);
  const [capabilities, setCapabilities] = useState<EngineCapability[]>([]);
  const [status, setStatus] = useState<EngineStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState("");
  const [activeEngine, setActiveEngine] = useState<EngineType | null>(null);
  const [currentPreset, setCurrentPreset] = useState<LocalModelPreset | null>(null);
  const [supportsVision, setSupportsVision] = useState(false);
  const engineRef = useRef<InferenceEngine | null>(null);
  const loadingRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;
    detectCapabilities().then(({ report, capabilities }) => {
      if (cancelled) return;
      setReport(report); setCapabilities(capabilities);
    });
    registerModelCache();
    return () => { cancelled = true; };
  }, []);

  const unloadModel = useCallback(async () => {
    await engineRef.current?.unload();
    engineRef.current = null;
    setActiveEngine(null); setCurrentPreset(null); setSupportsVision(false);
    setStatus("idle"); setProgress(0); setStatusMessage("");
  }, []);

  const loadModel = useCallback(async (presetId: string) => {
    const wanted = getPreset(presetId);
    if (!wanted) throw new Error(`Unknown local model "${presetId}"`);
    if (loadingRef.current) await loadingRef.current.catch(() => {});
    if (engineRef.current && currentPreset?.id === wanted.id && status === "ready") return;

    const run = (async () => {
      await Promise.resolve(engineRef.current?.unload()).catch(() => {});
      engineRef.current = null;
      setStatus("loading"); setProgress(0);

      const attempts: LocalModelPreset[] = [wanted];
      for (const eng of getFallbackChain(capabilities, wanted.engine)) {
        if (eng === wanted.engine) continue;
        const alt = fallbackModelFor(eng);
        if (alt && !alt.gated) attempts.push(alt); // a gated fallback would just fail the same way
      }
      const hfToken = wanted.gated ? await resolveHfToken() : null;

      let lastError: unknown = null;
      for (let i = 0; i < attempts.length; i++) {
        const preset = attempts[i];
        try {
          setCurrentPreset(preset); setProgress(0);
          const engine = await createEngine(preset.engine);
          engineRef.current = engine; setActiveEngine(preset.engine);
          setStatusMessage(i === 0 ? `Starting ${engine.label}…` : `Falling back to ${preset.name} on ${engine.label}…`);
          await engine.load(preset.ref, (pct, msg) => { setProgress(pct); setStatusMessage(msg); }, { hfToken, vision: preset.vision });
          setSupportsVision(engine.supportsVision);
          setStatus("ready"); setStatusMessage(`${preset.name} ready on ${engine.label}`);
          if (i > 0) toast.message(`Loaded ${preset.name} instead`, { description: `${attempts[0].name} failed on ${attempts[0].engine}; using ${engine.label}.` });
          return;
        } catch (e) {
          lastError = e;
          console.error(`local model load failed on ${preset.engine}:`, e);
          await Promise.resolve(engineRef.current?.unload()).catch(() => {}); engineRef.current = null;
          const msg = e instanceof Error ? e.message : String(e);
          if (i < attempts.length - 1) toast.error(`${preset.name} failed to load`, { description: `${msg} — trying ${attempts[i + 1].name}.` });
        }
      }
      const msg = lastError instanceof Error ? lastError.message : "Could not load any local model";
      setStatus("error"); setStatusMessage(msg); setProgress(0); setActiveEngine(null); setCurrentPreset(null);
      toast.error("No local AI engine could load", { description: msg });
      throw new Error(msg);
    })();
    loadingRef.current = run;
    try { await run; } finally { loadingRef.current = null; }
  }, [capabilities, currentPreset?.id, status]);

  const ensureLoaded = useCallback(async (presetId: string) => {
    if (!(engineRef.current && currentPreset?.id === presetId && status === "ready")) await loadModel(presetId);
    if (!engineRef.current) throw new Error("Local model is not loaded");
    return engineRef.current;
  }, [currentPreset?.id, loadModel, status]);

  const chat = useCallback(async (turns: ChatTurn[], callbacks: StreamCallbacks, images?: ImageAttachment[]) => {
    if (!engineRef.current) throw new Error("Local model is not loaded");
    await engineRef.current.chatStream(turns, callbacks, images);
  }, []);
  const generate = useCallback(async (turns: ChatTurn[], images?: ImageAttachment[]) => {
    if (!engineRef.current) throw new Error("Local model is not loaded");
    return engineRef.current.generate(turns, images);
  }, []);
  const interrupt = useCallback(() => { (engineRef.current as any)?.interrupt?.(); }, []);

  const value = useMemo<LocalLlmState>(() => ({
    report, capabilities, status, progress, statusMessage, activeEngine, currentPreset, supportsVision,
    loadModel, unloadModel, ensureLoaded, chat, generate, interrupt,
  }), [report, capabilities, status, progress, statusMessage, activeEngine, currentPreset, supportsVision, loadModel, unloadModel, ensureLoaded, chat, generate, interrupt]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLocalLlm(): LocalLlmState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLocalLlm must be used within LocalLlmProvider");
  return ctx;
}

type AiModelRow = { aiModel: string; localModelId: string | null; memoPrompt: string | null };
const CLOUD_DEFAULT: AiModelRow = { aiModel: "gpt-5.4", localModelId: null, memoPrompt: null };

async function fetchAiModelRow(userId: string): Promise<AiModelRow> {
  const { data } = await supabase.from("user_settings").select("ai_model, local_model_id, memo_prompt").eq("user_id", userId).maybeSingle();
  const row = data as any;
  return { aiModel: row?.ai_model ?? CLOUD_DEFAULT.aiModel, localModelId: row?.local_model_id ?? null, memoPrompt: row?.memo_prompt ?? null };
}

function deriveAiModel(row: AiModelRow) {
  const isLocal = row.aiModel === LOCAL_AI_MODEL || row.aiModel === LEGACY_LOCAL_AI_MODEL;
  const localModelId = row.aiModel === LEGACY_LOCAL_AI_MODEL ? "gemma-3n-e2b" : row.localModelId;
  return { aiModel: row.aiModel, isLocal, localModelId, memoPrompt: row.memoPrompt };
}

export type AiModelChoice = ReturnType<typeof deriveAiModel>;

/**
 * The user's AI model choice; `isLocal` routes chat/memo/extraction through
 * the browser. `resolve()` answers from the cache when fresh and otherwise
 * fetches, so a click that lands before the query settles still routes right.
 */
export function useAiModelSetting() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["ai-model-setting", user?.id];
  const query = useQuery({ queryKey, queryFn: () => fetchAiModelRow(user!.id), enabled: !!user, staleTime: 30_000 });
  const resolve = useCallback(async (): Promise<AiModelChoice> => {
    if (!user) return deriveAiModel(CLOUD_DEFAULT);
    return deriveAiModel(await queryClient.fetchQuery({ queryKey: ["ai-model-setting", user.id], queryFn: () => fetchAiModelRow(user.id), staleTime: 30_000 }));
  }, [queryClient, user]);
  return { ...deriveAiModel(query.data ?? CLOUD_DEFAULT), isLoading: query.isLoading, resolve };
}
