import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    // Fetch all users with gmail_label_enabled and a valid Google token
    const { data: eligibleUsers, error: usersError } = await adminClient
      .from("user_settings")
      .select("user_id, google_provider_token, google_provider_refresh_token")
      .eq("gmail_label_enabled", true);

    if (usersError) throw usersError;
    if (!eligibleUsers || eligibleUsers.length === 0) {
      return new Response(
        JSON.stringify({ message: "No users with Gmail listening enabled" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Processing ${eligibleUsers.length} user(s) with Gmail listening enabled`);

    let totalProcessed = 0;

    for (const userSettings of eligibleUsers) {
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

        for (const msg of messages) {
          try {
            // 3. Get full message details
            const fullMessage = await getMessage(token, msg.id);
            if (!fullMessage) continue;

            const headers = fullMessage.payload?.headers || [];
            const subject = extractSubject(headers);
            const senderName = extractSenderName(headers);

            // 4. Find deck attachments
            const attachments = findAttachments(fullMessage.payload?.parts || []);

            if (attachments.length === 0) {
              console.log(`No deck attachments in email "${subject}" — skipping`);
              await markAsRead(token, msg.id);
              continue;
            }

            console.log(`Processing ${attachments.length} attachment(s) from "${subject}"`);

            for (const attachment of attachments) {
              // 5. Download attachment
              const fileBytes = await getAttachment(
                token,
                msg.id,
                attachment.attachmentId
              );
              if (!fileBytes) {
                console.warn(`Failed to download attachment ${attachment.filename}`);
                continue;
              }

              const fileSizeMB = (fileBytes.length / (1024 * 1024)).toFixed(1);
              console.log(`Downloaded ${attachment.filename} (${fileSizeMB}MB)`);

              // 6. Derive deal name from filename or subject
              const dealName = attachment.filename
                .replace(/\.(pdf|pptx?)\s*$/i, "")
                .replace(/[_-]/g, " ")
                .trim() || subject;

              // 7. Create deal record
              const { data: deal, error: dealError } = await adminClient
                .from("deals")
                .insert({
                  user_id,
                  name: dealName,
                  source: "email",
                  status: "uploading",
                  auto_ingested: true,
                  deck_size: `${fileSizeMB}MB`,
                })
                .select()
                .single();

              if (dealError) {
                console.error(`Failed to create deal for ${attachment.filename}:`, dealError);
                continue;
              }

              // 8. Upload file to Supabase Storage
              const storagePath = `${user_id}/${deal.id}/${attachment.filename}`;
              const mimeType = attachment.filename.toLowerCase().endsWith(".pdf")
                ? "application/pdf"
                : "application/vnd.openxmlformats-officedocument.presentationml.presentation";

              const { error: uploadError } = await adminClient.storage
                .from("decks")
                .upload(
                  storagePath,
                  new Blob([fileBytes.buffer as ArrayBuffer], { type: mimeType }),
                  { upsert: true }
                );

              if (uploadError) {
                console.error(`Failed to upload ${attachment.filename}:`, uploadError);
                // Clean up the deal
                await adminClient.from("deals").delete().eq("id", deal.id);
                continue;
              }

              // 9. Create source record
              await adminClient.from("sources").insert({
                deal_id: deal.id,
                user_id,
                file_name: attachment.filename,
                original_size: `${fileSizeMB}MB`,
                storage_path: storagePath,
                source_type: "email",
                processing_status: "uploaded",
              });

              // 10. Trigger process-deck pipeline (true fire-and-forget).
              // We MUST NOT await the response — process-deck runs for minutes
              // and would otherwise kill this listener's request budget,
              // aborting process-deck mid-run (was leaving deals stuck in "extracting").
              // EdgeRuntime.waitUntil keeps the runtime alive long enough to
              // dispatch the request, but this handler returns immediately.
              const dispatch = fetch(
                `${supabaseUrl}/functions/v1/process-deck`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${supabaseServiceKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    dealId: deal.id,
                    storagePath,
                  }),
                }
              ).then(async (r) => {
                if (!r.ok) {
                  console.warn(
                    `process-deck dispatch returned ${r.status} for deal ${deal.id}:`,
                    await r.text().catch(() => "")
                  );
                } else {
                  console.log(`Dispatched process-deck for deal ${deal.id} (${dealName})`);
                  // Drain body so the connection can close cleanly.
                  await r.text().catch(() => "");
                }
              }).catch((e) => {
                console.warn(`process-deck dispatch error for deal ${deal.id}:`, e);
              });
              // @ts-expect-error EdgeRuntime is provided by Supabase Edge Functions.
              if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
                // @ts-expect-error see above
                EdgeRuntime.waitUntil(dispatch);
              }

              totalProcessed++;
            }

            // 11. Mark email as read after processing all attachments
            await markAsRead(token, msg.id);
          } catch (msgError) {
            console.error(`Error processing message ${msg.id}:`, msgError);
            // Mark as read even on error to avoid reprocessing loops
            await markAsRead(token, msg.id).catch(() => {});
          }
        }
      } catch (userError) {
        console.error(`Error processing user ${user_id}:`, userError);
      }
    }

    return new Response(
      JSON.stringify({ success: true, processed: totalProcessed }),
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
