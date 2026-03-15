import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { BlobReader, ZipReader, TextWriter } from "https://esm.sh/@zip.js/zip.js@2.7.34";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

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

/** Helper to update deal status */
async function setDealStatus(adminClient: any, dealId: string, status: string) {
  await adminClient
    .from("deals")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", dealId);
}

/** Check if the deal has been paused by the user. If so, record the step and exit. */
async function checkPaused(adminClient: any, dealId: string, currentStep: string): Promise<boolean> {
  const { data } = await adminClient
    .from("deals")
    .select("status")
    .eq("id", dealId)
    .single();
  if (data?.status === "paused") {
    await adminClient
      .from("deals")
      .update({ paused_at_step: currentStep, updated_at: new Date().toISOString() })
      .eq("id", dealId);
    console.log(`Deal ${dealId} paused at step: ${currentStep}`);
    return true;
  }
  return false;
}

/**
 * Convert PPTX to PDF using Google Drive API.
 * Upload as Google Slides (with convert), then export as PDF.
 */
async function convertPptxToPdfViaDrive(
  pptxBytes: ArrayBuffer,
  googleToken: string,
  fileName: string
): Promise<Uint8Array> {
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
    return new Uint8Array(pdfBuffer);
  } finally {
    // 3. Delete the temp Google Slides file
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
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { dealId, storagePath, resumeFrom } = await req.json();
    if (!dealId || !storagePath) {
      return new Response(JSON.stringify({ error: "Missing dealId or storagePath" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // When resuming, clear the paused_at_step
    if (resumeFrom) {
      await adminClient.from("deals").update({ paused_at_step: null, status: resumeFrom, updated_at: new Date().toISOString() }).eq("id", dealId);
    }

    // Determine which steps to skip when resuming
    const stepOrder = ["converting", "compressing", "extracting", "searching-website", "syncing", "memo-ready"];
    const resumeIdx = resumeFrom ? stepOrder.indexOf(resumeFrom) : -1;
    const shouldSkip = (step: string) => resumeFrom ? stepOrder.indexOf(step) < resumeIdx : false;

    // Fetch user settings (needed for Google token for conversion + AI model)
    const { data: settings } = await adminClient
      .from("user_settings")
      .select("ai_model, drive_sync_enabled, google_provider_token, naming_pattern, drive_folder")
      .eq("user_id", user.id)
      .single();
    const model = settings?.ai_model ?? "gpt-4o";

    // Download file from storage
    const { data: fileData, error: downloadError } = await adminClient.storage
      .from("decks").download(storagePath);
    if (downloadError || !fileData) {
      throw new Error(`Failed to download file: ${downloadError?.message}`);
    }

    let arrayBuffer = await fileData.arrayBuffer();
    const fileName = storagePath.split("/").pop()?.toLowerCase() ?? "";
    const isPptx = fileName.endsWith(".pptx") || fileName.endsWith(".ppt");
    const isPdf = fileName.endsWith(".pdf");

    // --- STEP 1: Convert PPTX to PDF (if applicable) ---
    let pdfStoragePath = storagePath;
    if (isPptx) {
      await setDealStatus(adminClient, dealId, "converting");

      if (!settings?.google_provider_token) {
        throw new Error("Google Drive not connected — required for PPTX to PDF conversion");
      }

      console.log("Converting PPTX to PDF via Google Drive API...");
      const pdfBytes = await convertPptxToPdfViaDrive(
        arrayBuffer,
        settings.google_provider_token,
        fileName
      );
      arrayBuffer = pdfBytes.buffer as ArrayBuffer;

      // Upload the converted PDF to storage (replacing the original path concept)
      const pdfFileName = fileName.replace(/\.(pptx|ppt)$/i, ".pdf");
      pdfStoragePath = storagePath.replace(/\.(pptx|ppt)$/i, ".pdf");

      const { error: pdfUploadError } = await adminClient.storage
        .from("decks")
        .upload(pdfStoragePath, new Blob([pdfBytes], { type: "application/pdf" }), {
          upsert: true,
        });
      if (pdfUploadError) {
        console.warn("Failed to upload converted PDF:", pdfUploadError.message);
      }

      console.log(`PPTX converted to PDF: ${(pdfBytes.length / (1024 * 1024)).toFixed(1)}MB`);
    }

    // --- STEP 2: Compress PDF ---
    await setDealStatus(adminClient, dealId, "compressing");

    const pdfBytes = new Uint8Array(arrayBuffer);
    const { compressed: compressedPdf, pages: pageCount } = await compressPdfToTarget(pdfBytes);

    // Re-upload compressed PDF
    const { error: compressUploadError } = await adminClient.storage
      .from("decks")
      .upload(pdfStoragePath, new Blob([compressedPdf], { type: "application/pdf" }), {
        upsert: true,
      });
    if (compressUploadError) {
      console.warn("Failed to upload compressed PDF:", compressUploadError.message);
    }

    await adminClient.from("deals").update({
      compressed_size: `${(compressedPdf.length / (1024 * 1024)).toFixed(1)}MB`,
      pages: pageCount,
      updated_at: new Date().toISOString(),
    }).eq("id", dealId);

    // --- STEP 3: Extracting metadata ---
    await setDealStatus(adminClient, dealId, "extracting");

    // Extract text from the (now always PDF) file
    let extractedText = "";
    let actualPageCount = pageCount;
    try {
      const result = extractPdfText(compressedPdf.buffer as ArrayBuffer);
      extractedText = result.text;
      if (result.pageCount > 0) actualPageCount = result.pageCount;
      console.log(`Extracted ${extractedText.length} chars, ${actualPageCount} pages`);
    } catch (e) {
      console.error("Text extraction failed (non-fatal):", e);
    }

    // If PDF text extraction yielded little and we had PPTX, try PPTX extraction from original
    if (isPptx && extractedText.length < 200) {
      try {
        const { data: origFile } = await adminClient.storage.from("decks").download(storagePath);
        if (origFile) {
          const origBuffer = await origFile.arrayBuffer();
          const pptxResult = await extractPptxText(origBuffer);
          if (pptxResult.text.length > extractedText.length) {
            extractedText = pptxResult.text;
            actualPageCount = pptxResult.pageCount;
            console.log(`Used PPTX text extraction instead: ${extractedText.length} chars`);
          }
        }
      } catch (e) {
        console.warn("PPTX fallback text extraction failed:", e);
      }
    }

    // Store extracted text
    if (extractedText) {
      const truncated = extractedText.slice(0, 100_000);
      await adminClient.from("sources")
        .update({ extracted_text: truncated })
        .eq("deal_id", dealId).eq("user_id", user.id);
    }

    // LLM metadata extraction
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
    if (isSapinsapin) {
      const deckText = extractedText
        ? `Here is the full text content of the pitch deck:\n\n${extractedText.slice(0, 50_000)}`
        : "No text could be extracted from the deck file.";
      userContent.push({ type: "text", text: `${deckText}\n\nAnalyze this pitch deck and extract metadata using the extract_deck_metadata tool.` });
    } else {
      // Always send the compressed PDF (even if originally PPTX, it's now converted)
      const base64 = btoa(new Uint8Array(compressedPdf).reduce((data, byte) => data + String.fromCharCode(byte), ""));
      userContent.push({
        type: "file",
        file: {
          filename: "deck.pdf",
          file_data: `data:application/pdf;base64,${base64}`,
        },
      });
      userContent.push({ type: "text", text: "Analyze this pitch deck and extract metadata using the extract_deck_metadata tool." });
    }

    const aiResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: aiHeaders,
      body: JSON.stringify({
        model: isSapinsapin ? sapinsapinModel : model,
        messages: [
          { role: "system", content: "You are a VC analyst assistant. Analyze startup pitch decks and extract structured metadata. Be precise. Return null for missing fields." },
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
              },
              required: ["startup_name", "stage", "sector", "page_count"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "extract_deck_metadata" } },
      }),
    });

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

    // Update deal with metadata
    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (metadata.startup_name) updatePayload.name = metadata.startup_name;
    if (metadata.website) {
      updatePayload.website = metadata.website;
      updatePayload.website_searching = false;
    }
    if (metadata.stage) updatePayload.stage = metadata.stage;
    if (metadata.sector) updatePayload.sector = metadata.sector;
    if (metadata.ask_amount) updatePayload.ask_amount = metadata.ask_amount;
    if (metadata.valuation) updatePayload.valuation = metadata.valuation;
    if (metadata.revenue) updatePayload.revenue = metadata.revenue;
    if (metadata.growth) updatePayload.growth = metadata.growth;
    if (metadata.team_size) updatePayload.team_size = metadata.team_size;
    updatePayload.pages = actualPageCount > 0 ? actualPageCount : (metadata.page_count ?? null);

    await adminClient.from("deals").update(updatePayload).eq("id", dealId);

    // --- STEP 4: Lite website search (if no website found in deck) ---
    let foundWebsite = metadata.website;
    if (!foundWebsite && firecrawlApiKey && metadata.startup_name) {
      await setDealStatus(adminClient, dealId, "searching-website");
      await adminClient.from("deals").update({ website_searching: true }).eq("id", dealId);

      try {
        const searchQuery = `${metadata.startup_name} company official website`;
        console.log("Lite website search:", searchQuery);

        const searchResponse = await fetch("https://api.firecrawl.dev/v1/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${firecrawlApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: searchQuery, limit: 5 }),
        });

        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          const results = searchData.data || searchData.results || [];

          const candidateUrl = results.find((r: any) =>
            r.url &&
            !r.url.includes("linkedin.com") &&
            !r.url.includes("crunchbase.com") &&
            !r.url.includes("google.com") &&
            !r.url.includes("wikipedia.org") &&
            !r.url.includes("facebook.com") &&
            !r.url.includes("twitter.com")
          )?.url;

          const linkedinUrl = results.find((r: any) =>
            r.url?.includes("linkedin.com/company")
          )?.url;

          if (candidateUrl) {
            foundWebsite = candidateUrl;
            console.log("Found website:", foundWebsite);
          }

          const webUpdate: Record<string, unknown> = {
            website_searching: false,
            updated_at: new Date().toISOString(),
          };
          if (foundWebsite) webUpdate.website = foundWebsite;
          if (linkedinUrl) webUpdate.linkedin_url = linkedinUrl;

          await adminClient.from("deals").update(webUpdate).eq("id", dealId);
        }
      } catch (e) {
        console.warn("Lite website search failed (non-fatal):", e);
        await adminClient.from("deals").update({ website_searching: false }).eq("id", dealId);
      }
    }

    // --- STEP 5: Sync to Google Drive ---
    await setDealStatus(adminClient, dealId, "syncing");

    try {
      // Use the converted PDF path for syncing
      const syncFileName = pdfStoragePath.split("/").pop() ?? fileName;
      const response = await fetch(`${supabaseUrl}/functions/v1/sync-to-drive`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dealId, storagePath: pdfStoragePath, fileName: syncFileName }),
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

    // --- STEP 6: Final status ---
    await setDealStatus(adminClient, dealId, "memo-ready");

    return new Response(
      JSON.stringify({ success: true, metadata, converted: isPptx }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("process-deck error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
