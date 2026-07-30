import { describe, it, expect } from "vitest";
import {
  decodePrefill,
  encodePrefill,
  sanitizePrefill,
  base64ToJsonString,
  type Prefill,
} from "./agentPrefill";

describe("encode/decode round-trip", () => {
  it("round-trips a full prefill via base64url", () => {
    const p: Prefill = {
      deal: { name: "Acme", linkedin_url: "https://linkedin.com/company/acme" },
      person: { name: "Jane Doe", title: "CEO", linkedin_url: "https://linkedin.com/in/jane" },
    };
    const decoded = decodePrefill(encodePrefill(p));
    expect(decoded).toEqual(p);
  });
});

describe("decodePrefill", () => {
  it("returns null for empty/garbage input", () => {
    expect(decodePrefill(null)).toBeNull();
    expect(decodePrefill("")).toBeNull();
    expect(decodePrefill("!!!not base64!!!")).toBeNull();
  });

  it("returns null when JSON is valid but has no usable fields", () => {
    const b64 = encodePrefill({} as Prefill);
    // encode of {} → decode should be null because nothing survives sanitize
    expect(decodePrefill(b64)).toBeNull();
  });

  it("maps person.role alias to title", () => {
    const b64 = encodePrefill({ person: { name: "X" } } as Prefill);
    // build a raw payload with `role` manually
    const rawJson = JSON.stringify({ person: { name: "Bob", role: "Founder" } });
    const bytes = new TextEncoder().encode(rawJson);
    let binary = "";
    bytes.forEach((x) => (binary += String.fromCharCode(x)));
    const raw = btoa(binary);
    const decoded = decodePrefill(raw);
    expect(decoded?.person).toEqual({ name: "Bob", title: "Founder" });
    expect(b64).toBeTruthy();
  });
});

describe("sanitizePrefill", () => {
  it("drops unknown fields and non-strings", () => {
    const out = sanitizePrefill({
      deal: { name: "Acme", evil: "drop-me", ask_amount: 5, website: "  x.com  " },
      person: { name: "Jane", title: 42, extra: true },
      junk: "nope",
    });
    expect(out.deal).toEqual({ name: "Acme", website: "x.com" }); // ask_amount:5 not a string
    expect(out.person).toEqual({ name: "Jane" }); // title:42 dropped
    expect((out as Record<string, unknown>).junk).toBeUndefined();
  });

  it("returns empty object for non-object input", () => {
    expect(sanitizePrefill(null)).toEqual({});
    expect(sanitizePrefill("string")).toEqual({});
    expect(sanitizePrefill(123)).toEqual({});
  });
});

describe("base64ToJsonString", () => {
  it("decodes utf-8 payloads", () => {
    const json = JSON.stringify({ deal: { name: "Café Ünïçøde" } });
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    expect(base64ToJsonString(btoa(binary))).toBe(json);
  });
});
