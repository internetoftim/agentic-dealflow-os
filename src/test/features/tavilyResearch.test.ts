import { describe, it, expect } from "vitest";
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
      const src = wr.slice(wr.indexOf("export function plausibleInvestors"), wr.indexOf("/**", wr.indexOf("export function plausibleInvestors")));
      const fn = new Function(`${src.replace("export function", "function")}; return plausibleInvestors;`)() as (n: string[]) => string[];
      expect(fn(["11.2 Capital", "11 Tribes Ventures", "1776 Ventures", "1843 Capital", "1855 Capital Partners", "1955 Capital", "1Confirmation"])).toEqual([]);
      expect(fn(["GIC", "Accel", "Y Combinator", "Craft Ventures", "Felicis Ventures", "Peak XV Partners", "Coatue"])).toHaveLength(7);
      expect(fn(["Accel", "Sequoia"])).toEqual(["Accel", "Sequoia"]); // short sorted lists are fine
      expect(fn(["Accel", "Accel", " Sequoia "])).toEqual(["Accel", "Sequoia"]);
    });
  });
});
