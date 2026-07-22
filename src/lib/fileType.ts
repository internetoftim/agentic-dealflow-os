/**
 * Deck file-type helpers shared by the upload flow (`compressDeck`) and the
 * public intake form. Kept dependency-free so it is trivially unit-testable.
 */

export const ALLOWED_DECK_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
];

export const ALLOWED_DECK_EXTENSIONS = [".pdf", ".pptx", ".ppt"];

/**
 * Return the lowercased file extension (including the leading dot), or "" when
 * the name has no real extension.
 *
 * Note: the previous inline implementation used
 *   `name.toLowerCase().slice(name.lastIndexOf("."))`
 * which returns the LAST CHARACTER for a name with no dot (slice(-1)), leaking a
 * bogus "extension" into validation. This version returns "" in that case.
 */
export function getFileExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  // No dot, a leading-dot dotfile, or a trailing dot => no real extension.
  if (dotIndex <= 0 || dotIndex === name.length - 1) return "";
  return name.slice(dotIndex).toLowerCase();
}

/** True when a file is an allowed deck by MIME type or extension. */
export function isAllowedDeckFile(file: { name: string; type: string }): boolean {
  return (
    ALLOWED_DECK_MIME_TYPES.includes(file.type) ||
    ALLOWED_DECK_EXTENSIONS.includes(getFileExtension(file.name))
  );
}
