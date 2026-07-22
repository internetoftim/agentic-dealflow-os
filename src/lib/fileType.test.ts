import { describe, it, expect } from "vitest";
import {
  getFileExtension,
  isAllowedDeckFile,
  ALLOWED_DECK_EXTENSIONS,
} from "./fileType";

describe("getFileExtension", () => {
  it("returns the lowercased extension including the dot", () => {
    expect(getFileExtension("deck.pdf")).toBe(".pdf");
    expect(getFileExtension("DECK.PDF")).toBe(".pdf");
    expect(getFileExtension("Q3 Board Deck.PPTX")).toBe(".pptx");
  });

  it("uses the LAST dot for multi-dot names", () => {
    expect(getFileExtension("archive.tar.gz")).toBe(".gz");
    expect(getFileExtension("a.b.pptx")).toBe(".pptx");
  });

  // Regression: the original implementation was
  //   name.toLowerCase().slice(name.lastIndexOf("."))
  // For a name with no dot, lastIndexOf(".") === -1 and slice(-1) returns the
  // LAST CHARACTER (e.g. "deck" -> "k"), leaking a bogus "extension" into the
  // upload + public-intake validation gates. A name without an extension must
  // yield "".
  it("returns empty string when there is no extension (regression)", () => {
    expect(getFileExtension("deck")).toBe("");
    expect(getFileExtension("presentation")).toBe("");
    expect(getFileExtension("noextension")).toBe("");
  });

  it("treats leading-dot dotfiles and trailing dots as having no extension", () => {
    expect(getFileExtension(".gitignore")).toBe("");
    expect(getFileExtension("deck.")).toBe("");
  });
});

describe("isAllowedDeckFile", () => {
  it("accepts allowed deck extensions regardless of MIME type", () => {
    for (const ext of ALLOWED_DECK_EXTENSIONS) {
      expect(isAllowedDeckFile({ name: `deck${ext}`, type: "" })).toBe(true);
    }
  });

  it("accepts by MIME type even when the name lacks an extension", () => {
    expect(isAllowedDeckFile({ name: "deck", type: "application/pdf" })).toBe(true);
  });

  it("rejects unsupported files (regression for the extension-less case)", () => {
    expect(isAllowedDeckFile({ name: "notes.txt", type: "text/plain" })).toBe(false);
    // Extension-less, no MIME: must be rejected, not accepted on a stray char.
    expect(isAllowedDeckFile({ name: "randomfile", type: "" })).toBe(false);
  });
});
