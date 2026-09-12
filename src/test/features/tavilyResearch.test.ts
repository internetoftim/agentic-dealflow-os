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
    expect(dr).toMatch(/if \(openaiKey && provider !== "tavily"\)/);
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
});
