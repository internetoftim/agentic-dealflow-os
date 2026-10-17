// Thin wrapper over the Anthropic SDK for the Managed Agents sessions EasyVC
// starts: deck capture (replaces the Cloud Run capture service) and deal
// diligence (replaces deep-research). Agent and environment IDs come from
// managed-agents/claude-lock.json via function secrets; see managed-agents/README.md.
// Pure logic lives in agent-sessions-core.ts.

import Anthropic, { toFile } from "npm:@anthropic-ai/sdk@0.135.0";
import {
  buildCaptureInput, CAPTURE_BUDGET_CENTS, consoleSessionUrl, DILIGENCE_BUDGET_CENTS, DILIGENCE_OUTCOME_DESCRIPTION,
  DILIGENCE_RUBRIC, newestByFilename, sessionMetadata, type SessionKind,
} from "./agent-sessions-core.ts";

const MA_BETA = "managed-agents-2026-04-01";
/** Inputs uploaded for a session are deleted by the Files API after a week. */
const INPUT_TTL_SECONDS = 7 * 24 * 3600;

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set (see managed-agents/README.md)`);
  return value;
}

let cached: Anthropic | null = null;
export function anthropic(): Anthropic {
  cached ??= new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  return cached;
}

export function consoleUrl(sessionId: string): string {
  return consoleSessionUrl(Deno.env.get("ANTHROPIC_WORKSPACE_ID"), sessionId);
}

async function uploadInput(name: string, bytes: Uint8Array, type: string): Promise<string> {
  const file = await anthropic().files.upload({
    file: await toFile(bytes, name, { type }),
    expires_in_seconds: INPUT_TTL_SECONDS,
  });
  return file.id;
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2));

/** Starts a deck-capture session; its outputs (deck.pdf, previews, capture.json) are collected by agent-webhook. */
export async function startCaptureSession(args: {
  kind: Extract<SessionKind, "capture" | "conversion">;
  url: string;
  gateEmail?: string | null;
  passcode?: string | null;
  maxPages?: number;
  ids: Record<string, string | null | undefined>;
  title: string;
}): Promise<{ sessionId: string; consoleUrl: string }> {
  const inputId = await uploadInput("capture-request.json", json(buildCaptureInput(args)), "application/json");
  const session = await anthropic().beta.sessions.create({
    agent: requireEnv("MA_DECK_CAPTURE_AGENT_ID"),
    environment_id: requireEnv("MA_RESEARCH_ENV_ID"),
    title: args.title.slice(0, 200),
    metadata: sessionMetadata(args.kind, args.ids),
    resources: [{ type: "file", file_id: inputId, mount_path: "/mnt/session/inputs/capture-request.json" }],
    budget: { type: "limit", max_list_cost: { amount: CAPTURE_BUDGET_CENTS, currency: "USD" } },
    initial_events: [{
      type: "user.message",
      content: [{ type: "text", text: "Capture the deck described in /mnt/session/inputs/capture-request.json." }],
    }],
  });
  return { sessionId: session.id, consoleUrl: consoleUrl(session.id) };
}

/** Starts a diligence session for one deal; the outcome grader iterates until the rubric passes or the $10 cap is hit. */
export async function startDiligenceSession(args: {
  dealInput: Record<string, unknown>;
  deckPdf: Uint8Array | null;
  ids: Record<string, string | null | undefined>;
  title: string;
}): Promise<{ sessionId: string; consoleUrl: string }> {
  const resources: { type: "file"; file_id: string; mount_path: string }[] = [
    { type: "file", file_id: await uploadInput("deal.json", json(args.dealInput), "application/json"), mount_path: "/mnt/session/inputs/deal.json" },
  ];
  if (args.deckPdf) {
    resources.push({ type: "file", file_id: await uploadInput("deck.pdf", args.deckPdf, "application/pdf"), mount_path: "/mnt/session/inputs/deck.pdf" });
  }
  const session = await anthropic().beta.sessions.create({
    agent: requireEnv("MA_DEAL_ANALYST_AGENT_ID"),
    environment_id: requireEnv("MA_RESEARCH_ENV_ID"),
    title: args.title.slice(0, 200),
    metadata: sessionMetadata("diligence", args.ids),
    resources,
    budget: { type: "limit", max_list_cost: { amount: DILIGENCE_BUDGET_CENTS, currency: "USD" } },
    initial_events: [{
      type: "user.define_outcome",
      description: DILIGENCE_OUTCOME_DESCRIPTION,
      rubric: { type: "text", content: DILIGENCE_RUBRIC },
      max_iterations: 3,
    }],
  });
  return { sessionId: session.id, consoleUrl: consoleUrl(session.id) };
}

/** A follow-up question from the investor, answered in the same session so the agents keep their findings. */
export async function sendFollowUp(sessionId: string, text: string): Promise<void> {
  await anthropic().beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
}

export async function retrieveSession(sessionId: string) {
  return await anthropic().beta.sessions.retrieve(sessionId);
}

/** stop_reason of the latest session.status_idle event (the session object itself has none). */
export async function latestIdleStop(sessionId: string): Promise<{ type: string | null; eventIds: string[] }> {
  const page = await anthropic().beta.sessions.events.list(sessionId, { types: ["session.status_idle"], order: "desc", limit: 1 });
  const idle = page.data[0] as { type: string; stop_reason?: { type?: string; event_ids?: string[] } } | undefined;
  return { type: idle?.stop_reason?.type ?? null, eventIds: idle?.stop_reason?.event_ids ?? [] };
}

/** Unattended sessions never leave a tool call waiting: deny anything the server paused for review. */
export async function denyPendingToolCalls(sessionId: string, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  await anthropic().beta.sessions.events.send(sessionId, {
    events: eventIds.map((id) => ({
      type: "user.tool_confirmation" as const,
      tool_use_id: id,
      result: "deny" as const,
      deny_message: "This run is unattended and this call needs a person's review, so it was denied. Continue without it.",
    })),
  });
}

/**
 * Files the agent wrote to /mnt/session/outputs/, by filename. The session
 * scope also lists the inputs mounted at creation, so input names never
 * overlap output names, and when a name repeats the newest file wins.
 * Retries briefly for the indexing lag after idle.
 */
export async function listOutputs(sessionId: string): Promise<Map<string, string>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const files: { id: string; filename: string; created_at: string }[] = [];
    for await (const f of anthropic().beta.files.list({ scope_id: sessionId, betas: [MA_BETA] })) {
      files.push({ id: f.id, filename: f.filename, created_at: f.created_at });
    }
    const out = new Map(newestByFilename(files).map((f) => [f.filename, f.id] as const));
    if (out.size > 0) return out;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return new Map();
}

export async function downloadOutput(fileId: string): Promise<Uint8Array> {
  const res = await anthropic().beta.files.download(fileId, { betas: [MA_BETA] });
  return new Uint8Array(await res.arrayBuffer());
}

export function unwrapWebhook(body: string, headers: Headers) {
  const plain: Record<string, string> = {};
  headers.forEach((value, key) => { plain[key] = value; });
  return anthropic().beta.webhooks.unwrap(body, { headers: plain, key: requireEnv("ANTHROPIC_WEBHOOK_SIGNING_KEY") });
}
