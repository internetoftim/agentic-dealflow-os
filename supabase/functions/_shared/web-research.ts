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

/**
 * Tavily has no `site:` operator. The domain becomes include_domains; a path
 * (e.g. linkedin.com/company) becomes a post-filter, because Tavily only
 * scopes by host and would otherwise return personal posts before pages.
 */
function splitSiteOperator(query: string): { query: string; domains: string[]; pathPrefixes: string[] } {
  const domains: string[] = [];
  const pathPrefixes: string[] = [];
  const cleaned = query
    .replace(/site:(\S+)/g, (_m, site: string) => {
      const [domain, ...rest] = site.split("/");
      domains.push(domain);
      if (rest.length) pathPrefixes.push(`${domain}/${rest.join("/")}`);
      return "";
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  return { query: cleaned || query, domains, pathPrefixes };
}

function matchesPathPrefix(url: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true;
  const bare = url.replace(/^https?:\/\/(www\.)?/, "");
  return prefixes.some((p) => bare.startsWith(p));
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
    const { query: q, domains, pathPrefixes } = splitSiteOperator(query);
    const body: Record<string, unknown> = {
      query: q,
      // Over-fetch when a path filter will discard some results.
      max_results: Math.min(Math.max(limit * (pathPrefixes.length ? 3 : 1), 1), 20),
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
      .filter((r: any) => typeof r?.url === "string" && matchesPathPrefix(r.url, pathPrefixes))
      .slice(0, limit)
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
    const content = data.results?.[0]?.raw_content;
    if (!content) {
      const why = data.failed_results?.[0]?.error ?? "no content returned";
      throw new Error(`Tavily extract failed for ${url}: ${why}`);
    }
    return content;
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

// ---------------------------------------------------------------- company lookup

/** Hosts that show up for any company search but are never its own site. */
const AGGREGATOR_HOSTS = [
  "linkedin.com", "crunchbase.com", "pitchbook.com", "wikipedia.org", "facebook.com", "twitter.com", "x.com",
  "instagram.com", "youtube.com", "glassdoor.com", "indeed.com", "g2.com", "producthunt.com", "ycombinator.com",
  "techcrunch.com", "bloomberg.com", "reuters.com", "medium.com", "github.com", "tracxn.com", "cbinsights.com",
  "apollo.io", "zoominfo.com", "rocketreach.co", "owler.com", "craft.co", "dealroom.co", "angel.co", "wellfound.com",
];
const isAggregator = (url: string) => {
  try { const h = new URL(url).hostname.replace(/^www\./, ""); return AGGREGATOR_HOSTS.some((a) => h === a || h.endsWith(`.${a}`)); }
  catch { return true; }
};
/** Subdomains that are never the marketing homepage; collapse them to the apex. */
const UTILITY_SUBDOMAINS = /^(www|docs|doc|app|blog|help|support|status|api|developer|developers|dev|careers|jobs|community|forum|learn|shop|store|console|dashboard|portal|mail|cdn|static)\./i;
const toOrigin = (url: string) => {
  try {
    const u = new URL(url);
    let host = u.hostname;
    // Strip one layer of utility subdomain when an apex remains (docs.tavily.com → tavily.com).
    if (UTILITY_SUBDOMAINS.test(host) && host.split(".").length >= 3) host = host.replace(UTILITY_SUBDOMAINS, "");
    return `${u.protocol}//${host}`;
  } catch { return url; }
};
const nameTokens = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

const hostHasToken = (url: string, tokens: string[]) => {
  try { const h = new URL(url).hostname.toLowerCase(); return tokens.some((t) => h.includes(t)); } catch { return false; }
};
const linkedinCompanySlug = (url: string) => {
  const m = url.match(/linkedin\.com\/company\/([^/?#]+)/i);
  return m ? `https://www.linkedin.com/company/${m[1]}` : null;
};

/**
 * Official website + LinkedIn company page from search alone, verified:
 * candidates are ranked (hostname containing the company name first, then
 * non-aggregator results that mention it), and the first whose homepage
 * actually names the company wins. Same verification process-deck uses,
 * without an LLM in the loop.
 */
export async function findCompanyUrls(
  web: WebResearch,
  opts: { name: string; sector?: string | null; knownWebsite?: string | null; seed?: SearchResult[] },
): Promise<{ website: string | null; linkedin_url: string | null }> {
  const tokens = nameTokens(opts.name);
  const lower = opts.name.toLowerCase();
  const mentions = (text: string) => {
    const hay = text.toLowerCase();
    return hay.includes(lower) || (tokens.length > 0 && tokens.every((t) => hay.includes(t)));
  };

  let website: string | null = opts.knownWebsite ? toOrigin(opts.knownWebsite) : null;
  if (!website) {
    const pool: SearchResult[] = [...(opts.seed ?? [])];
    const queries = [`"${opts.name}" official website${opts.sector ? ` ${opts.sector}` : ""}`, opts.name];
    for (const q of queries) {
      try { pool.push(...(await web.search(q, 8))); } catch (e) { console.warn("website search failed:", e); }
    }
    const seen = new Set<string>();
    const candidates = pool
      .filter((r) => !isAggregator(r.url) && mentions(`${r.title} ${r.description} ${r.url}`))
      .map((r) => ({ origin: toOrigin(r.url), score: hostHasToken(r.url, tokens) ? 2 : 1 }))
      .filter((c) => { if (seen.has(c.origin)) return false; seen.add(c.origin); return true; })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    for (const c of candidates) {
      try {
        const page = (await web.scrape(c.origin)).slice(0, 20_000);
        if (mentions(page)) { website = c.origin; break; }
      } catch (e) { console.warn(`verify ${c.origin} failed:`, e); }
    }
    // No candidate could be verified: only accept a hostname match, never a blog about the company.
    if (!website) website = candidates.find((c) => c.score === 2)?.origin ?? null;
  }

  let linkedin: string | null = null;
  for (const r of opts.seed ?? []) { const slug = linkedinCompanySlug(r.url); if (slug) { linkedin = slug; break; } }
  if (!linkedin) {
    try {
      const hits = await web.search(`"${opts.name}" site:linkedin.com/company`, 3);
      const preferred = hits.find((r) => linkedinCompanySlug(r.url) && mentions(`${r.title} ${r.description} ${r.url}`)) ?? hits.find((r) => linkedinCompanySlug(r.url));
      linkedin = preferred ? linkedinCompanySlug(preferred.url) : null;
    } catch (e) { console.warn("linkedin search failed:", e); }
  }
  return { website, linkedin_url: linkedin };
}
