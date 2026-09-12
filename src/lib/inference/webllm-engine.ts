import type { ChatTurn, GenerationResult, ImageAttachment, InferenceEngine, StreamCallbacks } from "./types";

type MLC = typeof import("@mlc-ai/web-llm");
type Engine = import("@mlc-ai/web-llm").MLCEngineInterface;

/**
 * WebLLM: MLC-compiled models on WebGPU. Weights are fetched from the MLC
 * Hugging Face org (ungated) and cached by the browser; the model runs in a
 * worker when the browser allows it, on the main thread otherwise.
 */
export class WebLLMEngine implements InferenceEngine {
  readonly type = "webllm" as const;
  readonly label = "WebLLM (WebGPU)";
  readonly supportsVision = false;
  private engine: Engine | null = null;
  private worker: Worker | null = null;

  async load(modelId: string, onProgress: (pct: number, message: string) => void): Promise<void> {
    const mlc: MLC = await import("@mlc-ai/web-llm");
    const known = mlc.prebuiltAppConfig.model_list.some((m) => m.model_id === modelId);
    if (!known) throw new Error(`"${modelId}" is not in WebLLM's prebuilt model list`);
    const initProgressCallback = (r: { progress: number; text: string }) =>
      onProgress(Math.round((r.progress ?? 0) * 100), r.text);

    try {
      this.worker = new Worker(new URL("./webllm.worker.ts", import.meta.url), { type: "module" });
      this.engine = await mlc.CreateWebWorkerMLCEngine(this.worker, modelId, { initProgressCallback });
    } catch (e) {
      console.warn("WebLLM worker unavailable, running on the main thread:", e);
      this.worker?.terminate(); this.worker = null;
      this.engine = await mlc.CreateMLCEngine(modelId, { initProgressCallback });
    }
    onProgress(100, "Model ready");
  }

  async unload(): Promise<void> {
    try { await this.engine?.unload(); } catch { /* engine may already be gone */ }
    this.worker?.terminate();
    this.engine = null; this.worker = null;
  }

  private async *stream(turns: ChatTurn[]) {
    if (!this.engine) throw new Error("Model not loaded");
    const chunks = await this.engine.chat.completions.create({ messages: turns, stream: true, temperature: 0.4, max_tokens: 1024 });
    for await (const chunk of chunks) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  async chatStream(turns: ChatTurn[], callbacks: StreamCallbacks, _images?: ImageAttachment[]): Promise<void> {
    for await (const token of this.stream(turns)) callbacks.onToken(token);
    callbacks.onComplete();
  }

  async generate(turns: ChatTurn[]): Promise<GenerationResult> {
    const start = performance.now();
    let first: number | null = null; let text = ""; let tokenCount = 0;
    for await (const token of this.stream(turns)) {
      if (first === null) first = performance.now();
      text += token; tokenCount++;
    }
    const timeMs = performance.now() - start;
    const ttftMs = first === null ? timeMs : first - start;
    return { text, tokenCount, timeMs, ttftMs, tpotMs: tokenCount > 1 ? (timeMs - ttftMs) / (tokenCount - 1) : 0 };
  }
}
