import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_AI_MODEL, NYO_BASE, OPENAI_BASE, resolveChatProvider, effectiveCloudModel, maxTokensParam,
} from "../../../supabase/functions/_shared/ai-provider";

const read = (p: string) => readFileSync(resolve(__dirname, "../../../", p), "utf8");
const env = (vars: Record<string, string>) => (k: string) => vars[k];

describe("GLM via NYO is the default model", () => {
  it("defaults to nyo-glm-5.3 when nothing is set or a local model is selected", () => {
    expect(DEFAULT_AI_MODEL).toBe("nyo-glm-5.3");
    expect(effectiveCloudModel(undefined)).toBe(DEFAULT_AI_MODEL);
    expect(effectiveCloudModel(null)).toBe(DEFAULT_AI_MODEL);
    expect(effectiveCloudModel("local-webgpu")).toBe(DEFAULT_AI_MODEL);
    expect(effectiveCloudModel("local-florence2")).toBe(DEFAULT_AI_MODEL);
    expect(effectiveCloudModel("gpt-5.4")).toBe("gpt-5.4");
  });

  it("routes nyo-* to NYO's OpenAI-compatible endpoint with the NYO key and bare model name", () => {
    const p = resolveChatProvider(undefined, env({ NYO_API_KEY: "rk_live_x\n" }));
    expect(p.id).toBe("nyo");
    expect(p.baseUrl).toBe(NYO_BASE);
    expect(p.model).toBe("glm-5.3");
    expect(p.headers.Authorization).toBe("Bearer rk_live_x");
    expect(p.supportsVision).toBe(false);
  });

  it("never sends a reasoning model an output cap it cannot answer under (NYO reasoning_budget_exhausted)", () => {
    const nyo = resolveChatProvider("nyo-glm-5.3-flash", env({ NYO_API_KEY: "k" }));
    expect(maxTokensParam(nyo, 100)).toEqual({ max_tokens: 2048 });
    expect(maxTokensParam(nyo, 4096)).toEqual({ max_tokens: 4096 });
    for (const fn of ["detect-pattern", "generate-memo"]) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      expect(src, fn).toMatch(/maxTokensParam\(/);
      expect(src, fn).not.toMatch(/max_tokens:\s*\d/);
    }
  });

  it("still routes OpenAI ids to OpenAI and keeps OpenAI-only params there", () => {
    const p = resolveChatProvider("gpt-5.4", env({ OPENAI_API_KEY: "sk" }));
    expect(p.id).toBe("openai");
    expect(p.baseUrl).toBe(OPENAI_BASE);
    expect(p.supportsVision).toBe(true);
    expect(maxTokensParam(p, 10)).toEqual({ max_completion_tokens: 10 });
  });

  it("names the missing credential", () => {
    expect(() => resolveChatProvider(undefined, env({}))).toThrow(/NYO_API_KEY/);
    expect(() => resolveChatProvider("gpt-5.4", env({}))).toThrow(/OPENAI_API_KEY/);
  });

  it("every LLM-calling function resolves the provider through the shared module", () => {
    for (const fn of ["deal-chat", "generate-memo", "process-deck", "detect-pattern", "deep-research"]) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      expect(src, fn).toMatch(/_shared\/ai-provider\.ts/);
      expect(src, fn).not.toMatch(/\?\?\s*"gpt-5\.4"/);
    }
  });

  it("the Settings model picker and the app-side default agree with the server default", () => {
    const settings = read("src/pages/SettingsPage.tsx");
    const ctx = read("src/contexts/LocalLlmContext.tsx");
    expect(settings).toMatch(/value: "nyo-glm-5\.3"[\s\S]*default/);
    expect(ctx).toMatch(/DEFAULT_AI_MODEL = "nyo-glm-5\.3"/);
    expect(ctx).toMatch(/aiModel: DEFAULT_AI_MODEL/);
  });
});
