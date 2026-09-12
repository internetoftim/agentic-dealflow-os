/**
 * Gmail → deal ingestion core, shared by gmail-listener, gmail-webhook and
 * the MCP server. One function turns a Gmail message into deals/sources and
 * writes an ingest_events row for every attachment, so every path — label,
 * receiver inbox, agent-triggered — behaves identically and is auditable.
 *
 * Guarantees:
 *  - Idempotent: a message already in the ledger for this user is never
 *    re-ingested, regardless of Gmail read state.
 *  - Deduplicated: attachments are SHA-256 hashed; a hash the user already
 *    has becomes a `duplicate` event instead of a second deal.
 *  - Nothing dropped silently: non-deck documents (xlsx/docx/csv/txt/md) are
 *    attached to the deal as data-room sources with text extracted; anything
 *    else is recorded as `unsupported`.
 */

export type Channel = "label" | "receiver" | "intake" | "agent" | "manual";
export type Outcome = "uploaded" | "attached" | "duplicate" | "unsupported" | "skipped" | "failed";

export interface IngestEvent {
  outcome: Outcome;
  reason?: string;
  file_name?: string;
  mime_type?: string;
  size_bytes?: number;
  content_hash?: string;
  deal_id?: string | null;
  source_id?: string | null;
  gmail_attachment_id?: string;
}

export interface MessageReport {
  message_id: string;
  thread_id: string | null;
  sender: string;
  subject: string;
  received_at: string | null;
  events: IngestEvent[];
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const PROCESSING_STATUSES = ["uploading", "converting", "compressing", "scraping", "extracting", "searching-website", "syncing"];

const DECK_EXT = [".pdf", ".pptx", ".ppt"];
const DOC_EXT = [".xlsx", ".xls", ".csv", ".docx", ".txt", ".md"];

export function classifyAttachment(filename: string): "deck" | "document" | "unsupported" {
  const f = filename.toLowerCase();
  if (DECK_EXT.some((e) => f.endsWith(e))) return "deck";
  if (DOC_EXT.some((e) => f.endsWith(e))) return "document";
  return "unsupported";
}

// ---------------------------------------------------------------- gmail
export async function gmailGet(token: string, path: string): Promise<any | null> {
  const res = await fetch(`${GMAIL}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? res.json() : null;
}

/** Message ids matching a query. Thread depth is irrelevant: Gmail lists messages, not threads. */
export async function searchMessages(token: string, query: string, max = 25): Promise<string[]> {
  const data = await gmailGet(token, `messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(max, 100)}`);
  return (data?.messages ?? []).map((m: any) => m.id as string);
}

export async function getMessage(token: string, id: string) {
  return gmailGet(token, `messages/${id}`);
}

export async function getAttachmentBytes(token: string, messageId: string, attachmentId: string): Promise<Uint8Array | null> {
  const data = await gmailGet(token, `messages/${messageId}/attachments/${attachmentId}`);
  if (!data?.data) return null;
  const b64 = String(data.data).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function markAsRead(token: string, messageId: string): Promise<void> {
  await fetch(`${GMAIL}/messages/${messageId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  }).catch(() => {});
}

export function headerValue(headers: any[], name: string): string {
  return headers?.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}
export function parseSender(from: string): { name: string; address: string } {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  const name = from.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() ?? address.split("@")[0] ?? "Unknown sender";
  return { name, address };
}

export interface AttachmentRef { filename: string; mimeType: string; attachmentId: string; size: number; kind: ReturnType<typeof classifyAttachment> }
export function findAttachments(parts: any[]): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  for (const part of parts ?? []) {
    if (part.filename && part.body?.attachmentId) {
      out.push({ filename: part.filename, mimeType: part.mimeType ?? "", attachmentId: part.body.attachmentId, size: part.body.size ?? 0, kind: classifyAttachment(part.filename) });
    }
    if (part.parts) out.push(...findAttachments(part.parts));
  }
  return out;
}

// ---------------------------------------------------------------- hashing & extraction
export async function sha256(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Best-effort text for non-deck documents so they can ground chat/memo. */
export async function extractDocumentText(filename: string, bytes: Uint8Array): Promise<string | null> {
  const f = filename.toLowerCase();
  try {
    if (f.endsWith(".csv") || f.endsWith(".txt") || f.endsWith(".md")) {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, 200_000);
    }
    if (f.endsWith(".xlsx") || f.endsWith(".xls")) {
      const XLSX = await import("https://esm.sh/xlsx@0.18.5");
      const wb = XLSX.read(bytes, { type: "array" });
      const chunks: string[] = [];
      for (const name of wb.SheetNames.slice(0, 20)) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        if (csv.trim()) chunks.push(`## Sheet: ${name}\n${csv}`);
      }
      return chunks.join("\n\n").slice(0, 200_000) || null;
    }
    if (f.endsWith(".docx")) {
      const { default: JSZip } = await import("https://esm.sh/jszip@3.10.1");
      const zip = await JSZip.loadAsync(bytes);
      const xml = await zip.file("word/document.xml")?.async("string");
      if (!xml) return null;
      return xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/[ \t]+/g, " ").trim().slice(0, 200_000) || null;
    }
  } catch (e) {
    console.warn(`Text extraction failed for ${filename}:`, e);
  }
  return null;
}

// ---------------------------------------------------------------- ledger
export async function alreadyIngested(adminClient: any, userId: string, messageId: string): Promise<boolean> {
  const { data } = await adminClient.from("ingest_events")
    .select("id").eq("user_id", userId).eq("gmail_message_id", messageId).limit(1);
  return (data?.length ?? 0) > 0;
}

async function logEvent(adminClient: any, base: Record<string, unknown>, ev: IngestEvent) {
  try {
    await adminClient.from("ingest_events").insert({ ...base, ...ev });
  } catch (e) { console.warn("ingest_events insert failed:", e); }
}

// ---------------------------------------------------------------- core
export interface IngestContext {
  adminClient: any;
  token: string;
  userId: string;
  channel: Channel;
  receiverAccountId?: string | null;
  receiverEmail?: string | null;
  supabaseUrl: string;
  serviceKey: string;
  /** Skip the ledger check (used when the caller already filtered). */
  force?: boolean;
}

/**
 * Ingest one Gmail message. Decks become deals (one per deck); other
 * documents attach to the first deal created from that message (or the most
 * recent deal for the user if the mail had no deck). Always marks read.
 */
export async function ingestGmailMessage(ctx: IngestContext, messageId: string): Promise<MessageReport> {
  const { adminClient, token, userId, channel, supabaseUrl, serviceKey } = ctx;
  const report: MessageReport = { message_id: messageId, thread_id: null, sender: "", subject: "", received_at: null, events: [] };

  const message = await getMessage(token, messageId);
  if (!message) {
    report.events.push({ outcome: "failed", reason: "Message not found" });
    return report;
  }
  const headers = message.payload?.headers ?? [];
  const sender = parseSender(headerValue(headers, "from"));
  report.thread_id = message.threadId ?? null;
  report.sender = `${sender.name} <${sender.address}>`;
  report.subject = headerValue(headers, "subject") || "No Subject";
  report.received_at = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null;

  const base = {
    user_id: userId, channel, receiver_account_id: ctx.receiverAccountId ?? null,
    gmail_message_id: messageId, sender: report.sender, subject: report.subject,
  };

  if (!ctx.force && (await alreadyIngested(adminClient, userId, messageId))) {
    report.events.push({ outcome: "skipped", reason: "Already processed" });
    return report; // do not re-log
  }

  const labels: string[] = message.labelIds ?? [];
  if (labels.includes("SENT") || labels.includes("DRAFT")) {
    const ev: IngestEvent = { outcome: "skipped", reason: "Outbound message" };
    await logEvent(adminClient, base, ev); report.events.push(ev);
    return report;
  }

  const attachments = findAttachments(message.payload?.parts ?? []);
  if (attachments.length === 0) {
    const ev: IngestEvent = { outcome: "skipped", reason: "No attachments" };
    await logEvent(adminClient, base, ev); report.events.push(ev);
    await markAsRead(token, messageId);
    return report;
  }

  // Decks first so documents in the same mail attach to the new deal.
  attachments.sort((a, b) => (a.kind === "deck" ? -1 : 1) - (b.kind === "deck" ? -1 : 1));

  const { data: active } = await adminClient.from("deals").select("id").eq("user_id", userId).in("status", PROCESSING_STATUSES).limit(1);
  let hasActiveJob = (active?.length ?? 0) > 0;
  let dealForDocs: string | null = null;

  for (const att of attachments) {
    const evBase: IngestEvent = { outcome: "failed", file_name: att.filename, mime_type: att.mimeType, size_bytes: att.size, gmail_attachment_id: att.attachmentId };
    try {
      if (att.kind === "unsupported") {
        const ev = { ...evBase, outcome: "unsupported" as Outcome, reason: `File type not handled (${att.filename.split(".").pop()})` };
        await logEvent(adminClient, base, ev); report.events.push(ev); continue;
      }
      const bytes = await getAttachmentBytes(token, messageId, att.attachmentId);
      if (!bytes) {
        const ev = { ...evBase, reason: "Download failed" };
        await logEvent(adminClient, base, ev); report.events.push(ev); continue;
      }
      const hash = await sha256(bytes);
      evBase.content_hash = hash;
      evBase.size_bytes = bytes.length;

      const { data: dup } = await adminClient.from("sources").select("id, deal_id, file_name")
        .eq("user_id", userId).eq("content_hash", hash).limit(1);
      if (dup?.length) {
        const ev = { ...evBase, outcome: "duplicate" as Outcome, reason: `Identical to "${dup[0].file_name}" already on a deal`, deal_id: dup[0].deal_id, source_id: dup[0].id };
        await logEvent(adminClient, base, ev); report.events.push(ev);
        if (!dealForDocs) dealForDocs = dup[0].deal_id;
        continue;
      }

      const sizeMB = (bytes.length / (1024 * 1024)).toFixed(1);

      if (att.kind === "deck") {
        const dealName = att.filename.replace(/\.(pdf|pptx?)\s*$/i, "").replace(/[_-]/g, " ").trim() || report.subject;
        const provenance = [
          channel === "receiver" ? "**Received via deal inbox**" : "**Received by email**",
          ctx.receiverEmail ? `- Inbox: ${ctx.receiverEmail}` : null,
          `- From: ${report.sender}`, `- Subject: ${report.subject}`,
        ].filter(Boolean).join("\n");
        const { data: deal, error } = await adminClient.from("deals").insert({
          user_id: userId, name: dealName, source: channel === "receiver" ? "receiver" : "email",
          status: hasActiveJob ? "queued" : "uploading", auto_ingested: true,
          deck_size: `${sizeMB}MB`, memo_draft: provenance, deep_research_status: "pending",
        }).select("id").single();
        if (error || !deal) throw new Error(error?.message ?? "deal insert failed");

        const storagePath = `${userId}/${deal.id}/${att.filename}`;
        const mime = att.filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        const { error: upErr } = await adminClient.storage.from("decks").upload(storagePath, new Blob([bytes.buffer as ArrayBuffer], { type: mime }), { upsert: true });
        if (upErr) { await adminClient.from("deals").delete().eq("id", deal.id); throw new Error(`upload failed: ${upErr.message}`); }

        const { data: src } = await adminClient.from("sources").insert({
          deal_id: deal.id, user_id: userId, file_name: att.filename, original_size: `${sizeMB}MB`,
          storage_path: storagePath, source_type: channel === "receiver" ? "receiver" : "email",
          processing_status: hasActiveJob ? "queued" : "uploaded", content_hash: hash,
        }).select("id").single();

        if (!hasActiveJob) {
          const dispatch = fetch(`${supabaseUrl}/functions/v1/process-deck`, {
            method: "POST",
            headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ dealId: deal.id, storagePath }),
          }).then(async (r) => { if (!r.ok) console.warn(`process-deck ${r.status} for ${deal.id}:`, await r.text().catch(() => "")); else await r.text().catch(() => ""); })
            .catch((e) => console.warn(`process-deck dispatch error ${deal.id}:`, e));
          (globalThis as any).EdgeRuntime?.waitUntil?.(dispatch);
          hasActiveJob = true;
        }
        dealForDocs = dealForDocs ?? deal.id;
        const ev = { ...evBase, outcome: "uploaded" as Outcome, deal_id: deal.id, source_id: src?.id ?? null, reason: hasActiveJob && !src ? undefined : (hasActiveJob ? "Queued behind an active job" : undefined) };
        await logEvent(adminClient, base, ev); report.events.push(ev);
        continue;
      }

      // Supporting document → data-room source on the deal from this mail
      // (or the user's most recent deal when the mail carried no deck).
      if (!dealForDocs) {
        const { data: latest } = await adminClient.from("deals").select("id").eq("user_id", userId).order("created_at", { ascending: false }).limit(1);
        dealForDocs = latest?.[0]?.id ?? null;
      }
      if (!dealForDocs) {
        const ev = { ...evBase, outcome: "skipped" as Outcome, reason: "Document without a deal to attach to" };
        await logEvent(adminClient, base, ev); report.events.push(ev); continue;
      }
      const storagePath = `${userId}/${dealForDocs}/${att.filename}`;
      const { error: upErr } = await adminClient.storage.from("decks").upload(storagePath, new Blob([bytes.buffer as ArrayBuffer], { type: att.mimeType || "application/octet-stream" }), { upsert: true });
      if (upErr) throw new Error(`upload failed: ${upErr.message}`);
      const text = await extractDocumentText(att.filename, bytes);
      const { data: src } = await adminClient.from("sources").insert({
        deal_id: dealForDocs, user_id: userId, file_name: att.filename, original_size: `${sizeMB}MB`,
        storage_path: storagePath, source_type: "attachment", processing_status: "attached",
        content_hash: hash, extracted_text: text,
      }).select("id").single();
      const ev = { ...evBase, outcome: "attached" as Outcome, deal_id: dealForDocs, source_id: src?.id ?? null, reason: text ? undefined : "Attached without text extraction" };
      await logEvent(adminClient, base, ev); report.events.push(ev);
    } catch (e) {
      const ev = { ...evBase, outcome: "failed" as Outcome, reason: String(e).slice(0, 300) };
      await logEvent(adminClient, base, ev); report.events.push(ev);
    }
  }

  await markAsRead(token, messageId);
  return report;
}

/** Candidate messages not yet in the ledger — the read-only "scan" step. */
export async function scanForCandidates(ctx: Pick<IngestContext, "adminClient" | "token" | "userId">, opts: { query: string; max?: number }) {
  const ids = await searchMessages(ctx.token, opts.query, opts.max ?? 25);
  const out: Array<{ message_id: string; thread_id: string | null; sender: string; subject: string; received_at: string | null; attachments: Array<{ attachment_id: string; file_name: string; size_bytes: number; kind: string }> }> = [];
  for (const id of ids) {
    if (await alreadyIngested(ctx.adminClient, ctx.userId, id)) continue;
    const m = await getMessage(ctx.token, id);
    if (!m) continue;
    const labels: string[] = m.labelIds ?? [];
    if (labels.includes("SENT") || labels.includes("DRAFT")) continue;
    const headers = m.payload?.headers ?? [];
    const s = parseSender(headerValue(headers, "from"));
    out.push({
      message_id: id, thread_id: m.threadId ?? null, sender: `${s.name} <${s.address}>`,
      subject: headerValue(headers, "subject") || "No Subject",
      received_at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
      attachments: findAttachments(m.payload?.parts ?? []).map((a) => ({ attachment_id: a.attachmentId, file_name: a.filename, size_bytes: a.size, kind: a.kind })),
    });
  }
  return out;
}

/** Receiver inboxes scan everything with attachments from the last 30 days. */
export const RECEIVER_QUERY = "has:attachment in:inbox newer_than:30d";

export function summarize(reports: MessageReport[]) {
  const counts: Record<Outcome, number> = { uploaded: 0, attached: 0, duplicate: 0, unsupported: 0, skipped: 0, failed: 0 };
  for (const r of reports) for (const e of r.events) counts[e.outcome]++;
  return counts;
}
