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
  page_count?: number;
  pdf_base64?: string;
  screenshots?: CaptureScreenshot[] | null;
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
    ...(args.gateEmail ? { gate_email: args.gateEmail } : {}),
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

export async function captureSync(args: CaptureSyncArgs): Promise<CaptureSyncResult> {
  const response = await fetch(`${args.baseUrl}/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": args.apiKey,
    },
    body: JSON.stringify(buildCapturePayload(args)),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Capture service error [${response.status}]: ${errorText}`);
  }

  const data = (await response.json()) as CaptureServiceResponse;
  if (!data?.pdf_base64) {
    throw new Error("Capture service returned no PDF data");
  }

  return {
    title: data.title ?? null,
    pageCount: typeof data.page_count === "number" ? data.page_count : 0,
    pdfBase64: data.pdf_base64,
    previewImages: samplePreviewImages(data.screenshots),
  };
}

export async function captureAsync(_args: CaptureSyncArgs): Promise<never> {
  throw new Error("captureAsync is not implemented yet. Use captureSync for the current Cloud Run backend.");
}
