import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Process DocSend Link Edge Function
 *
 * Accepts a DocSend (or PandaDoc) URL and attempts a headless-browser capture
 * flow first (OpenAI Responses + computer_use_preview). If that fails, it
 * falls back to Firecrawl scrape + screenshot.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // --- Auth ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const firecrawlApiKey = Deno.env.get("FIRECRAWL_API_KEY")?.trim();
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY")?.trim();

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Missing url parameter" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate URL format
    const normalizedUrl = url.trim();
    const isDocSend = /docsend\.com/i.test(normalizedUrl);
    const isPandaDoc = /pandadoc\.com/i.test(normalizedUrl);
    if (!isDocSend && !isPandaDoc) {
      return new Response(
        JSON.stringify({ error: "URL must be a DocSend or PandaDoc link" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const sourceType = isDocSend ? "docsend" : "pandadoc";

    // --- Step 1: Create deal record immediately (status = scraping) ---
    const dealName = deriveDealName(normalizedUrl);
    const { data: deal, error: dealError } = await adminClient
      .from("deals")
      .insert({
        user_id: user.id,
        name: dealName,
        source: sourceType,
        status: "scraping",
        auto_ingested: false,
      })
      .select()
      .single();

    if (dealError) {
      throw new Error(`Failed to create deal: ${dealError.message}`);
    }

    console.log(`Created deal ${deal.id} for ${sourceType} URL: ${normalizedUrl}`);

    // --- Step 2: Scrape with Firecrawl ---
    try {
      await adminClient
        .from("deals")
        .update({ status: "scraping", updated_at: new Date().toISOString() })
        .eq("id", deal.id);

      // Fetch user model preference early so we can pick the capture engine
      const { data: settings } = await adminClient
        .from("user_settings")
        .select("ai_model")
        .eq("user_id", user.id)
        .single();
      const aiModel = settings?.ai_model ?? "gpt-5-mini";

      const scrapeResult = await scrapeDocsendOrPandadoc({
        url: normalizedUrl,
        model: aiModel,
        openaiApiKey,
        firecrawlApiKey,
      });

      console.log(
        `Firecrawl returned ${scrapeResult.markdown.length} chars markdown, ` +
          `screenshot: ${scrapeResult.screenshotUrl ? "yes" : "no"}`
      );

      // --- Step 3: Store screenshot in Supabase Storage (if available) ---
      let storagePath: string | null = null;
      if (scrapeResult.screenshotUrl) {
        try {
          const imgRes = await fetch(scrapeResult.screenshotUrl);
          if (imgRes.ok) {
            const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
            storagePath = `${user.id}/${deal.id}/screenshot.png`;
            const { error: uploadError } = await adminClient.storage
              .from("decks")
              .upload(storagePath, new Blob([imgBytes], { type: "image/png" }), {
                upsert: true,
              });
            if (uploadError) {
              console.warn("Screenshot upload failed:", uploadError.message);
              storagePath = null;
            }
          }
        } catch (e) {
          console.warn("Failed to download screenshot:", e);
        }
      }

      // --- Step 4: Create source record ---
      await adminClient.from("sources").insert({
        deal_id: deal.id,
        user_id: user.id,
        file_name: `${sourceType}-${extractSlug(normalizedUrl)}.md`,
        original_size: `${(scrapeResult.markdown.length / 1024).toFixed(0)}KB`,
        storage_path: storagePath,
        source_type: sourceType,
        processing_status: "extracted",
        extracted_text: scrapeResult.markdown.slice(0, 100_000),
      });

      // --- Step 5: Update deal with page count estimate and extracted metadata ---
      const pageEstimate = estimatePages(scrapeResult.markdown);
      await adminClient
        .from("deals")
        .update({
          pages: pageEstimate,
          status: "extracting",
          updated_at: new Date().toISOString(),
        })
        .eq("id", deal.id);

      // --- Step 6: Extract metadata via LLM ---
      await extractMetadata(adminClient, deal.id, user.id, scrapeResult.markdown);

      console.log(`DocSend processing complete for deal ${deal.id}`);

      return new Response(
        JSON.stringify({ success: true, dealId: deal.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } catch (scrapeError) {
      console.error(`Scrape failed for deal ${deal.id}:`, scrapeError);
      await adminClient
        .from("deals")
        .update({ status: "error", updated_at: new Date().toISOString() })
        .eq("id", deal.id);

      const message = scrapeError instanceof Error ? scrapeError.message : "Scrape failed";
      return new Response(
        JSON.stringify({ error: message, dealId: deal.id }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (error) {
    console.error("process-docsend error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ─── Helpers ───────────────────────────────────────────────

/** Scrape a URL using Firecrawl and return markdown + screenshot URL */
async function scrapeWithFirecrawl(
  apiKey: string,
  url: string
): Promise<{ markdown: string; screenshotUrl: string | null; title: string | null }> {
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["markdown", "screenshot"],
      waitFor: 5000, // DocSend pages load slowly
      timeout: 30000,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firecrawl scrape failed [${res.status}]: ${errText}`);
  }

  const data = await res.json();
  const result = data.data || data;

  return {
    markdown: result.markdown || "",
    screenshotUrl: result.screenshot || null,
    title: result.metadata?.title || null,
  };
}

type ScrapeResult = { markdown: string; screenshotUrl: string | null; title: string | null };
type ComputerUseOutputItem = {
  type?: string;
  name?: string;
  arguments?: string;
};

async function scrapeDocsendOrPandadoc(params: {
  url: string;
  model: string;
  openaiApiKey?: string | null;
  firecrawlApiKey?: string | null;
}): Promise<ScrapeResult> {
  const { url, model, openaiApiKey, firecrawlApiKey } = params;

  // Preferred path: headless browser driven by model computer use.
  if (openaiApiKey) {
    try {
      console.log(`Trying headless computer-use capture with model ${model}`);
      return await scrapeWithComputerUse(openaiApiKey, url, model);
    } catch (e) {
      console.warn("Computer-use capture failed, falling back to Firecrawl:", e);
    }
  } else {
    console.warn("OPENAI_API_KEY missing — cannot run computer-use capture");
  }

  if (!firecrawlApiKey) {
    throw new Error("No extraction engine available: missing OPENAI_API_KEY and FIRECRAWL_API_KEY");
  }

  return await scrapeWithFirecrawl(firecrawlApiKey, url);
}

async function scrapeWithComputerUse(apiKey: string, url: string, preferredModel: string): Promise<ScrapeResult> {
  const model = normalizeComputerUseModel(preferredModel);
  const prompt = `Open this deck URL in a headless browser: ${url}

Important:
1) Pass any view gate that only requires standard web interaction.
2) Navigate slide-by-slide using the page controls (next arrow / right key) until the end.
3) Capture visible text from each page.
4) Take screenshots while navigating pages.
5) Call submit_docsend_capture with:
   - markdown: consolidated notes per page in markdown
   - page_count: total pages visited
   - title: best-effort deck title
   - screenshot_count: number of screenshots captured

If blocked by an auth wall that cannot be passed, still call submit_docsend_capture with best effort content and explain the blocker in markdown.`;

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: "medium" },
      truncation: "auto",
      tools: [
        {
          type: "computer_use_preview",
          display_width: 1366,
          display_height: 768,
          environment: "browser",
        },
        {
          type: "function",
          name: "submit_docsend_capture",
          description: "Return extracted deck content after browsing and screenshotting pages.",
          parameters: {
            type: "object",
            properties: {
              title: { type: ["string", "null"] },
              markdown: { type: "string" },
              page_count: { type: "number" },
              screenshot_count: { type: "number" },
            },
            required: ["markdown", "page_count", "screenshot_count", "title"],
            additionalProperties: false,
          },
        },
      ],
      instructions:
        "You are a meticulous VC data extraction agent. Navigate deck pages carefully, capture content, and always finish by calling submit_docsend_capture.",
      input: [{ role: "user", content: prompt }],
      max_output_tokens: 8000,
    }),
  });

  if (!res.ok) {
    throw new Error(`Computer use API failed [${res.status}]: ${await res.text()}`);
  }

  const data = await res.json();
  const outputItems: ComputerUseOutputItem[] = Array.isArray(data.output) ? data.output : [];
  const toolCall = outputItems.find(
    (item) => item.type === "function_call" && item.name === "submit_docsend_capture"
  );

  if (!toolCall?.arguments) {
    throw new Error("Computer use response did not include submit_docsend_capture");
  }

  const capture = JSON.parse(toolCall.arguments);
  const markdown = String(capture?.markdown || "").trim();

  if (!markdown) {
    throw new Error("Computer use capture returned empty markdown");
  }

  const pageCount = Number.isFinite(capture?.page_count) ? Math.max(1, Math.round(capture.page_count)) : 0;
  const screenshotCount = Number.isFinite(capture?.screenshot_count)
    ? Math.max(0, Math.round(capture.screenshot_count))
    : 0;
  console.log(
    `Computer-use capture complete — model=${model}, pages=${pageCount}, screenshots=${screenshotCount}`
  );

  return {
    markdown,
    screenshotUrl: null,
    title: capture?.title ?? null,
  };
}

function normalizeComputerUseModel(model: string): string {
  // Keep gpt-5-mini as default workflow; allow gpt-5.4 as explicit advanced option.
  if (model === "gpt-5.4") return "gpt-5.4";
  if (model === "gpt-5-mini" || model === "gpt-5") return model;
  return "gpt-5-mini";
}

/** Derive a deal name from a DocSend/PandaDoc URL */
function deriveDealName(url: string): string {
  // Try to extract slug: docsend.com/view/abc123 → "abc123"
  const slug = extractSlug(url);
  // Clean up the slug to make it more readable
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || "DocSend Import";
}

/** Extract the slug/ID from a DocSend or PandaDoc URL */
function extractSlug(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // docsend.com/view/SLUG or app.pandadoc.com/s/SLUG
    return parts[parts.length - 1] || "unknown";
  } catch {
    return "unknown";
  }
}

/** Rough page count estimate from markdown length */
function estimatePages(markdown: string): number {
  // ~500 words per slide, ~5 chars per word
  const wordCount = markdown.split(/\s+/).length;
  return Math.max(1, Math.round(wordCount / 500));
}

/** Use the configured AI model to extract metadata from scraped text */
async function extractMetadata(
  adminClient: SupabaseClient,
  dealId: string,
  userId: string,
  text: string
): Promise<void> {
  // Fetch user's AI model preference
  const { data: settings } = await adminClient
    .from("user_settings")
    .select("ai_model")
    .eq("user_id", userId)
    .single();
  const model = settings?.ai_model ?? "gpt-5-mini";

  const isSapinsapin = model === "gpt-oss-202b";
  const sapinsapinModel = "/models/gpt-oss-20b-balitanlp-cpt";
  const SAPINSAPIN_BASE = "https://apollo-inference-bridge.am1-aks.apolloglobal.net";
  const OPENAI_BASE = "https://api.openai.com";

  const baseUrl = isSapinsapin ? SAPINSAPIN_BASE : OPENAI_BASE;
  const apiKey = isSapinsapin
    ? Deno.env.get("APOLLO_API_KEY")?.trim().replace(/[\r\n]/g, "")
    : Deno.env.get("OPENAI_API_KEY")?.trim().replace(/[\r\n]/g, "");

  if (!apiKey) {
    console.warn("No AI API key configured — skipping metadata extraction");
    await adminClient
      .from("deals")
      .update({ status: "memo-ready", updated_at: new Date().toISOString() })
      .eq("id", dealId);
    return;
  }

  const aiHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (isSapinsapin) {
    aiHeaders["X-API-Key"] = apiKey;
  } else {
    aiHeaders["Authorization"] = `Bearer ${apiKey}`;
  }

  const textSnippet = text.slice(0, 50_000);
  const aiPayload = {
    model: isSapinsapin ? sapinsapinModel : model,
    messages: [
      {
        role: "system",
        content:
          "You are the Deep Research & Identity Agent for a VC Deal OS. Extract startup metadata from the scraped content of a pitch deck shared via DocSend/PandaDoc. Be precise — return null for fields you cannot verify.",
      },
      {
        role: "user",
        content: `Here is the scraped content of a pitch deck:\n\n${textSnippet}\n\nAnalyze this and extract metadata using the extract_deck_metadata tool. Return null for fields you cannot determine.`,
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "extract_deck_metadata",
          description: "Extract structured metadata from a startup pitch deck.",
          parameters: {
            type: "object",
            properties: {
              startup_name: { type: "string", description: "Name of the startup/company" },
              website: { type: ["string", "null"], description: "Company website URL if found" },
              stage: {
                type: "string",
                enum: ["Pre-Seed", "Seed", "Series A", "Series B", "Series C", "Growth", "Unknown"],
              },
              sector: { type: "string", description: "Primary sector/industry" },
              ask_amount: { type: ["string", "null"], description: "Amount being raised" },
              valuation: { type: ["string", "null"], description: "Valuation if mentioned" },
              revenue: { type: ["string", "null"], description: "Current revenue/ARR" },
              growth: { type: ["string", "null"], description: "Growth rate" },
              team_size: { type: ["string", "null"], description: "Team size" },
            },
            required: ["startup_name", "stage", "sector"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "extract_deck_metadata" } },
  };

  try {
    const aiRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: aiHeaders,
      body: JSON.stringify(aiPayload),
    });

    if (!aiRes.ok) {
      console.warn(`AI metadata extraction failed [${aiRes.status}]:`, await aiRes.text());
      await adminClient
        .from("deals")
        .update({ status: "memo-ready", updated_at: new Date().toISOString() })
        .eq("id", dealId);
      return;
    }

    const aiData = await aiRes.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      console.warn("No tool call in AI response");
      await adminClient
        .from("deals")
        .update({ status: "memo-ready", updated_at: new Date().toISOString() })
        .eq("id", dealId);
      return;
    }

    const meta = JSON.parse(toolCall.function.arguments);
    console.log(`Extracted metadata: ${meta.startup_name} (${meta.sector}, ${meta.stage})`);

    // Update deal with extracted metadata
    const updatePayload: Record<string, unknown> = {
      name: meta.startup_name || deriveDealNameFallback(dealId),
      stage: meta.stage || "Unknown",
      sector: meta.sector || "Unknown",
      status: "memo-ready",
      updated_at: new Date().toISOString(),
    };
    if (meta.website) updatePayload.website = meta.website;
    if (meta.ask_amount) updatePayload.ask_amount = meta.ask_amount;
    if (meta.valuation) updatePayload.valuation = meta.valuation;
    if (meta.revenue) updatePayload.revenue = meta.revenue;
    if (meta.growth) updatePayload.growth = meta.growth;
    if (meta.team_size) updatePayload.team_size = meta.team_size;

    await adminClient.from("deals").update(updatePayload).eq("id", dealId);
  } catch (e) {
    console.error("Metadata extraction error:", e);
    await adminClient
      .from("deals")
      .update({ status: "memo-ready", updated_at: new Date().toISOString() })
      .eq("id", dealId);
  }
}

function deriveDealNameFallback(dealId: string): string {
  return `DocSend Import ${dealId.slice(0, 6)}`;
}
