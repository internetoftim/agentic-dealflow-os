export type ValidationState =
  | "verified"
  | "partially_verified"
  | "conflicting"
  | "low_confidence"
  | "insufficient_evidence"
  | "failed";

export type RetryOptions = {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  step: string;
  onAttempt?: (meta: { step: string; attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void;
};

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxAttempts = Math.max(1, options.retries + 1);
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await withTimeout(fn(), options.timeoutMs, `${options.step} timed out after ${options.timeoutMs}ms`);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      const delayMs = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      options.onAttempt?.({ step: options.step, attempt, maxAttempts, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new Error(`${options.step} failed after ${maxAttempts} attempts: ${toErrorMessage(lastError)}`);
}

export function classifyWebsiteConfidence(input: {
  companyName: string;
  candidateUrl: string | null;
  title?: string | null;
  contentSample?: string | null;
  corroborationCount?: number;
  redirectChain?: string[];
  hasSslError?: boolean;
  isReachable?: boolean;
}): { score: number; decision: "accepted" | "rejected" | "needs_review"; reasons: string[]; canonicalDomain: string | null } {
  const reasons: string[] = [];
  if (!input.candidateUrl) return { score: 0, decision: "rejected", reasons: ["missing_candidate_url"], canonicalDomain: null };

  let score = 0;
  const canonicalDomain = getDomain(input.redirectChain?.at(-1) ?? input.candidateUrl);
  const brand = normalize(input.companyName);
  const domain = normalize(canonicalDomain ?? "");

  if (input.isReachable === false) {
    reasons.push("domain_unreachable");
    return { score: 0, decision: "rejected", reasons, canonicalDomain };
  }

  if (input.hasSslError) {
    score -= 40;
    reasons.push("ssl_error");
  }

  if (domain && brand && domain.includes(brand.replace(/\s+/g, ""))) {
    score += 50;
    reasons.push("domain_brand_match");
  }

  const titleNorm = normalize(input.title ?? "");
  if (titleNorm.includes(brand) || (input.contentSample && normalize(input.contentSample).includes(brand))) {
    score += 25;
    reasons.push("onsite_brand_match");
  }

  if ((input.corroborationCount ?? 0) >= 2) {
    score += 20;
    reasons.push("cross_source_corroboration");
  } else if ((input.corroborationCount ?? 0) === 1) {
    score += 5;
    reasons.push("single_source_corroboration");
  }

  if (/(wixsite|wordpress|notion|linktr\.ee|carrd)/.test(domain)) {
    score -= 20;
    reasons.push("weak_hosting_signal");
  }

  const decision = score >= 75 ? "accepted" : score >= 45 ? "needs_review" : "rejected";
  return { score: Math.max(0, Math.min(100, score)), decision, reasons, canonicalDomain };
}

export function decideValidationState(params: {
  citations: number;
  contradictions: number;
  confidence: number;
  requiredFieldsMissing: number;
}): ValidationState {
  if (params.requiredFieldsMissing > 2) return "insufficient_evidence";
  if (params.contradictions > 0 && params.confidence >= 50) return "conflicting";
  if (params.citations === 0 || params.confidence < 35) return "low_confidence";
  if (params.confidence >= 80 && params.citations >= 2 && params.contradictions === 0) return "verified";
  return "partially_verified";
}

export const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const getDomain = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
