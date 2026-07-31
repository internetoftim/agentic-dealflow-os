import { describe, expect, it } from "vitest";

import {
  decodeBase64Url,
  encodeBase64Url,
  renderReport,
  runAttachmentPipeline,
} from "./attachmentPipeline";
import {
  buildDemoFixture,
  DEMO_FOLDER_PATH,
  MockDrivePort,
  MockGmailPort,
} from "./mockGooglePorts";

const names = (entries: { filename: string }[]) => entries.map((e) => e.filename);

describe("base64url helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63]);
    expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
  });
});

describe("runAttachmentPipeline on the demo fixture", () => {
  it("buckets every discovered attachment exactly once, as expected", async () => {
    const fx = await buildDemoFixture();
    const report = await runAttachmentPipeline(fx.gmail, fx.drive, {
      query: fx.query,
      driveFolderPath: fx.folderPath,
    });

    expect(names(report.uploaded)).toEqual(fx.expected.uploaded);
    expect(names(report.duplicated)).toEqual(fx.expected.duplicated);
    expect(names(report.skipped)).toEqual(fx.expected.skipped);
    expect(names(report.unsupported)).toEqual(fx.expected.unsupported);

    const bucketTotal =
      report.uploaded.length +
      report.duplicated.length +
      report.skipped.length +
      report.unsupported.length;
    expect(bucketTotal).toBe(report.attachmentsDiscovered);
    expect(report.attachmentsDiscovered).toBe(9);
    expect(report.threadsMatched).toBe(3);
    expect(report.messagesScanned).toBe(7);
  });

  it("never touches threads that do not match the query", async () => {
    const fx = await buildDemoFixture();
    const report = await runAttachmentPipeline(fx.gmail, fx.drive, {
      query: fx.query,
      driveFolderPath: fx.folderPath,
    });
    const everyFilename = [
      ...report.uploaded,
      ...report.duplicated,
      ...report.skipped,
      ...report.unsupported,
    ].map((e) => e.filename);
    expect(everyFilename).not.toContain("menu.pdf");
  });

  it("finds attachments hidden deep inside a thread the query matched via another message", async () => {
    const fx = await buildDemoFixture();
    const report = await runAttachmentPipeline(fx.gmail, fx.drive, {
      query: fx.query,
      driveFolderPath: fx.folderPath,
    });
    const acme = report.uploaded.find((e) => e.filename === "acme-seed-deck.pdf");
    expect(acme).toBeDefined();
    // The query only matches msg-1-1; the deck rides on the third reply.
    expect(acme!.messageId).toBe("msg-1-3");
    expect(acme!.threadId).toBe("thread-1");
  });

  it("downloads only via real (messageId, attachmentId) pairs", async () => {
    const fx = await buildDemoFixture();
    await runAttachmentPipeline(fx.gmail, fx.drive, {
      query: fx.query,
      driveFolderPath: fx.folderPath,
    });
    // The mock throws on any fabricated pair; additionally every recorded
    // call must carry the message it claims to belong to.
    expect(fx.gmail.downloadCalls).toEqual([
      { messageId: "msg-1-3", attachmentId: "att-1-3-1-acme-seed-deck.pdf" },
      { messageId: "msg-2-1", attachmentId: "att-2-1-1-beta-pitch.pdf" },
      { messageId: "msg-2-2", attachmentId: "att-2-2-1-beta-pitch-v1.pdf" },
      { messageId: "msg-3-1", attachmentId: "att-3-1-1-gamma-deck.pdf" },
      { messageId: "msg-3-2", attachmentId: "att-3-2-2-gamma-financials.pdf" },
      { messageId: "msg-3-2", attachmentId: "att-3-2-3-gamma-notes.pdf" },
    ]);
  });

  it("explains duplicates: in-run duplicates cite the original message, Drive duplicates cite the existing file", async () => {
    const fx = await buildDemoFixture();
    const report = await runAttachmentPipeline(fx.gmail, fx.drive, {
      query: fx.query,
      driveFolderPath: fx.folderPath,
    });
    const inRun = report.duplicated.find((e) => e.filename === "beta-pitch-v1.pdf");
    expect(inRun?.detail).toContain("msg-2-1");
    const inDrive = report.duplicated.find((e) => e.filename === "gamma-deck.pdf");
    expect(inDrive?.driveFileId).toMatch(/^seeded-/);
    expect(inDrive?.detail).toContain("already present in Drive folder");
  });

  it("gives a distinct reason for every skip", async () => {
    const fx = await buildDemoFixture();
    const report = await runAttachmentPipeline(fx.gmail, fx.drive, {
      query: fx.query,
      driveFolderPath: fx.folderPath,
    });
    const reason = (name: string) => report.skipped.find((e) => e.filename === name)?.detail;
    expect(reason("gamma-deck-hires.pdf")).toContain("exceeds limit");
    expect(reason("gamma-financials.pdf")).toContain("download failed");
    expect(reason("gamma-notes.pdf")).toContain("empty");
  });

  it("records uploads in the Drive folder it resolved", async () => {
    const fx = await buildDemoFixture();
    const report = await runAttachmentPipeline(fx.gmail, fx.drive, {
      query: fx.query,
      driveFolderPath: fx.folderPath,
    });
    expect(report.folderPath).toBe(DEMO_FOLDER_PATH);
    expect(fx.drive.uploads.map((u) => u.name)).toEqual(fx.expected.uploaded);
    expect(fx.drive.uploads.every((u) => u.folderId === report.folderId)).toBe(true);
  });
});

describe("runAttachmentPipeline edge cases", () => {
  it("returns an empty report when nothing matches", async () => {
    const gmail = new MockGmailPort([
      { messages: [{ subject: "hello", bodyText: "nothing relevant" }] },
    ]);
    const drive = new MockDrivePort();
    const report = await runAttachmentPipeline(gmail, drive, {
      query: "nomatchterm",
      driveFolderPath: "Some/Folder",
    });
    expect(report.threadsMatched).toBe(0);
    expect(report.attachmentsDiscovered).toBe(0);
    expect(report.uploaded).toEqual([]);
    expect(report.duplicated).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.unsupported).toEqual([]);
  });

  it("uploads inline (data-embedded) attachments without calling attachments.get", async () => {
    const gmail = new MockGmailPort([
      {
        messages: [
          {
            subject: "inline deck",
            bodyText: "small file inline",
            attachments: [
              { filename: "tiny.pdf", mimeType: "application/pdf", content: "tiny", inline: true },
            ],
          },
        ],
      },
    ]);
    const drive = new MockDrivePort();
    const report = await runAttachmentPipeline(gmail, drive, {
      query: "inline",
      driveFolderPath: "F",
    });
    expect(names(report.uploaded)).toEqual(["tiny.pdf"]);
    expect(report.uploaded[0].attachmentId).toBeNull();
    expect(gmail.downloadCalls).toEqual([]);
  });

  it("treats extensionless files as unsupported", async () => {
    const gmail = new MockGmailPort([
      {
        messages: [
          {
            subject: "deck",
            bodyText: "",
            attachments: [{ filename: "README", mimeType: "text/plain", content: "hi" }],
          },
        ],
      },
    ]);
    const drive = new MockDrivePort();
    const report = await runAttachmentPipeline(gmail, drive, {
      query: "deck",
      driveFolderPath: "F",
    });
    expect(names(report.unsupported)).toEqual(["README"]);
  });

  it("turns an upload failure into a skip with the error message", async () => {
    const gmail = new MockGmailPort([
      {
        messages: [
          {
            subject: "deck",
            bodyText: "",
            attachments: [{ filename: "boom.pdf", mimeType: "application/pdf", content: "x" }],
          },
        ],
      },
    ]);
    const drive = new MockDrivePort();
    drive.uploadFile = async () => {
      throw new Error("quota exceeded");
    };
    const report = await runAttachmentPipeline(gmail, drive, {
      query: "deck",
      driveFolderPath: "F",
    });
    expect(names(report.skipped)).toEqual(["boom.pdf"]);
    expect(report.skipped[0].detail).toContain("quota exceeded");
  });
});

describe("renderReport", () => {
  it("prints every section and the totals line", async () => {
    const fx = await buildDemoFixture();
    const report = await runAttachmentPipeline(fx.gmail, fx.drive, {
      query: fx.query,
      driveFolderPath: fx.folderPath,
    });
    const text = renderReport(report);
    for (const section of ["UPLOADED (2)", "DUPLICATED (2)", "SKIPPED (3)", "UNSUPPORTED (2)"]) {
      expect(text).toContain(section);
    }
    expect(text).toContain("Totals: 2 uploaded, 2 duplicated, 3 skipped, 2 unsupported");
    expect(text).toContain("acme-seed-deck.pdf");
    expect(text).toContain("message=msg-1-3");
  });
});
