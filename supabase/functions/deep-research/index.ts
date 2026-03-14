import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SAPINSAPIN_BASE = "https://apollo-inference-bridge.am1-aks.apolloglobal.net";
const SAPINSAPIN_MODEL = "/models/gpt-oss-20b-balitanlp-cpt";

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
    const firecrawlApiKey = Deno.env.get("FIRECRAWL_API_KEY");
    const sapinsapinApiKey = Deno.env.get("APOLLO_API_KEY")?.trim().replace(/[\r\n]/g, "");

    if (!firecrawlApiKey) {
      throw new Error("FIRECRAWL_API_KEY is not configured");
    }
    if (!sapinsapinApiKey) {
      throw new Error("APOLLO_API_KEY is not configured");
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

    const { dealId } = await req.json();
    if (!dealId) {
      return new Response(JSON.stringify({ error: "Missing dealId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch deal
    const { data: deal, error: dealError } = await adminClient
      .from("deals")
      .select("*")
      .eq("id", dealId)
      .eq("user_id", user.id)
      .single();

    if (dealError || !deal) {
      throw new Error("Deal not found");
    }

    // Mark as researching
    await adminClient
      .from("deals")
      .update({ deep_research_status: "researching", updated_at: new Date().toISOString() })
      .eq("id", dealId);

    console.log(`Starting deep research for: ${deal.name}`);

    // Step 1: Use Firecrawl search to find company website and LinkedIn
    const searchQuery = `${deal.name} company ${deal.sector ? deal.sector : ""} official website LinkedIn`;
    console.log("Firecrawl search query:", searchQuery);

    const searchResponse = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: searchQuery,
        limit: 10,
      }),
    });

    if (!searchResponse.ok) {
      const errText = await searchResponse.text();
      console.error("Firecrawl search error:", searchResponse.status, errText);
      throw new Error(`Firecrawl search failed [${searchResponse.status}]`);
    }

    const searchData = await searchResponse.json();
    const searchResults = searchData.data || searchData.results || [];
    console.log(`Firecrawl returned ${searchResults.length} results`);

    // Step 2: If we found a website, scrape it for more context
    let websiteContent = "";
    const candidateWebsite = deal.website || searchResults.find((r: any) =>
      r.url && !r.url.includes("linkedin.com") && !r.url.includes("crunchbase.com") && !r.url.includes("google.com")
    )?.url;

    if (candidateWebsite) {
      try {
        console.log("Scraping website:", candidateWebsite);
        const scrapeResponse = await fetch("https://api.firecrawl.dev/v1/scrape", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${firecrawlApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: candidateWebsite,
            formats: ["markdown"],
            onlyMainContent: true,
          }),
        });

        if (scrapeResponse.ok) {
          const scrapeData = await scrapeResponse.json();
          websiteContent = (scrapeData.data?.markdown || scrapeData.markdown || "").slice(0, 10_000);
          console.log(`Scraped ${websiteContent.length} chars from website`);
        }
      } catch (e) {
        console.error("Website scrape failed (non-fatal):", e);
      }
    }

    // Step 3: Send search results + scraped content to Sapinsapin for structured extraction
    const searchSummary = searchResults
      .map((r: any, i: number) => `[${i + 1}] ${r.title || ""} - ${r.url || ""}\n${r.description || ""}`)
      .join("\n\n");

    const researchPrompt = `You are a VC research analyst. Based on the following search results and website content, extract accurate company information.

COMPANY NAME: ${deal.name}
SECTOR: ${deal.sector}
STAGE: ${deal.stage}

SEARCH RESULTS:
${searchSummary}

${websiteContent ? `WEBSITE CONTENT:\n${websiteContent}` : ""}

Extract the company's official website URL and LinkedIn company page URL using the extract_company_research tool. Only return URLs you are confident about. Return null for any field you cannot verify.`;

    const aiResponse = await fetch(`${SAPINSAPIN_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "X-API-Key": sapinsapinApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SAPINSAPIN_MODEL,
        messages: [
          { role: "system", content: "You are a precise research analyst. Only return verified information." },
          { role: "user", content: researchPrompt },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "extract_company_research",
              description: "Extract verified company research data from search results.",
              parameters: {
                type: "object",
                properties: {
                  website: {
                    type: ["string", "null"],
                    description: "Official company website URL (e.g. https://company.com)",
                  },
                  linkedin_url: {
                    type: ["string", "null"],
                    description: "LinkedIn company page URL (e.g. https://linkedin.com/company/company-name)",
                  },
                },
                required: ["website", "linkedin_url"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "extract_company_research" } },
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("Sapinsapin error:", aiResponse.status, errText);
      throw new Error(`Sapinsapin API error [${aiResponse.status}]`);
    }

    const aiResult = await aiResponse.json();
    const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall) {
      console.error("No tool call in response:", JSON.stringify(aiResult));
      throw new Error("No structured output from Sapinsapin");
    }

    const research = JSON.parse(toolCall.function.arguments);
    console.log("Deep research results:", JSON.stringify(research));

    // Step 4: Update deal with research results
    const updatePayload: Record<string, unknown> = {
      deep_research_status: "completed",
      updated_at: new Date().toISOString(),
    };

    if (research.website && !deal.website) {
      updatePayload.website = research.website;
    }
    if (research.linkedin_url) {
      updatePayload.linkedin_url = research.linkedin_url;
    }

    await adminClient
      .from("deals")
      .update(updatePayload)
      .eq("id", dealId)
      .eq("user_id", user.id);

    return new Response(
      JSON.stringify({ success: true, research }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("deep-research error:", error);

    // Try to mark as failed
    try {
      const { dealId } = await (error as any)._req?.json?.() ?? {};
    } catch {}

    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
