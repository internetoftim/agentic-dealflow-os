import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { compressDeck, compressPdf } from "./compressPdf";

/**
 * Build a real, minimal PDF File so the pdf-lib code path in compressDeck
 * runs end-to-end without any mocking.
 */
async function makePdfFile(name = "deck.pdf", pageCount = 3): Promise<File> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([200, 200]);
  const bytes = await doc.save();
  return new File([bytes], name, { type: "application/pdf" });
}

describe("compressDeck", () => {
  it("rejects unsupported file types", async () => {
    const txt = new File(["hello"], "notes.txt", { type: "text/plain" });
    await expect(compressDeck(txt)).rejects.toThrow(/PDF or PPTX/i);
  });

  it("does not misclassify an extension-less file as a supported deck (regression)", async () => {
    // Empty MIME type and no extension -> must be rejected, not treated as a
    // PDF/PPTX because getFileExtension returned a stray last character.
    const blob = new File(["data"], "randomfile", { type: "" });
    await expect(compressDeck(blob)).rejects.toThrow(/PDF or PPTX/i);
  });

  it("passes PPTX files through untouched and defers page counting", async () => {
    const pptx = new File(["fake-pptx-bytes"], "startup.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const result = await compressDeck(pptx);
    expect(result.isPptx).toBe(true);
    expect(result.pages).toBe(0);
    expect(result.compressed).toBe(pptx); // same File instance, no re-encoding
  });

  it("accepts a PPTX identified only by extension (empty MIME type)", async () => {
    const pptx = new File(["fake"], "deck.pptx", { type: "" });
    const result = await compressDeck(pptx);
    expect(result.isPptx).toBe(true);
  });

  it("re-serializes a PDF and reports its page count", async () => {
    const pdf = await makePdfFile("real.pdf", 4);
    const result = await compressDeck(pdf);
    expect(result.isPptx).toBe(false);
    expect(result.pages).toBe(4);
    expect(result.compressed.type).toBe("application/pdf");
    expect(result.compressed.name).toBe("real.pdf");
    expect(result.compressed.size).toBeGreaterThan(0);
  });
});

describe("compressPdf (deprecated wrapper)", () => {
  it("delegates to compressDeck and returns compressed + pages", async () => {
    const pdf = await makePdfFile("legacy.pdf", 2);
    const result = await compressPdf(pdf);
    expect(result.pages).toBe(2);
    expect(result.compressed.type).toBe("application/pdf");
  });
});
