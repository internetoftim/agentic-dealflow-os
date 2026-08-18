import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { BlobReader, ZipReader, TextWriter } from "https://esm.sh/@zip.js/zip.js@2.7.34";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1?bundle-deps";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const CAPTURED_VIEWER_SOURCES = new Set(["docsend", "pandadoc", "papermark"]);

/** Extract plain text from all slides in a PPTX file (which is a ZIP of XML). */
async function extractPptxText(arrayBuffer: ArrayBuffer): Promise<{ text: string; pageCount: number }> {
  const zipReader = new ZipReader(new BlobReader(new Blob([arrayBuffer])));
  const entries = await zipReader.getEntries();
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.filename))
    .sort((a, b) => {
      const numA = parseInt(a.filename.match(/slide(\d+)/i)?.[1] ?? "0");
      const numB = parseInt(b.filename.match(/slide(\d+)/i)?.[1] ?? "0");
      return numA - numB;
    });

  const slideTexts: string[] = [];
  for (const entry of slideEntries) {
    const writer = new TextWriter();
    const xml = await entry.getData!(writer);
    const text = xml
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/\s+/g, " ").trim();
    if (text) {
      const slideNum = entry.filename.match(/slide(\d+)/i)?.[1] ?? "?";
      slideTexts.push(`[Slide ${slideNum}] ${text}`);
    }
  }
  await zipReader.close();
  return { text: slideTexts.join("\n\n"), pageCount: slideEntries.length };
}

/** Very basic PDF text extraction. */
function extractPdfText(arrayBuffer: ArrayBuffer): { text: string; pageCount: number } {
  const bytes = new Uint8Array(arrayBuffer);
  const raw = new TextDecoder("latin1").decode(bytes);
  const pageCount = (raw.match(/\/Type\s*\/Page(?!\s*s)/g) || []).length;

  const textChunks: string[] = [];
  const btPattern = /BT\s([\s\S]*?)ET/g;
  let match;
  while ((match = btPattern.exec(raw)) !== null) {
    const block = match[1];
    const tjPattern = /\(([^)]*)\)\s*Tj/g;
    let tj;
    while ((tj = tjPattern.exec(block)) !== null) {
      const text = tj[1].replace(/\\n/g, "\n").replace(/\\\(/g, "(").replace(/\\\)/g, ")");
      if (text.trim()) textChunks.push(text.trim());
    }
    const tjArrayPattern = /\[([^\]]*)\]\s*TJ/g;
    let tja;
    while ((tja = tjArrayPattern.exec(block)) !== null) {
      const inner = tja[1];
      const strPattern = /\(([^)]*)\)/g;
      let s;
      while ((s = strPattern.exec(inner)) !== null) {
        const text = s[1].replace(/\\n/g, "\n").replace(/\\\(/g, "(").replace(/\\\)/g, ")");
        if (text.trim()) textChunks.push(text.trim());
      }
    }
  }
  return { text: textChunks.join(" ").replace(/\s+/g, " ").trim(), pageCount };
}

function isCapturedViewerSource(sourceType?: string | null): boolean {
  return CAPTURED_VIEWER_SOURCES.has((sourceType ?? "").toLowerCase());
}

/** Sanitize a company name: remove slashes, colons, emojis, and other illegal filename chars. */
function sanitizeCompanyName(name: string): string {
  return name
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{200D}\u{20E3}]/gu, "") // emojis
    .replace(/[\/\\:*?"<>|]/g, "") // filesystem-illegal chars
    .replace(/\s+/g, " ")
    .trim();
}

/** Helper to update deal status */
async function setDealStatus(adminClient: any, dealId: string, status: string) {
  await adminClient
    .from("deals")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", dealId);
}

/** Check if the deal has been cancelled/aborted by the user. If so, exit. */
async function checkAborted(adminClient: any, dealId: string, currentStep: string): Promise<boolean> {
  const { data } = await adminClient
    .from("deals")
    .select("status")
    .eq("id", dealId)
    .single();
  if (data?.status === "cancelled") {
    console.log(`Deal ${dealId} was cancelled at step: ${currentStep}`);
    return true;
  }
  return false;
}

/** After a job finishes or is cancelled, check if there's a queued deal for this user and start it. */
async function processNextQueued(adminClient: any, userId: string, supabaseUrl: string, supabaseServiceKey: string) {
  const { data: queued } = await adminClient
    .from("deals")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);
  
  if (queued && queued.length > 0) {
    const nextDeal = queued[0];
    // Get the source to find storage path
    const { data: sources } = await adminClient
      .from("sources")
      .select("storage_path, source_type")
      .eq("deal_id", nextDeal.id)
      .order("created_at", { ascending: false })
      .limit(1);
    const nextSource = sources?.[0];
    const storagePath = nextSource?.storage_path;
    if (!storagePath) return;
    const skipCompression = isCapturedViewerSource(nextSource?.source_type);

    // Update status from queued to uploading
    await adminClient.from("deals").update({ status: "uploading", updated_at: new Date().toISOString() }).eq("id", nextDeal.id);

    // Fire process-deck for the queued deal
    try {
      await fetch(`${supabaseUrl}/functions/v1/process-deck`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseServiceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dealId: nextDeal.id,
          storagePath,
          ...(skipCompression ? { skipCompression: true } : {}),
        }),
      });
      console.log(`Started queued deal: ${nextDeal.id}`);
    } catch (e) {
      console.warn("Failed to start queued deal:", e);
    }
  }
}

/** Extract text from a Google Slides presentation via the Slides API. */
function extractTextFromSlidesApi(presentation: any): string {
  const slides = presentation.slides || [];
  const slideTexts: string[] = [];

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const texts: string[] = [];

    const extractFromElements = (elements: any[]) => {
      for (const el of elements || []) {
        // Text from shapes
        if (el.shape?.text?.textElements) {
          for (const te of el.shape.text.textElements) {
            if (te.textRun?.content) {
              const t = te.textRun.content.trim();
              if (t) texts.push(t);
            }
          }
        }
        // Text from tables
        if (el.table) {
          for (const row of el.table.tableRows || []) {
            for (const cell of row.tableCells || []) {
              if (cell.text?.textElements) {
                for (const te of cell.text.textElements) {
                  if (te.textRun?.content) {
                    const t = te.textRun.content.trim();
                    if (t) texts.push(t);
                  }
                }
              }
            }
          }
        }
        // Recurse into groups
        if (el.elementGroup?.children) {
          extractFromElements(el.elementGroup.children);
        }
      }
    };

    extractFromElements(slide.pageElements);
    if (texts.length > 0) {
      slideTexts.push(`[Slide ${i + 1}] ${texts.join(" ")}`);
    }
  }

  return slideTexts.join("\n\n");
}

/**
 * Convert PPTX to PDF using Google Drive API.
 * Upload as Google Slides (with convert), then export as PDF.
 * Also extracts text via the Google Slides API for accurate content extraction.
 */
async function convertPptxToPdfViaDrive(
  pptxBytes: ArrayBuffer,
  googleToken: string,
  fileName: string
): Promise<{ pdfBytes: Uint8Array; slidesText: string }> {
  // 1. Upload PPTX to Google Drive, converting to Google Slides
  const metadata = {
    name: `_temp_convert_${fileName}`,
    mimeType: "application/vnd.google-apps.presentation",
  };

  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" })
  );
  form.append(
    "file",
    new Blob([pptxBytes], {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    })
  );

  const uploadRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${googleToken}` },
      body: form,
    }
  );

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Drive upload for conversion failed [${uploadRes.status}]: ${errText}`);
  }

  const driveFile = await uploadRes.json();
  const tempFileId = driveFile.id;

  try {
    // 2. Export the Google Slides file as PDF
    const exportRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${tempFileId}/export?mimeType=application/pdf`,
      {
        headers: { Authorization: `Bearer ${googleToken}` },
      }
    );

    if (!exportRes.ok) {
      const errText = await exportRes.text();
      throw new Error(`Drive PDF export failed [${exportRes.status}]: ${errText}`);
    }

    const pdfBuffer = await exportRes.arrayBuffer();

    // 3. Extract text via Google Slides API (much more accurate than PDF text extraction)
    let slidesText = "";
    try {
      const presRes = await fetch(
        `https://slides.googleapis.com/v1/presentations/${tempFileId}`,
        { headers: { Authorization: `Bearer ${googleToken}` } }
      );

      if (presRes.ok) {
        const presentation = await presRes.json();
        slidesText = extractTextFromSlidesApi(presentation);
        console.log(`Extracted ${slidesText.length} chars from ${(presentation.slides || []).length} slides via Slides API`);
      } else {
        console.warn(`Slides API returned ${presRes.status}`);
      }
    } catch (e) {
      console.warn("Slides API text extraction failed (non-fatal):", e);
    }

    return { pdfBytes: new Uint8Array(pdfBuffer), slidesText };
  } finally {
    // 4. Delete the temp Google Slides file
    await fetch(`https://www.googleapis.com/drive/v3/files/${tempFileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${googleToken}` },
    }).catch((e) => console.warn("Failed to delete temp Drive file:", e));
  }
}

/**
 * Compress a PDF to target size using pdf-lib.
 * Re-serializes with object streams. If still over target, removes metadata/annotations.
 */
async function compressPdfToTarget(
  pdfBytes: Uint8Array,
  targetSizeBytes: number = 10 * 1024 * 1024
): Promise<{ compressed: Uint8Array; pages: number }> {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPageCount();

  // Strip metadata to reduce size
  pdfDoc.setTitle("");
  pdfDoc.setAuthor("");
  pdfDoc.setSubject("");
  pdfDoc.setKeywords([]);
  pdfDoc.setProducer("");
  pdfDoc.setCreator("");

  const compressed = await pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });

  const result = new Uint8Array(compressed);
  const sizeMB = (result.length / (1024 * 1024)).toFixed(1);

  if (result.length > targetSizeBytes) {
    console.warn(`PDF is ${sizeMB}MB after compression (target: ${(targetSizeBytes / (1024 * 1024)).toFixed(0)}MB)`);
  } else {
    console.log(`PDF compressed to ${sizeMB}MB`);
  }

  return { compressed: result, pages };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Populated once the job's identity is resolved, so the catch block can
  // mark the deal as failed and release the per-user queue lock.
  let failCtx: {
    // deno-lint-ignore no-explicit-any -- matches helper signatures in this file
    adminClient: any;
    dealId: string;
    userId: string;
    supabaseUrl: string;
    supabaseServiceKey: string;
  } | null = null;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
    const sapinsapinApiKey = Deno.env.get("APOLLO_API_KEY");
    const firecrawlApiKey = Deno.env.get("FIRECRAWL_API_KEY");

    const SAPINSAPIN_BASE = "https://apollo-inference-bridge.am1-aks.apolloglobal.net";
    const OPENAI_BASE = "https://api.openai.com";

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Support two auth modes:
    // 1. User JWT (from frontend) — resolves user via getUser()
    // 2. Service-role key (from gmail-listener cron) — userId passed in request body
    let userId: string;
    const isServiceRole = authHeader === `Bearer ${supabaseServiceKey}`;

    if (isServiceRole) {
      // Service-role call: userId must be in the request body (set below after parsing)
      userId = ""; // will be set after body parse
    } else {
      const userClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: userError } = await userClient.auth.getUser();
      if (userError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = user.id;
    }

    const body = await req.json();
    const { dealId, storagePath, resumeFrom, localExtracted, skipCompression } = body;
    if (!dealId || !storagePath) {
      return new Response(JSON.stringify({ error: "Missing dealId or storagePath" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // For service-role calls, resolve userId from the deal record
    if (isServiceRole) {
      const { data: dealRecord } = await adminClient.from("deals").select("user_id").eq("id", dealId).single();
      if (!dealRecord) {
        return new Response(JSON.stringify({ error: "Deal not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = dealRecord.user_id;
    }

    failCtx = { adminClient, dealId, userId, supabaseUrl, supabaseServiceKey };

    // When resuming, clear the paused_at_step
    if (resumeFrom) {
      await adminClient.from("deals").update({ paused_at_step: null, status: resumeFrom, updated_at: new Date().toISOString() }).eq("id", dealId);
    }

    // Determine which steps to skip when resuming
    const stepOrder = ["converting", "extracting", "compressing", "searching-website", "syncing", "memo-ready"];
    const resumeIdx = resumeFrom ? stepOrder.indexOf(resumeFrom) : -1;
    const shouldSkip = (step: string) => resumeFrom ? stepOrder.indexOf(step) < resumeIdx : false;

    // Fetch user settings (needed for Google token for conversion + AI model)
    const { data: settings } = await adminClient
      .from("user_settings")
      .select("ai_model, drive_sync_enabled, google_provider_token, naming_pattern, drive_folder")
      .eq("user_id", userId)
      .single();
    const model = settings?.ai_model ?? "gpt-5.4";

    // Download file from storage only when needed (PPTX conversion path).
    let arrayBuffer: ArrayBuffer | null = null;
    const fileName = storagePath.split("/").pop()?.toLowerCase() ?? "";
    const isPptx = fileName.endsWith(".pptx") || fileName.endsWith(".ppt");
    const isPdf = fileName.endsWith(".pdf");

    if (isPptx && !skipCompression) {
      const { data: fileData, error: downloadError } = await adminClient.storage
        .from("decks").download(storagePath);
      if (downloadError || !fileData) {
        throw new Error(`Failed to download file: ${downloadError?.message}`);
      }
      arrayBuffer = await fileData.arrayBuffer();
    }

    // --- STEP 1: Convert PPTX to PDF (if applicable) ---
    let pdfStoragePath = storagePath;
    let slidesApiText = "";
    if (isPptx && !shouldSkip("converting") && arrayBuffer) {
      if (await checkAborted(adminClient, dealId, "converting")) {
        await processNextQueued(adminClient, userId, supabaseUrl, supabaseServiceKey);
        return new Response(JSON.stringify({ success: true, cancelled: true, at: "converting" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      await setDealStatus(adminClient, dealId, "converting");

      if (!settings?.google_provider_token) {
        throw new Error("Google Drive not connected — required for PPTX to PDF conversion");
      }

      console.log("Converting PPTX to PDF via Google Drive API...");
      const conversionResult = await convertPptxToPdfViaDrive(
        arrayBuffer,
        settings.google_provider_token,
        fileName
      );
      arrayBuffer = conversionResult.pdfBytes.buffer as ArrayBuffer;
      slidesApiText = conversionResult.slidesText;

      pdfStoragePath = storagePath.replace(/\.(pptx|ppt)$/i, ".pdf");

      const { error: pdfUploadError } = await adminClient.storage
        .from("decks")
        .upload(pdfStoragePath, new Blob([conversionResult.pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" }), {
          upsert: true,
        });
      if (pdfUploadError) {
        console.warn("Failed to upload converted PDF:", pdfUploadError.message);
      }

      console.log(`PPTX converted to PDF: ${(conversionResult.pdfBytes.length / (1024 * 1024)).toFixed(1)}MB`);
    } else if (isPptx) {
      pdfStoragePath = storagePath.replace(/\.(pptx|ppt)$/i, ".pdf");
    }

    // --- STEP 2: Extracting metadata ---
    let compressedPdf: Uint8Array | null = null;
    let pageCount = 0;
    if (skipCompression) {
      const { data: dealData } = await adminClient.from("deals").select("pages").eq("id", dealId).single();
      pageCount = dealData?.pages ?? 0;
    }
    // If text was extracted locally (e.g. Florence-2 in-browser), skip server-side extraction
    // but still run LLM metadata extraction if a cloud model is configured
    const isLocalModel = model === "local-florence2";

    if (!shouldSkip("extracting")) {
      if (await checkAborted(adminClient, dealId, "extracting")) {
        await processNextQueued(adminClient, userId, supabaseUrl, supabaseServiceKey);
        return new Response(JSON.stringify({ success: true, cancelled: true, at: "extracting" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      await setDealStatus(adminClient, dealId, "extracting");

      let extractedText = "";
      let actualPageCount = pageCount;
      const { data: existingSource } = await adminClient.from("sources")
        .select("extracted_text, source_type, preview_images")
        .eq("deal_id", dealId)
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const existingSourceText = existingSource?.extracted_text?.trim() ?? "";
      const previewImages = Array.isArray(existingSource?.preview_images)
        ? existingSource.preview_images.filter((item: unknown): item is string => typeof item === "string" && item.startsWith("data:image/"))
        : [];
      const hasStoredCapturedText = isCapturedViewerSource(existingSource?.source_type) && existingSourceText.length > 0;

      // If client already extracted text locally (e.g. Florence-2), load it
      if (localExtracted) {
        extractedText = existingSourceText;
        console.log(`Using locally-extracted text: ${extractedText.length} chars`);
      } else if (hasStoredCapturedText) {
        extractedText = existingSourceText;
        console.log(`Using stored OCR fallback text: ${extractedText.length} chars`);
      } else {
        // Server-side text extraction
        // For PPTX: prefer Slides API text (most accurate), then PPTX XML, then PDF text
        if (isPptx && slidesApiText.length >= 200) {
          extractedText = slidesApiText;
          console.log(`Using Slides API text: ${extractedText.length} chars`);
        } else {
          // Try PDF text extraction — download on-demand if not already in memory
          try {
            const pdfBuffer: ArrayBuffer = await (async () => {
            // Lightweight download just for text extraction
            const { data: pdfFile } = await adminClient.storage.from("decks").download(pdfStoragePath);
            if (!pdfFile) throw new Error("Cannot download PDF for text extraction");
            return await pdfFile.arrayBuffer();
            })();
            const result = extractPdfText(pdfBuffer);
            extractedText = result.text;
            if (result.pageCount > 0) actualPageCount = result.pageCount;
            console.log(`Extracted ${extractedText.length} chars from PDF, ${actualPageCount} pages`);
          } catch (e) {
            console.error("Text extraction failed (non-fatal):", e);
          }

          // For PPTX: fallback to XML extraction if PDF text is insufficient
          if (isPptx && extractedText.length < 200) {
            if (slidesApiText.length > extractedText.length) {
              extractedText = slidesApiText;
              console.log(`Using Slides API text (short but best available): ${extractedText.length} chars`);
            } else {
              try {
                const { data: origFile } = await adminClient.storage.from("decks").download(storagePath);
                if (origFile) {
                  const origBuffer = await origFile.arrayBuffer();
                  const pptxResult = await extractPptxText(origBuffer);
                  if (pptxResult.text.length > extractedText.length) {
                    extractedText = pptxResult.text;
                    actualPageCount = pptxResult.pageCount;
                  }
                }
              } catch (e) {
                console.warn("PPTX fallback text extraction failed:", e);
              }
            }
          }

          if (extractedText.length < 200 && hasStoredCapturedText && existingSourceText.length > extractedText.length) {
            extractedText = existingSourceText;
            console.log(`Falling back to stored OCR text: ${extractedText.length} chars`);
          }
        }

        if (extractedText) {
          await adminClient.from("sources")
            .update({ extracted_text: extractedText.slice(0, 100_000) })
            .eq("deal_id", dealId).eq("user_id", userId);
        }
      }

      // For local-florence2 model: skip LLM metadata extraction, use basic heuristic
      if (isLocalModel) {
        console.log("Local model selected — skipping LLM metadata extraction, using heuristic");
        const updatePayload: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
          pages: actualPageCount > 0 ? actualPageCount : null,
        };
        // Don't blindly set website from text — Step 4 will verify it via search
        await adminClient.from("deals").update(updatePayload).eq("id", dealId);
      } else {
        // LLM metadata extraction (cloud models)
        const isSapinsapin = model === "gpt-oss-202b";
        const sapinsapinModel = "/models/gpt-oss-20b-balitanlp-cpt";
        const baseUrl = isSapinsapin ? SAPINSAPIN_BASE : OPENAI_BASE;
        const rawApiKey = (isSapinsapin ? sapinsapinApiKey : openaiApiKey)?.trim().replace(/[\r\n]/g, "");

        if (!rawApiKey) {
          throw new Error(isSapinsapin ? "APOLLO_API_KEY is not configured" : "OPENAI_API_KEY is not configured");
        }

        const aiHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (isSapinsapin) {
          aiHeaders["X-API-Key"] = rawApiKey;
        } else {
          aiHeaders["Authorization"] = `Bearer ${rawApiKey}`;
        }

        const userContent: unknown[] = [];

        const supportsMultimodal = !isSapinsapin && (model === "gpt-4o" || model === "gpt-5" || model === "gpt-5-mini" || model === "gpt-5.4");
        const textToSend = extractedText.length > 0 ? extractedText.slice(0, 50_000) : "No text could be extracted from the deck file.";
        userContent.push({ type: "text", text: `Analyze this pitch deck and extract metadata using the extract_deck_metadata tool. Return null for fields you cannot determine.\n\nDeck text (if available):\n${textToSend}` });
        if (supportsMultimodal && previewImages.length > 0) {
          for (const url of previewImages.slice(0, 8)) {
            userContent.push({ type: "image_url", image_url: { url, detail: "low" } });
          }
        }

        const aiPayload = {
          model: isSapinsapin ? sapinsapinModel : model,
          messages: [
            { role: "system", content: "You are the Deep Research & Identity Agent for a VC Deal OS. Your primary job is to accurately identify the startup's name, their core sector, and extract key deal metadata from a pitch deck. The Company Name is usually the most prominent proper noun on the first page. Be precise — return null for fields you cannot verify." },
            { role: "user", content: userContent },
          ],
          tools: [{
            type: "function",
            function: {
              name: "extract_deck_metadata",
              description: "Extract structured metadata from a startup pitch deck.",
              parameters: {
                type: "object",
                properties: {
                  startup_name: { type: "string", description: "Name of the startup/company" },
                  website: { type: ["string", "null"], description: "Company website URL if found" },
                  stage: { type: "string", enum: ["Pre-Seed", "Seed", "Series A", "Series B", "Series C", "Growth", "Unknown"] },
                  sector: { type: "string", description: "Primary sector/industry" },
                  ask_amount: { type: ["string", "null"], description: "Amount being raised" },
                  valuation: { type: ["string", "null"], description: "Valuation if mentioned" },
                  revenue: { type: ["string", "null"], description: "Current revenue/ARR" },
                  growth: { type: ["string", "null"], description: "Growth rate" },
                  team_size: { type: ["string", "null"], description: "Team size" },
                  page_count: { type: "number", description: "Number of pages/slides" },
                  confidence_score: { type: "number", description: "Confidence score 0-100 for the identity extraction accuracy" },
                },
                required: ["startup_name", "stage", "sector", "page_count", "confidence_score"],
                additionalProperties: false,
              },
            },
          }],
          tool_choice: { type: "function", function: { name: "extract_deck_metadata" } },
        };

        let aiResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: aiHeaders,
          body: JSON.stringify(aiPayload),
        });

        // Fallback: if file-based request fails, retry with text-only
        // Keep a lightweight retry with text-only prompt
        if (!aiResponse.ok && extractedText.length > 0) {
          console.warn(`AI call failed (${aiResponse.status}), retrying with text-only extraction`);
          aiPayload.messages = [
            { role: "system", content: "You are a VC analyst assistant. Analyze startup pitch decks and extract structured metadata. Be precise. Return null for missing fields." },
            { role: "user", content: [{ type: "text", text: `Here is the full text content of the pitch deck:\n\n${extractedText.slice(0, 50_000)}\n\nAnalyze this pitch deck and extract metadata using the extract_deck_metadata tool. Return null for fields you cannot determine.` }] },
          ];
          aiResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: aiHeaders,
            body: JSON.stringify(aiPayload),
          });
        }

        if (!aiResponse.ok) {
          const errText = await aiResponse.text();
          console.error("AI API error:", aiResponse.status, errText);
          throw new Error(`AI API error [${aiResponse.status}]: ${errText}`);
        }

        const aiResult = await aiResponse.json();
        const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
        if (!toolCall) throw new Error("No structured output returned from AI");

        const metadata = JSON.parse(toolCall.function.arguments);
        console.log("Extracted metadata:", JSON.stringify(metadata));

        const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (metadata.startup_name) updatePayload.name = sanitizeCompanyName(metadata.startup_name);
        console.log(`Identity confidence: ${metadata.confidence_score ?? "N/A"}/100`);
        // Don't set website from LLM extraction — Step 4 will verify via search + scrape
        if (metadata.stage) updatePayload.stage = metadata.stage;
        if (metadata.sector) updatePayload.sector = metadata.sector;
        if (metadata.ask_amount) updatePayload.ask_amount = metadata.ask_amount;
        if (metadata.valuation) updatePayload.valuation = metadata.valuation;
        if (metadata.revenue) updatePayload.revenue = metadata.revenue;
        if (metadata.growth) updatePayload.growth = metadata.growth;
        if (metadata.team_size) updatePayload.team_size = metadata.team_size;
        updatePayload.pages = actualPageCount > 0 ? actualPageCount : (metadata.page_count ?? null);

        await adminClient.from("deals").update(updatePayload).eq("id", dealId);
      }
    }

    // --- STEP 3: Compress PDF (run late; skip when already-captured or already small) ---
    if (!shouldSkip("compressing")) {
      if (await checkAborted(adminClient, dealId, "compressing")) {
        await processNextQueued(adminClient, userId, supabaseUrl, supabaseServiceKey);
        return new Response(JSON.stringify({ success: true, cancelled: true, at: "compressing" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      await setDealStatus(adminClient, dealId, "compressing");

      if (skipCompression) {
        console.log("Skipping compression — captured deck already stored");
      } else {
        const { data: pdfFile } = await adminClient.storage.from("decks").download(pdfStoragePath);
        if (!pdfFile) throw new Error("Cannot download PDF for compression");
        const pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
        const shouldCompress = pdfBytes.length > 10 * 1024 * 1024;

        if (shouldCompress) {
          const result = await compressPdfToTarget(pdfBytes);
          compressedPdf = result.compressed;
          pageCount = result.pages || pageCount;
          const { error: compressUploadError } = await adminClient.storage
            .from("decks")
            .upload(pdfStoragePath, new Blob([compressedPdf.buffer as ArrayBuffer], { type: "application/pdf" }), { upsert: true });
          if (compressUploadError) console.warn("Failed to upload compressed PDF:", compressUploadError.message);
          await adminClient.from("deals").update({
            compressed_size: `${(compressedPdf.length / (1024 * 1024)).toFixed(1)}MB`,
            pages: pageCount || null,
            updated_at: new Date().toISOString(),
          }).eq("id", dealId);
        } else {
          console.log("Skipping compression — PDF already <= 10MB");
          await adminClient.from("deals").update({
            compressed_size: `${(pdfBytes.length / (1024 * 1024)).toFixed(1)}MB`,
            pages: pageCount || null,
            updated_at: new Date().toISOString(),
          }).eq("id", dealId);
        }
      }
    }

    // --- STEP 4: Smart website search via GPT-5 web search + Firecrawl fallback ---
    if (!shouldSkip("searching-website")) {
      if (await checkAborted(adminClient, dealId, "searching-website")) {
        await processNextQueued(adminClient, userId, supabaseUrl, supabaseServiceKey);
        return new Response(JSON.stringify({ success: true, cancelled: true, at: "searching-website" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { data: currentDeal } = await adminClient.from("deals").select("website, name, sector, stage").eq("id", dealId).single();

      if (currentDeal?.name) {
        await setDealStatus(adminClient, dealId, "searching-website");
        await adminClient.from("deals").update({ website_searching: true }).eq("id", dealId);

        const companyName = currentDeal.name;
        const sectorHint = currentDeal.sector && currentDeal.sector !== "Unknown" ? currentDeal.sector : "";
        let verifiedWebsite: string | null = null;
        let linkedinUrl: string | null = null;

        // --- PRIMARY: GPT-5 web search ---
        if (openaiApiKey) {
          try {
            console.log(`GPT-5 web search for: ${companyName}`);
            const searchPrompt = `Find the official company website and LinkedIn company page for "${companyName}"${sectorHint ? ` (${sectorHint} sector)` : ""}. This is a startup. Search the web and return the verified URLs. Do NOT guess — only return URLs you find in search results. Exclude aggregator sites like Crunchbase, PitchBook, etc.`;

            const searchPayload = {
              model: "gpt-5-mini",
              tools: [
                { type: "web_search" },
                {
                  type: "function",
                  name: "find_company_urls",
                  description: "Return the verified company website and LinkedIn URLs found via web search.",
                  parameters: {
                    type: "object",
                    properties: {
                      website: { type: ["string", "null"], description: "The official company website URL (e.g. https://company.com). Null if not found." },
                      linkedin_url: { type: ["string", "null"], description: "The LinkedIn company page URL. Null if not found." },
                      confidence: { type: "number", description: "Confidence 0-100 that the website belongs to this specific company" },
                    },
                    required: ["website", "linkedin_url", "confidence"],
                    additionalProperties: false,
                  },
                },
              ],
              instructions: "You are a research assistant. Use web_search to find the official company website and LinkedIn page. Once you have the URLs, call find_company_urls with the verified results.",
              input: [{ role: "user", content: searchPrompt }],
              max_output_tokens: 2048,
            };

            const searchRes = await fetch("https://api.openai.com/v1/responses", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${openaiApiKey?.trim().replace(/[\r\n]/g, "")}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(searchPayload),
            });

            if (searchRes.ok) {
              const searchResult = await searchRes.json();
              const fnCall = (searchResult.output ?? []).find((o: any) => o.type === "function_call" && o.name === "find_company_urls");
              if (fnCall) {
                const urls = JSON.parse(fnCall.arguments);
                console.log("GPT-5 web search result:", JSON.stringify(urls));

                if (urls.website && urls.confidence >= 60) {
                  try {
                    const u = new URL(urls.website.startsWith("http") ? urls.website : `https://${urls.website}`);
                    verifiedWebsite = `${u.protocol}//${u.hostname}`;
                  } catch {
                    verifiedWebsite = urls.website;
                  }
                  console.log(`✓ GPT-5 verified website: ${verifiedWebsite} (confidence: ${urls.confidence})`);
                }
                if (urls.linkedin_url) {
                  linkedinUrl = urls.linkedin_url;
                  console.log(`✓ GPT-5 found LinkedIn: ${linkedinUrl}`);
                }
              }
            } else {
              const errText = await searchRes.text();
              console.warn(`GPT-5 web search failed (${searchRes.status}): ${errText}`);
            }
          } catch (e) {
            console.warn("GPT-5 web search error (non-fatal):", e);
          }
        }

        // --- FALLBACK: Firecrawl multi-query search if GPT-5 didn't find a website ---
        if (!verifiedWebsite && firecrawlApiKey) {
          try {
            const searchQueries = [
              `"${companyName}" official website`,
              `${companyName} startup ${sectorHint}`.trim(),
              `${companyName} company`,
            ];

            const excludedDomains = [
              "linkedin.com", "crunchbase.com", "google.com", "wikipedia.org",
              "facebook.com", "twitter.com", "x.com", "instagram.com", "youtube.com",
              "glassdoor.com", "indeed.com", "pitchbook.com", "bloomberg.com",
              "techcrunch.com", "ycombinator.com", "reddit.com", "github.com",
            ];
            const isExcluded = (url: string) => excludedDomains.some((d) => url.includes(d));
            const companyNameLower = companyName.toLowerCase();
            const seenUrls = new Set<string>();

            for (const searchQuery of searchQueries) {
              if (verifiedWebsite) break;
              console.log("Firecrawl fallback query:", searchQuery);

              const searchResponse = await fetch("https://api.firecrawl.dev/v1/search", {
                method: "POST",
                headers: { Authorization: `Bearer ${firecrawlApiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ query: searchQuery, limit: 8 }),
              });

              if (!searchResponse.ok) { console.warn(`Firecrawl query failed (${searchResponse.status})`); continue; }

              const searchData = await searchResponse.json();
              const results = searchData.data || searchData.results || [];
              console.log(`Firecrawl returned ${results.length} results`);

              if (!linkedinUrl) {
                linkedinUrl = results.find((r: any) => r.url?.includes("linkedin.com/company"))?.url ?? null;
              }

              const candidates = results.filter((r: any) => r.url && !isExcluded(r.url) && !seenUrls.has(r.url));
              candidates.forEach((r: any) => seenUrls.add(r.url));

              for (const candidate of candidates.slice(0, 3)) {
                try {
                  const titleDesc = `${candidate.title || ""} ${candidate.description || ""}`.toLowerCase();
                  const mentions = titleDesc.includes(companyNameLower) ||
                    companyNameLower.split(/\s+/).filter((w: string) => w.length > 2).every((w: string) => titleDesc.includes(w));
                  if (!mentions) continue;

                  const scrapeRes = await fetch("https://api.firecrawl.dev/v1/scrape", {
                    method: "POST",
                    headers: { Authorization: `Bearer ${firecrawlApiKey}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ url: candidate.url, formats: ["markdown"], onlyMainContent: true }),
                  });

                  if (scrapeRes.ok) {
                    const scrapeData = await scrapeRes.json();
                    const content = (scrapeData.data?.markdown || scrapeData.markdown || "").toLowerCase().slice(0, 5000);
                    const contentMatch = content.includes(companyNameLower) ||
                      companyNameLower.split(/\s+/).filter((w: string) => w.length > 2).every((w: string) => content.includes(w));
                    if (contentMatch) {
                      try {
                        const u = new URL(candidate.url.startsWith("http") ? candidate.url : `https://${candidate.url}`);
                        verifiedWebsite = `${u.protocol}//${u.hostname}`;
                      } catch { verifiedWebsite = candidate.url; }
                      console.log(`✓ Firecrawl verified: ${verifiedWebsite}`);
                      break;
                    }
                  }
                } catch (e) { console.warn(`Firecrawl verify failed for ${candidate.url}:`, e); }
              }
            }
          } catch (e) {
            console.warn("Firecrawl fallback failed (non-fatal):", e);
          }
        }

        // Update deal
        const webUpdate: Record<string, unknown> = { website_searching: false, updated_at: new Date().toISOString() };
        if (verifiedWebsite && !currentDeal.website) webUpdate.website = verifiedWebsite;
        if (linkedinUrl) webUpdate.linkedin_url = linkedinUrl;
        await adminClient.from("deals").update(webUpdate).eq("id", dealId);
        console.log(`Website search complete: website=${verifiedWebsite || "none"}, linkedin=${linkedinUrl || "none"}`);
      }
    }

    // --- STEP 5: Sync to Google Drive ---
    if (!shouldSkip("syncing")) {
      if (await checkAborted(adminClient, dealId, "syncing")) {
        await processNextQueued(adminClient, userId, supabaseUrl, supabaseServiceKey);
        return new Response(JSON.stringify({ success: true, cancelled: true, at: "syncing" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      await setDealStatus(adminClient, dealId, "syncing");

      try {
        const syncFileName = pdfStoragePath.split("/").pop() ?? fileName;
        const response = await fetch(`${supabaseUrl}/functions/v1/sync-to-drive`, {
          method: "POST",
          headers: { Authorization: `Bearer ${supabaseServiceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ dealId, storagePath: pdfStoragePath, fileName: syncFileName, userId }),
        });

        if (response.ok) {
          console.log("Drive sync completed");
        } else {
          const errText = await response.text();
          console.warn("Drive sync returned error:", errText);
        }
      } catch (e) {
        console.warn("Drive sync skipped:", e);
      }
    }

    // --- STEP 6: Final status ---
    await setDealStatus(adminClient, dealId, "memo-ready");

    // --- STEP 7: Auto-trigger deep-research ---
    // Populates structured fields (ask, valuation, revenue, team, key people) automatically
    // so users don't have to wait for "Generate Memo" to see metadata.
    try {
      const { data: existingDeal } = await adminClient
        .from("deals")
        .select("deep_research_status")
        .eq("id", dealId)
        .single();
      const drStatus = existingDeal?.deep_research_status;
      if (drStatus !== "researching" && drStatus !== "completed") {
        console.log(`Auto-triggering deep-research for deal ${dealId}`);

        // Mark as researching up-front so the UI can show progress and the
        // frontend polling loop keeps refreshing until completion.
        await adminClient
          .from("deals")
          .update({ deep_research_status: "researching", updated_at: new Date().toISOString() })
          .eq("id", dealId);

        const drInvocation = fetch(`${supabaseUrl}/functions/v1/deep-research`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${supabaseServiceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ dealId }),
        })
          .then(async (res) => {
            if (!res.ok) {
              const errText = await res.text().catch(() => "");
              console.error("Deep-research auto-trigger HTTP error:", res.status, errText);
              await adminClient
                .from("deals")
                .update({ deep_research_status: "failed", updated_at: new Date().toISOString() })
                .eq("id", dealId)
                .catch(() => {});
            }
          })
          .catch(async (e) => {
            console.error("Deep-research auto-trigger failed:", e);
            await adminClient
              .from("deals")
              .update({ deep_research_status: "failed", updated_at: new Date().toISOString() })
              .eq("id", dealId)
              .catch(() => {});
          });

        // Keep the edge runtime alive until the request actually flushes — bare
        // fire-and-forget can be killed mid-flight when the response returns.
        const edgeRuntime = (globalThis as any).EdgeRuntime;
        if (edgeRuntime?.waitUntil) {
          edgeRuntime.waitUntil(drInvocation);
        }
      } else {
        console.log(`Skipping auto-trigger; deep_research_status=${drStatus}`);
      }
    } catch (e) {
      console.warn("Deep-research auto-trigger setup failed:", e);
    }

    // Process next queued deal for this user
    await processNextQueued(adminClient, userId, supabaseUrl, supabaseServiceKey);

    return new Response(
      JSON.stringify({ success: true, converted: isPptx }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("process-deck error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    // A crashed job must not leave the deal stuck mid-pipeline, and must not
    // hold the per-user queue lock forever: mark it failed (unless the user
    // cancelled it) and start the next queued deal.
    if (failCtx) {
      try {
        const { data: current } = await failCtx.adminClient
          .from("deals")
          .select("status")
          .eq("id", failCtx.dealId)
          .single();
        if (current && current.status !== "cancelled") {
          await failCtx.adminClient
            .from("deals")
            .update({ status: "error", updated_at: new Date().toISOString() })
            .eq("id", failCtx.dealId);
        }
        await processNextQueued(
          failCtx.adminClient,
          failCtx.userId,
          failCtx.supabaseUrl,
          failCtx.supabaseServiceKey
        );
      } catch (cleanupError) {
        console.error("process-deck failure cleanup failed:", cleanupError);
      }
    }
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
