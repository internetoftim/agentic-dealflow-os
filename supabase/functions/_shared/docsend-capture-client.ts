interface CaptureSyncArgs {
  apiKey: string;
  baseUrl: string;
  gateEmail?: string | null;
  maxPages?: number;
  url: string;
}

export interface CaptureSyncResult {
  pageCount: number;
  pdfBase64: string;
  title: string | null;
}

function buildCapturePayload(args: CaptureSyncArgs) {
  return {
    url: args.url,
    max_pages: args.maxPages ?? 50,
    ...(args.gateEmail ? { gate_email: args.gateEmail } : {}),
  };
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

  const data = await response.json();
  if (!data?.pdf_base64) {
    throw new Error("Capture service returned no PDF data");
  }

  return {
    title: data.title ?? null,
    pageCount: typeof data.page_count === "number" ? data.page_count : 0,
    pdfBase64: data.pdf_base64,
  };
}

export async function captureAsync(_args: CaptureSyncArgs): Promise<never> {
  throw new Error("captureAsync is not implemented yet. Use captureSync for the current Cloud Run backend.");
}
