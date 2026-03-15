import { PDFDocument } from "pdf-lib";

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

const ALLOWED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
];

const ALLOWED_EXTENSIONS = [".pdf", ".pptx", ".ppt"];

function getFileExtension(name: string): string {
  return name.toLowerCase().slice(name.lastIndexOf("."));
}

/**
 * Process an uploaded deck file.
 * - PDFs are re-serialized through pdf-lib for compression.
 * - PPTX/PPT files pass through as-is (conversion happens server-side in process-deck).
 */
export async function compressDeck(
  file: File
): Promise<{ compressed: File; pages: number; isPptx: boolean }> {
  const ext = getFileExtension(file.name);
  const isAllowedType = ALLOWED_TYPES.includes(file.type) || ALLOWED_EXTENSIONS.includes(ext);

  if (!isAllowedType) {
    throw new Error(
      "Please upload a PDF or PPTX file. Other formats are not supported yet."
    );
  }

  const isPptx = ext === ".pptx" || ext === ".ppt";

  if (isPptx) {
    // PPTX: pass through as-is, page count will be determined server-side
    return { compressed: file, pages: 0, isPptx: true };
  }

  // PDF: compress via pdf-lib
  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
  const pages = pdfDoc.getPageCount();

  const compressedBytes = await pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });

  const compressedBlob = new Blob([compressedBytes.buffer as ArrayBuffer], {
    type: "application/pdf",
  });

  if (compressedBlob.size > MAX_SIZE_BYTES) {
    console.warn(
      `PDF still ${(compressedBlob.size / (1024 * 1024)).toFixed(1)}MB after compression.`
    );
  }

  const compressedFile = new File([compressedBlob], file.name, {
    type: "application/pdf",
  });

  return { compressed: compressedFile, pages, isPptx: false };
}

/** @deprecated Use compressDeck instead */
export const compressPdf = async (file: File) => {
  const result = await compressDeck(file);
  return { compressed: result.compressed, pages: result.pages };
};
