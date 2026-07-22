import { describe, it, expect } from "vitest";
import { isEmailValid } from "./validation";

describe("isEmailValid", () => {
  it("accepts well-formed addresses", () => {
    expect(isEmailValid("founder@startup.com")).toBe(true);
    expect(isEmailValid("a.b-c+tag@sub.domain.io")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isEmailValid("")).toBe(false);
    expect(isEmailValid("no-at-sign")).toBe(false);
    expect(isEmailValid("missing@domain")).toBe(false); // no TLD dot
    expect(isEmailValid("with space@x.com")).toBe(false);
    expect(isEmailValid("two@@x.com")).toBe(false);
  });
});
