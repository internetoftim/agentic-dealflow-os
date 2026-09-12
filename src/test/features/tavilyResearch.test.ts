import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");

describe("Tavily is the research engine wherever OpenAI was doing web search", () => {
  const dr = read("supabase/functions/deep-research/index.ts");
  const pd = read("supabase/functions/process-deck/index.ts");
  const wr = read("supabase/functions/_shared/web-research.ts");

  it("deep-research defaults to the tavily provider whenever the key is configured", () => {
    expect(dr).toMatch(/return tavilyAvailable \? "tavily" : "custom";/);
    expect(dr).toMatch(/resolveDeepResearchProvider\(settings\?\.deep_research_provider, !!tavilyApiKey\)/);
  });

  it("company URLs and key people come from search under tavily, not the OpenAI Responses API", () => {
    expect(dr).toMatch(/provider === "tavily"\) \{[\s\S]*?findCompanyUrls\(web/);
    expect(dr).toMatch(/if \(people\.length === 0 && openaiKey && provider !== "tavily"\)/);
  });

  it("process-deck skips the GPT-5 web search when Tavily is available", () => {
    expect(pd).toMatch(/if \(openaiApiKey && !tavilyApiKey\)/);
  });

  it("web-research keeps site: paths as a post-filter and surfaces extract failures", () => {
    expect(wr).toMatch(/pathPrefixes\.push\(/);
    expect(wr).toMatch(/matchesPathPrefix\(r\.url, pathPrefixes\)/);
    expect(wr).toMatch(/throw new Error\(`Tavily extract failed for/);
  });

  it("findCompanyUrls never returns an aggregator as the official site", () => {
    const list = wr.slice(wr.indexOf("const AGGREGATOR_HOSTS"), wr.indexOf("];", wr.indexOf("const AGGREGATOR_HOSTS")));
    for (const h of ["linkedin.com", "crunchbase.com", "pitchbook.com", "wikipedia.org", "ycombinator.com"]) expect(list).toContain(h);
    expect(wr).toMatch(/!isAggregator\(r\.url\) && mentions\(/);
    // A website is only accepted after its homepage is fetched and names the company.
    expect(wr).toMatch(/const page = \(await web\.scrape\(c\.origin\)\)[\s\S]*?if \(mentions\(page\)\) \{ website = c\.origin; break; \}/);
    expect(wr).toMatch(/UTILITY_SUBDOMAINS/);
  });

  it("Settings offers Tavily as the default provider", () => {
    const st = read("src/pages/SettingsPage.tsx");
    expect(st).toMatch(/value: "tavily" as const/);
    expect(st).toMatch(/deep_research_provider \?\? "tavily"/);
  });

  describe("Tavily Research API is the primary source of the company profile", () => {
    it("deep-research starts the research call up front and prefers its fields over scraping", () => {
      expect(dr).toMatch(/const profilePromise: Promise<CompanyProfile \| null> = provider === "tavily" && tavilyApiKey/);
      expect(dr).toMatch(/fundingTotal = profile\.funding_total;/);
      expect(dr).toMatch(/if \(crunchbaseUrl && !\(profile && \(fundingTotal \|\| investors\)\)\)/);
      expect(dr).toMatch(/if \(profile\?\.latest_articles\.length\) \{/);
      expect(dr).toMatch(/if \(profile\?\.key_people\.length\) \{/);
      expect(dr).toMatch(/if \(people\.length === 0 && openaiKey && provider !== "tavily"\)/);
    });

    it("the output schema satisfies Tavily's validator (no top-level type, descriptions everywhere)", () => {
      const schema = wr.slice(wr.indexOf("const COMPANY_PROFILE_SCHEMA"), wr.indexOf("const cleanUrl"));
      expect(schema).not.toMatch(/^\s*type: "object",\s*$/m); // top level has only properties/required
      // Every typed node (properties and array items, nested included) carries a description.
      const typed = (schema.match(/type: "/g) ?? []).length;
      const described = (schema.match(/description: "/g) ?? []).length;
      expect(typed).toBeGreaterThanOrEqual(12);
      expect(described).toBeGreaterThanOrEqual(typed);
      expect(schema).toMatch(/required: \["website", "linkedin_url", "investors", "latest_articles", "key_people"\]/);
    });

    it("polls GET /research/{id} and fails soft (null) on timeout or error", () => {
      expect(wr).toMatch(/`\$\{TAVILY_BASE\}\/research\/\$\{request_id\}`/);
      expect(wr).toMatch(/timed out for/);
      expect((wr.match(/return null;/g) ?? []).length).toBeGreaterThanOrEqual(5);
    });

    it("normalizes N/A-style placeholders and non-URLs out of the profile", () => {
      expect(wr).toMatch(/n\\\/a\|unknown\|none\|null\|not \(available\|found\|disclosed\)/);
      expect(wr).toMatch(/\^https\?:\\\/\\\//);
    });
  });

  describe("investor list sanity", () => {
    it("the research prompt excludes investor directories the company itself publishes", () => {
      expect(wr).toMatch(/Do NOT list investors merely mentioned, featured, or catalogued on the company's website/);
    });
    it("plausibleInvestors drops alphabetized directory dumps and keeps real cap tables", async () => {
      const { plausibleInvestors } = await import("../../../supabase/functions/_shared/web-research.ts");
      expect(plausibleInvestors(["11.2 Capital", "11 Tribes Ventures", "1776 Ventures", "1843 Capital", "1855 Capital Partners", "1955 Capital", "1Confirmation"])).toEqual([]);
      expect(plausibleInvestors(["GIC", "Accel", "Y Combinator", "Craft Ventures", "Felicis Ventures", "Peak XV Partners", "Coatue"])).toHaveLength(7);
      expect(plausibleInvestors(["Accel", "Sequoia"])).toEqual(["Accel", "Sequoia"]); // short sorted lists are fine
      expect(plausibleInvestors(["Accel", "Accel", " Sequoia "])).toEqual(["Accel", "Sequoia"]);
    });
  });

  describe("web-research behaviour (module imported, fetch mocked)", () => {
    async function client(responder: (url: string, init?: RequestInit) => unknown) {
      (globalThis as any).Deno = { env: { get: () => undefined } };
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        const body = responder(String(url), init);
        return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
      }));
      const { createWebResearch } = await import("../../../supabase/functions/_shared/web-research.ts");
      return createWebResearch({ tavilyApiKey: "tvly-test", firecrawlApiKey: "fc-test" });
    }

    it("translates site:domain/path into include_domains plus a path post-filter", async () => {
      const seen: any[] = [];
      const web = await client((url, init) => {
        if (url.endsWith("/search")) {
          seen.push(JSON.parse(String(init?.body)));
          return { results: [
            { url: "https://www.linkedin.com/posts/someone_supabase-activity-123", title: "post", content: "" },
            { url: "https://www.linkedin.com/company/supabase", title: "Supabase - LinkedIn", content: "" },
            { url: "https://www.linkedin.com/in/paulcopplestone", title: "Paul", content: "" },
          ] };
        }
        return {};
      });
      const hits = await web.search("site:linkedin.com/company Supabase", 3);
      expect(seen[0].include_domains).toEqual(["linkedin.com"]);
      expect(seen[0].query).toBe("Supabase");
      expect(seen[0].max_results).toBeGreaterThan(3); // over-fetch when a path filter will discard results
      expect(hits.map((h) => h.url)).toEqual(["https://www.linkedin.com/company/supabase"]);
    });

    it("falls back to Firecrawl when Tavily extract reports the page in failed_results", async () => {
      const calls: string[] = [];
      const web = await client((url) => {
        calls.push(url);
        if (url.endsWith("/extract")) return { results: [], failed_results: [{ url: "https://x.test/p", error: "404 page not found" }] };
        if (url.includes("firecrawl")) return { data: { markdown: "# from firecrawl" } };
        return {};
      });
      expect(await web.scrape("https://x.test/p")).toBe("# from firecrawl");
      expect(calls.some((c) => c.includes("api.tavily.com/extract"))).toBe(true);
      expect(calls.some((c) => c.includes("api.firecrawl.dev/v1/scrape"))).toBe(true);
    });

    it("surfaces the extract failure when no fallback provider exists", async () => {
      (globalThis as any).Deno = { env: { get: () => undefined } };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [], failed_results: [{ url: "u", error: "404 page not found" }] }), { status: 200 })));
      const { createWebResearch } = await import("../../../supabase/functions/_shared/web-research.ts");
      const web = createWebResearch({ tavilyApiKey: "tvly-test", firecrawlApiKey: null });
      await expect(web.scrape("https://x.test/p")).rejects.toThrow(/404 page not found/);
    });
  });
});
