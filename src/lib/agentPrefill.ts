/**
 * Decoding + whitelisting for the agent deep-link `?prefill=<base64-json>`.
 *
 * An agent (or a link it generates) can open
 *   /agent/deal/:id?prefill=<base64-json>
 * to pre-populate the "agent-assisted edit" form in DealWorkspace. The payload
 * is untrusted, so we base64-decode, JSON-parse defensively, and hard-whitelist
 * only known string fields before anything reaches React state.
 *
 * Payload shape: { deal?: {<deal fields>}, person?: { name, title|role, linkedin_url } }
 */

export type PrefillDeal = {
  name?: string;
  linkedin_url?: string;
  website?: string;
  sector?: string;
  stage?: string;
  ask_amount?: string;
  valuation?: string;
  revenue?: string;
  growth?: string;
  nrr?: string;
  team_size?: string;
};

export type PrefillPerson = {
  name?: string;
  title?: string;
  linkedin_url?: string;
};

export type Prefill = { deal?: PrefillDeal; person?: PrefillPerson };

const DEAL_FIELDS: (keyof PrefillDeal)[] = [
  "name",
  "linkedin_url",
  "website",
  "sector",
  "stage",
  "ask_amount",
  "valuation",
  "revenue",
  "growth",
  "nrr",
  "team_size",
];

// Accepts `title` or the common alias `role` and maps both to `title`.
const PERSON_FIELD_ALIASES: Record<string, keyof PrefillPerson> = {
  name: "name",
  title: "title",
  role: "title",
  linkedin_url: "linkedin_url",
  linkedinUrl: "linkedin_url",
};

function asString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** base64 (standard or url-safe) → UTF-8 string. Returns null on failure. */
export function base64ToJsonString(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Whitelist an arbitrary parsed object down to a safe Prefill. */
export function sanitizePrefill(raw: unknown): Prefill {
  const out: Prefill = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;

  const rawDeal = obj.deal;
  if (rawDeal && typeof rawDeal === "object") {
    const deal: PrefillDeal = {};
    for (const key of DEAL_FIELDS) {
      const val = asString((rawDeal as Record<string, unknown>)[key]);
      if (val !== undefined) deal[key] = val;
    }
    if (Object.keys(deal).length) out.deal = deal;
  }

  const rawPerson = obj.person;
  if (rawPerson && typeof rawPerson === "object") {
    const person: PrefillPerson = {};
    for (const [alias, target] of Object.entries(PERSON_FIELD_ALIASES)) {
      const val = asString((rawPerson as Record<string, unknown>)[alias]);
      if (val !== undefined && person[target] === undefined) person[target] = val;
    }
    if (Object.keys(person).length) out.person = person;
  }

  return out;
}

/** Full pipeline: base64 → JSON → sanitized Prefill. Returns null if unusable. */
export function decodePrefill(param: string | null | undefined): Prefill | null {
  if (!param) return null;
  const json = base64ToJsonString(param);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const prefill = sanitizePrefill(parsed);
  if (!prefill.deal && !prefill.person) return null;
  return prefill;
}

/** Helper for building links/tests: object → base64-url JSON. */
export function encodePrefill(prefill: Prefill): string {
  const json = JSON.stringify(prefill);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
