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

import { ingestGmailMessage, searchMessages, RECEIVER_QUERY, type MessageReport } from "./gmail-ingest.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

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

// ---------------------------------------------------------------- ingestion

/** Candidate message ids for a receiver: everything with an attachment, read or not. */
export async function listReceiverCandidates(token: string, max = 25): Promise<string[]> {
  return searchMessages(token, RECEIVER_QUERY, max);
}

/** Ingest one message for a receiver account via the shared core. */
export async function ingestReceiverMessage(opts: {
  adminClient: any; token: string; account: ReceiverAccount; messageId: string; supabaseUrl: string; serviceKey: string; force?: boolean;
}): Promise<MessageReport> {
  return ingestGmailMessage({
    adminClient: opts.adminClient, token: opts.token, userId: opts.account.user_id, channel: "receiver",
    receiverAccountId: opts.account.id, receiverEmail: opts.account.email,
    supabaseUrl: opts.supabaseUrl, serviceKey: opts.serviceKey, force: opts.force,
  }, opts.messageId);
}

/** Poll one receiver account end to end. Returns the per-message reports. */
export async function pollReceiverAccount(opts: {
  adminClient: any; account: ReceiverAccount; supabaseUrl: string; serviceKey: string; max?: number;
}): Promise<MessageReport[]> {
  const { adminClient, account, supabaseUrl, serviceKey } = opts;
  try {
    const token = await getReceiverToken(adminClient, account);
    if (!token) {
      await recordReceiverPoll(adminClient, account.id, "Google token expired — reconnect this inbox");
      return [];
    }
    const ids = await listReceiverCandidates(token, opts.max ?? 25);
    const reports: MessageReport[] = [];
    for (const id of ids) {
      reports.push(await ingestReceiverMessage({ adminClient, token, account, messageId: id, supabaseUrl, serviceKey }));
    }
    await recordReceiverPoll(adminClient, account.id, null);
    return reports;
  } catch (e) {
    await recordReceiverPoll(adminClient, account.id, String(e).slice(0, 300));
    return [];
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
