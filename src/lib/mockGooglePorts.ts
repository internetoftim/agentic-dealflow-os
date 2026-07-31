/**
 * mockGooglePorts — in-memory Gmail/Drive implementations of the pipeline
 * ports, plus the deterministic demo fixture used by both the vitest suite
 * and `scripts/attachment-pipeline-e2e.ts`.
 *
 * The Gmail mock enforces REAL identifiers: downloadAttachment throws unless
 * the (messageId, attachmentId) pair actually exists in the fixture, so any
 * code path that fabricates or mixes up IDs fails loudly.
 */

import {
  encodeBase64Url,
  type DriveFileMeta,
  type DrivePort,
  type GmailMessageFull,
  type GmailPart,
  type GmailPort,
} from "./attachmentPipeline";

// ---------------------------------------------------------------------------
// Fixture specs
// ---------------------------------------------------------------------------

export interface MockAttachmentSpec {
  filename: string;
  mimeType: string;
  /** Attachment bytes (utf-8 of `content` if given). */
  content?: string;
  bytes?: Uint8Array;
  /** Embed as inline base64url data instead of an attachmentId part. */
  inline?: boolean;
  /** Override the size Gmail declares (e.g. to simulate oversize parts). */
  declaredSize?: number;
  /** Simulate a failing attachments.get call. */
  failDownload?: boolean;
}

export interface MockMessageSpec {
  subject: string;
  bodyText: string;
  labels?: string[];
  attachments?: MockAttachmentSpec[];
}

export interface MockThreadSpec {
  messages: MockMessageSpec[];
}

// ---------------------------------------------------------------------------
// Gmail mock
// ---------------------------------------------------------------------------

interface StoredAttachment {
  spec: MockAttachmentSpec;
  bytes: Uint8Array;
  attachmentId: string | null;
}

interface StoredMessage {
  id: string;
  threadId: string;
  spec: MockMessageSpec;
  attachments: StoredAttachment[];
  full: GmailMessageFull;
}

interface StoredThread {
  id: string;
  messages: StoredMessage[];
}

function specBytes(spec: MockAttachmentSpec): Uint8Array {
  if (spec.bytes) return spec.bytes;
  return new TextEncoder().encode(spec.content ?? `mock-content:${spec.filename}`);
}

export class MockGmailPort implements GmailPort {
  private threads: StoredThread[] = [];
  private messagesById = new Map<string, StoredMessage>();
  /** Every (messageId, attachmentId) pair the pipeline asked to download. */
  readonly downloadCalls: { messageId: string; attachmentId: string }[] = [];

  constructor(threadSpecs: MockThreadSpec[]) {
    threadSpecs.forEach((threadSpec, t) => {
      const threadId = `thread-${t + 1}`;
      const thread: StoredThread = { id: threadId, messages: [] };
      threadSpec.messages.forEach((msgSpec, m) => {
        const messageId = `msg-${t + 1}-${m + 1}`;
        const attachments: StoredAttachment[] = (msgSpec.attachments ?? []).map((att, a) => ({
          spec: att,
          bytes: specBytes(att),
          attachmentId: att.inline ? null : `att-${t + 1}-${m + 1}-${a + 1}-${att.filename}`,
        }));

        const parts: GmailPart[] = [
          {
            partId: "0",
            filename: "",
            mimeType: "text/plain",
            body: { size: msgSpec.bodyText.length, data: encodeBase64Url(new TextEncoder().encode(msgSpec.bodyText)) },
          },
          ...attachments.map((att, a): GmailPart => ({
            partId: String(a + 1),
            filename: att.spec.filename,
            mimeType: att.spec.mimeType,
            body: att.attachmentId
              ? {
                  attachmentId: att.attachmentId,
                  size: att.spec.declaredSize ?? att.bytes.length,
                }
              : {
                  data: encodeBase64Url(att.bytes),
                  size: att.spec.declaredSize ?? att.bytes.length,
                },
          })),
        ];

        const stored: StoredMessage = {
          id: messageId,
          threadId,
          spec: msgSpec,
          attachments,
          full: {
            id: messageId,
            threadId,
            payload: {
              mimeType: "multipart/mixed",
              headers: [{ name: "Subject", value: msgSpec.subject }],
              parts,
            },
          },
        };
        thread.messages.push(stored);
        this.messagesById.set(messageId, stored);
      });
      this.threads.push(thread);
    });
  }

  /**
   * Naive Gmail query semantics: whitespace-separated tokens must ALL match
   * a single message; a thread is returned when any of its messages matches.
   * Supported tokens: `label:x`, `has:attachment`, free text (subject/body).
   */
  async searchThreads(query: string, maxThreads: number): Promise<string[]> {
    const tokens = query.split(/\s+/).filter(Boolean);
    const messageMatches = (msg: StoredMessage): boolean =>
      tokens.every((token) => {
        const lower = token.toLowerCase();
        if (lower.startsWith("label:")) {
          return (msg.spec.labels ?? []).some((l) => l.toLowerCase() === lower.slice(6));
        }
        if (lower === "has:attachment") return msg.attachments.length > 0;
        return (
          msg.spec.subject.toLowerCase().includes(lower) ||
          msg.spec.bodyText.toLowerCase().includes(lower)
        );
      });
    return this.threads
      .filter((t) => t.messages.some(messageMatches))
      .map((t) => t.id)
      .slice(0, maxThreads);
  }

  async getThread(threadId: string): Promise<GmailMessageFull[]> {
    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread) throw new Error(`mock: unknown thread "${threadId}"`);
    return thread.messages.map((m) => m.full);
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
    this.downloadCalls.push({ messageId, attachmentId });
    const message = this.messagesById.get(messageId);
    if (!message) throw new Error(`mock: unknown message id "${messageId}"`);
    const attachment = message.attachments.find((a) => a.attachmentId === attachmentId);
    if (!attachment) {
      throw new Error(
        `mock: attachment id "${attachmentId}" does not belong to message "${messageId}" — the pipeline must use real identifier pairs`
      );
    }
    if (attachment.spec.failDownload) {
      throw new Error(`mock: simulated download failure for "${attachment.spec.filename}"`);
    }
    return attachment.bytes;
  }
}

// ---------------------------------------------------------------------------
// Drive mock
// ---------------------------------------------------------------------------

export class MockDrivePort implements DrivePort {
  private folderIdsByPath = new Map<string, string>();
  private filesByFolder = new Map<string, DriveFileMeta[]>();
  readonly uploads: { folderId: string; name: string; mimeType: string; size: number }[] = [];
  private nextFolder = 1;
  private nextFile = 1;

  private normalize(path: string): string {
    return path.split("/").map((s) => s.trim()).filter(Boolean).join("/");
  }

  async ensureFolderPath(path: string): Promise<string> {
    const normalized = this.normalize(path);
    if (!normalized) throw new Error(`mock: invalid Drive folder path "${path}"`);
    let id = this.folderIdsByPath.get(normalized);
    if (!id) {
      id = `folder-${this.nextFolder++}`;
      this.folderIdsByPath.set(normalized, id);
      this.filesByFolder.set(id, []);
    }
    return id;
  }

  /** Pre-seed a file that "already exists" in the folder before the run. */
  async seedFile(path: string, name: string, size: number): Promise<DriveFileMeta> {
    const folderId = await this.ensureFolderPath(path);
    const meta: DriveFileMeta = { id: `seeded-${this.nextFile++}`, name, size };
    this.filesByFolder.get(folderId)!.push(meta);
    return meta;
  }

  async listFiles(folderId: string): Promise<DriveFileMeta[]> {
    return [...(this.filesByFolder.get(folderId) ?? [])];
  }

  async uploadFile({
    folderId,
    name,
    mimeType,
    bytes,
  }: {
    folderId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<{ id: string; name: string }> {
    const files = this.filesByFolder.get(folderId);
    if (!files) throw new Error(`mock: unknown folder id "${folderId}"`);
    const meta: DriveFileMeta = { id: `drive-file-${this.nextFile++}`, name, size: bytes.length };
    files.push(meta);
    this.uploads.push({ folderId, name, mimeType, size: bytes.length });
    return { id: meta.id, name: meta.name };
  }
}

// ---------------------------------------------------------------------------
// The demo fixture — one deterministic inbox exercising every report bucket
// ---------------------------------------------------------------------------

export const DEMO_QUERY = "deck";
export const DEMO_FOLDER_PATH = "EasyVC/Deal Inbox";

export interface DemoFixture {
  gmail: MockGmailPort;
  drive: MockDrivePort;
  query: string;
  folderPath: string;
  /** Filenames expected in each bucket, in processing order. */
  expected: {
    uploaded: string[];
    duplicated: string[];
    skipped: string[];
    unsupported: string[];
  };
}

export async function buildDemoFixture(): Promise<DemoFixture> {
  const betaBytes = new TextEncoder().encode("beta pitch deck bytes v1");

  const gmail = new MockGmailPort([
    // Thread 1: the query only matches the FIRST message; the deck arrives
    // on the third reply — the "hidden inside a longer thread" case.
    {
      messages: [
        {
          subject: "Acme <> EasyVC intro",
          bodyText: "Great to meet — sending our deck shortly.",
          labels: ["inbox"],
        },
        {
          subject: "Re: Acme <> EasyVC intro",
          bodyText: "Looking forward to it!",
        },
        {
          subject: "Re: Acme <> EasyVC intro",
          bodyText: "Here it is, plus our logo for the memo.",
          attachments: [
            { filename: "acme-seed-deck.pdf", mimeType: "application/pdf", content: "acme seed deck bytes" },
            { filename: "acme-logo.png", mimeType: "image/png", content: "png bytes", inline: true },
          ],
        },
      ],
    },
    // Thread 2: same content attached twice under different names →
    // the second one is an in-run duplicate by content hash.
    {
      messages: [
        {
          subject: "Beta pitch deck",
          bodyText: "Deck attached.",
          attachments: [{ filename: "beta-pitch.pdf", mimeType: "application/pdf", bytes: betaBytes }],
        },
        {
          subject: "Re: Beta pitch deck",
          bodyText: "Re-attaching same file for the partners.",
          attachments: [{ filename: "beta-pitch-v1.pdf", mimeType: "application/pdf", bytes: betaBytes }],
        },
      ],
    },
    // Thread 3: a Drive-existing duplicate, an oversize skip, a failed
    // download skip, an empty-file skip, and an unsupported video.
    {
      messages: [
        {
          subject: "Gamma deck + extras",
          bodyText: "Everything you asked for.",
          attachments: [
            { filename: "gamma-deck.pdf", mimeType: "application/pdf", content: "gamma deck bytes" },
            {
              filename: "gamma-raise-video.mov",
              mimeType: "video/quicktime",
              content: "mov bytes",
            },
          ],
        },
        {
          subject: "Re: Gamma deck + extras",
          bodyText: "And the big one.",
          attachments: [
            {
              filename: "gamma-deck-hires.pdf",
              mimeType: "application/pdf",
              content: "hires",
              declaredSize: 50 * 1024 * 1024,
            },
            {
              filename: "gamma-financials.pdf",
              mimeType: "application/pdf",
              content: "financial bytes",
              failDownload: true,
            },
            { filename: "gamma-notes.pdf", mimeType: "application/pdf", bytes: new Uint8Array(0) },
          ],
        },
      ],
    },
    // Thread 4: does NOT match the query — must never be scanned.
    {
      messages: [
        {
          subject: "Lunch on Thursday?",
          bodyText: "No files here.",
          attachments: [{ filename: "menu.pdf", mimeType: "application/pdf", content: "menu bytes" }],
        },
      ],
    },
  ]);

  const drive = new MockDrivePort();
  // gamma-deck.pdf already lives in the target folder with identical name+size.
  await drive.seedFile(DEMO_FOLDER_PATH, "gamma-deck.pdf", new TextEncoder().encode("gamma deck bytes").length);

  return {
    gmail,
    drive,
    query: DEMO_QUERY,
    folderPath: DEMO_FOLDER_PATH,
    expected: {
      uploaded: ["acme-seed-deck.pdf", "beta-pitch.pdf"],
      duplicated: ["beta-pitch-v1.pdf", "gamma-deck.pdf"],
      skipped: ["gamma-deck-hires.pdf", "gamma-financials.pdf", "gamma-notes.pdf"],
      unsupported: ["acme-logo.png", "gamma-raise-video.mov"],
    },
  };
}
