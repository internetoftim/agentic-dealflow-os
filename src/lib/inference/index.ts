export type * from "./types";
export { detectCapabilities, probeDevice, capabilitiesFromReport, getBestEngine, getFallbackChain } from "./detect";

import type { EngineType, InferenceEngine } from "./types";

/**
 * Engines are loaded lazily: WebLLM and Transformers.js are multi-megabyte
 * bundles that most sessions (cloud models) never need.
 */
export async function createEngine(type: EngineType): Promise<InferenceEngine> {
  switch (type) {
    case "mediapipe": return new (await import("./mediapipe-engine")).MediaPipeEngine();
    case "webllm": return new (await import("./webllm-engine")).WebLLMEngine();
    case "onnx": return new (await import("./onnx-engine")).OnnxEngine();
  }
}
