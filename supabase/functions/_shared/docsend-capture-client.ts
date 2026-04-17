interface CaptureSyncArgs {
  apiKey: string;
  baseUrl: string;
  gateEmail?: string | null;
  maxPages?: number;
  url: string;
}

type CaptureScreenshot = {
  data_url?: string | null;
  page?: number | null;
};

type CaptureServiceResponse = {
  data?: CaptureServiceResponse;
  page_count?: number;
  pageCount?: number;
  pdf_base64?: string;
  pdfBase64?: string;
  screenshots?: CaptureScreenshot[] | null;
  preview_images?: string[] | null;
  previewImages?: string[] | null;
  title?: string | null;
};

const PREVIEW_IMAGE_LIMIT = 6;

export interface CaptureSyncResult {
  pageCount: number;
  pdfBase64: string;
  previewImages: string[];
  title: string | null;
}

function buildCapturePayload(args: CaptureSyncArgs) {
  return {
    url: args.url,
    max_pages: args.maxPages ?? 50,
    maxPages: args.maxPages ?? 50,
    ...(args.gateEmail ? { gate_email: args.gateEmail } : {}),
    ...(args.gateEmail ? { gateEmail: args.gateEmail } : {}),
  };
}

function samplePreviewImages(
  screenshots: CaptureScreenshot[] | null | undefined,
  maxImages: number = PREVIEW_IMAGE_LIMIT,
): string[] {
  const validImages = (screenshots ?? [])
    .map((shot) => shot?.data_url)
    .filter((url): url is string => typeof url === "string" && url.startsWith("data:image/"));

  if (validImages.length <= maxImages) {
    return validImages;
  }

  const sampled: string[] = [];
  const usedIndexes = new Set<number>();

  for (let i = 0; i < maxImages; i += 1) {
    const index = Math.min(
      validImages.length - 1,
      Math.round((i * (validImages.length - 1)) / Math.max(1, maxImages - 1)),
    );

    if (!usedIndexes.has(index)) {
      sampled.push(validImages[index]);
      usedIndexes.add(index);
    }
  }

  return sampled;
}

function unwrapCaptureResponse(raw: CaptureServiceResponse): CaptureServiceResponse {
  if (raw && typeof raw === "object" && raw.data && typeof raw.data === "object") {
    return raw.data;
  }
  return raw;
}

function getPageCount(data: CaptureServiceResponse): number {
  if (typeof data.page_count === "number") return data.page_count;
  if (typeof data.pageCount === "number") return data.pageCount;
  return 0;
}

function getPdfBase64(data: CaptureServiceResponse): string | null {
  if (typeof data.pdf_base64 === "string" && data.pdf_base64.length > 0) return data.pdf_base64;
  if (typeof data.pdfBase64 === "string" && data.pdfBase64.length > 0) return data.pdfBase64;
  return null;
}

function getPreviewImages(data: CaptureServiceResponse): string[] {
  if (Array.isArray(data.preview_images)) {
    return data.preview_images.filter((url): url is string => typeof url === "string" && url.startsWith("data:image/"));
  }

  if (Array.isArray(data.previewImages)) {
    return data.previewImages.filter((url): url is string => typeof url === "string" && url.startsWith("data:image/"));
  }

  return samplePreviewImages(data.screenshots);
}

export async function captureSync(args: CaptureSyncArgs): Promise<CaptureSyncResult> {
  const normalizedBaseUrl = args.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${normalizedBaseUrl}/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": args.apiKey,
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify(buildCapturePayload(args)),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Capture service error [${response.status}]: ${errorText}`);
  }

  const raw = (await response.json()) as CaptureServiceResponse;
  const data = unwrapCaptureResponse(raw);
  const pdfBase64 = getPdfBase64(data);

  if (!pdfBase64) {
    throw new Error("Capture service returned no PDF data");
  }

  return {
    title: data.title ?? null,
    pageCount: getPageCount(data),
    pdfBase64,
    previewImages: getPreviewImages(data),
  };
}

export async function captureAsync(_args: CaptureSyncArgs): Promise<never> {
  throw new Error("captureAsync is not implemented yet. Use captureSync for the current Cloud Run backend.");
}
