/**
 * Receiver ("deal inbox") Gmail accounts — shared by gmail-listener (poll),
 * gmail-watch (push registration) and gmail-webhook (push handling).
 *
 * Unlike the primary account's label-based flow, a receiver account is scanned
 * wholesale: every inbound message carrying a deck attachment becomes a deal
 * for the owning user (and, via the deals_set_team trigger, their team).
 */

export interface ReceiverAccount {
  id: string;
  user_id: string;
  email: string;
  google_access_token: string | null;
  google_refresh_token: string | null;
  gmail_history_id: string | null;
  enabled: boolean;
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const PROCESSING_STATUSES = ["uploading", "converting", "compressing", "scraping", "extracting", "searching-website", "syncing"];

export async function refreshGoogleAccessToken(refreshToken: string): Promise<string | null> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET");
    return null;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    console.error("Receiver token refresh failed:", await res.text());
    return null;
  }
  return (await res.json()).access_token ?? null;
}

/** Valid access token for a receiver, refreshing and persisting when needed. */
export async function getReceiverToken(adminClient: any, account: ReceiverAccount): Promise<string | null> {
  if (account.google_access_token) {
    const probe = await fetch(`${GMAIL}/profile`, {
      headers: { Authorization: `Bearer ${account.google_access_token}` },
    });
    if (probe.ok) return account.google_access_token;
  }
  if (!account.google_refresh_token) return null;
  const fresh = await refreshGoogleAccessToken(account.google_refresh_token);
  if (fresh) {
    await adminClient.from("receiver_accounts")
      .update({ google_access_token: fresh }).eq("id", account.id);
  }
  return fresh;
}

export async function recordReceiverPoll(adminClient: any, accountId: string, error: string | null) {
  await adminClient.from("receiver_accounts")
    .update({ last_polled_at: new Date().toISOString(), last_error: error })
    .eq("id", accountId);
}

// ---------------------------------------------------------------- gmail helpers

/** Unread inbox messages with an attachment — the receiver scans everything. */
export async function listReceiverCandidates(token: string, max = 20): Promise<string[]> {
  const q = encodeURIComponent("is:unread has:attachment in:inbox");
  const res = await fetch(`${GMAIL}/messages?q=${q}&maxResults=${max}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error("Receiver list failed:", await res.text());
    return [];
  }
  const data = await res.json();
  return (data.messages ?? []).map((m: any) => m.id as string);
}

export async function getMessage(token: string, messageId: string): Promise<any | null> {
  const res = await fetch(`${GMAIL}/messages/${messageId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok ? res.json() : null;
}

export async function getAttachment(token: string, messageId: string, attachmentId: string): Promise<Uint8Array | null> {
  const res = await fetch(`${GMAIL}/messages/${messageId}/attachments/${attachmentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const base64 = String(data.data ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

export function extractSender(headers: any[]): { name: string; address: string } {
  const from = headerValue(headers, "from");
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  const name = from.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() ?? address.split("@")[0] ?? "Unknown sender";
  return { name, address };
}

function isDeckFile(filename: string): boolean {
  const f = filename.toLowerCase();
  return f.endsWith(".pdf") || f.endsWith(".pptx") || f.endsWith(".ppt");
}

export function findDeckAttachments(parts: any[]): { filename: string; attachmentId: string; size: number }[] {
  const out: { filename: string; attachmentId: string; size: number }[] = [];
  for (const part of parts ?? []) {
    if (part.filename && part.body?.attachmentId && isDeckFile(part.filename)) {
      out.push({ filename: part.filename, attachmentId: part.body.attachmentId, size: part.body.size ?? 0 });
    }
    if (part.parts) out.push(...findDeckAttachments(part.parts));
  }
  return out;
}

// ---------------------------------------------------------------- ingestion

/**
 * Turn one Gmail message into deals (one per deck attachment) for the
 * receiver's owner. Returns the number of deals created. Always marks the
 * message read afterwards so it is never re-scanned.
 */
export async function ingestReceiverMessage(opts: {
  adminClient: any;
  token: string;
  account: ReceiverAccount;
  messageId: string;
  supabaseUrl: string;
  serviceKey: string;
}): Promise<number> {
  const { adminClient, token, account, messageId, supabaseUrl, serviceKey } = opts;
  const userId = account.user_id;
  let created = 0;

  try {
    const message = await getMessage(token, messageId);
    if (!message) return 0;

    // Only inbound mail: skip anything the receiver itself sent.
    const labels: string[] = message.labelIds ?? [];
    if (labels.includes("SENT") || labels.includes("DRAFT")) {
      await markAsRead(token, messageId);
      return 0;
    }

    const headers = message.payload?.headers ?? [];
    const subject = headerValue(headers, "subject") || "No Subject";
    const sender = extractSender(headers);
    const attachments = findDeckAttachments(message.payload?.parts ?? []);

    if (attachments.length === 0) {
      console.log(`Receiver ${account.email}: no deck in "${subject}" — skipping`);
      await markAsRead(token, messageId);
      return 0;
    }

    // Same per-user concurrency guard as the app uploader and public intake.
    const { data: active } = await adminClient.from("deals")
      .select("id").eq("user_id", userId).in("status", PROCESSING_STATUSES).limit(1);
    let hasActiveJob = (active?.length ?? 0) > 0;

    for (const attachment of attachments) {
      const bytes = await getAttachment(token, messageId, attachment.attachmentId);
      if (!bytes) {
        console.warn(`Receiver ${account.email}: failed to download ${attachment.filename}`);
        continue;
      }
      const sizeMB = (bytes.length / (1024 * 1024)).toFixed(1);
      const dealName = attachment.filename.replace(/\.(pdf|pptx?)\s*$/i, "").replace(/[_-]/g, " ").trim() || subject;

      const provenance = [
        "**Received via deal inbox**",
        `- Inbox: ${account.email}`,
        `- From: ${sender.name} <${sender.address}>`,
        `- Subject: ${subject}`,
      ].join("\n");

      const { data: deal, error: dealError } = await adminClient.from("deals").insert({
        user_id: userId,
        name: dealName,
        source: "receiver",
        status: hasActiveJob ? "queued" : "uploading",
        auto_ingested: true,
        deck_size: `${sizeMB}MB`,
        memo_draft: provenance,
        deep_research_status: "pending",
      }).select("id").single();
      if (dealError || !deal) {
        console.error(`Receiver ${account.email}: deal insert failed:`, dealError);
        continue;
      }

      const storagePath = `${userId}/${deal.id}/${attachment.filename}`;
      const mime = attachment.filename.toLowerCase().endsWith(".pdf")
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      const { error: uploadError } = await adminClient.storage.from("decks")
        .upload(storagePath, new Blob([bytes.buffer as ArrayBuffer], { type: mime }), { upsert: true });
      if (uploadError) {
        console.error(`Receiver ${account.email}: upload failed:`, uploadError);
        await adminClient.from("deals").delete().eq("id", deal.id);
        continue;
      }

      await adminClient.from("sources").insert({
        deal_id: deal.id,
        user_id: userId,
        file_name: attachment.filename,
        original_size: `${sizeMB}MB`,
        storage_path: storagePath,
        source_type: "receiver",
        processing_status: hasActiveJob ? "queued" : "uploaded",
      });

      if (hasActiveJob) {
        console.log(`Receiver ${account.email}: deal ${deal.id} queued behind an active job`);
      } else {
        // Fire-and-forget; process-deck runs for minutes and must not be awaited.
        const dispatch = fetch(`${supabaseUrl}/functions/v1/process-deck`, {
          method: "POST",
          headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ dealId: deal.id, storagePath }),
        }).then(async (r) => {
          if (!r.ok) console.warn(`process-deck dispatch ${r.status} for ${deal.id}:`, await r.text().catch(() => ""));
          else await r.text().catch(() => "");
        }).catch((e) => console.warn(`process-deck dispatch error for ${deal.id}:`, e));
        (globalThis as any).EdgeRuntime?.waitUntil?.(dispatch);
        // Subsequent attachments in the same mail queue behind this one.
        hasActiveJob = true;
      }
      created++;
    }
  } catch (e) {
    console.error(`Receiver ${account.email}: message ${messageId} failed:`, e);
  } finally {
    await markAsRead(token, messageId);
  }
  return created;
}

/** Poll one receiver account end to end. Returns deals created. */
export async function pollReceiverAccount(opts: {
  adminClient: any;
  account: ReceiverAccount;
  supabaseUrl: string;
  serviceKey: string;
}): Promise<number> {
  const { adminClient, account, supabaseUrl, serviceKey } = opts;
  try {
    const token = await getReceiverToken(adminClient, account);
    if (!token) {
      await recordReceiverPoll(adminClient, account.id, "Google token expired — reconnect this inbox");
      return 0;
    }
    const ids = await listReceiverCandidates(token);
    let total = 0;
    for (const id of ids) {
      total += await ingestReceiverMessage({ adminClient, token, account, messageId: id, supabaseUrl, serviceKey });
    }
    await recordReceiverPoll(adminClient, account.id, null);
    return total;
  } catch (e) {
    await recordReceiverPoll(adminClient, account.id, String(e).slice(0, 300));
    return 0;
  }
}

/** Register Gmail push notifications for a receiver account. */
export async function registerReceiverWatch(adminClient: any, token: string, account: ReceiverAccount, topicName: string) {
  const res = await fetch(`${GMAIL}/watch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ topicName, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" }),
  });
  if (!res.ok) throw new Error(`watch() failed for ${account.email}: ${await res.text()}`);
  const data = await res.json();
  if (!account.gmail_history_id && data.historyId) {
    await adminClient.from("receiver_accounts")
      .update({ gmail_history_id: String(data.historyId) }).eq("id", account.id);
  }
  return data;
}
