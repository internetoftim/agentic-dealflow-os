import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
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
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");

    if (!lovableApiKey) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { dealId, storagePath } = await req.json();
    if (!dealId || !storagePath) {
      return new Response(JSON.stringify({ error: "Missing dealId or storagePath" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Download PDF from Supabase storage
    const { data: fileData, error: downloadError } = await adminClient.storage
      .from("decks")
      .download(storagePath);

    if (downloadError || !fileData) {
      throw new Error(`Failed to download file: ${downloadError?.message}`);
    }

    // Convert PDF to base64 for Gemini multimodal
    const arrayBuffer = await fileData.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
    );

    // Call Gemini via Lovable AI Gateway with tool calling for structured output
    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `You are a VC analyst assistant. You analyze startup pitch decks (PDFs) and extract structured metadata. Be precise and concise. If information is not found, return null for that field.`,
          },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:application/pdf;base64,${base64}`,
                },
              },
              {
                type: "text",
                text: "Analyze this pitch deck and extract metadata using the extract_deck_metadata tool.",
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "extract_deck_metadata",
              description: "Extract structured metadata from a startup pitch deck PDF.",
              parameters: {
                type: "object",
                properties: {
                  startup_name: {
                    type: "string",
                    description: "Name of the startup/company",
                  },
                  website: {
                    type: "string",
                    description: "Company website URL if found (e.g. https://example.com)",
                  },
                  stage: {
                    type: "string",
                    enum: ["Pre-Seed", "Seed", "Series A", "Series B", "Series C", "Growth", "Unknown"],
                    description: "Fundraising stage",
                  },
                  sector: {
                    type: "string",
                    description: "Primary sector/industry (e.g. Fintech, SaaS, AI/ML, Healthcare, Climate)",
                  },
                  ask_amount: {
                    type: "string",
                    description: "Amount being raised (e.g. '$5M')",
                  },
                  valuation: {
                    type: "string",
                    description: "Valuation if mentioned (e.g. '$25M pre-money')",
                  },
                  revenue: {
                    type: "string",
                    description: "Current revenue/ARR if mentioned (e.g. '$1.2M ARR')",
                  },
                  growth: {
                    type: "string",
                    description: "Growth rate if mentioned (e.g. '3x YoY')",
                  },
                  team_size: {
                    type: "string",
                    description: "Team size if mentioned (e.g. '15')",
                  },
                  page_count: {
                    type: "number",
                    description: "Approximate number of pages/slides in the deck",
                  },
                },
                required: ["startup_name", "stage", "sector"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "extract_deck_metadata" } },
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited, please try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please add funds." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errText = await aiResponse.text();
      console.error("AI gateway error:", aiResponse.status, errText);
      throw new Error(`AI gateway error [${aiResponse.status}]: ${errText}`);
    }

    const aiResult = await aiResponse.json();

    // Extract tool call arguments
    const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      throw new Error("No structured output returned from AI");
    }

    const metadata = JSON.parse(toolCall.function.arguments);
    console.log("Extracted metadata:", JSON.stringify(metadata));

    // Update deal record with extracted metadata
    const updatePayload: Record<string, unknown> = {
      status: "analyzed",
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
    if (metadata.page_count) updatePayload.pages = metadata.page_count;

    const { error: updateError } = await adminClient
      .from("deals")
      .update(updatePayload)
      .eq("id", dealId)
      .eq("user_id", user.id);

    if (updateError) {
      throw new Error(`Failed to update deal: ${updateError.message}`);
    }

    return new Response(
      JSON.stringify({ success: true, metadata }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("process-deck error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
