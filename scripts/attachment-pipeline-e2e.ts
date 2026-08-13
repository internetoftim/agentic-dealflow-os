/**
 * attachment-pipeline-e2e — end-to-end runner for the Gmail → Drive
 * attachment pipeline.
 *
 *   bun scripts/attachment-pipeline-e2e.ts            # mock mode (default)
 *   bun scripts/attachment-pipeline-e2e.ts --live     # real Gmail + Drive
 *
 * Mock mode runs the full workflow against the deterministic in-memory
 * fixture (threads with attachments hidden on deep replies, duplicates,
 * unsupported files, failing downloads), prints the final status report,
 * verifies every expectation, and fails if ANY console error/warning was
 * emitted along the way.
 *
 * Live mode talks to the real APIs. It needs a Google OAuth "Desktop app"
 * client and pauses for the user to authorize when no token is available:
 *
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET   (required)
 *   GOOGLE_ACCESS_TOKEN     use this token directly (skips OAuth pause)
 *   GOOGLE_REFRESH_TOKEN    mint an access token via refresh (skips pause)
 *   --query "..."           Gmail search query   (default: has:attachment newer_than:30d)
 *   --folder "A/B"          Drive folder path    (default: EasyVC/Deal Inbox)
 *
 * Scopes requested: gmail.readonly + drive.file (least privilege: the app
 * only sees Drive files it created; set GOOGLE_DRIVE_SCOPE to override).
 */

import { createInterface } from "node:readline/promises";

import { renderReport, runAttachmentPipeline } from "../src/lib/attachmentPipeline";
import { createDriveHttpPort, createGmailHttpPort } from "../src/lib/googlePorts";
import { buildDemoFixture } from "../src/lib/mockGooglePorts";

// ---------------------------------------------------------------------------
// Zero-console-error guard: any console.error/warn during the run fails it.
// ---------------------------------------------------------------------------

const consoleProblems: string[] = [];
const realError = console.error.bind(console);
const realWarn = console.warn.bind(console);
console.error = (...args: unknown[]) => {
  consoleProblems.push(`console.error: ${args.map(String).join(" ")}`);
  realError(...args);
};
console.warn = (...args: unknown[]) => {
  consoleProblems.push(`console.warn: ${args.map(String).join(" ")}`);
  realWarn(...args);
};

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

// ---------------------------------------------------------------------------
// Mock mode
// ---------------------------------------------------------------------------

async function runMockMode(): Promise<void> {
  console.log("Mode: MOCK (deterministic in-memory Gmail + Drive fixture)\n");

  const fx = await buildDemoFixture();
  const report = await runAttachmentPipeline(fx.gmail, fx.drive, {
    query: fx.query,
    driveFolderPath: fx.folderPath,
  });

  console.log(renderReport(report));
  console.log("");

  // Verify the run end-to-end.
  const failures: string[] = [];
  const names = (entries: { filename: string }[]) => entries.map((e) => e.filename);
  const check = (label: string, actual: string[], expected: string[]) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${label}: expected [${expected.join(", ")}], got [${actual.join(", ")}]`);
    }
  };
  check("uploaded", names(report.uploaded), fx.expected.uploaded);
  check("duplicated", names(report.duplicated), fx.expected.duplicated);
  check("skipped", names(report.skipped), fx.expected.skipped);
  check("unsupported", names(report.unsupported), fx.expected.unsupported);

  const bucketTotal =
    report.uploaded.length +
    report.duplicated.length +
    report.skipped.length +
    report.unsupported.length;
  if (bucketTotal !== report.attachmentsDiscovered) {
    failures.push(
      `bucket total ${bucketTotal} does not equal attachments discovered ${report.attachmentsDiscovered}`
    );
  }
  for (const call of fx.gmail.downloadCalls) {
    if (!call.messageId.startsWith("msg-") || !call.attachmentId.startsWith("att-")) {
      failures.push(`download used non-real identifiers: ${JSON.stringify(call)}`);
    }
  }
  if (fx.drive.uploads.length !== report.uploaded.length) {
    failures.push(
      `Drive received ${fx.drive.uploads.length} upload(s) but report claims ${report.uploaded.length}`
    );
  }

  if (consoleProblems.length > 0) {
    failures.push(...consoleProblems);
  }

  if (failures.length > 0) {
    realError("\nE2E FAILED:");
    for (const f of failures) realError(`  ✗ ${f}`);
    process.exit(1);
  }

  console.log("Verification: all expectations met — uploads, duplicates, skips,");
  console.log("unsupported files, and real (messageId, attachmentId) usage all check out.");
  console.log("Console errors/warnings during run: 0");
  console.log("\nE2E PASSED ✅");
}

// ---------------------------------------------------------------------------
// Live mode — real Gmail + Drive with an explicit OAuth authorization pause
// ---------------------------------------------------------------------------

const REDIRECT_URI = "http://localhost:53682";

async function obtainAccessToken(): Promise<string> {
  const direct = process.env.GOOGLE_ACCESS_TOKEN;
  if (direct) return direct;

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "live mode needs GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (a Google OAuth 'Desktop app' client), or a GOOGLE_ACCESS_TOKEN"
    );
  }

  const tokenRequest = async (params: Record<string, string>): Promise<Record<string, string>> => {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    if (!res.ok) throw new Error(`token endpoint ${res.status}: ${await res.text()}`);
    return res.json();
  };

  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (refreshToken) {
    const data = await tokenRequest({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    return data.access_token;
  }

  // ---- OAuth authorization pause: the human must approve access. ----
  const scope =
    process.env.GOOGLE_DRIVE_SCOPE ??
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file";
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      scope,
    });

  console.log("\n=== AUTHORIZATION REQUIRED ===");
  console.log("1. Open this URL in your browser and approve access:\n");
  console.log(`   ${authUrl}\n`);
  console.log(`2. Your browser will be redirected to ${REDIRECT_URI}/?code=...`);
  console.log("   (the page won't load — that's expected; the code is in the address bar)");
  console.log("3. Paste the value of the `code` parameter below.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question("Authorization code: ")).trim();
  rl.close();
  if (!code) throw new Error("no authorization code provided");

  const data = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  if (data.refresh_token) {
    console.log(
      "\nReceived a refresh token. To skip this pause next time, export it as GOOGLE_REFRESH_TOKEN (store it like a password).\n"
    );
  }
  return data.access_token;
}

async function runLiveMode(): Promise<void> {
  console.log("Mode: LIVE (real Gmail + Google Drive)\n");

  const accessToken = await obtainAccessToken();
  const getToken = async () => accessToken;

  const query = argValue("--query") ?? "has:attachment newer_than:30d";
  const folder = argValue("--folder") ?? "EasyVC/Deal Inbox";
  console.log(`Query: ${query}`);
  console.log(`Drive folder: ${folder}\n`);

  const report = await runAttachmentPipeline(
    createGmailHttpPort(getToken),
    createDriveHttpPort(getToken),
    { query, driveFolderPath: folder }
  );

  console.log(renderReport(report));
  if (consoleProblems.length > 0) {
    realError(`\nConsole errors/warnings during run: ${consoleProblems.length}`);
    process.exit(1);
  }
  console.log("\nConsole errors/warnings during run: 0");
  console.log("LIVE RUN COMPLETE ✅");
}

// ---------------------------------------------------------------------------

const live = process.argv.includes("--live");
(live ? runLiveMode() : runMockMode()).catch((err) => {
  realError("E2E run crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
