import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getReceiverToken, ingestReceiverMessage, listReceiverCandidates, recordReceiverPoll, type ReceiverAccount } from "../_shared/gmail-receiver.ts";
import { ingestGmailMessage } from "../_shared/gmail-ingest.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Refresh a Google access token using the refresh token */
async function refreshAccessToken(refreshToken: string): Promise<string | null> {
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
    console.error("Token refresh failed:", await res.text());
    return null;
  }
  const data = await res.json();
  return data.access_token;
}

/** Get a valid access token for a user, refreshing if needed */
async function getValidToken(
  adminClient: any,
  userId: string,
  currentToken: string | null,
  refreshToken: string | null
): Promise<string | null> {
  // Try current token first
  if (currentToken) {
    const testRes = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${currentToken}` } }
    );
    if (testRes.ok) return currentToken;
  }

  // Refresh
  if (!refreshToken) {
    console.error(`No refresh token for user ${userId}`);
    return null;
  }

  const newToken = await refreshAccessToken(refreshToken);
  if (newToken) {
    await adminClient
      .from("user_settings")
      .update({ google_provider_token: newToken })
      .eq("user_id", userId);
  }
  return newToken;
}

const DECK_LABEL_NAME = "deck";

async function getOrCreateLabelId(token: string, labelName: string): Promise<string | null> {
  const listRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) {
    console.error("Failed to list labels:", await listRes.text());
    return null;
  }
  const { labels } = await listRes.json();
  const allNames = labels?.map((l: any) => l.name) || [];
  console.log(`Available labels: ${JSON.stringify(allNames)}`);
  const match = labels?.find((l: any) => l.name.toLowerCase() === labelName.toLowerCase());
  if (match) return match.id;

  // Create the label if it doesn't exist
  console.log(`Label "${labelName}" not found, creating it...`);
  const createRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: labelName, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
  if (!createRes.ok) {
    console.error("Failed to create label:", await createRes.text());
    return null;
  }
  const created = await createRes.json();
  console.log(`Created label "${labelName}" with id ${created.id}`);
  return created.id;
}

function isDeckFile(filename: string): boolean {
  const ext = filename.toLowerCase();
  return ext.endsWith(".pdf") || ext.endsWith(".pptx") || ext.endsWith(".ppt");
}

function findAttachments(parts: any[]): { filename: string; mimeType: string; attachmentId: string; size: number }[] {
  const attachments: any[] = [];
  for (const part of parts || []) {
    if (part.filename && part.body?.attachmentId && isDeckFile(part.filename)) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0,
      });
    }
    if (part.parts) attachments.push(...findAttachments(part.parts));
  }
  return attachments;
}

async function getAttachment(token: string, messageId: string, attachmentId: string): Promise<Uint8Array | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const base64 = data.data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function markAsRead(token: string, messageId: string): Promise<void> {
  await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    }
  );
}

/**
 * Gmail Webhook — receives Google Pub/Sub push notifications.
 * 
 * When Gmail sends a notification, this function:
 * 1. Decodes the Pub/Sub message to get the user's email and historyId
 * 2. Finds the matching user in our DB
 * 3. Uses history.list to get new messages since last historyId
 * 4. Processes deck attachments from messages with the "deck" label
 */
/** Receiver mailbox push: pull new inbox messages since the last historyId. */
async function handleReceiverNotification(
  adminClient: any, account: ReceiverAccount, newHistoryId: string, supabaseUrl: string, serviceKey: string,
): Promise<number> {
  const token = await getReceiverToken(adminClient, account);
  if (!token) {
    await recordReceiverPoll(adminClient, account.id, "Google token expired — reconnect this inbox");
    return 0;
  }
  let ids: string[] = [];
  const start = account.gmail_history_id || newHistoryId;
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${start}&labelId=INBOX&historyTypes=messageAdded`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.ok) {
    const data = await res.json();
    for (const h of data.history ?? []) for (const a of h.messagesAdded ?? []) if (a.message?.id) ids.push(a.message.id);
  } else {
    console.warn(`Receiver history failed (${res.status}) — falling back to unread scan`);
    ids = await listReceiverCandidates(token);
  }
  ids = [...new Set(ids)];
  let processed = 0;
  for (const id of ids) {
    const r = await ingestReceiverMessage({ adminClient, token, account, messageId: id, supabaseUrl, serviceKey });
    processed += r.events.filter((e) => e.outcome === "uploaded").length;
  }
  if (newHistoryId) {
    await adminClient.from("receiver_accounts").update({ gmail_history_id: newHistoryId }).eq("id", account.id);
  }
  await recordReceiverPoll(adminClient, account.id, null);
  console.log(`Receiver ${account.email}: ${processed} deal(s) from ${ids.length} message(s)`);
  return processed;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();

    // Pub/Sub sends: { message: { data: base64(...), messageId, publishTime }, subscription }
    const pubsubMessage = body?.message;
    if (!pubsubMessage?.data) {
      console.log("No Pub/Sub data in request");
      return new Response(JSON.stringify({ message: "No data" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Decode the Pub/Sub payload
    const decoded = JSON.parse(atob(pubsubMessage.data));
    const emailAddress = decoded.emailAddress;
    const newHistoryId = decoded.historyId;

    console.log(`Pub/Sub notification for ${emailAddress}, historyId: ${newHistoryId}`);

    if (!emailAddress) {
      return new Response(JSON.stringify({ message: "No email in notification" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Find the user by their email
    const { data: authUsers } = await adminClient.auth.admin.listUsers();
    const matchedUser = authUsers?.users?.find(
      (u: any) => u.email?.toLowerCase() === emailAddress.toLowerCase()
    );

    if (!matchedUser) {
      // Not a primary account — is it a receiver (deal-inbox) mailbox?
      const { data: receiver } = await adminClient
        .from("receiver_accounts")
        .select("id, user_id, email, google_access_token, google_refresh_token, gmail_history_id, enabled")
        .ilike("email", emailAddress)
        .maybeSingle();
      if (receiver && (receiver as ReceiverAccount).enabled) {
        const count = await handleReceiverNotification(adminClient, receiver as ReceiverAccount, String(newHistoryId ?? ""), supabaseUrl, supabaseServiceKey);
        return new Response(JSON.stringify({ message: "Receiver processed", processed: count }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      console.log(`No matching user for ${emailAddress}`);
      return new Response(JSON.stringify({ message: "User not found" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = matchedUser.id;

    // Get user settings
    const { data: settings } = await adminClient
      .from("user_settings")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (!settings || !settings.gmail_label_enabled) {
      console.log(`Gmail listening disabled for user ${userId}`);
      return new Response(JSON.stringify({ message: "Gmail listening disabled" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get valid token
    const token = await getValidToken(
      adminClient,
      userId,
      settings.google_provider_token,
      settings.google_provider_refresh_token
    );

    if (!token) {
      console.error(`Could not get valid token for user ${userId}`);
      return new Response(JSON.stringify({ error: "Token refresh failed" }), {
        status: 200, // Return 200 to avoid Pub/Sub retries
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get the "deck" label ID
    const labelId = await getOrCreateLabelId(token, DECK_LABEL_NAME);
    if (!labelId) {
      console.log(`No "deck" label found for user ${userId}`);
      return new Response(JSON.stringify({ message: "No deck label" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use history.list to get changes since last historyId
    const startHistoryId = settings.gmail_history_id || newHistoryId;
    const historyUrl = `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${startHistoryId}&labelId=${labelId}&historyTypes=messageAdded&historyTypes=labelAdded`;
    const historyRes = await fetch(historyUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    let messageIds: string[] = [];

    if (historyRes.ok) {
      const historyData = await historyRes.json();
      console.log(`History response: ${JSON.stringify(historyData).slice(0, 500)}`);
      const histories = historyData.history || [];
      for (const h of histories) {
      // Extract from messagesAdded
      for (const added of h.messagesAdded || []) {
        if (added.message?.id) messageIds.push(added.message.id);
      }
      // Extract from labelsAdded
      for (const labeled of h.labelsAdded || []) {
        if (labeled.message?.id) messageIds.push(labeled.message.id);
      }
      // Fallback: extract from top-level messages array
      for (const msg of h.messages || []) {
        if (msg.id) messageIds.push(msg.id);
      }
      }
    } else {
      const errText = await historyRes.text();
      console.error(`History list failed (${historyRes.status}):`, errText);
      if (historyRes.status === 404) {
        // historyId too old — fall back to listing unread messages with label
        console.log("History expired, falling back to unread messages");
        const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=${labelId}&q=is:unread&maxResults=10`;
        const listRes = await fetch(listUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (listRes.ok) {
          const listData = await listRes.json();
          messageIds = (listData.messages || []).map((m: any) => m.id);
        }
      }
    }

    // Deduplicate
    messageIds = [...new Set(messageIds)];

    console.log(`Processing ${messageIds.length} message(s) for user ${userId}`);

    let processed = 0;

    // Shared core: ledger (idempotent), content-hash dedup, documents
    // attached as data-room sources, every outcome recorded.
    for (const msgId of messageIds) {
      const r = await ingestGmailMessage(
        { adminClient, token, userId, channel: "label", supabaseUrl, serviceKey: supabaseServiceKey },
        msgId,
      );
      processed += r.events.filter((e) => e.outcome === "uploaded").length;
    }

    // Update historyId
    await adminClient
      .from("user_settings")
      .update({ gmail_history_id: String(newHistoryId) })
      .eq("user_id", userId);

    console.log(`Done: processed ${processed} deck(s) for ${emailAddress}`);

    return new Response(
      JSON.stringify({ success: true, processed }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("gmail-webhook error:", error);
    // Always return 200 to Pub/Sub to avoid infinite retries
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
