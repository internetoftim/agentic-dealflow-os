/**
 * In-browser inference contract. Every engine — MediaPipe (WebGPU, Gemma
 * .task/.litertlm), WebLLM (WebGPU, MLC models), Transformers.js (WASM,
 * works everywhere) — implements this so the provider can swap between them
 * along a fallback chain without the rest of the app knowing which one ran.
 */

export type EngineType = "mediapipe" | "webllm" | "onnx";
export type EngineStatus = "idle" | "loading" | "ready" | "error";

export interface EngineCapability {
  engine: EngineType;
  label: string;
  available: boolean;
  reason?: string;
  /** Lower is preferred. */
  priority: number;
}

/** What the device can do — the "can I AI?" report shown in Settings. */
export interface DeviceReport {
  webgpu: boolean;
  adapter?: string;
  shaderF16?: boolean;
  /** navigator.deviceMemory in GB when exposed (Chromium only). */
  deviceMemoryGB?: number;
  /** Cache API / storage quota in bytes, when the browser reports it. */
  storageQuotaBytes?: number;
  storageUsageBytes?: number;
  hardwareConcurrency?: number;
}

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ImageAttachment {
  /** data: or blob: URL */
  dataUrl: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onComplete: () => void;
}

export interface GenerationResult {
  text: string;
  tokenCount: number;
  timeMs: number;
  /** Time to first token. */
  ttftMs: number;
  /** Mean time per output token after the first. */
  tpotMs: number;
}

export interface LoadOptions {
  hfToken?: string | null;
  vision?: boolean;
}

export interface InferenceEngine {
  readonly type: EngineType;
  readonly label: string;
  /** True once a vision-capable model is loaded. */
  readonly supportsVision: boolean;

  load(modelRef: string, onProgress: (pct: number, message: string) => void, options?: LoadOptions): Promise<void>;
  unload(): Promise<void> | void;

  /** Stream a reply to a conversation. Engines that lack native chat templating serialize turns themselves. */
  chatStream(turns: ChatTurn[], callbacks: StreamCallbacks, images?: ImageAttachment[]): Promise<void>;

  /** One-shot generation with timing, for memos/extraction and self-tests. */
  generate(turns: ChatTurn[], images?: ImageAttachment[]): Promise<GenerationResult>;
}
