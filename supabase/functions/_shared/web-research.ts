/**
 * Web search + page extraction for the deep-research flows.
 *
 * Provider selection: Tavily when TAVILY_API_KEY is configured, otherwise
 * Firecrawl. When both keys exist, Tavily is primary and Firecrawl is a
 * per-call fallback, so a Tavily outage degrades instead of failing the run.
 * Results are normalised to one shape so callers never see provider details.
 */

const TAVILY_BASE = "https://api.tavily.com";
const FIRECRAWL_BASE = "https://api.firecrawl.dev/v1";
const REQUEST_TIMEOUT_MS = 20_000;

export interface SearchResult {
  url: string;
  title: string;
  description: string;
  metadata?: { source?: string | null };
}

export interface WebResearch {
  /** Which provider serves as primary — for logging. */
  provider: "tavily" | "firecrawl";
  /** Search the web. Returns [] on a soft failure, throws only if every configured provider fails. */
  search(query: string, limit: number): Promise<SearchResult[]>;
  /** Fetch a page as markdown/text. Returns "" when the page can't be extracted. */
  scrape(url: string): Promise<string>;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Tavily has no `site:` operator; translate it to include_domains. */
function splitSiteOperator(query: string): { query: string; domains: string[] } {
  const domains: string[] = [];
  const cleaned = query
    .replace(/site:(\S+)/g, (_m, site: string) => {
      // "crunchbase.com/organization" → domain "crunchbase.com"
      domains.push(site.split("/")[0]);
      return "";
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  return { query: cleaned || query, domains };
}

export function createWebResearch(opts: {
  tavilyApiKey?: string | null;
  firecrawlApiKey?: string | null;
}): WebResearch {
  const tavilyKey = opts.tavilyApiKey?.trim() || null;
  const firecrawlKey = opts.firecrawlApiKey?.trim() || null;

  if (!tavilyKey && !firecrawlKey) {
    throw new Error("Neither TAVILY_API_KEY nor FIRECRAWL_API_KEY is configured");
  }

  const tavilySearch = async (query: string, limit: number): Promise<SearchResult[]> => {
    const { query: q, domains } = splitSiteOperator(query);
    const body: Record<string, unknown> = {
      query: q,
      max_results: Math.min(Math.max(limit, 1), 20),
      search_depth: "basic",
      include_answer: false,
    };
    if (domains.length > 0) body.include_domains = domains;

    const res = await fetchWithTimeout(`${TAVILY_BASE}/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tavilyKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Tavily search failed [${res.status}]: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    return (data.results ?? [])
      .filter((r: any) => typeof r?.url === "string")
      .map((r: any) => ({
        url: r.url,
        title: r.title ?? "",
        description: (r.content ?? "").slice(0, 400),
      }));
  };

  const tavilyScrape = async (url: string): Promise<string> => {
    const res = await fetchWithTimeout(`${TAVILY_BASE}/extract`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tavilyKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [url] }),
    }, 30_000);
    if (!res.ok) {
      throw new Error(`Tavily extract failed [${res.status}]: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    return data.results?.[0]?.raw_content ?? "";
  };

  const firecrawlCall = (path: "/search" | "/scrape", body: Record<string, unknown>) =>
    fetchWithTimeout(`${FIRECRAWL_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const firecrawlSearch = async (query: string, limit: number): Promise<SearchResult[]> => {
    const res = await firecrawlCall("/search", { query, limit });
    if (!res.ok) {
      throw new Error(`Firecrawl search failed [${res.status}]: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    return (data.data ?? data.results ?? [])
      .filter((r: any) => typeof r?.url === "string")
      .map((r: any) => ({
        url: r.url,
        title: r.title ?? "",
        description: r.description ?? "",
        metadata: r.metadata,
      }));
  };

  const firecrawlScrape = async (url: string): Promise<string> => {
    const res = await firecrawlCall("/scrape", { url, formats: ["markdown"], onlyMainContent: true });
    if (!res.ok) {
      throw new Error(`Firecrawl scrape failed [${res.status}]: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    return data.data?.markdown ?? data.markdown ?? "";
  };

  const provider: "tavily" | "firecrawl" = tavilyKey ? "tavily" : "firecrawl";

  const withFallback = async <T>(
    label: string,
    primary: () => Promise<T>,
    fallback: (() => Promise<T>) | null,
  ): Promise<T> => {
    try {
      return await primary();
    } catch (e) {
      if (fallback) {
        console.warn(`${label}: ${provider} failed, falling back to firecrawl:`, e);
        return await fallback();
      }
      throw e;
    }
  };

  return {
    provider,
    search: (query, limit) =>
      tavilyKey
        ? withFallback(`search "${query.slice(0, 60)}"`, () => tavilySearch(query, limit), firecrawlKey ? () => firecrawlSearch(query, limit) : null)
        : firecrawlSearch(query, limit),
    scrape: (url) =>
      tavilyKey
        ? withFallback(`scrape ${url}`, () => tavilyScrape(url), firecrawlKey ? () => firecrawlScrape(url) : null)
        : firecrawlScrape(url),
  };
}
