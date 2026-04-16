import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SAPINSAPIN_BASE = "https://apollo-inference-bridge.am1-aks.apolloglobal.net";
const SAPINSAPIN_MODEL = "/models/gpt-oss-20b-balitanlp-cpt";
const OPENAI_BASE = "https://api.openai.com";

function getAiConfig(model: string) {
  const isSapinsapin = model === "gpt-oss-202b";
  const isComputerUse = model === "gpt-5.4";
  return {
    isSapinsapin,
    isComputerUse,
    baseUrl: isSapinsapin ? SAPINSAPIN_BASE : OPENAI_BASE,
    modelName: isComputerUse ? "gpt-5.4" : isSapinsapin ? SAPINSAPIN_MODEL : model,
    envKey: isSapinsapin ? "APOLLO_API_KEY" : "OPENAI_API_KEY",
  };
}

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

    if (!firecrawlApiKey) {
      throw new Error("FIRECRAWL_API_KEY is not configured");
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

    // Fetch user settings for provider and model preference
    const { data: settings } = await adminClient
      .from("user_settings")
      .select("ai_model, deep_research_provider")
      .eq("user_id", user.id)
      .single();
    const { data: latestSource } = await adminClient
      .from("sources")
      .select("extracted_text, preview_images")
      .eq("deal_id", dealId)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const provider = "firecrawl";
    const aiModel = settings?.ai_model ?? "gpt-5.4";
    const deckTextContext = (latestSource?.extracted_text || "").slice(0, 12_000);
    const previewImages = Array.isArray(latestSource?.preview_images)
      ? latestSource.preview_images.filter((item: unknown): item is string => typeof item === "string" && item.startsWith("data:image/"))
      : [];

    // Mark as researching
    await adminClient
      .from("deals")
      .update({ deep_research_status: "researching", updated_at: new Date().toISOString() })
      .eq("id", dealId);

    console.log(`Deep research for "${deal.name}" — provider: ${provider}, model: ${aiModel}`);

    // Step 1: Firecrawl search
    const searchQuery = `${deal.name} company ${deal.sector ? deal.sector : ""} official website LinkedIn`;
    console.log("Firecrawl search query:", searchQuery);

    const searchResponse = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: searchQuery, limit: 10 }),
    });

    if (!searchResponse.ok) {
      const errText = await searchResponse.text();
      console.error("Firecrawl search error:", searchResponse.status, errText);
      throw new Error(`Firecrawl search failed [${searchResponse.status}]`);
    }

    const searchData = await searchResponse.json();
    const searchResults = searchData.data || searchData.results || [];
    console.log(`Firecrawl returned ${searchResults.length} results`);

    // Step 2: Scrape candidate website
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
          body: JSON.stringify({ url: candidateWebsite, formats: ["markdown"], onlyMainContent: true }),
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

    // Step 3: Crunchbase search + scrape via Firecrawl
    let crunchbaseUrl: string | null = null;
    let fundingTotal: string | null = null;
    let lastFundingRound: string | null = null;
    let numEmployees: string | null = null;
    let investors: string | null = null;

    // Check if any initial search result already has a Crunchbase URL
    const cbFromSearch = searchResults.find((r: any) =>
      r.url?.includes("crunchbase.com/organization")
    );
    if (cbFromSearch) {
      crunchbaseUrl = cbFromSearch.url;
    }

    // If not found, do a dedicated Crunchbase search
    if (!crunchbaseUrl) {
      try {
        const cbSearchQuery = `site:crunchbase.com/organization ${deal.name}`;
        console.log("Crunchbase search query:", cbSearchQuery);
        const cbSearchResponse = await fetch("https://api.firecrawl.dev/v1/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${firecrawlApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: cbSearchQuery, limit: 3 }),
        });

        if (cbSearchResponse.ok) {
          const cbSearchData = await cbSearchResponse.json();
          const cbResults = cbSearchData.data || cbSearchData.results || [];
          const cbResult = cbResults.find((r: any) =>
            r.url?.includes("crunchbase.com/organization")
          );
          if (cbResult) {
            crunchbaseUrl = cbResult.url;
          }
        }
      } catch (e) {
        console.error("Crunchbase search failed (non-fatal):", e);
      }
    }

    // Scrape the Crunchbase page for structured data
    if (crunchbaseUrl) {
      try {
        console.log("Scraping Crunchbase:", crunchbaseUrl);
        const cbScrapeResponse = await fetch("https://api.firecrawl.dev/v1/scrape", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${firecrawlApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: crunchbaseUrl, formats: ["markdown"], onlyMainContent: true }),
        });

        if (cbScrapeResponse.ok) {
          const cbScrapeData = await cbScrapeResponse.json();
          const cbMarkdown = (cbScrapeData.data?.markdown || cbScrapeData.markdown || "");
          console.log(`Scraped ${cbMarkdown.length} chars from Crunchbase`);

          // Extract data from Crunchbase markdown using regex patterns
          const fundingMatch = cbMarkdown.match(/Total Funding[:\s]*\$?([\d,.]+[BMKbmk]?)/i)
            || cbMarkdown.match(/Funding Total[:\s]*\$?([\d,.]+[BMKbmk]?)/i)
            || cbMarkdown.match(/\$(\d[\d,.]*[BMK])\s*(total|funding)/i);
          if (fundingMatch) {
            fundingTotal = fundingMatch[1].trim();
            if (fundingTotal && !fundingTotal.startsWith("$")) fundingTotal = "$" + fundingTotal;
          }

          const roundMatch = cbMarkdown.match(/Last Funding[:\s]*(Series [A-Z\d]+|Seed|Pre-Seed|Grant|Debt|Convertible|Angel|IPO|Venture)/i)
            || cbMarkdown.match(/(Series [A-Z\d]+|Seed|Pre-Seed)\s*[-–—]\s/i);
          if (roundMatch) {
            lastFundingRound = roundMatch[1].trim();
          }

          const empMatch = cbMarkdown.match(/(?:Number of )?Employees?[:\s]*([\d,]+(?:\s*-\s*[\d,]+)?)/i)
            || cbMarkdown.match(/(\d[\d,]*\s*-\s*\d[\d,]*)\s*employees/i)
            || cbMarkdown.match(/(\d[\d,]+)\s*employees/i);
          if (empMatch) {
            numEmployees = empMatch[1].trim();
          }

          // Extract investors
          // Common patterns: "Investors: A, B, C" or "Notable Investors" section or "Funded by"
          const investorPatterns = [
            /(?:Notable )?Investors?[:\s]*([^\n]+)/i,
            /(?:Funded|Backed)\s+by[:\s]*([^\n]+)/i,
            /(?:Lead )?Investor[s]?[:\s]*\[?([^\]\n]+)\]?/i,
          ];
          for (const pat of investorPatterns) {
            const invMatch = cbMarkdown.match(pat);
            if (invMatch) {
              const raw = invMatch[1].trim();
              // Clean up: remove markdown links, extra whitespace
              const cleaned = raw
                .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) → text
                .replace(/\s{2,}/g, " ")
                .trim();
              if (cleaned.length > 2 && cleaned.length < 500) {
                investors = cleaned;
                break;
              }
            }
          }

          console.log("Crunchbase extraction:", JSON.stringify({ crunchbaseUrl, fundingTotal, lastFundingRound, numEmployees, investors }));
        }
      } catch (e) {
        console.error("Crunchbase scrape failed (non-fatal):", e);
      }
    }

    let research: { website: string | null; linkedin_url: string | null };

    if (provider === "firecrawl") {
      const websiteUrl = candidateWebsite || null;
      const linkedinResult = searchResults.find((r: any) =>
        r.url?.includes("linkedin.com/company")
      );
      research = {
        website: websiteUrl,
        linkedin_url: linkedinResult?.url || null,
      };
      console.log("Firecrawl-only extraction:", JSON.stringify(research));
    } else {
      // Custom agent mode: use selected LLM for structured extraction
      const config = getAiConfig(aiModel);
      const rawApiKey = Deno.env.get(config.envKey)?.trim().replace(/[\r\n]/g, "");
      if (!rawApiKey) {
        throw new Error(`${config.envKey} is not configured`);
      }

      const searchSummary = searchResults
        .map((r: any, i: number) => `[${i + 1}] ${r.title || ""} - ${r.url || ""}\n${r.description || ""}`)
        .join("\n\n");

      if (config.isComputerUse) {
        // GPT-5.4 Computer Use path — uses OpenAI Responses API with computer_use_preview tool
        console.log("Using GPT-5.4 with web_search for deep research");

        const cuPrompt = `You are a VC research analyst. Find the official website and LinkedIn company page for "${deal.name}" (sector: ${deal.sector || "unknown"}, stage: ${deal.stage || "unknown"}).

Here are initial search results to guide you:
${searchSummary}

${candidateWebsite ? `Candidate website: ${candidateWebsite}` : ""}
${deckTextContext ? `\nDeck context (from slides):\n${deckTextContext}` : ""}

Use web_search to verify URLs if needed. Once confident, call the extract_company_research function with verified results.`;

        const cuInputContent: Array<Record<string, unknown>> = [{ type: "input_text", text: cuPrompt }];
        for (const url of previewImages.slice(0, 6)) {
          cuInputContent.push({ type: "input_image", image_url: url, detail: "low" });
        }

        const cuResponse = await fetch(`${OPENAI_BASE}/v1/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${rawApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            reasoning: { effort: "medium" },
            tools: [
              { type: "web_search", name: "web_search" },
              {
                type: "function",
                name: "extract_company_research",
                description: "Extract verified company research data.",
                parameters: {
                  type: "object",
                  properties: {
                    website: {
                      type: ["string", "null"],
                      description: "Official company website URL",
                    },
                    linkedin_url: {
                      type: ["string", "null"],
                      description: "LinkedIn company page URL",
                    },
                  },
                  required: ["website", "linkedin_url"],
                  additionalProperties: false,
                },
              },
            ],
            instructions: "You are a precise research analyst. Use web_search to verify company information. When confident, call extract_company_research.",
            input: [{ role: "user", content: cuInputContent }],
            max_output_tokens: 4096,
          }),
        });

        if (!cuResponse.ok) {
          const errText = await cuResponse.text();
          console.error("Computer Use API error:", cuResponse.status, errText);
          throw new Error(`Computer Use API error [${cuResponse.status}]`);
        }

        const cuResult = await cuResponse.json();
        console.log("Computer Use response output length:", cuResult.output?.length);

        // Find the function call in the output items
        const funcCall = cuResult.output?.find(
          (item: any) => item.type === "function_call" && item.name === "extract_company_research"
        );

        if (funcCall) {
          research = JSON.parse(funcCall.arguments);
          console.log("Computer Use extraction:", JSON.stringify(research));
        } else {
          // Fallback: try to extract from any text output
          console.warn("No function call in Computer Use response, falling back to heuristic");
          research = {
            website: candidateWebsite || null,
            linkedin_url: searchResults.find((r: any) => r.url?.includes("linkedin.com/company"))?.url || null,
          };
        }
      } else {
        // Standard LLM tool-calling path
        const researchPrompt = `You are a VC research analyst. Based on the following search results and website content, extract accurate company information.

COMPANY NAME: ${deal.name}
SECTOR: ${deal.sector}
STAGE: ${deal.stage}

SEARCH RESULTS:
${searchSummary}

${websiteContent ? `WEBSITE CONTENT:\n${websiteContent}` : ""}
${deckTextContext ? `\nDECK CONTEXT:\n${deckTextContext}` : ""}

Extract the company's official website URL and LinkedIn company page URL using the extract_company_research tool. Only return URLs you are confident about. Return null for any field you cannot verify.`;

        const aiHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (config.isSapinsapin) {
          aiHeaders["X-API-Key"] = rawApiKey;
        } else {
          aiHeaders["Authorization"] = `Bearer ${rawApiKey}`;
        }

        const userContent: Array<Record<string, unknown>> = [{ type: "text", text: researchPrompt }];
        if (!config.isSapinsapin) {
          for (const url of previewImages.slice(0, 6)) {
            userContent.push({ type: "image_url", image_url: { url, detail: "low" } });
          }
        }

        const aiResponse = await fetch(`${config.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: aiHeaders,
          body: JSON.stringify({
            model: config.modelName,
            messages: [
              { role: "system", content: "You are a precise research analyst. Only return verified information." },
              { role: "user", content: userContent },
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
          console.error("AI API error:", aiResponse.status, errText);
          throw new Error(`AI API error [${aiResponse.status}]`);
        }

        const aiResult = await aiResponse.json();
        const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];

        if (!toolCall) {
          console.error("No tool call in response:", JSON.stringify(aiResult));
          throw new Error("No structured output from AI");
        }

        research = JSON.parse(toolCall.function.arguments);
        console.log("Custom agent extraction:", JSON.stringify(research));
      }
    }

    // Update deal with research results
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
    if (crunchbaseUrl) {
      updatePayload.crunchbase_url = crunchbaseUrl;
    }
    if (fundingTotal) {
      updatePayload.funding_total = fundingTotal;
    }
    if (lastFundingRound) {
      updatePayload.last_funding_round = lastFundingRound;
    }
    if (numEmployees && !deal.team_size) {
      updatePayload.team_size = numEmployees;
    }
    if (numEmployees) {
      updatePayload.num_employees = numEmployees;
    }
    if (investors) {
      updatePayload.investors = investors;
    }

    await adminClient
      .from("deals")
      .update(updatePayload)
      .eq("id", dealId)
      .eq("user_id", user.id);

    // Step 4: Extract key people (GPT web search primary, Firecrawl fallback)
    let people: { name: string; title: string | null; linkedin_url: string | null }[] = [];

    const openaiKey = Deno.env.get("OPENAI_API_KEY")?.trim().replace(/[\r\n]/g, "");

    if (openaiKey) {
      // GPT primary: use web_search tool to find key people
      try {
        console.log("Extracting key people via GPT web search…");
        const peoplePrompt = `Find the founders, CEO, CTO, and other C-suite executives of "${deal.name}". ${deal.sector ? `Sector: ${deal.sector}.` : ""} ${research.website ? `Website: ${research.website}.` : ""} ${research.linkedin_url ? `LinkedIn: ${research.linkedin_url}.` : ""}

Use web_search to find their names, titles, and LinkedIn profile URLs. Then call extract_people with verified results. Only include people you are confident about.`;

        const gptResponse = await fetch(`${OPENAI_BASE}/v1/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            tools: [
              { type: "web_search", name: "web_search" },
              {
                type: "function",
                name: "extract_people",
                description: "Extract key people at the company with their titles and LinkedIn URLs.",
                parameters: {
                  type: "object",
                  properties: {
                    people: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string", description: "Full name" },
                          title: { type: ["string", "null"], description: "Job title (CEO, CTO, Co-founder, etc.)" },
                          linkedin_url: { type: ["string", "null"], description: "LinkedIn profile URL" },
                        },
                        required: ["name", "title", "linkedin_url"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["people"],
                  additionalProperties: false,
                },
              },
            ],
            instructions: "You are a precise research analyst. Use web_search to find key people. When confident, call extract_people.",
            input: [{ role: "user", content: peoplePrompt }],
            max_output_tokens: 4096,
          }),
        });

        if (gptResponse.ok) {
          const gptResult = await gptResponse.json();
          const funcCall = gptResult.output?.find(
            (item: any) => item.type === "function_call" && item.name === "extract_people"
          );
          if (funcCall) {
            const parsed = JSON.parse(funcCall.arguments);
            people = parsed.people || [];
            console.log(`GPT extracted ${people.length} people`);
          } else {
            console.warn("No extract_people function call in GPT response, falling back to Firecrawl");
          }
        } else {
          console.error("GPT people search failed:", gptResponse.status, await gptResponse.text());
        }
      } catch (e) {
        console.error("GPT people extraction failed (non-fatal):", e);
      }
    }

    // Firecrawl fallback if GPT returned no people
    if (people.length === 0) {
      try {
        console.log("Falling back to Firecrawl for key people search…");
        const peopleSearchQuery = `"${deal.name}" founders CEO CTO site:linkedin.com/in`;
        const peopleSearchResponse = await fetch("https://api.firecrawl.dev/v1/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${firecrawlApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: peopleSearchQuery, limit: 10 }),
        });

        if (peopleSearchResponse.ok) {
          const peopleSearchData = await peopleSearchResponse.json();
          const peopleResults = peopleSearchData.data || peopleSearchData.results || [];
          console.log(`Firecrawl people search returned ${peopleResults.length} results`);

          for (const r of peopleResults) {
            if (r.url?.includes("linkedin.com/in/")) {
              // Extract name and title from search result title/description
              const titleText = r.title || "";
              // LinkedIn titles are often "Name - Title - Company | LinkedIn"
              const parts = titleText.split(" - ");
              const personName = parts[0]?.replace(/\s*\|.*$/, "").trim();
              const personTitle = parts.length > 1 ? parts[1]?.replace(/\s*\|.*$/, "").trim() : null;

              if (personName && personName.length > 1 && personName.length < 60) {
                people.push({
                  name: personName,
                  title: personTitle || null,
                  linkedin_url: r.url,
                });
              }
            }
          }
          // Deduplicate by linkedin_url
          const seen = new Set<string>();
          people = people.filter(p => {
            const key = p.linkedin_url || p.name;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          console.log(`Firecrawl extracted ${people.length} people after dedup`);
        }
      } catch (e) {
        console.error("Firecrawl people search failed (non-fatal):", e);
      }
    }

    // Store people in deal_people table
    if (people.length > 0) {
      // Delete existing people for this deal first
      await adminClient.from("deal_people").delete().eq("deal_id", dealId);

      const rows = people.slice(0, 10).map(p => ({
        deal_id: dealId,
        user_id: user.id,
        name: p.name,
        title: p.title,
        linkedin_url: p.linkedin_url,
      }));

      const { error: insertError } = await adminClient.from("deal_people").insert(rows);
      if (insertError) {
        console.error("Failed to insert deal people:", insertError);
      } else {
        console.log(`Stored ${rows.length} people for deal ${dealId}`);
      }
    }

    return new Response(
      JSON.stringify({ success: true, provider, research, crunchbase: { crunchbaseUrl, fundingTotal, lastFundingRound, numEmployees }, people }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("deep-research error:", error);

    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
