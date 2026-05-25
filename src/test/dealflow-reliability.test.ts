import { describe, expect, it, vi } from "vitest";
import { classifyWebsiteConfidence, decideValidationState, withRetry } from "../../supabase/functions/_shared/dealflow-reliability";

describe("classifyWebsiteConfidence", () => {
  it("accepts strong brand-aligned domain", () => {
    const result = classifyWebsiteConfidence({
      companyName: "Acme Labs",
      candidateUrl: "https://acmelabs.com",
      title: "Acme Labs - AI Infrastructure",
      contentSample: "Welcome to Acme Labs",
      corroborationCount: 2,
      isReachable: true,
    });
    expect(result.decision).toBe("accepted");
    expect(result.score).toBeGreaterThanOrEqual(75);
  });

  it("rejects unreachable domain", () => {
    const result = classifyWebsiteConfidence({
      companyName: "Acme Labs",
      candidateUrl: "https://acme-labs-foo.example",
      isReachable: false,
    });
    expect(result.decision).toBe("rejected");
    expect(result.reasons).toContain("domain_unreachable");
  });
});

describe("decideValidationState", () => {
  it("returns verified for strong evidence", () => {
    expect(decideValidationState({ citations: 3, contradictions: 0, confidence: 90, requiredFieldsMissing: 0 })).toBe("verified");
  });

  it("returns conflicting when contradictions exist", () => {
    expect(decideValidationState({ citations: 4, contradictions: 1, confidence: 70, requiredFieldsMissing: 0 })).toBe("conflicting");
  });
});

describe("withRetry", () => {
  it("retries until success", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, {
      retries: 2,
      baseDelayMs: 1,
      maxDelayMs: 2,
      timeoutMs: 50,
      step: "unit_step",
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
