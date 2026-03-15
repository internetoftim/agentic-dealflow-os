/**
 * Local vision processing using Gemma 3n E2B via MediaPipe LlmInference (WebGPU).
 * Extracts text from PDF pages by rendering them to images and running multimodal inference.
 */
import { FilesetResolver, LlmInference } from "@mediapipe/tasks-genai";

const MODEL_URL =
  "https://huggingface.co/google/gemma-3n-E2B-it-litert-lm/resolve/main/gemma-3n-E2B-it-int4-Web.litertlm";

let llm: LlmInference | null = null;

export type VisionProgress = {
  stage: "loading-model" | "rendering-pages" | "processing-page" | "done";
  percent: number;
  message: string;
};

/**
 * Load Gemma 3n E2B model with vision support (cached after first load).
 */
export async function loadVisionModel(
  onProgress?: (p: VisionProgress) => void
): Promise<void> {
  if (llm) return;

  if (!(navigator as any).gpu) {
    throw new Error("WebGPU is required for Gemma 3n. Please use Chrome 113+ or Edge 113+.");
  }

  onProgress?.({
    stage: "loading-model",
    percent: 0,
    message: "Initializing WebGPU runtime…",
  });

  const genai = await FilesetResolver.forGenAiTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@latest/wasm"
  );

  onProgress?.({
    stage: "loading-model",
    percent: 5,
    message: "Downloading Gemma 3n E2B (~3.4GB)… This may take a few minutes.",
  });

  llm = await LlmInference.createFromOptions(genai, {
    baseOptions: { modelAssetPath: MODEL_URL },
    maxTokens: 2048,
    topK: 40,
    temperature: 0.2,
    randomSeed: 42,
    maxNumImages: 8, // enable vision support
  });

  onProgress?.({
    stage: "loading-model",
    percent: 100,
    message: "Model loaded!",
  });
}

/**
 * Run Gemma 3n multimodal inference on a canvas/image to extract text.
 */
async function extractTextFromCanvas(
  canvas: HTMLCanvasElement,
  pageNum: number
): Promise<string> {
  if (!llm) throw new Error("Model not loaded. Call loadVisionModel() first.");

  // Create an image blob URL from the canvas
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b!), "image/png")
  );
  const imageUrl = URL.createObjectURL(blob);

  try {
    // Use multimodal prompting: array of text + image
    const response = await llm.generateResponse([
      "<start_of_turn>user\n",
      "Extract ALL text visible in this slide image. Return only the raw text content, preserving the reading order. Include headings, bullet points, numbers, and any text in charts or diagrams. Do not add commentary.\n",
      { imageSource: imageUrl },
      "<end_of_turn>\n<start_of_turn>model\n",
    ]);
    return response?.trim() || "";
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

/**
 * Render PDF pages to images using pdf.js and extract text from each via Gemma 3n.
 */
export async function extractTextFromPdf(
  pdfArrayBuffer: ArrayBuffer,
  onProgress?: (p: VisionProgress) => void
): Promise<{ text: string; pageCount: number }> {
  // Dynamically import pdf.js
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

  const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
  const pageCount = pdf.numPages;

  onProgress?.({
    stage: "rendering-pages",
    percent: 0,
    message: `Processing ${pageCount} pages with Gemma 3n…`,
  });

  // Ensure model is loaded
  await loadVisionModel(onProgress);

  const pageTexts: string[] = [];
  const SCALE = 1.5; // render at 1.5x for good OCR quality

  for (let i = 1; i <= pageCount; i++) {
    onProgress?.({
      stage: "processing-page",
      percent: Math.round((i / pageCount) * 100),
      message: `Extracting text from page ${i}/${pageCount}…`,
    });

    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: SCALE });

    // Render page to canvas
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d")!;

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Run multimodal OCR via Gemma 3n
    const text = await extractTextFromCanvas(canvas, i);
    if (text.trim()) {
      pageTexts.push(`[Page ${i}] ${text}`);
    }

    // Cleanup
    canvas.width = 0;
    canvas.height = 0;
  }

  onProgress?.({
    stage: "done",
    percent: 100,
    message: "Text extraction complete!",
  });

  return {
    text: pageTexts.join("\n\n"),
    pageCount,
  };
}

/**
 * Check if local vision model is available (requires WebGPU).
 */
export function isLocalVisionAvailable(): boolean {
  return !!(navigator as any).gpu;
}

/**
 * Unload the model from memory.
 */
export function unloadVisionModel(): void {
  llm = null;
}
