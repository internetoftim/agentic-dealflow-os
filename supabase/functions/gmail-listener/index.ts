import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { pollReceiverAccount, type ReceiverAccount } from "../_shared/gmail-receiver.ts";
import { ingestGmailMessage } from "../_shared/gmail-ingest.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/** Gmail label name to watch for deck submissions */
const DECK_LABEL_NAME = "deck";

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
  return (await res.json()).access_token;
}

/** Get a valid token, refreshing if expired */
async function getValidToken(
  adminClient: any,
  userId: string,
  currentToken: string | null,
  refreshToken: string | null
): Promise<string | null> {
  if (currentToken) {
    const testRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${currentToken}` },
    });
    if (testRes.ok) return currentToken;
  }
  if (!refreshToken) return null;
  const newToken = await refreshAccessToken(refreshToken);
  if (newToken) {
    await adminClient.from("user_settings").update({ google_provider_token: newToken }).eq("user_id", userId);
  }
  return newToken;
}

/** Get or create the Gmail label ID for the given name */
async function getOrCreateLabelId(
  token: string,
  labelName: string
): Promise<string | null> {
  const listRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) {
    console.error("Failed to list labels:", await listRes.text());
    return null;
  }
  const { labels } = await listRes.json();
  const match = labels?.find(
    (l: any) => l.name.toLowerCase() === labelName.toLowerCase()
  );
  if (match) return match.id;

  // Create label if it doesn't exist
  const createRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: labelName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      }),
    }
  );
  if (createRes.ok) {
    const created = await createRes.json();
    console.log(`Created Gmail label "${labelName}" with ID ${created.id}`);
    return created.id;
  }
  console.error("Failed to create label:", await createRes.text());
  return null;
}

/** Fetch unread messages with the given label */
async function getUnreadMessages(
  token: string,
  labelId: string
): Promise<any[]> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=${labelId}&q=is:unread&maxResults=10`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error("Failed to list messages:", await res.text());
    return [];
  }
  const data = await res.json();
  return data.messages || [];
}

/** Get full message details */
async function getMessage(token: string, messageId: string): Promise<any> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  return res.json();
}

/** Download an attachment from Gmail */
async function getAttachment(
  token: string,
  messageId: string,
  attachmentId: string
): Promise<Uint8Array | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  // Gmail returns base64url-encoded data
  const base64 = data.data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Mark a message as read (remove UNREAD label) */
async function markAsRead(token: string, messageId: string): Promise<void> {
  await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    }
  );
}

/** Extract sender name from email headers */
function extractSenderName(headers: any[]): string {
  const from = headers.find((h: any) => h.name.toLowerCase() === "from")?.value || "";
  // "John Doe <john@example.com>" → "John Doe"
  const match = from.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  // "john@example.com" → "john"
  const emailMatch = from.match(/([^@]+)@/);
  return emailMatch ? emailMatch[1].trim() : "Unknown Sender";
}

/** Extract subject from email headers */
function extractSubject(headers: any[]): string {
  return headers.find((h: any) => h.name.toLowerCase() === "subject")?.value || "No Subject";
}

/** Check if a filename is a supported deck format */
function isDeckFile(filename: string): boolean {
  const ext = filename.toLowerCase();
  return ext.endsWith(".pdf") || ext.endsWith(".pptx") || ext.endsWith(".ppt");
}

/** Find attachments in message parts (recursive for multipart) */
function findAttachments(
  parts: any[]
): { filename: string; mimeType: string; attachmentId: string; size: number }[] {
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
    // Recurse into multipart sub-parts
    if (part.parts) {
      attachments.push(...findAttachments(part.parts));
    }
  }
  return attachments;
}

/**
 * Gmail Listener Edge Function
 * 
 * Polls Gmail for unread emails with the "deck" label, extracts deck attachments,
 * creates deal records, and triggers the process-deck pipeline.
 * 
 * Can be triggered via cron or manually.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // ---- Recovery path: re-dispatch process-deck for a specific stalled deal.
    // Lets us recover deals that got stuck in "extracting" because a previous
    // listener run awaited process-deck and was killed mid-flight. Body:
    //   { "retryDealId": "<uuid>", "resumeFrom"?: "extracting" }
    if (req.method === "POST") {
      let body: any = null;
      try { body = await req.clone().json(); } catch { /* not JSON */ }
      if (body?.retryDealId) {
        const { data: deal } = await adminClient
          .from("deals")
          .select("id, user_id")
          .eq("id", body.retryDealId)
          .maybeSingle();
        if (!deal) {
          return new Response(JSON.stringify({ error: "deal not found" }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const { data: source } = await adminClient
          .from("sources")
          .select("storage_path")
          .eq("deal_id", body.retryDealId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!source?.storage_path) {
          return new Response(JSON.stringify({ error: "no source storage_path" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const r = await fetch(`${supabaseUrl}/functions/v1/process-deck`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${supabaseServiceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            dealId: body.retryDealId,
            storagePath: source.storage_path,
            ...(body.resumeFrom ? { resumeFrom: body.resumeFrom } : {}),
          }),
        });
        return new Response(
          JSON.stringify({ dispatched: r.ok, status: r.status }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }


    // Fetch all users with gmail_label_enabled and a valid Google token
    const { data: eligibleUsers, error: usersError } = await adminClient
      .from("user_settings")
      .select("user_id, google_provider_token, google_provider_refresh_token")
      .eq("gmail_label_enabled", true);

    if (usersError) throw usersError;
    console.log(`Processing ${eligibleUsers?.length ?? 0} user(s) with Gmail listening enabled`);

    let totalProcessed = 0;

    for (const userSettings of eligibleUsers ?? []) {
      const { user_id } = userSettings;

      try {
        // 0. Get valid token (refresh if needed)
        const token = await getValidToken(
          adminClient,
          user_id,
          userSettings.google_provider_token,
          userSettings.google_provider_refresh_token
        );
        if (!token) {
          console.warn(`No valid token for user ${user_id}`);
          continue;
        }

        // 1. Get or create the "deck" label
        const labelId = await getOrCreateLabelId(token, DECK_LABEL_NAME);
        if (!labelId) {
          console.warn(`Could not find/create label for user ${user_id}`);
          continue;
        }

        // 2. Fetch unread messages with that label
        const messages = await getUnreadMessages(token, labelId);
        if (messages.length === 0) {
          console.log(`No unread deck emails for user ${user_id}`);
          continue;
        }

        console.log(`Found ${messages.length} unread deck email(s) for user ${user_id}`);

        // Shared core: ledger (idempotent), content-hash dedup, documents
        // attached as data-room sources, every outcome recorded.
        for (const msg of messages) {
          const r = await ingestGmailMessage(
            { adminClient, token, userId: user_id, channel: "label", supabaseUrl, serviceKey: supabaseServiceKey },
            msg.id,
          );
          totalProcessed += r.events.filter((e) => e.outcome === "uploaded").length;
        }
      } catch (userError) {
        console.error(`Error processing user ${user_id}:`, userError);
      }
    }

    // ---- Receiver (deal-inbox) accounts: every inbound mail is scanned, no label.
    let receiverProcessed = 0;
    const { data: receivers } = await adminClient
      .from("receiver_accounts")
      .select("id, user_id, email, google_access_token, google_refresh_token, gmail_history_id, enabled")
      .eq("enabled", true);
    for (const account of (receivers ?? []) as ReceiverAccount[]) {
      const reports = await pollReceiverAccount({ adminClient, account, supabaseUrl, serviceKey: supabaseServiceKey });
      receiverProcessed += reports.flatMap((r) => r.events).filter((e) => e.outcome === "uploaded").length;
    }
    if (receivers?.length) console.log(`Receiver inboxes: ${receivers.length} polled, ${receiverProcessed} deal(s) created`);

    return new Response(
      JSON.stringify({ success: true, processed: totalProcessed, receiverProcessed }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("gmail-listener error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
