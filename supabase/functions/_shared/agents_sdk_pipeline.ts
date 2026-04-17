/**
 * Agents SDK reference pipeline for deal extraction + deep research.
 *
 * Note: this module is intentionally not wired into handlers yet.
 * It is designed for phased migration from inline prompt/tool orchestration
 * in process-deck and deep-research edge functions.
 */
import { Agent, run, tool } from "npm:@openai/agents";
import { z } from "npm:zod";

const DeckMetadataSchema = z.object({
  startup_name: z.string().min(1),
  website: z.string().url().nullable(),
  stage: z.enum(["Pre-Seed", "Seed", "Series A", "Series B", "Series C", "Growth", "Unknown"]),
  sector: z.string().min(1),
  ask_amount: z.string().nullable(),
  valuation: z.string().nullable(),
  revenue: z.string().nullable(),
  growth: z.string().nullable(),
  team_size: z.string().nullable(),
  page_count: z.number().int().nonnegative(),
  confidence_score: z.number().min(0).max(100),
});

const CompanyResearchSchema = z.object({
  website: z.string().url().nullable(),
  linkedin_url: z.string().url().nullable(),
  crunchbase_url: z.string().url().nullable(),
  funding_total: z.string().nullable(),
  last_funding_round: z.string().nullable(),
  num_employees: z.string().nullable(),
  investors: z.string().nullable(),
});

const PersonSchema = z.object({
  name: z.string().min(1),
  title: z.string().nullable(),
  linkedin_url: z.string().url().nullable(),
});

const KeyPeopleSchema = z.object({
  people: z.array(PersonSchema).max(10),
});

export type DeckMetadata = z.infer<typeof DeckMetadataSchema>;
export type CompanyResearch = z.infer<typeof CompanyResearchSchema>;
export type KeyPeople = z.infer<typeof KeyPeopleSchema>;

export type DealResearchInput = {
  companyName: string;
  sector?: string | null;
  stage?: string | null;
  deckText?: string;
  previewImages?: string[];
};

export type DealResearchOutput = {
  metadata: DeckMetadata;
  companyResearch: CompanyResearch;
  keyPeople: KeyPeople;
};

/**
 * Optional Firecrawl bridge if you still want deterministic scrape/search in the loop.
 * You can inject real implementations from the edge function runtime.
 */
export function createDealResearchPipeline(deps: {
  firecrawlSearch?: (query: string, limit?: number) => Promise<unknown>;
  firecrawlScrape?: (url: string) => Promise<unknown>;
}) {
  const firecrawlSearchTool = tool({
    name: "firecrawl_search",
    description: "Search the web via Firecrawl and return result snippets.",
    parameters: z.object({ query: z.string(), limit: z.number().int().positive().max(10).default(5) }),
    execute: async ({ query, limit }) => {
      if (!deps.firecrawlSearch) return { error: "firecrawl_search unavailable" };
      return await deps.firecrawlSearch(query, limit);
    },
  });

  const firecrawlScrapeTool = tool({
    name: "firecrawl_scrape",
    description: "Scrape page main content via Firecrawl.",
    parameters: z.object({ url: z.string().url() }),
    execute: async ({ url }) => {
      if (!deps.firecrawlScrape) return { error: "firecrawl_scrape unavailable" };
      return await deps.firecrawlScrape(url);
    },
  });

  const extractionAgent = new Agent({
    name: "deck-extraction-agent",
    instructions:
      "Extract startup deck metadata precisely. Return null for unknown fields. Prefer grounded facts from text/images only.",
    model: "gpt-5.4",
    outputType: DeckMetadataSchema,
  });

  const companyResearchAgent = new Agent({
    name: "company-research-agent",
    instructions:
      "Find official company website, LinkedIn company page, and funding context. Use tools to verify. Never guess.",
    model: "gpt-5.4",
    tools: [
      { type: "web_search" },
      firecrawlSearchTool,
      firecrawlScrapeTool,
    ],
    outputType: CompanyResearchSchema,
  });

  const peopleAgent = new Agent({
    name: "people-research-agent",
    instructions:
      "Find founders and executives with best-effort LinkedIn profile URLs. Only include confident matches.",
    model: "gpt-5.4",
    tools: [{ type: "web_search" }, firecrawlSearchTool],
    outputType: KeyPeopleSchema,
  });

  return {
    async runAll(input: DealResearchInput): Promise<DealResearchOutput> {
      const extractionPrompt = JSON.stringify({
        company_name_hint: input.companyName,
        sector_hint: input.sector ?? null,
        stage_hint: input.stage ?? null,
        deck_text: (input.deckText ?? "").slice(0, 50_000),
        preview_images: (input.previewImages ?? []).slice(0, 8),
      });

      const metadataRun = await run(extractionAgent, extractionPrompt);
      const companyRun = await run(
        companyResearchAgent,
        `Company: ${input.companyName}\nSector: ${input.sector ?? "unknown"}\nStage: ${input.stage ?? "unknown"}`,
      );
      const peopleRun = await run(
        peopleAgent,
        `Find key people for ${input.companyName}. Website hint: ${(companyRun.finalOutput as CompanyResearch).website ?? "unknown"}`,
      );

      return {
        metadata: metadataRun.finalOutput as DeckMetadata,
        companyResearch: companyRun.finalOutput as CompanyResearch,
        keyPeople: peopleRun.finalOutput as KeyPeople,
      };
    },
  };
}
