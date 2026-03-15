/**
 * Local vision processing using Florence-2 (Transformers.js) + pdf.js
 * Extracts text from PDF pages by rendering them to images and running OCR/captioning.
 */
import {
  Florence2ForConditionalGeneration,
  AutoProcessor,
  AutoTokenizer,
  RawImage,
  type PreTrainedModel,
  type Processor,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";

const MODEL_ID = "onnx-community/Florence-2-base-ft";

let model: PreTrainedModel | null = null;
let processor: Processor | null = null;
let tokenizer: PreTrainedTokenizer | null = null;

export type VisionProgress = {
  stage: "loading-model" | "rendering-pages" | "processing-page" | "done";
  percent: number;
  message: string;
};

/**
 * Load Florence-2 model (cached after first load).
 */
export async function loadVisionModel(
  onProgress?: (p: VisionProgress) => void
): Promise<void> {
  if (model && processor && tokenizer) return;

  onProgress?.({
    stage: "loading-model",
    percent: 0,
    message: "Downloading Florence-2 model (~500MB)…",
  });

  const [m, p, t] = await Promise.all([
    Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
      dtype: "fp32",
      progress_callback: (progress: any) => {
        if (progress.status === "progress" && progress.progress) {
          onProgress?.({
            stage: "loading-model",
            percent: Math.round(progress.progress),
            message: `Downloading model: ${Math.round(progress.progress)}%`,
          });
        }
      },
    }),
    AutoProcessor.from_pretrained(MODEL_ID),
    AutoTokenizer.from_pretrained(MODEL_ID),
  ]);

  model = m;
  processor = p;
  tokenizer = t;

  onProgress?.({
    stage: "loading-model",
    percent: 100,
    message: "Model loaded!",
  });
}

/**
 * Run Florence-2 OCR on a single image (RawImage).
 */
async function extractTextFromImage(image: RawImage): Promise<string> {
  if (!model || !processor || !tokenizer) {
    throw new Error("Model not loaded. Call loadVisionModel() first.");
  }

  // Use <OCR> task for text extraction
  const task = "<OCR>";
  const prompts = processor(image, task);
  const textInputs = tokenizer(task);

  const generated = await (model as any).generate({
    ...textInputs,
    ...prompts,
    max_new_tokens: 1024,
  });

  const decoded = tokenizer.batch_decode(generated, { skip_special_tokens: true });
  return decoded[0]?.replace(task, "").trim() || "";
}

/**
 * Render PDF pages to images using pdf.js and extract text from each via Florence-2.
 */
export async function extractTextFromPdf(
  pdfArrayBuffer: ArrayBuffer,
  onProgress?: (p: VisionProgress) => void
): Promise<{ text: string; pageCount: number }> {
  // Dynamically import pdf.js to avoid SSR issues
  const pdfjsLib = await import("pdfjs-dist");

  // Set worker source
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

  const pdf = await pdfjsLib.getDocument({ data: pdfArrayBuffer }).promise;
  const pageCount = pdf.numPages;

  onProgress?.({
    stage: "rendering-pages",
    percent: 0,
    message: `Processing ${pageCount} pages…`,
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

    // Convert canvas to RawImage
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rawImage = new RawImage(
      new Uint8ClampedArray(imageData.data),
      canvas.width,
      canvas.height,
      4 // RGBA channels
    );

    // Run OCR
    const text = await extractTextFromImage(rawImage);
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
 * Check if local vision model is available (WebGPU or WASM).
 */
export function isLocalVisionAvailable(): boolean {
  return true; // Transformers.js falls back to WASM if no WebGPU
}

/**
 * Unload the model from memory.
 */
export function unloadVisionModel(): void {
  model = null;
  processor = null;
  tokenizer = null;
}
