// One place that turns a user's `ai_model` setting into "which HTTP endpoint,
// which model name, which credential". Pure (env is injected) so the frontend
// test-suite can import it.
//
// Default: GLM 5.3 served through NYO's OpenAI-compatible API. Settings values
// prefixed `nyo-` route there; plain OpenAI ids route to api.openai.com;
// `gpt-oss-202b` routes to the Sapinsapin bridge; local/browser models fall
// back to the default cloud model for server-side work.

export const NYO_BASE = "https://llm.nyolab.ai/api/public/v1";
export const OPENAI_BASE = "https://api.openai.com/v1";
export const SAPINSAPIN_BASE = "https://apollo-inference-bridge.am1-aks.apolloglobal.net/v1";
export const SAPINSAPIN_MODEL = "/models/gpt-oss-20b-balitanlp-cpt";

export const NYO_PREFIX = "nyo-";
export const DEFAULT_AI_MODEL = "nyo-glm-5.3";

/** Settings values that mean "runs in the browser, not on the server". */
export const LOCAL_AI_MODELS = ["local-webgpu", "local-florence2"];

export type ChatProvider = {
  /** "nyo" | "openai" | "sapinsapin" */
  id: "nyo" | "openai" | "sapinsapin";
  /** Base URL up to and including /v1. */
  baseUrl: string;
  /** Model name to send in the request body. */
  model: string;
  /** Env var holding the credential. */
  envKey: "NYO_API_KEY" | "OPENAI_API_KEY" | "APOLLO_API_KEY";
  /** Request headers including auth; throws if the credential is missing. */
  headers: Record<string, string>;
  /** Whether image_url content parts may be sent. */
  supportsVision: boolean;
  /** Whether OpenAI-only body params (max_completion_tokens, strict tools) are safe. */
  isOpenAI: boolean;
};

export function isLocalAiModel(aiModel: string | null | undefined): boolean {
  return !!aiModel && LOCAL_AI_MODELS.includes(aiModel);
}

/** The cloud model to use server-side for a given setting (local ⇒ default). */
export function effectiveCloudModel(aiModel: string | null | undefined): string {
  if (!aiModel || isLocalAiModel(aiModel)) return DEFAULT_AI_MODEL;
  return aiModel;
}

export function resolveChatProvider(
  aiModel: string | null | undefined,
  env: (key: string) => string | undefined,
): ChatProvider {
  const model = effectiveCloudModel(aiModel);
  const clean = (v: string | undefined) => v?.trim().replace(/[\r\n]/g, "") ?? "";

  if (model.startsWith(NYO_PREFIX)) {
    const key = clean(env("NYO_API_KEY"));
    if (!key) throw new Error("NYO_API_KEY is not configured");
    return {
      id: "nyo",
      baseUrl: NYO_BASE,
      model: model.slice(NYO_PREFIX.length),
      envKey: "NYO_API_KEY",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      supportsVision: false,
      isOpenAI: false,
    };
  }
  if (model === "gpt-oss-202b") {
    const key = clean(env("APOLLO_API_KEY"));
    if (!key) throw new Error("APOLLO_API_KEY is not configured");
    return {
      id: "sapinsapin",
      baseUrl: SAPINSAPIN_BASE,
      model: SAPINSAPIN_MODEL,
      envKey: "APOLLO_API_KEY",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      supportsVision: false,
      isOpenAI: false,
    };
  }
  const key = clean(env("OPENAI_API_KEY"));
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  return {
    id: "openai",
    baseUrl: OPENAI_BASE,
    model,
    envKey: "OPENAI_API_KEY",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    supportsVision: ["gpt-4o", "gpt-5", "gpt-5-mini", "gpt-5.4"].includes(model),
    isOpenAI: true,
  };
}

/**
 * Reasoning models (GLM, DeepSeek via NYO) spend hundreds of tokens thinking
 * before they write; a cap below this returns an empty answer and NYO's
 * `reasoning_budget_exhausted` error while still charging for the reasoning.
 */
export const REASONING_MIN_OUTPUT_TOKENS = 2048;

/** `max_completion_tokens` is OpenAI-only; everyone else speaks `max_tokens`, floored for reasoning models. */
export function maxTokensParam(p: ChatProvider, n: number): Record<string, number> {
  if (p.isOpenAI) return { max_completion_tokens: n };
  return { max_tokens: Math.max(n, REASONING_MIN_OUTPUT_TOKENS) };
}
