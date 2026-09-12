import { useEffect, useState } from "react";
import { Cpu, Download, Square, Zap, KeyRound, Trash2, Loader2, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { useLocalLlm } from "@/contexts/LocalLlmContext";
import { LOCAL_MODELS, DEFAULT_LOCAL_MODEL_ID, canRun, type LocalModelPreset } from "@/lib/localModels";
import type { EngineType } from "@/lib/inference/types";
import { clearModelCache, fetchServerHfToken, getStoredHfToken, modelCacheUsage, setStoredHfToken } from "@/lib/modelCache";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

const fmtBytes = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const ENGINE_LABEL: Record<EngineType, string> = { mediapipe: "MediaPipe · WebGPU", webllm: "WebLLM · WebGPU", onnx: "Transformers.js · WASM" };

/**
 * "Can I AI?" for this device, plus the model picker. Selection is saved to
 * user_settings.local_model_id; the model itself is loaded on demand (here,
 * or the first time chat/memo needs it).
 */
export function LocalModelSection({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const llm = useLocalLlm();
  const [hfToken, setHfToken] = useState(getStoredHfToken() ?? "");
  const [serverToken, setServerToken] = useState<boolean | null>(null);
  const [cache, setCache] = useState<{ bytes: number; entries: number } | null>(null);
  const [testOut, setTestOut] = useState("");
  const [testing, setTesting] = useState(false);

  useEffect(() => { fetchServerHfToken().then((t) => setServerToken(!!t)); modelCacheUsage().then(setCache); }, [llm.status]);

  const selected = LOCAL_MODELS.find((m) => m.id === (selectedId ?? DEFAULT_LOCAL_MODEL_ID)) ?? LOCAL_MODELS[0];
  const needsToken = selected.gated && !hfToken && serverToken === false;

  const choose = async (m: LocalModelPreset) => {
    onSelect(m.id);
    if (!user) return;
    const { error } = await supabase.from("user_settings").upsert({ user_id: user.id, local_model_id: m.id } as any, { onConflict: "user_id" });
    if (error) toast.error("Failed to save model choice"); else queryClient.invalidateQueries({ queryKey: ["ai-model-setting"] });
  };

  const runTest = async () => {
    setTesting(true); setTestOut("");
    try {
      await llm.ensureLoaded(selected.id);
      const r = await llm.generate([{ role: "system", content: "You are a concise assistant." }, { role: "user", content: "In one sentence, what does a venture capital analyst do?" }]);
      setTestOut(`${r.text}\n\n— ${r.tokenCount} tokens · first token ${Math.round(r.ttftMs)} ms · ${r.tpotMs ? (1000 / r.tpotMs).toFixed(1) : "?"} tok/s`);
    } catch (e: any) { setTestOut(`Error: ${e.message}`); } finally { setTesting(false); }
  };

  const groups: EngineType[] = ["mediapipe", "webllm", "onnx"];
  const r = llm.report;

  return (
    <div className="rounded-md border border-border bg-card p-5 space-y-5">
      {/* Device report */}
      <div>
        <p className="eyebrow mb-2 flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5" /> This device</p>
        {!r ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Probing WebGPU…</p>
        ) : (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-[12px]">
            <div><dt className="text-muted-foreground">WebGPU</dt><dd className={r.webgpu ? "text-success font-medium" : "text-destructive font-medium"}>{r.webgpu ? "Available" : "Not available"}</dd></div>
            <div><dt className="text-muted-foreground">Adapter</dt><dd className="truncate" title={r.adapter}>{r.adapter ?? "—"}</dd></div>
            <div><dt className="text-muted-foreground">shader-f16</dt><dd>{r.shaderF16 == null ? "—" : r.shaderF16 ? "Yes" : "No"}</dd></div>
            <div><dt className="text-muted-foreground">Memory</dt><dd>{r.deviceMemoryGB ? `${r.deviceMemoryGB} GB` : "—"} · {r.hardwareConcurrency ?? "?"} cores</dd></div>
            <div className="col-span-2"><dt className="text-muted-foreground">Browser storage</dt><dd>{r.storageQuotaBytes ? `${fmtBytes(r.storageUsageBytes ?? 0)} used of ${fmtBytes(r.storageQuotaBytes)}` : "—"}</dd></div>
            <div className="col-span-2"><dt className="text-muted-foreground">Cached models</dt><dd className="flex items-center gap-2">{cache ? `${fmtBytes(cache.bytes)} · ${cache.entries} files` : "—"}
              {cache && cache.entries > 0 && <button className="text-muted-foreground hover:text-destructive" title="Clear cached models" onClick={async () => { await clearModelCache(); setCache(await modelCacheUsage()); toast.success("Model cache cleared"); }}><Trash2 className="h-3 w-3" /></button>}
            </dd></div>
          </dl>
        )}
      </div>

      {/* Picker */}
      {groups.map((eng) => {
        const cap = llm.capabilities.find((c) => c.engine === eng);
        return (
          <div key={eng}>
            <p className="eyebrow mb-1.5 flex items-center gap-2">{ENGINE_LABEL[eng]}
              {cap && !cap.available && <span className="text-[9px] normal-case tracking-normal text-destructive">{cap.reason}</span>}
            </p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {LOCAL_MODELS.filter((m) => m.engine === eng).map((m) => {
                const verdict = r ? canRun(m, llm.capabilities, r) : null;
                const active = selected.id === m.id;
                const Icon = !verdict ? Loader2 : verdict.level === "good" ? CheckCircle2 : verdict.level === "tight" ? AlertTriangle : XCircle;
                return (
                  <button key={m.id} onClick={() => choose(m)} disabled={verdict?.ok === false}
                    className={`text-left rounded-[5px] border p-2.5 transition-colors ${active ? "border-brand bg-brand-muted/40" : verdict?.ok === false ? "border-border opacity-50 cursor-not-allowed" : "border-border hover:border-foreground/25"}`}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium text-foreground">{m.name}</span>
                      {m.vision && <span className="eyebrow text-[9px]">vision</span>}
                      {m.gated && <span className="eyebrow text-[9px]" title="Gated on Hugging Face"><KeyRound className="inline h-2.5 w-2.5" /></span>}
                      {m.recommended && <span className="eyebrow text-[9px] text-brand">recommended</span>}
                      <span className="ml-auto text-[11px] text-muted-foreground">{m.sizeLabel}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{m.description}</p>
                    {verdict && <p className={`mt-1 text-[10.5px] inline-flex items-center gap-1 ${verdict.level === "good" ? "text-success" : verdict.level === "tight" ? "text-warning" : "text-destructive"}`}><Icon className="h-3 w-3" /> {verdict.reason}</p>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Gated access */}
      {selected.gated && (
        <div className="rounded-[5px] border border-border bg-muted/40 p-3 space-y-2">
          <p className="text-xs text-foreground flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" /> Gemma weights are gated on Hugging Face.
            {serverToken ? <span className="text-success"> This workspace has access configured.</span> : serverToken === false ? " Paste a token from an account that accepted the Gemma license — it stays in this browser." : ""}
          </p>
          <div className="flex gap-2">
            <Input type="password" value={hfToken} onChange={(e) => setHfToken(e.target.value)} placeholder="hf_…" className="max-w-xs font-mono text-xs" aria-label="Hugging Face token" />
            <Button size="sm" variant="outline" onClick={() => { setStoredHfToken(hfToken.trim() || null); toast.success(hfToken.trim() ? "Token saved in this browser" : "Token removed"); }}>Save</Button>
          </div>
        </div>
      )}

      {/* Load / status */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" className="gap-1.5" disabled={llm.status === "loading" || needsToken} onClick={() => llm.loadModel(selected.id).catch(() => {})}>
            {llm.status === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {llm.currentPreset?.id === selected.id && llm.status === "ready" ? "Loaded" : `Load ${selected.name}`}
          </Button>
          {llm.status === "ready" && (
            <>
              <Button size="sm" variant="outline" className="gap-1.5" disabled={testing} onClick={runTest}>{testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />} Test</Button>
              <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" onClick={() => llm.unloadModel()}><Square className="h-3.5 w-3.5" /> Unload</Button>
            </>
          )}
          {needsToken && <span className="text-[11px] text-warning">Add a Hugging Face token to load this model.</span>}
        </div>
        {(llm.status === "loading" || llm.status === "ready" || llm.status === "error") && (
          <div>
            {llm.status === "loading" && <div className="h-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full bg-brand transition-[width]" style={{ width: `${llm.progress}%` }} /></div>}
            <p className={`mt-1 text-[11px] ${llm.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>{llm.statusMessage}</p>
          </div>
        )}
        {testOut && <pre className="whitespace-pre-wrap rounded-[5px] border border-border bg-muted/40 p-3 text-[12px] text-foreground">{testOut}</pre>}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Runs entirely in your browser: deck text, chat and memos never leave this device. Downloads are cached; first load takes a few minutes on a fast connection.
      </p>
    </div>
  );
}
