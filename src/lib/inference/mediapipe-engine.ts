import type { ChatTurn, GenerationResult, ImageAttachment, InferenceEngine, LoadOptions, StreamCallbacks } from "./types";
import { sendHfTokenToServiceWorker } from "@/lib/modelCache";

const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.26/wasm";
/** Above this the model is streamed straight to the GPU by MediaPipe (no buffer in JS memory). */
const BUFFER_LIMIT_BYTES = 1.5 * 1024 ** 3;

const fmt = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

/**
 * MediaPipe LlmInference on WebGPU — the only way to run Gemma 3n / Gemma 4
 * (multimodal) in a browser today. Gemma weights on Hugging Face are gated:
 * small .task files are downloaded here with the token; large or .litertlm
 * files are streamed by MediaPipe, with the token injected by the model-cache
 * service worker.
 */
export class MediaPipeEngine implements InferenceEngine {
  readonly type = "mediapipe" as const;
  readonly label = "MediaPipe (WebGPU)";
  supportsVision = false;
  private llm: any = null;
  private busy: Promise<unknown> = Promise.resolve();

  async load(modelUrl: string, onProgress: (pct: number, message: string) => void, options: LoadOptions = {}): Promise<void> {
    if (!(navigator as any).gpu) throw new Error("WebGPU is required for MediaPipe models");
    onProgress(0, "Initializing WebGPU runtime…");
    const { FilesetResolver, LlmInference } = await import("@mediapipe/tasks-genai");
    const genai = await FilesetResolver.forGenAiTasks(WASM_CDN);
    const token = options.hfToken ?? null;
    const isHf = /huggingface\.co|hf\.co/.test(modelUrl);
    const headers: Record<string, string> = token && isHf ? { Authorization: `Bearer ${token}` } : {};

    // Size probe doubles as the access check: a 401/403 here means the token is missing or lacks the Gemma license.
    let size = 0;
    const head = await fetch(modelUrl, { method: "HEAD", headers, redirect: "follow" }).catch(() => null);
    if (head && !head.ok) {
      if (head.status === 401 || head.status === 403) {
        throw new Error("This model is gated on Hugging Face. Add a Hugging Face token that has accepted the Gemma license.");
      }
      throw new Error(`Model download failed (${head.status})`);
    }
    size = Number(head?.headers.get("content-length") ?? 0);
    const vision = !!options.vision;
    const genOptions = { maxTokens: 2048, topK: 40, temperature: 0.4, randomSeed: 7, ...(vision ? { maxNumImages: 6 } : {}) };

    if (modelUrl.toLowerCase().endsWith(".litertlm") || size === 0 || size > BUFFER_LIMIT_BYTES) {
      // Streaming path: MediaPipe fetches the URL itself; the service worker adds auth + caching.
      await sendHfTokenToServiceWorker(token);
      onProgress(10, size ? `Streaming ${fmt(size)} model to the GPU (no byte progress available)…` : "Streaming model to the GPU…");
      this.llm = await LlmInference.createFromOptions(genai, { baseOptions: { modelAssetPath: modelUrl }, ...genOptions });
    } else {
      const buffer = await downloadWithProgress(modelUrl, headers, size, onProgress);
      onProgress(98, "Initializing model…");
      this.llm = await LlmInference.createFromOptions(genai, { baseOptions: { modelAssetBuffer: buffer }, ...genOptions });
    }
    this.supportsVision = vision;
    onProgress(100, "Model ready");
  }

  unload(): void {
    try { this.llm?.close?.(); } catch { /* already closed */ }
    this.llm = null;
    this.supportsVision = false;
  }

  /** Gemma's chat template; images are inserted before the last user message. */
  private buildInput(turns: ChatTurn[], images?: ImageAttachment[]): Array<string | { imageSource: string }> {
    const system = turns.filter((t) => t.role === "system").map((t) => t.content).join("\n\n");
    const dialogue = turns.filter((t) => t.role !== "system");
    const parts: Array<string | { imageSource: string }> = [];
    dialogue.forEach((t, i) => {
      const role = t.role === "assistant" ? "model" : "user";
      const isLastUser = t.role === "user" && i === dialogue.length - 1;
      parts.push(`<start_of_turn>${role}\n`);
      if (i === 0 && system) parts.push(`${system}\n\n`);
      if (isLastUser && images?.length && this.supportsVision) for (const img of images) parts.push({ imageSource: img.dataUrl });
      parts.push(`${t.content}<end_of_turn>\n`);
    });
    parts.push("<start_of_turn>model\n");
    return parts;
  }

  /** MediaPipe rejects overlapping generateResponse calls; serialize them. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }

  async chatStream(turns: ChatTurn[], callbacks: StreamCallbacks, images?: ImageAttachment[]): Promise<void> {
    if (!this.llm) throw new Error("Model not loaded");
    const input = this.buildInput(turns, images);
    await this.exclusive(() => new Promise<void>((resolve, reject) => {
      try {
        this.llm.generateResponse(input, (partial: string, done: boolean) => {
          if (partial) callbacks.onToken(partial);
          if (done) { callbacks.onComplete(); resolve(); }
        });
      } catch (e) { reject(e); }
    }));
  }

  async generate(turns: ChatTurn[], images?: ImageAttachment[]): Promise<GenerationResult> {
    const start = performance.now();
    let first: number | null = null; let text = ""; let tokenCount = 0;
    await this.chatStream(turns, {
      onToken: (t) => { if (first === null) first = performance.now(); text += t; tokenCount++; },
      onComplete: () => {},
    }, images);
    const timeMs = performance.now() - start;
    const ttftMs = first === null ? timeMs : first - start;
    return { text: text.trim(), tokenCount, timeMs, ttftMs, tpotMs: tokenCount > 1 ? (timeMs - ttftMs) / (tokenCount - 1) : 0 };
  }
}

async function downloadWithProgress(url: string, headers: Record<string, string>, total: number, onProgress: (pct: number, message: string) => void): Promise<Uint8Array> {
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); received += value.length;
    const pct = total ? Math.min(97, Math.round((received / total) * 97)) : 50;
    onProgress(pct, `Downloading ${fmt(received)}${total ? ` / ${fmt(total)}` : ""}`);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}
