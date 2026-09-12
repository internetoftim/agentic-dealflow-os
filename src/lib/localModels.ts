import type { DeviceReport, EngineCapability, EngineType } from "@/lib/inference/types";

export interface LocalModelPreset {
  id: string;
  name: string;
  engine: EngineType;
  /** WebLLM model id, or a download URL for MediaPipe / a HF repo for Transformers.js. */
  ref: string;
  sizeLabel: string;
  sizeBytes: number;
  /** Rough GPU memory needed to run comfortably. */
  vramMB: number;
  description: string;
  /** Hugging Face gated download — needs a token with access to the Gemma license. */
  gated: boolean;
  vision?: boolean;
  recommended?: boolean;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/**
 * Engine-specific presets: a MediaPipe .task cannot be fed to WebLLM and vice
 * versa, so a cross-engine fallback always swaps to that engine's own model.
 * Gemma 4 and Gemma 3 4B exist in-browser only as MediaPipe LiteRT builds.
 */
export const LOCAL_MODELS: LocalModelPreset[] = [
  // ---- MediaPipe (WebGPU) — Gemma family from Google's LiteRT community builds
  { id: "gemma-4-e2b", name: "Gemma 4 E2B", engine: "mediapipe", ref: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task",
    sizeLabel: "~2.0 GB", sizeBytes: 2.0 * GB, vramMB: 3500, gated: true, vision: true, recommended: true,
    description: "Newest Gemma. Multimodal (reads slides), 128K context, strong reasoning for its size." },
  { id: "gemma-4-e4b", name: "Gemma 4 E4B", engine: "mediapipe", ref: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.task",
    sizeLabel: "~3.0 GB", sizeBytes: 3.0 * GB, vramMB: 5000, gated: true, vision: true,
    description: "Larger Gemma 4. Best quality here; needs a capable GPU." },
  { id: "gemma-3n-e2b", name: "Gemma 3n E2B", engine: "mediapipe", ref: "https://huggingface.co/google/gemma-3n-E2B-it-litert-lm/resolve/main/gemma-3n-E2B-it-int4-Web.litertlm",
    sizeLabel: "~3.0 GB", sizeBytes: 3.0 * GB, vramMB: 4500, gated: true, vision: true,
    description: "Multimodal Gemma 3n. Reads deck pages directly; streams to GPU." },
  { id: "gemma-3-4b", name: "Gemma 3 4B", engine: "mediapipe", ref: "https://huggingface.co/litert-community/Gemma3-4B-IT/resolve/main/gemma3-4b-it-int4-web.task",
    sizeLabel: "~2.3 GB", sizeBytes: 2.3 * GB, vramMB: 4000, gated: true,
    description: "Text-only Gemma 3, strongest of the 3-series in the browser." },
  { id: "gemma-3-1b-mp", name: "Gemma 3 1B", engine: "mediapipe", ref: "https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-q4_0-web.task",
    sizeLabel: "~555 MB", sizeBytes: 555 * MB, vramMB: 1500, gated: true,
    description: "Quick to load, good everyday quality." },
  { id: "gemma-3-270m", name: "Gemma 3 270M", engine: "mediapipe", ref: "https://huggingface.co/litert-community/gemma-3-270m-it/resolve/main/gemma3-270m-it-q4_0-web.task",
    sizeLabel: "~200 MB", sizeBytes: 200 * MB, vramMB: 800, gated: true,
    description: "Tiny. Loads in seconds; fine for quick questions." },

  // ---- WebLLM (WebGPU) — MLC builds, no Hugging Face login needed
  { id: "webllm-gemma-3-1b", name: "Gemma 3 1B (MLC)", engine: "webllm", ref: "gemma3-1b-it-q4f16_1-MLC",
    sizeLabel: "~1.0 GB", sizeBytes: 1.0 * GB, vramMB: 1800, gated: false, recommended: true,
    description: "Gemma 3 without a Hugging Face account. Same weights, MLC runtime." },
  { id: "webllm-llama-3.2-1b", name: "Llama 3.2 1B", engine: "webllm", ref: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    sizeLabel: "~700 MB", sizeBytes: 700 * MB, vramMB: 1500, gated: false,
    description: "Compact and fast; good fallback when Gemma isn't cached yet." },
  { id: "webllm-phi-3.5-mini", name: "Phi 3.5 Mini", engine: "webllm", ref: "Phi-3.5-mini-instruct-q4f16_1-MLC",
    sizeLabel: "~2.2 GB", sizeBytes: 2.2 * GB, vramMB: 3800, gated: false,
    description: "Strong reasoning for its size; heavier download." },
  { id: "webllm-smollm2-360m", name: "SmolLM2 360M", engine: "webllm", ref: "SmolLM2-360M-Instruct-q4f16_1-MLC",
    sizeLabel: "~250 MB", sizeBytes: 250 * MB, vramMB: 700, gated: false,
    description: "Smallest GPU model; use to check the pipeline works on a device." },

  // ---- Transformers.js (WASM) — works without WebGPU, including iOS
  { id: "onnx-smollm2-135m", name: "SmolLM2 135M (WASM)", engine: "onnx", ref: "HuggingFaceTB/SmolLM2-135M-Instruct",
    sizeLabel: "~100 MB", sizeBytes: 100 * MB, vramMB: 0, gated: false,
    description: "Runs anywhere, slowly. The last-resort engine." },
];

export const DEFAULT_LOCAL_MODEL_ID = "webllm-gemma-3-1b";

export const getPreset = (id: string | null | undefined) => LOCAL_MODELS.find((m) => m.id === id) ?? null;
export const modelsForEngine = (engine: EngineType) => LOCAL_MODELS.filter((m) => m.engine === engine);
/** Smallest ungated model for an engine — what cross-engine fallback swaps to. */
export const fallbackModelFor = (engine: EngineType) =>
  [...modelsForEngine(engine)].filter((m) => !m.gated).sort((a, b) => a.sizeBytes - b.sizeBytes)[0] ?? null;

export type RunVerdict = { ok: boolean; level: "good" | "tight" | "no"; reason: string };

/** The caniaitest-style verdict: can this device realistically run this preset? */
export function canRun(preset: LocalModelPreset, caps: EngineCapability[], report: DeviceReport): RunVerdict {
  const cap = caps.find((c) => c.engine === preset.engine);
  if (!cap?.available) return { ok: false, level: "no", reason: cap?.reason ?? "Engine unavailable" };
  if (report.storageQuotaBytes && report.storageQuotaBytes - (report.storageUsageBytes ?? 0) < preset.sizeBytes * 1.2) {
    return { ok: false, level: "no", reason: "Not enough browser storage to cache the model" };
  }
  if (preset.engine !== "onnx" && report.deviceMemoryGB && report.deviceMemoryGB * 1024 < preset.vramMB * 1.5) {
    return { ok: true, level: "tight", reason: `Needs ~${(preset.vramMB / 1024).toFixed(1)} GB of GPU memory; this device reports ${report.deviceMemoryGB} GB RAM` };
  }
  return { ok: true, level: "good", reason: preset.engine === "onnx" ? "CPU (WASM) — slow but works" : "GPU accelerated" };
}
