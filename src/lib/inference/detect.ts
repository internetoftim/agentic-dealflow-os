import type { DeviceReport, EngineCapability, EngineType } from "./types";

/**
 * Adapter-level WebGPU probe: `navigator.gpu` existing is not enough — some
 * browsers expose it but return no adapter (blocklisted GPU, headless, remote
 * desktop). Only a real adapter counts.
 */
export async function probeDevice(): Promise<DeviceReport> {
  const nav = typeof navigator !== "undefined" ? (navigator as any) : undefined;
  const report: DeviceReport = { webgpu: false };
  if (!nav) return report;
  report.hardwareConcurrency = nav.hardwareConcurrency;
  if (typeof nav.deviceMemory === "number") report.deviceMemoryGB = nav.deviceMemory;
  try {
    if (nav.storage?.estimate) {
      const est = await nav.storage.estimate();
      report.storageQuotaBytes = est.quota;
      report.storageUsageBytes = est.usage;
    }
  } catch { /* storage estimate is best-effort */ }
  try {
    const adapter = nav.gpu ? await nav.gpu.requestAdapter() : null;
    if (adapter) {
      report.webgpu = true;
      report.shaderF16 = !!adapter.features?.has?.("shader-f16");
      const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo().catch(() => null) : null);
      const name = [info?.vendor, info?.architecture, info?.device, info?.description].filter(Boolean).join(" · ");
      if (name) report.adapter = name;
    }
  } catch { report.webgpu = false; }
  return report;
}

export function capabilitiesFromReport(report: DeviceReport): EngineCapability[] {
  const noGpu = "WebGPU is not available in this browser (Chrome/Edge 113+, Safari 18+, Firefox 141+)";
  return [
    { engine: "mediapipe", label: "MediaPipe (WebGPU)", available: report.webgpu, reason: report.webgpu ? undefined : noGpu, priority: 1 },
    { engine: "webllm", label: "WebLLM (WebGPU)", available: report.webgpu, reason: report.webgpu ? undefined : noGpu, priority: 2 },
    { engine: "onnx", label: "Transformers.js (WASM)", available: true, priority: 3 },
  ];
}

export async function detectCapabilities(): Promise<{ report: DeviceReport; capabilities: EngineCapability[] }> {
  const report = await probeDevice();
  return { report, capabilities: capabilitiesFromReport(report) };
}

export function getBestEngine(caps: EngineCapability[]): EngineType {
  return [...caps].filter((c) => c.available).sort((a, b) => a.priority - b.priority)[0]?.engine ?? "onnx";
}

/**
 * Load-attempt order: the preferred engine, then every other available engine
 * by priority. WASM is always last so the chain never dead-ends — even if
 * detection itself failed and `caps` is empty.
 */
export function getFallbackChain(caps: EngineCapability[], preferred: EngineType): EngineType[] {
  const ordered = [...caps].filter((c) => c.available).sort((a, b) => a.priority - b.priority).map((c) => c.engine);
  const chain: EngineType[] = [preferred, ...ordered.filter((e) => e !== preferred)];
  if (!chain.includes("onnx")) chain.push("onnx");
  return chain;
}
