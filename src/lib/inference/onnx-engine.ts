import type { ChatTurn, GenerationResult, ImageAttachment, InferenceEngine, StreamCallbacks } from "./types";

type Generator = {
  (input: string | ChatTurn[], options: Record<string, unknown>): Promise<Array<{ generated_text: unknown }> | undefined>;
  tokenizer: any;
  dispose?: () => Promise<void> | void;
};

/**
 * Transformers.js: ONNX Runtime on WASM (or WebGPU when present). Slow, but
 * it is the one engine that works on every browser, so the fallback chain
 * always ends here instead of in an error.
 */
export class OnnxEngine implements InferenceEngine {
  readonly type = "onnx" as const;
  readonly label = "Transformers.js (WASM)";
  readonly supportsVision = false;
  private generator: Generator | null = null;
  private TextStreamer: any = null;

  async load(modelRef: string, onProgress: (pct: number, message: string) => void): Promise<void> {
    onProgress(0, "Loading Transformers.js…");
    const tf: any = await import("@huggingface/transformers");
    tf.env.allowLocalModels = false;
    this.TextStreamer = tf.TextStreamer;
    const hasGpu = typeof navigator !== "undefined" && !!(navigator as any).gpu;
    this.generator = (await tf.pipeline("text-generation", modelRef, {
      dtype: "q4",
      device: hasGpu ? "webgpu" : "wasm",
      progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
        if (p.status === "progress" || p.status === "download") onProgress(Math.min(5 + Math.round(p.progress ?? 0) * 0.9, 95), `Downloading ${p.file ?? ""} ${Math.round(p.progress ?? 0)}%`);
        else if (p.status === "ready") onProgress(100, "Model ready");
      },
    })) as Generator;
    onProgress(100, "Model ready");
  }

  async unload(): Promise<void> {
    await this.generator?.dispose?.();
    this.generator = null;
  }

  private run(turns: ChatTurn[], onToken?: (t: string) => void) {
    if (!this.generator) throw new Error("Model not loaded");
    const streamer = new this.TextStreamer(this.generator.tokenizer, {
      skip_prompt: true, skip_special_tokens: true, callback_function: (t: string) => onToken?.(t),
    });
    // Chat-formatted input lets the tokenizer apply the model's own template.
    return this.generator(turns, { max_new_tokens: 512, temperature: 0.4, do_sample: true, streamer });
  }

  async chatStream(turns: ChatTurn[], callbacks: StreamCallbacks, _images?: ImageAttachment[]): Promise<void> {
    await this.run(turns, callbacks.onToken);
    callbacks.onComplete();
  }

  async generate(turns: ChatTurn[]): Promise<GenerationResult> {
    const start = performance.now();
    let first: number | null = null; let tokenCount = 0; let text = "";
    const out = await this.run(turns, (t) => { if (first === null) first = performance.now(); tokenCount++; text += t; });
    if (!text) {
      const gen = out?.[0]?.generated_text;
      text = Array.isArray(gen) ? String((gen as any[]).at(-1)?.content ?? "") : String(gen ?? "");
    }
    const timeMs = performance.now() - start;
    const ttftMs = first === null ? timeMs : first - start;
    return { text: text.trim(), tokenCount: Math.max(tokenCount, 1), timeMs, ttftMs, tpotMs: tokenCount > 1 ? (timeMs - ttftMs) / (tokenCount - 1) : 0 };
  }
}
