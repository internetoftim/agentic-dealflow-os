// Pure logic for the Claude Managed Agents sessions that capture decks and run
// deal diligence: what each session is given, how its results map back onto
// EasyVC's tables, and what to do when a session goes idle. No Deno, Supabase
// or SDK imports, so vitest can exercise all of it (src/test/features/agentSessions.test.ts).

import { filterExcludedArticles, filterExcludedInvestorString, filterExcludedNames, nameKey } from "./deal-agent-tools.ts";

export const DILIGENCE_VERSION = "diligence/2026-10-17.1";
export const CAPTURE_VERSION = "capture-agent/2026-10-17.2";

/** Hard spend caps per session, in US cents as the API expects ("1000" = $10.00). */
export const DILIGENCE_BUDGET_CENTS = "1000";
export const CAPTURE_BUDGET_CENTS = "300";

export const DILIGENCE_OUTCOME_DESCRIPTION =
  "Run diligence on the deal described in /mnt/session/inputs/deal.json (deck at /mnt/session/inputs/deck.pdf when present). " +
  "Write /mnt/session/outputs/diligence.json and /mnt/session/outputs/memo.md as your instructions describe.";

// Starter rubric - tune it with the eval (see managed-agents/README.md).
export const DILIGENCE_RUBRIC = `# Deal diligence rubric (starter - tune with the eval)
- /mnt/session/outputs/diligence.json exists, is valid JSON, and has every top-level key: company, founders, claims, market, competitors, news, risks, gaps, recommendation, summary.
- company identifies the right company (name and website match the deck), or identity_notes explains the ambiguity.
- Every founder named in the deck has an entry with a background drawn from at least two independent sources, or an explicit statement that nothing could be found.
- Every quantitative claim in the deck (revenue, growth, customers, team size, funding) appears in claims with its slide number, a verdict of verified, contradicted or unverifiable, and at least one source URL (unverifiable entries say what was searched).
- market gives TAM, SAM and SOM both bottom-up and top-down, with stated assumptions and a cited source for every input, and explains any gap larger than 2x between the two.
- competitors lists at least five companies or alternatives, each with funding and differentiation and a source.
- Every claim marked contradicted and every high-severity founder red flag also appears in risks.
- /mnt/session/outputs/memo.md has all nine sections (Executive Summary, Market, Product & Traction, Team, Business Model, Competition, Risks, Investment Thesis, Recommendation), and its Market, Team, Competition and Risks sections cite research sources as links, not only the deck.
- gaps names what could not be verified; nothing is presented as fact on a single weak source.
`;

// ------------------------------------------------------------------ inputs

export type DealRow = Record<string, unknown> & { id: string; name?: string | null };
export type PersonRow = { name: string; title?: string | null; linkedin_url?: string | null; manual?: boolean | null };
export type SourceRow = { extracted_text?: string | null; is_primary?: boolean | null; source_type?: string | null };

const DEAL_INPUT_FIELDS = [
  "name", "website", "linkedin_url", "crunchbase_url", "stage", "sector", "source", "ask_amount", "valuation",
  "revenue", "growth", "nrr", "team_size", "funding_total", "last_funding_round", "num_employees", "investors",
] as const;

/** Extracted deck text handed to the agent is capped so one huge data room can't blow the context. */
export const MAX_INPUT_TEXT_CHARS = 120_000;

/** deal.json - everything EasyVC already knows about the deal, for the diligence session. */
export function buildDealInput(deal: DealRow, people: PersonRow[], sources: SourceRow[], notes: string[] = []) {
  const fields: Record<string, unknown> = {};
  for (const key of DEAL_INPUT_FIELDS) {
    const value = deal[key];
    if (value !== null && value !== undefined && value !== "") fields[key] = value;
  }
  const ordered = [...sources].sort((a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)));
  let text = ordered.map((s) => (s.extracted_text ?? "").trim()).filter(Boolean).join("\n\n---\n\n");
  const truncated = text.length > MAX_INPUT_TEXT_CHARS;
  if (truncated) text = text.slice(0, MAX_INPUT_TEXT_CHARS);
  return {
    deal_id: deal.id,
    ...fields,
    people: people.map((p) => ({ name: p.name, title: p.title ?? null, linkedin_url: p.linkedin_url ?? null, added_by_user: Boolean(p.manual) })),
    investor_notes: notes.filter((n) => n.trim()).slice(0, 20),
    extracted_text: text,
    extracted_text_truncated: truncated,
  };
}

/** capture.json - what the capture agent needs to open the viewer. */
export function buildCaptureInput(args: { url: string; gateEmail?: string | null; passcode?: string | null; maxPages?: number }) {
  return {
    url: args.url,
    gate_email: args.gateEmail || null,
    passcode: args.passcode || null,
    max_pages: Math.min(Math.max(args.maxPages ?? 50, 1), 100),
  };
}

// ------------------------------------------------------------------ outputs

type Source = string;
export type Diligence = {
  company: {
    name: string; website: string | null; linkedin_url: string | null; crunchbase_url: string | null;
    funding_total: string | null; last_funding_round: string | null; num_employees: string | null;
    investors: string[]; identity_notes?: string;
  };
  founders: { name: string; title: string | null; linkedin_url: string | null; background?: string; red_flags?: { issue: string; severity: string; sources: Source[] }[]; sources?: Source[] }[];
  claims: { claim: string; slide: number | null; category?: string; verdict: "verified" | "contradicted" | "unverifiable"; evidence?: string; sources: Source[] }[];
  market: Record<string, unknown>;
  competitors: Record<string, unknown>[];
  news: { title: string; url: string; date?: string; source?: string }[];
  risks: { risk: string; severity: string; evidence?: string }[];
  gaps: string[];
  recommendation: "pass" | "follow_up" | "invest" | null;
  summary: string;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const isHttpUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim());
const VERDICTS = new Set(["verified", "contradicted", "unverifiable"]);
const RECOMMENDATIONS = new Set(["pass", "follow_up", "invest"]);

/**
 * Parses the agent's diligence.json defensively: the agent writes it, so any
 * field may be missing or the wrong type. Throws only when the file isn't a
 * JSON object at all - partial reports are still worth saving.
 */
export function parseDiligence(raw: string): Diligence {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("diligence.json is not valid JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("diligence.json is not a JSON object");
  const d = data as Record<string, unknown>;
  const c = obj(d.company);
  return {
    company: {
      name: str(c.name) ?? "",
      website: isHttpUrl(c.website) ? c.website.trim() : null,
      linkedin_url: isHttpUrl(c.linkedin_url) ? c.linkedin_url.trim() : null,
      crunchbase_url: isHttpUrl(c.crunchbase_url) ? c.crunchbase_url.trim() : null,
      funding_total: str(c.funding_total),
      last_funding_round: str(c.last_funding_round),
      num_employees: str(c.num_employees),
      investors: arr(c.investors).map(str).filter((s): s is string => Boolean(s)),
      identity_notes: str(c.identity_notes) ?? undefined,
    },
    founders: arr<Record<string, unknown>>(d.founders).filter((f) => str(f?.name)).map((f) => ({
      ...f,
      name: str(f.name)!,
      title: str(f.title),
      linkedin_url: isHttpUrl(f.linkedin_url) ? (f.linkedin_url as string).trim() : null,
    })) as Diligence["founders"],
    claims: arr<Record<string, unknown>>(d.claims).filter((c) => str(c?.claim)).map((c) => ({
      ...c,
      claim: str(c.claim)!,
      slide: typeof c.slide === "number" ? c.slide : null,
      verdict: (VERDICTS.has(String(c.verdict)) ? c.verdict : "unverifiable") as Diligence["claims"][number]["verdict"],
      sources: arr(c.sources).filter(isHttpUrl),
    })) as Diligence["claims"],
    market: obj(d.market),
    competitors: arr<Record<string, unknown>>(d.competitors).filter((x) => str(x?.name)),
    news: arr<Record<string, unknown>>(d.news).filter((n) => str(n?.title) && isHttpUrl(n?.url)).map((n) => ({
      title: str(n.title)!, url: (n.url as string).trim(), date: str(n.date) ?? undefined, source: str(n.source) ?? undefined,
    })),
    risks: arr<Record<string, unknown>>(d.risks).filter((r) => str(r?.risk)).map((r) => ({
      risk: str(r.risk)!, severity: str(r.severity) ?? "medium", evidence: str(r.evidence) ?? undefined,
    })),
    gaps: arr(d.gaps).map(str).filter((s): s is string => Boolean(s)),
    recommendation: RECOMMENDATIONS.has(String(d.recommendation)) ? (d.recommendation as Diligence["recommendation"]) : null,
    summary: str(d.summary) ?? "",
  };
}

/** Counts shown in the UI, the MCP tools and pipeline_runs metrics. */
export function diligenceMetrics(d: Diligence) {
  const verdicts = { verified: 0, contradicted: 0, unverifiable: 0 };
  for (const c of d.claims) verdicts[c.verdict] += 1;
  return {
    founders: d.founders.length,
    claims: d.claims.length,
    ...verdicts,
    competitors: d.competitors.length,
    risks: d.risks.length,
    high_risks: d.risks.filter((r) => r.severity === "high").length,
    sourced_claims: d.claims.filter((c) => c.sources.length > 0).length,
  };
}

/**
 * The deals-row update a finished diligence run makes. Mirrors what
 * deep-research wrote, so the existing UI keeps working: website is only filled
 * when empty, team_size only when empty, and anything the user excluded through
 * the deal agent stays out.
 */
export function dealPatchFromDiligence(d: Diligence, current: { website?: unknown; team_size?: unknown; research_exclusions?: unknown }) {
  const exclusions = current.research_exclusions;
  const patch: Record<string, unknown> = {
    deep_research_status: "completed",
    latest_articles: filterExcludedArticles(
      d.news.slice(0, 3).map((n) => ({ title: n.title, url: n.url, source: n.source ?? null, preview: null })),
      exclusions,
    ),
  };
  if (d.company.website && !current.website) patch.website = d.company.website;
  if (d.company.linkedin_url) patch.linkedin_url = d.company.linkedin_url;
  if (d.company.crunchbase_url) patch.crunchbase_url = d.company.crunchbase_url;
  if (d.company.funding_total) patch.funding_total = d.company.funding_total;
  if (d.company.last_funding_round) patch.last_funding_round = d.company.last_funding_round;
  if (d.company.num_employees) {
    patch.num_employees = d.company.num_employees;
    if (!current.team_size) patch.team_size = d.company.num_employees;
  }
  const investors = filterExcludedInvestorString(d.company.investors.join(", ") || null, exclusions);
  if (investors) patch.investors = investors;
  return patch;
}

/**
 * deal_people rows to insert for researched founders: excluded people and
 * anyone the user already added by hand are skipped, at most 10.
 */
export function peopleRowsFromDiligence(d: Diligence, manualNames: string[], exclusions: unknown, ids: { dealId: string; userId: string }) {
  const manual = new Set(manualNames.map(nameKey));
  return filterExcludedNames(d.founders, exclusions, "people")
    .filter((f) => !manual.has(nameKey(f.name)))
    .slice(0, 10)
    .map((f) => ({ deal_id: ids.dealId, user_id: ids.userId, name: f.name, title: f.title, linkedin_url: f.linkedin_url }));
}

export type CaptureReport =
  | { status: "ok"; title: string | null; page_count: number; source_type: string | null; previews: string[]; notes?: string }
  | { status: "failed"; reason: string };

export function parseCaptureReport(raw: string): CaptureReport {
  let data: Record<string, unknown>;
  try {
    data = obj(JSON.parse(raw));
  } catch {
    return { status: "failed", reason: "The capture agent wrote an unreadable capture.json." };
  }
  if (data.status !== "ok") {
    return { status: "failed", reason: str(data.reason) ?? "The capture agent could not capture this deck." };
  }
  const pageCount = typeof data.page_count === "number" && data.page_count > 0 ? Math.floor(data.page_count) : 0;
  return {
    status: "ok",
    title: str(data.title),
    page_count: pageCount,
    source_type: str(data.source_type),
    previews: arr(data.previews).map(str).filter((s): s is string => Boolean(s && /^preview-\d+\.(jpe?g|png)$/i.test(s))).slice(0, 6),
    notes: str(data.notes) ?? undefined,
  };
}

// ------------------------------------------------------------------ session lifecycle

export type SessionKind = "capture" | "conversion" | "diligence";

/** Session metadata we set at create time and read back in the webhook (string values, at most 16 keys). */
export function sessionMetadata(kind: SessionKind, ids: Record<string, string | null | undefined>): Record<string, string> {
  const meta: Record<string, string> = { app: "easyvc", kind };
  for (const [k, v] of Object.entries(ids)) if (v) meta[k] = String(v).slice(0, 512);
  return meta;
}

export function readSessionKind(metadata: unknown): SessionKind | null {
  const kind = obj(metadata).kind;
  return kind === "capture" || kind === "conversion" || kind === "diligence" ? kind : null;
}

/**
 * What to do when a session goes idle, from the latest session.status_idle
 * event's stop_reason. Sessions run unattended, so a tool call the server
 * couldn't judge (requires_action) is denied rather than left waiting forever.
 */
export type IdleAction = "collect" | "deny_pending" | "budget_reached" | "failed";
export function idleAction(stopReasonType: string | null | undefined): IdleAction {
  switch (stopReasonType) {
    case "end_turn": return "collect";
    case "requires_action": return "deny_pending";
    case "budget_reached": return "budget_reached";
    default: return "failed";
  }
}

export function failureMessage(action: IdleAction, stopReasonType: string | null | undefined): string {
  if (action === "budget_reached") return "Stopped at the per-run spending cap before finishing.";
  if (stopReasonType === "refusal") return "The agent declined this request.";
  if (stopReasonType === "retries_exhausted") return "The agent hit repeated errors and gave up.";
  return `The agent stopped unexpectedly (${stopReasonType ?? "unknown reason"}).`;
}

/** One file per filename, keeping the most recently created (session file listings can repeat a name). */
export function newestByFilename<T extends { filename: string; created_at: string }>(files: T[]): T[] {
  const newest = new Map<string, T>();
  for (const f of files) {
    const seen = newest.get(f.filename);
    if (!seen || f.created_at > seen.created_at) newest.set(f.filename, f);
  }
  return [...newest.values()];
}

export function consoleSessionUrl(workspaceId: string | null | undefined, sessionId: string): string {
  return `https://platform.claude.com/workspaces/${workspaceId || "default"}/sessions/${sessionId}`;
}
