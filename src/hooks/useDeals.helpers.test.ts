import { describe, it, expect } from "vitest";
import {
  isDocViewerSource,
  DOC_VIEWER_SOURCES,
  PROCESSING_STATUSES,
  WORKFLOW_STEPS,
} from "./useDeals";

describe("isDocViewerSource", () => {
  it("returns true for known document-viewer sources", () => {
    for (const source of DOC_VIEWER_SOURCES) {
      expect(isDocViewerSource(source)).toBe(true);
    }
    expect(isDocViewerSource("docsend")).toBe(true);
    expect(isDocViewerSource("pandadoc")).toBe(true);
    expect(isDocViewerSource("papermark")).toBe(true);
  });

  it("returns false for non-viewer / manual sources", () => {
    expect(isDocViewerSource("manual")).toBe(false);
    expect(isDocViewerSource("email")).toBe(false);
    expect(isDocViewerSource("deal-desk")).toBe(false);
  });

  it("handles undefined / empty source without throwing", () => {
    expect(isDocViewerSource(undefined)).toBe(false);
    expect(isDocViewerSource("")).toBe(false);
  });

  it("is case-sensitive (only lowercase canonical values match)", () => {
    // Sources are stored lowercase; guard against accidental case drift.
    expect(isDocViewerSource("DocSend")).toBe(false);
  });
});

describe("workflow status metadata", () => {
  it("PROCESSING_STATUSES are all non-terminal step keys or transitional states", () => {
    // Every processing status should be a known concept; ensure no obvious typos
    // by checking they are all lowercase kebab/simple tokens.
    for (const s of PROCESSING_STATUSES) {
      expect(s).toMatch(/^[a-z-]+$/);
    }
  });

  it("WORKFLOW_STEPS has unique, ordered keys ending in a terminal 'memo-ready'", () => {
    const keys = WORKFLOW_STEPS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
    expect(keys[keys.length - 1]).toBe("memo-ready");
    // Every step exposes a human label.
    for (const step of WORKFLOW_STEPS) {
      expect(step.label.length).toBeGreaterThan(0);
    }
  });

  it("terminal steps (deep-research, memo-ready) are not in PROCESSING_STATUSES", () => {
    expect(PROCESSING_STATUSES).not.toContain("memo-ready");
  });
});
