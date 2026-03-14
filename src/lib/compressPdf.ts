import { PDFDocument } from "pdf-lib";

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Compress a PDF file client-side.
 * Strategy: re-serialize through pdf-lib which strips unused objects,
 * re-encodes streams, and produces a leaner file.
 * Returns the compressed File (or original if already under limit).
 */
export async function compressPdf(file: File): Promise<{ compressed: File; pages: number }> {
  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });

  const pages = pdfDoc.getPageCount();

  // pdf-lib re-serialization strips dead objects & optimizes streams
  const compressedBytes = await pdfDoc.save({
    useObjectStreams: true,   // compact cross-ref streams
    addDefaultPage: false,
  });

  const compressedBlob = new Blob([compressedBytes], { type: "application/pdf" });

  // If still over 20MB after optimization, we can't do more client-side
  // (image downscaling in pdf-lib is limited). Upload as-is and warn.
  if (compressedBlob.size > MAX_SIZE_BYTES) {
    console.warn(
      `PDF still ${(compressedBlob.size / (1024 * 1024)).toFixed(1)}MB after compression (limit ${MAX_SIZE_BYTES / (1024 * 1024)}MB).`
    );
  }

  const compressedFile = new File([compressedBlob], file.name, {
    type: "application/pdf",
  });

  return { compressed: compressedFile, pages };
}
