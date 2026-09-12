import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor, render, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";

/* ---------- pure logic: capabilities, presets, verdicts ---------- */
import { capabilitiesFromReport, getFallbackChain, getBestEngine } from "@/lib/inference/detect";
import { LOCAL_MODELS, DEFAULT_LOCAL_MODEL_ID, getPreset, fallbackModelFor, canRun } from "@/lib/localModels";
import type { DeviceReport } from "@/lib/inference/types";

const gpu: DeviceReport = { webgpu: true, shaderF16: true, deviceMemoryGB: 16, storageQuotaBytes: 50e9, storageUsageBytes: 0 };
const noGpu: DeviceReport = { webgpu: false, deviceMemoryGB: 8, storageQuotaBytes: 50e9, storageUsageBytes: 0 };

describe("engine detection", () => {
  it("only the WASM engine is available without a WebGPU adapter", () => {
    const caps = capabilitiesFromReport(noGpu);
    expect(caps.filter((c) => c.available).map((c) => c.engine)).toEqual(["onnx"]);
    expect(caps.find((c) => c.engine === "webllm")?.reason).toMatch(/WebGPU/);
    expect(getBestEngine(caps)).toBe("onnx");
  });
  it("prefers MediaPipe, then WebLLM, then WASM when WebGPU works", () => {
    const caps = capabilitiesFromReport(gpu);
    expect(getBestEngine(caps)).toBe("mediapipe");
    expect(getFallbackChain(caps, "webllm")).toEqual(["webllm", "mediapipe", "onnx"]);
  });
  it("fallback chain always ends in WASM, even when detection produced nothing", () => {
    expect(getFallbackChain([], "webllm")).toEqual(["webllm", "onnx"]);
  });
});

describe("local model presets", () => {
  it("ids are unique and the default is a recommended, ungated WebLLM model", () => {
    expect(new Set(LOCAL_MODELS.map((m) => m.id)).size).toBe(LOCAL_MODELS.length);
    const d = getPreset(DEFAULT_LOCAL_MODEL_ID)!;
    expect(d.engine).toBe("webllm"); expect(d.gated).toBe(false); expect(d.recommended).toBe(true);
  });
  it("offers Gemma 4 and Gemma 3 on MediaPipe and Gemma 3 on WebLLM", () => {
    const names = LOCAL_MODELS.map((m) => m.name.toLowerCase());
    expect(names.some((n) => n.includes("gemma 4"))).toBe(true);
    expect(LOCAL_MODELS.some((m) => m.engine === "mediapipe" && m.name.includes("Gemma 3"))).toBe(true);
    expect(LOCAL_MODELS.some((m) => m.engine === "webllm" && m.ref.startsWith("gemma3"))).toBe(true);
  });
  it("cross-engine fallback picks the smallest ungated model per engine", () => {
    expect(fallbackModelFor("webllm")?.gated).toBe(false);
    expect(fallbackModelFor("onnx")?.engine).toBe("onnx");
    const mp = fallbackModelFor("mediapipe");
    if (mp) expect(mp.gated).toBe(false);
  });
  it("canRun refuses GPU engines without WebGPU but keeps WASM usable", () => {
    const caps = capabilitiesFromReport(noGpu);
    expect(canRun(getPreset("webllm-gemma-3-1b")!, caps, noGpu).ok).toBe(false);
    expect(canRun(getPreset("onnx-smollm2-135m")!, caps, noGpu)).toMatchObject({ ok: true, level: "good" });
  });
  it("canRun flags insufficient browser storage and tight memory", () => {
    const caps = capabilitiesFromReport(gpu);
    const big = LOCAL_MODELS.find((m) => m.sizeBytes > 3e9)!;
    expect(canRun(big, caps, { ...gpu, storageQuotaBytes: 1e9 }).level).toBe("no");
    expect(canRun(big, caps, { ...gpu, deviceMemoryGB: 4 }).level).toBe("tight");
  });
});

/* ---------- context: setting → routing, and the load fallback chain ---------- */
const state = vi.hoisted(() => ({
  settings: { ai_model: "gpt-5.4", local_model_id: null as string | null, memo_prompt: null as string | null },
  loadOutcomes: {} as Record<string, "ok" | "fail">,
  loaded: [] as string[],
  generated: "local answer",
}));

vi.mock("@/integrations/supabase/client", async () => {
  const { makeSupabaseMock } = await import("./supabaseMock");
  const m = makeSupabaseMock({
    tables: {
      user_settings: { data: state.settings },
      deals: { data: { id: "d1", name: "Acme", stage: "Seed", sector: "Fintech", revenue: "$1.2M ARR" } },
      sources: { data: [{ file_name: "deck.pdf", extracted_text: "Slide 1: Acme does payments. ".repeat(50) }] },
    },
  });
  (m.supabase as any).from = vi.fn((t: string) => {
    const b = (makeSupabaseMock({ tables: { [t]: t === "user_settings" ? { data: state.settings } : t === "deals" ? { data: { id: "d1", name: "Acme", stage: "Seed", sector: "Fintech", revenue: "$1.2M ARR" } } : { data: [{ file_name: "deck.pdf", extracted_text: "Slide 1: Acme does payments. ".repeat(50) }] } } }).supabase as any).from(t);
    return b;
  });
  return { supabase: m.supabase };
});
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1" }, session: { access_token: "jwt" } }) }));
vi.mock("@/lib/inference", () => ({
  detectCapabilities: async () => ({ report: gpu, capabilities: capabilitiesFromReport(gpu) }),
  getFallbackChain,
  createEngine: async (type: string) => ({
    type, label: `${type}-engine`, supportsVision: type === "mediapipe",
    load: async (ref: string, onProgress: (p: number, m: string) => void) => {
      onProgress(50, "half");
      if (state.loadOutcomes[type] === "fail") throw new Error(`${type} exploded`);
      state.loaded.push(`${type}:${ref}`);
    },
    unload: async () => {},
    chatStream: async (_t: unknown, cb: { onToken: (s: string) => void; onComplete: () => void }) => { for (const tok of ["lo", "cal ", "answer"]) cb.onToken(tok); cb.onComplete(); },
    generate: async () => ({ text: state.generated, tokenCount: 3, timeMs: 10, ttftMs: 2, tpotMs: 4 }),
  }),
}));
vi.mock("@/lib/modelCache", () => ({
  registerModelCache: vi.fn(), resolveHfToken: async () => null, fetchServerHfToken: async () => null,
  getStoredHfToken: () => null, setStoredHfToken: vi.fn(), modelCacheUsage: async () => ({ bytes: 0, entries: 0 }), clearModelCache: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), message: vi.fn(), success: vi.fn() } }));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocalLlmProvider, useLocalLlm, useAiModelSetting, LOCAL_AI_MODEL, LEGACY_LOCAL_AI_MODEL } from "@/contexts/LocalLlmContext";
import { useDealChat } from "@/hooks/useDealChat";
import { useGenerateMemo } from "@/hooks/useGenerateMemo";
import { buildDealContext } from "@/lib/localContext";
import { LocalModelSection } from "@/components/LocalModelSection";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <LocalLlmProvider>{children}</LocalLlmProvider>
  </QueryClientProvider>
);

beforeEach(() => {
  state.settings = { ai_model: "gpt-5.4", local_model_id: null, memo_prompt: null };
  state.loadOutcomes = {}; state.loaded = [];
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network must not be used on the local path"); }));
});

describe("useAiModelSetting", () => {
  it("routes locally for the new option and maps the legacy Gemma 3n option to its preset", async () => {
    state.settings.ai_model = LOCAL_AI_MODEL; state.settings.local_model_id = "gemma-4-e2b";
    const { result } = renderHook(() => useAiModelSetting(), { wrapper });
    await waitFor(() => expect(result.current.isLocal).toBe(true));
    expect(result.current.localModelId).toBe("gemma-4-e2b");

    state.settings.ai_model = LEGACY_LOCAL_AI_MODEL; state.settings.local_model_id = null;
    const legacy = renderHook(() => useAiModelSetting(), { wrapper });
    await waitFor(() => expect(legacy.result.current.isLocal).toBe(true));
    expect(legacy.result.current.localModelId).toBe("gemma-3n-e2b");
  });
  it("stays on the cloud path for cloud models", async () => {
    const { result } = renderHook(() => useAiModelSetting(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isLocal).toBe(false);
  });
});

describe("LocalLlmProvider load chain", () => {
  it("loads the requested preset on its engine and reports ready", async () => {
    const { result } = renderHook(() => useLocalLlm(), { wrapper });
    await waitFor(() => expect(result.current.capabilities.length).toBe(3));
    await act(() => result.current.loadModel("webllm-gemma-3-1b"));
    expect(result.current.status).toBe("ready");
    expect(result.current.activeEngine).toBe("webllm");
    expect(state.loaded).toEqual(["webllm:gemma3-1b-it-q4f16_1-MLC"]);
  });
  it("falls back across engines with a visible notice, never silently", async () => {
    state.loadOutcomes = { mediapipe: "fail", webllm: "fail" };
    const { result } = renderHook(() => useLocalLlm(), { wrapper });
    await waitFor(() => expect(result.current.capabilities.length).toBe(3));
    await act(() => result.current.loadModel("gemma-3n-e2b"));
    expect(result.current.status).toBe("ready");
    expect(result.current.activeEngine).toBe("onnx");
    expect(result.current.currentPreset?.engine).toBe("onnx");
    expect(toast.error).toHaveBeenCalled();
    expect(toast.message).toHaveBeenCalledWith(expect.stringMatching(/Loaded .* instead/), expect.anything());
  });
  it("surfaces an error state when every engine fails", async () => {
    state.loadOutcomes = { mediapipe: "fail", webllm: "fail", onnx: "fail" };
    const { result } = renderHook(() => useLocalLlm(), { wrapper });
    await waitFor(() => expect(result.current.capabilities.length).toBe(3));
    // act() must resolve for React to flush, so catch inside it.
    let err: Error | null = null;
    await act(async () => { try { await result.current.loadModel("webllm-gemma-3-1b"); } catch (e) { err = e as Error; } });
    expect(err?.message).toMatch(/exploded/);
    expect(result.current.status).toBe("error");
  });
});

describe("local grounding", () => {
  it("builds a system prompt from deal facts and extracted deck text within a budget", async () => {
    const { system, dealName } = await buildDealContext("d1", undefined, 300);
    expect(dealName).toBe("Acme");
    expect(system).toContain("- Revenue: $1.2M ARR");
    expect(system).toContain("=== deck.pdf ===");
    expect(system.length).toBeLessThan(900);
  });
});

describe("local chat + memo paths", () => {
  it("useDealChat streams from the in-browser engine without any network call", async () => {
    state.settings.ai_model = LOCAL_AI_MODEL;
    const { result } = renderHook(() => useDealChat("d1", ["s1"]), { wrapper });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    await act(() => result.current.send("Summarise the deck"));
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe("local answer"));
    expect(fetch).not.toHaveBeenCalled();
    expect(state.loaded[0]).toMatch(/^webllm:/);
  });
  it("useGenerateMemo writes the locally generated memo straight to the deal", async () => {
    state.settings.ai_model = LOCAL_AI_MODEL; state.generated = "# Memo\nAcme is fine.";
    const { result } = renderHook(() => useGenerateMemo(), { wrapper });
    await act(async () => { await result.current.mutateAsync("d1"); });
    const update = (supabase.from as any).mock.results.map((r: any) => r.value).find((b: any) => b.update?.mock.calls.length);
    expect(update.update.mock.calls[0][0].memo_draft).toBe("# Memo\nAcme is fine.");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("LocalModelSection", () => {
  it("shows the device verdict and persists the chosen preset", async () => {
    const onSelect = vi.fn();
    render(<LocalModelSection selectedId={null} onSelect={onSelect} />, { wrapper });
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());
    expect(screen.getAllByText("GPU accelerated").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Gemma 4 E2B"));
    expect(onSelect).toHaveBeenCalledWith("gemma-4-e2b");
    await waitFor(() => {
      const upsert = (supabase.from as any).mock.results.map((r: any) => r.value).find((b: any) => b.upsert?.mock?.calls?.length);
      expect(upsert?.upsert.mock.calls[0][0]).toMatchObject({ user_id: "u1", local_model_id: "gemma-4-e2b" });
    });
  });
});

describe("Settings wiring (source)", () => {
  const src = readFileSync("src/pages/SettingsPage.tsx", "utf8");
  it("the local WebGPU model is a selectable AI model option and no longer disabled", () => {
    expect(src).toMatch(/value: "local-webgpu"[^\n]*disabled: false/);
    expect(src).not.toMatch(/local-florence2[^\n]*disabled: true/);
    expect(src).toContain("<LocalModelSection");
    expect(src).toContain("local_model_id");
  });
  it("the settings migration grants the new column to authenticated users", () => {
    const sql = readFileSync("supabase/migrations/20260912210000_local_model_setting.sql", "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS local_model_id text/);
    expect(sql).toMatch(/GRANT SELECT \(local_model_id\), INSERT \(local_model_id\), UPDATE \(local_model_id\)/);
  });
});
