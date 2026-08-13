/**
 * attachmentPipeline — Gmail → Google Drive attachment workflow engine.
 *
 * Searches Gmail THREADS (not just messages) so attachments on replies deep
 * inside a long thread are found even when only one message matches the
 * query. Every attachment is addressed by its real (messageId, attachmentId)
 * pair, downloaded, deduplicated (within the run by content hash, against the
 * target Drive folder by name+size), uploaded into the chosen folder, and
 * accounted for in exactly one report bucket:
 *
 *   uploaded | skipped | duplicated | unsupported
 *
 * The engine is framework-free and isomorphic: it talks to Gmail/Drive only
 * through the GmailPort/DrivePort interfaces, so the same code runs in the
 * browser, a Supabase edge function, a CLI script, or against in-memory
 * mocks in tests. It never logs — results are returned, not printed.
 */

// ---------------------------------------------------------------------------
// Gmail payload shapes (subset of the REST resource we rely on)
// ---------------------------------------------------------------------------

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPartBody {
  /** Present when the part's content must be fetched via attachments.get */
  attachmentId?: string;
  /** Decoded size in bytes as declared by Gmail */
  size?: number;
  /** Present when small/inline content is embedded directly (base64url) */
  data?: string;
}

export interface GmailPart {
  partId?: string;
  filename?: string;
  mimeType?: string;
  headers?: GmailHeader[];
  body?: GmailPartBody;
  parts?: GmailPart[];
}

export interface GmailMessageFull {
  id: string;
  threadId: string;
  payload?: GmailPart;
}

// ---------------------------------------------------------------------------
// Ports — the only way the pipeline touches the outside world
// ---------------------------------------------------------------------------

export interface GmailPort {
  /** Return IDs of threads matching a Gmail search query. */
  searchThreads(query: string, maxThreads: number): Promise<string[]>;
  /** Return ALL messages of a thread with full MIME payloads. */
  getThread(threadId: string): Promise<GmailMessageFull[]>;
  /** Download one attachment by its real message + attachment identifiers. */
  downloadAttachment(messageId: string, attachmentId: string): Promise<Uint8Array>;
}

export interface DriveFileMeta {
  id: string;
  name: string;
  size?: number;
  md5Checksum?: string;
}

export interface DrivePort {
  /** Resolve (creating as needed) a folder path like "EasyVC/Inbox". */
  ensureFolderPath(path: string): Promise<string>;
  /** List non-trashed files directly inside a folder. */
  listFiles(folderId: string): Promise<DriveFileMeta[]>;
  /** Upload bytes as a new file inside the folder. */
  uploadFile(args: {
    folderId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<{ id: string; name: string }>;
}

// ---------------------------------------------------------------------------
// Options and report types
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  /** Gmail search query, e.g. `label:deck has:attachment newer_than:30d` */
  query: string;
  /** Target Drive folder path, e.g. "EasyVC/Deal Inbox" */
  driveFolderPath: string;
  /** Lower-cased extensions to accept. Defaults to deck/doc formats. */
  supportedExtensions?: string[];
  /** Max threads to expand (default 20). */
  maxThreads?: number;
  /** Attachments larger than this are skipped, not downloaded (default 25MB). */
  maxAttachmentBytes?: number;
}

export type AttachmentStatus = "uploaded" | "skipped" | "duplicated" | "unsupported";

export interface AttachmentReportEntry {
  status: AttachmentStatus;
  filename: string;
  mimeType: string;
  /** Size Gmail declares for the part (0 when unknown). */
  declaredSize: number;
  threadId: string;
  messageId: string;
  /** Real Gmail attachment ID; null only for inline data parts. */
  attachmentId: string | null;
  subject: string;
  /** Human-readable explanation: why skipped/duplicated, or Drive file name. */
  detail: string;
  driveFileId?: string;
}

export interface PipelineReport {
  query: string;
  folderPath: string;
  folderId: string;
  threadsMatched: number;
  messagesScanned: number;
  attachmentsDiscovered: number;
  uploaded: AttachmentReportEntry[];
  skipped: AttachmentReportEntry[];
  duplicated: AttachmentReportEntry[];
  unsupported: AttachmentReportEntry[];
}

export const DEFAULT_SUPPORTED_EXTENSIONS = [
  ".pdf",
  ".ppt",
  ".pptx",
  ".doc",
  ".docx",
  ".key",
];

const DEFAULT_MAX_THREADS = 20;
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Base64url helpers (Gmail encodes attachment bytes as base64url)
// ---------------------------------------------------------------------------

export function decodeBase64Url(data: string): Uint8Array {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface DiscoveredAttachment {
  filename: string;
  mimeType: string;
  declaredSize: number;
  threadId: string;
  messageId: string;
  attachmentId: string | null;
  /** Set only for inline parts that embed their bytes directly. */
  inlineData?: string;
  subject: string;
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Depth-first walk of a message's MIME tree collecting real attachments. */
function collectAttachments(message: GmailMessageFull): DiscoveredAttachment[] {
  const subject = headerValue(message.payload?.headers, "subject") || "(no subject)";
  const found: DiscoveredAttachment[] = [];
  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    const hasContent = Boolean(part.body?.attachmentId || part.body?.data);
    if (part.filename && hasContent) {
      found.push({
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        declaredSize: part.body?.size ?? 0,
        threadId: message.threadId,
        messageId: message.id,
        attachmentId: part.body?.attachmentId ?? null,
        inlineData: part.body?.attachmentId ? undefined : part.body?.data,
        subject,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(message.payload);
  return found;
}

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

/** SHA-256 hex via WebCrypto, with a pure-JS fallback for odd runtimes. */
async function contentHash(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const buf = new Uint8Array(bytes).buffer;
    const digest = await subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // FNV-1a fallback — only used where WebCrypto is unavailable.
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16)}:${bytes.length}`;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function runAttachmentPipeline(
  gmail: GmailPort,
  drive: DrivePort,
  options: PipelineOptions
): Promise<PipelineReport> {
  const supported = (options.supportedExtensions ?? DEFAULT_SUPPORTED_EXTENSIONS).map((e) =>
    e.toLowerCase()
  );
  const maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS;
  const maxBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

  // 1. Resolve the destination folder and what already lives in it.
  const folderId = await drive.ensureFolderPath(options.driveFolderPath);
  const existingFiles = await drive.listFiles(folderId);

  // 2. Search threads, then expand each FULL thread so attachments on
  //    non-matching replies inside the thread are still discovered.
  const threadIds = await gmail.searchThreads(options.query, maxThreads);
  let messagesScanned = 0;
  const discovered: DiscoveredAttachment[] = [];
  for (const threadId of threadIds) {
    const messages = await gmail.getThread(threadId);
    messagesScanned += messages.length;
    for (const message of messages) {
      discovered.push(...collectAttachments(message));
    }
  }

  // 3. Classify, download, dedupe, upload.
  const report: PipelineReport = {
    query: options.query,
    folderPath: options.driveFolderPath,
    folderId,
    threadsMatched: threadIds.length,
    messagesScanned,
    attachmentsDiscovered: discovered.length,
    uploaded: [],
    skipped: [],
    duplicated: [],
    unsupported: [],
  };

  /** Content hash → the first entry that carried those bytes this run. */
  const seenHashes = new Map<string, AttachmentReportEntry>();

  const entryFor = (att: DiscoveredAttachment): Omit<AttachmentReportEntry, "status" | "detail"> => ({
    filename: att.filename,
    mimeType: att.mimeType,
    declaredSize: att.declaredSize,
    threadId: att.threadId,
    messageId: att.messageId,
    attachmentId: att.attachmentId,
    subject: att.subject,
  });

  for (const att of discovered) {
    const base = entryFor(att);
    const ext = fileExtension(att.filename);

    if (!supported.includes(ext)) {
      report.unsupported.push({
        ...base,
        status: "unsupported",
        detail: `extension "${ext || "(none)"}" is not in the supported set [${supported.join(", ")}]`,
      });
      continue;
    }

    if (att.declaredSize > maxBytes) {
      report.skipped.push({
        ...base,
        status: "skipped",
        detail: `declared size ${att.declaredSize} bytes exceeds limit of ${maxBytes} bytes`,
      });
      continue;
    }

    let bytes: Uint8Array;
    try {
      if (att.attachmentId) {
        bytes = await gmail.downloadAttachment(att.messageId, att.attachmentId);
      } else if (att.inlineData) {
        bytes = decodeBase64Url(att.inlineData);
      } else {
        throw new Error("attachment part has neither attachmentId nor inline data");
      }
    } catch (err) {
      report.skipped.push({
        ...base,
        status: "skipped",
        detail: `download failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (bytes.length === 0) {
      report.skipped.push({ ...base, status: "skipped", detail: "attachment is empty (0 bytes)" });
      continue;
    }
    if (bytes.length > maxBytes) {
      report.skipped.push({
        ...base,
        status: "skipped",
        detail: `actual size ${bytes.length} bytes exceeds limit of ${maxBytes} bytes`,
      });
      continue;
    }

    const hash = await contentHash(bytes);
    const firstSeen = seenHashes.get(hash);
    if (firstSeen) {
      report.duplicated.push({
        ...base,
        status: "duplicated",
        detail: `identical content to "${firstSeen.filename}" from message ${firstSeen.messageId} earlier in this run`,
      });
      continue;
    }

    const existing = existingFiles.find((f) => f.name === att.filename && f.size === bytes.length);
    if (existing) {
      const entry: AttachmentReportEntry = {
        ...base,
        status: "duplicated",
        detail: `already present in Drive folder as "${existing.name}" (${existing.id})`,
        driveFileId: existing.id,
      };
      report.duplicated.push(entry);
      seenHashes.set(hash, entry);
      continue;
    }

    try {
      const uploadedFile = await drive.uploadFile({
        folderId,
        name: att.filename,
        mimeType: att.mimeType,
        bytes,
      });
      const entry: AttachmentReportEntry = {
        ...base,
        status: "uploaded",
        detail: `uploaded as "${uploadedFile.name}" (${uploadedFile.id})`,
        driveFileId: uploadedFile.id,
      };
      report.uploaded.push(entry);
      seenHashes.set(hash, entry);
      // Future name+size collisions in this run should also read as duplicates
      // of what we just uploaded.
      existingFiles.push({ id: uploadedFile.id, name: uploadedFile.name, size: bytes.length });
    } catch (err) {
      report.skipped.push({
        ...base,
        status: "skipped",
        detail: `upload failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

function shortId(id: string | null): string {
  if (!id) return "(inline)";
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

function renderSection(title: string, entries: AttachmentReportEntry[]): string[] {
  const lines = [`${title} (${entries.length})`];
  if (entries.length === 0) {
    lines.push("  — none");
    return lines;
  }
  for (const e of entries) {
    lines.push(`  • ${e.filename} [${e.mimeType}]`);
    lines.push(`      message=${e.messageId} attachment=${shortId(e.attachmentId)}`);
    lines.push(`      thread=${e.threadId} subject="${e.subject}"`);
    lines.push(`      ${e.detail}`);
  }
  return lines;
}

export function renderReport(report: PipelineReport): string {
  const lines: string[] = [
    "=== Gmail → Drive Attachment Pipeline Report ===",
    `Query:        ${report.query}`,
    `Drive folder: ${report.folderPath} (${report.folderId})`,
    `Scanned:      ${report.threadsMatched} thread(s), ${report.messagesScanned} message(s), ${report.attachmentsDiscovered} attachment(s) discovered`,
    "",
    ...renderSection("UPLOADED", report.uploaded),
    "",
    ...renderSection("DUPLICATED", report.duplicated),
    "",
    ...renderSection("SKIPPED", report.skipped),
    "",
    ...renderSection("UNSUPPORTED", report.unsupported),
    "",
    `Totals: ${report.uploaded.length} uploaded, ${report.duplicated.length} duplicated, ${report.skipped.length} skipped, ${report.unsupported.length} unsupported`,
  ];
  return lines.join("\n");
}
