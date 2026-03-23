import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Process DocSend Link Edge Function
 *
 * 1. Creates a deal immediately (status = scraping) so the UI shows progress.
 * 2. Calls the external DocSend Capture Service (Playwright-based, async/slow).
 * 3. Stores the resulting PDF + extracted markdown.
 * 4. Runs metadata extraction via LLM.
 *
 * The capture service can take 30-120+ seconds for multi-page decks,
 * so the frontend relies on realtime subscriptions / polling to track progress.
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
    const captureServiceUrl = Deno.env.get("DOCSEND_CAPTURE_SERVICE_URL");
    const captureServiceApiKey = Deno.env.get("DOCSEND_CAPTURE_SERVICE_API_KEY");
    

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

    // --- Step 1: Create deal immediately (status = scraping) ---
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

    // Return immediately so the frontend doesn't hang.
    // Processing continues in the background via waitUntil-style pattern.
    const responsePromise = new Response(
      JSON.stringify({ success: true, dealId: deal.id, status: "scraping" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

    // --- Background processing (runs after response is sent) ---
    const backgroundWork = (async () => {
      try {
        let markdown = "";
        let pdfBase64: string | null = null;
        let pageCount = 0;
        let storagePath: string | null = null;

        // Use DocSend Capture Service (Playwright-based) for all links
        if (!captureServiceUrl || !captureServiceApiKey) {
          throw new Error("DOCSEND_CAPTURE_SERVICE_URL and DOCSEND_CAPTURE_SERVICE_API_KEY must be configured");
        }

        console.log(`Using DocSend Capture Service for deal ${deal.id}`);
        {

          const captureRes = await fetch(`${captureServiceUrl}/capture`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": captureServiceApiKey!,
            },
            body: JSON.stringify({ url: normalizedUrl, max_pages: 50 }),
          });

          if (!captureRes.ok) {
            const errText = await captureRes.text();
            throw new Error(`Capture service failed [${captureRes.status}]: ${errText}`);
          }

          const captureData = await captureRes.json();
          markdown = captureData.markdown || "";
          pdfBase64 = captureData.pdf_base64 || null;
          pageCount = captureData.page_count || estimatePages(markdown);

          console.log(`Capture service returned ${pageCount} pages, ${markdown.length} chars markdown`);

          // Store the PDF from capture service
          if (pdfBase64) {
            try {
              const pdfBytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
              storagePath = `${user.id}/${deal.id}/deck.pdf`;
              const { error: uploadError } = await adminClient.storage
                .from("decks")
                .upload(storagePath, new Blob([pdfBytes], { type: "application/pdf" }), {
                  upsert: true,
                });
              if (uploadError) {
                console.warn("PDF upload failed:", uploadError.message);
                storagePath = null;
              } else {
                const sizeMB = (pdfBytes.length / (1024 * 1024)).toFixed(1);
                await adminClient
                  .from("deals")
                  .update({ deck_size: `${sizeMB}MB`, compressed_size: `${sizeMB}MB` })
                  .eq("id", deal.id);
              }
            } catch (e) {
              console.warn("Failed to store PDF:", e);
            }
          }
        }

        // --- Update deal: scraping done, move to extracting ---
        await adminClient
          .from("deals")
          .update({
            pages: pageCount,
            status: "extracting",
            updated_at: new Date().toISOString(),
          })
          .eq("id", deal.id);

        // --- Create source record ---
        await adminClient.from("sources").insert({
          deal_id: deal.id,
          user_id: user.id,
          file_name: `${sourceType}-${extractSlug(normalizedUrl)}.md`,
          original_size: `${(markdown.length / 1024).toFixed(0)}KB`,
          storage_path: storagePath,
          source_type: sourceType,
          processing_status: "extracted",
          extracted_text: markdown.slice(0, 100_000),
        });

        // --- Extract metadata via LLM ---
        await extractMetadata(adminClient, deal.id, user.id, markdown);

        console.log(`DocSend processing complete for deal ${deal.id}`);
      } catch (bgError) {
        console.error(`Background processing failed for deal ${deal.id}:`, bgError);
        await adminClient
          .from("deals")
          .update({ status: "error", updated_at: new Date().toISOString() })
          .eq("id", deal.id);
      }
    })();

    // Use respondWith pattern: return response immediately, let background work continue
    // In Deno Deploy / Supabase Edge Functions, the runtime keeps the function alive
    // until all promises settle, even after the response is sent.
    backgroundWork.catch((e) => console.error("Unhandled background error:", e));

    return responsePromise;
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

function deriveDealName(url: string): string {
  const slug = extractSlug(url);
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || "DocSend Import";
}

function extractSlug(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  } catch {
    return "unknown";
  }
}

function estimatePages(markdown: string): number {
  const wordCount = markdown.split(/\s+/).length;
  return Math.max(1, Math.round(wordCount / 500));
}

/** Use the configured AI model to extract metadata from scraped text */
async function extractMetadata(
  adminClient: any,
  dealId: string,
  userId: string,
  text: string
): Promise<void> {
  const { data: settings } = await adminClient
    .from("user_settings")
    .select("ai_model")
    .eq("user_id", userId)
    .single();
  const model = settings?.ai_model ?? "gpt-oss-202b";

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

    const updatePayload: Record<string, unknown> = {
      name: meta.startup_name || `DocSend Import ${dealId.slice(0, 6)}`,
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
