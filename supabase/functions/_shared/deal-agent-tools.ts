// The deal agent: a conversational way to refine a deal's data room.
// "This article isn't relevant", "the stage is Series A", "remove that
// investor", "add Jane Doe as CTO" — the model turns the request into one of
// the tool calls below and the deal-agent edge function executes it against
// the single deal the user is looking at.
//
// Everything here is pure (no Deno/Supabase imports): tool schemas, argument
// sanitising and the reducers that compute the new state. The edge function
// only does I/O, so the rules are unit-tested.

// ------------------------------------------------------------------ shapes
export type Article = { title: string; url: string; source?: string | null; preview?: string | null };
export type InvestorProfile = { name: string; linkedin_url?: string | null; crunchbase_url?: string | null; tracxn_url?: string | null };
export type Person = { id?: string; name: string; title?: string | null; linkedin_url?: string | null; manual?: boolean | null };
export type Exclusions = { articles: string[]; investors: string[]; people: string[] };

/** `revisionId` is set when the action changed data: it is what Undo refers to. */
export type AgentAction = { tool: string; ok: boolean; summary: string; revisionId?: string | null };

// ------------------------------------------------------------------ fields
/** Deal fields the agent may set. Anything else (ids, status, ownership) is ignored. */
export const EDITABLE_FIELDS = [
  "name", "stage", "sector", "ask_amount", "valuation", "revenue", "growth", "nrr", "team_size",
  "num_employees", "website", "linkedin_url", "crunchbase_url", "funding_total", "last_funding_round",
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

const URL_FIELDS = new Set<string>(["website", "linkedin_url", "crunchbase_url"]);
const REQUIRED_TEXT = new Set<string>(["name", "stage", "sector"]);

/**
 * Whitelist and normalise a field update. null (or "") clears an optional
 * field; required text fields cannot be cleared; URLs must be http(s).
 */
export function sanitizeFieldUpdates(input: unknown): { updates: Record<string, string | null>; rejected: string[] } {
  const updates: Record<string, string | null> = {};
  const rejected: string[] = [];
  if (!input || typeof input !== "object") return { updates, rejected };
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!(EDITABLE_FIELDS as readonly string[]).includes(key)) { rejected.push(key); continue; }
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      if (REQUIRED_TEXT.has(key)) rejected.push(key);
      else updates[key] = null;
      continue;
    }
    if (typeof raw !== "string" && typeof raw !== "number") { rejected.push(key); continue; }
    const value = String(raw).trim().slice(0, 500);
    if (URL_FIELDS.has(key)) {
      const url = normalizeHttpUrl(value);
      if (!url) { rejected.push(key); continue; }
      updates[key] = url;
      continue;
    }
    updates[key] = value;
  }
  return { updates, rejected };
}

export function normalizeHttpUrl(value: string): string | null {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ matching
/** Compare URLs ignoring scheme, www, trailing slash, query and fragment. */
export function urlKey(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function nameKey(name: string): string {
  return name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ------------------------------------------------------------------ articles
/**
 * Remove articles by their 1-based number (as shown to the model and the
 * user), by URL, or by a title fragment. Returns what stays and what went.
 */
export function removeArticles(
  articles: Article[],
  sel: { numbers?: unknown; urls?: unknown; title_contains?: unknown },
): { kept: Article[]; removed: Article[] } {
  const numbers = new Set((Array.isArray(sel.numbers) ? sel.numbers : []).map((n) => Number(n)).filter((n) => Number.isInteger(n)));
  const urls = new Set((Array.isArray(sel.urls) ? sel.urls : []).filter((u): u is string => typeof u === "string").map(urlKey));
  const fragment = typeof sel.title_contains === "string" ? sel.title_contains.trim().toLowerCase() : "";
  const kept: Article[] = [];
  const removed: Article[] = [];
  articles.forEach((a, i) => {
    const hit = numbers.has(i + 1) || urls.has(urlKey(a.url)) || (fragment.length >= 3 && (a.title ?? "").toLowerCase().includes(fragment));
    (hit ? removed : kept).push(a);
  });
  return { kept, removed };
}

export function addArticle(articles: Article[], input: { title?: unknown; url?: unknown; source?: unknown }): { articles: Article[]; added?: Article; error?: string } {
  const url = typeof input.url === "string" ? normalizeHttpUrl(input.url.trim()) : null;
  if (!url) return { articles, error: "A valid http(s) URL is required" };
  if (articles.some((a) => urlKey(a.url) === urlKey(url))) return { articles, error: "That article is already listed" };
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 300) : url;
  const added: Article = { title, url, source: typeof input.source === "string" ? input.source.trim().slice(0, 120) || null : null, preview: null };
  return { articles: [added, ...articles], added };
}

// ------------------------------------------------------------------ investors
export function splitInvestors(investors: string | null | undefined): string[] {
  return (investors ?? "").split(/,|;|\||•/g).map((n) => n.trim()).filter((n) => n.length > 1);
}

export function applyInvestorChanges(
  investors: string | null | undefined,
  profiles: InvestorProfile[] | null | undefined,
  change: { add?: unknown; remove?: unknown },
): { investors: string | null; profiles: InvestorProfile[]; added: string[]; removed: string[] } {
  const toRemove = new Set((Array.isArray(change.remove) ? change.remove : []).filter((n): n is string => typeof n === "string").map(nameKey));
  const current = splitInvestors(investors);
  const removed = current.filter((n) => toRemove.has(nameKey(n)));
  let names = current.filter((n) => !toRemove.has(nameKey(n)));
  let nextProfiles = (profiles ?? []).filter((p) => !toRemove.has(nameKey(p.name)));
  for (const p of profiles ?? []) if (toRemove.has(nameKey(p.name)) && !removed.some((r) => nameKey(r) === nameKey(p.name))) removed.push(p.name);

  const added: string[] = [];
  for (const raw of Array.isArray(change.add) ? change.add : []) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().slice(0, 120);
    if (name.length < 2 || names.some((n) => nameKey(n) === nameKey(name))) continue;
    names = [...names, name];
    if (!nextProfiles.some((p) => nameKey(p.name) === nameKey(name))) nextProfiles = [...nextProfiles, { name, linkedin_url: null, crunchbase_url: null, tracxn_url: null }];
    added.push(name);
  }
  return { investors: names.length ? names.join(", ") : null, profiles: nextProfiles, added, removed };
}

// ------------------------------------------------------------------ exclusions
// What the user told the agent is not relevant. Deep research rebuilds news,
// investors and people on every run; without this list a removed item would
// simply come back.
export function readExclusions(raw: unknown): Exclusions {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { articles: list(r.articles), investors: list(r.investors), people: list(r.people) };
}

export function mergeExclusions(current: unknown, add: Partial<Exclusions>): Exclusions {
  const base = readExclusions(current);
  const dedupe = (existing: string[], extra: string[] | undefined, key: (s: string) => string) => {
    const seen = new Set(existing.map(key));
    const out = [...existing];
    for (const v of extra ?? []) if (!seen.has(key(v))) { seen.add(key(v)); out.push(v); }
    return out.slice(-200);
  };
  return {
    articles: dedupe(base.articles, add.articles, urlKey),
    investors: dedupe(base.investors, add.investors, nameKey),
    people: dedupe(base.people, add.people, nameKey),
  };
}

export function withoutExclusion(current: unknown, kind: keyof Exclusions, value: string): Exclusions {
  const base = readExclusions(current);
  const key = kind === "articles" ? urlKey : nameKey;
  return { ...base, [kind]: base[kind].filter((v) => key(v) !== key(value)) };
}

/** Applied by deep research to whatever it found, before saving. */
export function filterExcludedArticles<T extends { url: string }>(articles: T[], raw: unknown): T[] {
  const ex = new Set(readExclusions(raw).articles.map(urlKey));
  return articles.filter((a) => !ex.has(urlKey(a.url)));
}
export function filterExcludedNames<T extends { name: string }>(items: T[], raw: unknown, kind: "investors" | "people"): T[] {
  const ex = new Set(readExclusions(raw)[kind].map(nameKey));
  return items.filter((i) => !ex.has(nameKey(i.name)));
}
export function filterExcludedInvestorString(investors: string | null, raw: unknown): string | null {
  const ex = new Set(readExclusions(raw).investors.map(nameKey));
  const kept = splitInvestors(investors).filter((n) => !ex.has(nameKey(n)));
  return kept.length ? kept.join(", ") : null;
}

// ------------------------------------------------------------------ people
export function findPerson(people: Person[], name: unknown): Person | undefined {
  if (typeof name !== "string") return undefined;
  const key = nameKey(name);
  if (!key) return undefined;
  return people.find((p) => nameKey(p.name) === key) ?? people.find((p) => nameKey(p.name).includes(key));
}

// ------------------------------------------------------------------ memo
export function applyMemoEdit(current: string | null | undefined, input: { mode?: unknown; content?: unknown }): { memo: string | null; error?: string } {
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content) return { memo: current ?? null, error: "content is required" };
  if (input.mode === "replace") return { memo: content.slice(0, 60_000) };
  return { memo: `${current ? `${current.trimEnd()}\n\n` : ""}${content}`.slice(0, 60_000) };
}

// ------------------------------------------------------------------ context for the model
export function buildSnapshot(input: {
  deal: Record<string, unknown>;
  articles: Article[];
  profiles: InvestorProfile[];
  people: Person[];
  sources: Array<{ file_name: string; is_primary?: boolean | null }>;
  exclusions: Exclusions;
}): string {
  const d = input.deal;
  const field = (k: string) => (d[k] === null || d[k] === undefined || d[k] === "" ? "—" : String(d[k]));
  const lines: string[] = [];
  lines.push(`Deal: ${field("name")} · stage ${field("stage")} · sector ${field("sector")} · status ${field("status")} · research ${field("deep_research_status")}`);
  lines.push(`Fields: ${EDITABLE_FIELDS.filter((k) => !["name", "stage", "sector"].includes(k)).map((k) => `${k}=${field(k)}`).join("; ")}`);
  lines.push(`Investors: ${field("investors")}`);
  lines.push(input.articles.length
    ? `Articles:\n${input.articles.map((a, i) => `  ${i + 1}. ${a.title} — ${a.url}`).join("\n")}`
    : "Articles: none");
  lines.push(input.people.length
    ? `People:\n${input.people.map((p) => `  - ${p.name}${p.title ? `, ${p.title}` : ""}${p.linkedin_url ? ` (${p.linkedin_url})` : ""}`).join("\n")}`
    : "People: none");
  lines.push(input.sources.length
    ? `Decks and documents: ${input.sources.map((s) => `${s.file_name}${s.is_primary ? " [primary]" : ""}`).join("; ")}`
    : "Decks and documents: none");
  const memo = typeof d.memo_draft === "string" ? d.memo_draft : "";
  lines.push(memo ? `Memo draft: ${memo.length} characters, begins "${memo.slice(0, 160).replace(/\s+/g, " ")}…"` : "Memo draft: none");
  const ex = input.exclusions;
  if (ex.articles.length || ex.investors.length || ex.people.length) {
    lines.push(`Marked not relevant (kept out of future research): ${ex.articles.length} article(s), investors [${ex.investors.join(", ")}], people [${ex.people.join(", ")}]`);
  }
  return lines.join("\n");
}

export const AGENT_SYSTEM_PROMPT = `You are EasyVC's deal agent. You refine ONE deal's data room on the user's instruction by calling tools.

Rules:
- Act, don't describe. When the user asks for a change, call the tool(s) that make it, then confirm in one or two short sentences what changed.
- Only change what the user asked for. Never invent facts, URLs, people or numbers; if the request needs a value you do not have, ask one short question instead of guessing.
- "Not relevant", "wrong company", "remove this" about an article, investor or person means remove it (it is also remembered so research will not bring it back).
- Refer to articles by their number or title as listed. If a request is ambiguous between several items, ask which one.
- You can only act on this deal. You cannot delete the deal, change who owns it, or share it.
- If a tool reports an error, say so plainly and suggest the fix. Do not claim a change that a tool did not confirm.
- Answer questions about the deal from the snapshot. Keep replies brief; no headings.`;

// ------------------------------------------------------------------ tool schemas (OpenAI-style function calling)
const str = (description: string) => ({ type: "string", description });
export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "update_deal_fields",
      description: "Set or correct fields on the deal. Pass null to clear an optional field.",
      parameters: {
        type: "object",
        properties: {
          fields: {
            type: "object",
            description: `Any of: ${EDITABLE_FIELDS.join(", ")}`,
            properties: Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, { type: ["string", "null"] }])),
          },
        },
        required: ["fields"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_articles",
      description: "Remove news articles that are not relevant to this company. They are remembered and kept out of future research.",
      parameters: {
        type: "object",
        properties: {
          numbers: { type: "array", items: { type: "integer" }, description: "Article numbers as listed (1-based)" },
          urls: { type: "array", items: { type: "string" } },
          title_contains: str("A distinctive fragment of the title, if no number or URL is known"),
          reason: str("Why it is not relevant, in the user's words"),
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_article",
      description: "Add a news article the user provides.",
      parameters: { type: "object", properties: { title: str("Headline"), url: str("Article URL"), source: str("Publication") }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_investors",
      description: "Add or remove investors. Removed investors are remembered and kept out of future research.",
      parameters: {
        type: "object",
        properties: { add: { type: "array", items: { type: "string" } }, remove: { type: "array", items: { type: "string" } } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upsert_person",
      description: "Add a key person, or correct an existing one's title or LinkedIn URL.",
      parameters: { type: "object", properties: { name: str("Full name"), title: str("Role"), linkedin_url: str("LinkedIn profile URL") }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_person",
      description: "Remove a key person who is wrong or not relevant. Remembered and kept out of future research.",
      parameters: { type: "object", properties: { name: str("Name as listed") }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_memo",
      description: "Append to the investment memo draft, or replace it entirely.",
      parameters: {
        type: "object",
        properties: { mode: { type: "string", enum: ["append", "replace"] }, content: str("Markdown text") },
        required: ["mode", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_note",
      description: "Add a note to the deal (for the user's own observations).",
      parameters: { type: "object", properties: { content: str("The note") }, required: ["content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "restore_excluded",
      description: "Undo a 'not relevant' decision so research may include the item again.",
      parameters: {
        type: "object",
        properties: { kind: { type: "string", enum: ["articles", "investors", "people"] }, value: str("The URL or name to restore") },
        required: ["kind", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "undo_last_change",
      description: "Undo the most recent change made to this deal (when the user says undo, revert, or that the last change was wrong).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "rerun_research",
      description: "Re-run deep research for this deal in the background (respects everything marked not relevant).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_memo",
      description: "Generate the investment memo from the current data in the background.",
      parameters: { type: "object", properties: {} },
    },
  },
] as const;

export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((t) => t.function.name);

/** Keep the conversation the model sees bounded and well-formed. */
export function trimHistory(messages: unknown, max = 16): Array<{ role: "user" | "assistant"; content: string }> {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m): m is { role: "user" | "assistant"; content: string } =>
      !!m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0)
    .slice(-max)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
}
