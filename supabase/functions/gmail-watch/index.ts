import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getUserGoogleAccessToken } from "../_shared/google-tokens.ts";
import { getReceiverToken, registerReceiverWatch, type ReceiverAccount } from "../_shared/gmail-receiver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Gmail Watch — registers Gmail push notifications via users.watch().
 * 
 * Call this on a cron schedule (e.g., daily) to keep the watch subscription active.
 * Gmail watch expires after ~7 days, so renewing daily is safe.
 * 
 * Requires a GCP Pub/Sub topic that has been granted publish permissions to
 * gmail-api-push@system.gserviceaccount.com
 * 
 * Body can optionally include:
 * - topicName: the Pub/Sub topic (defaults to env GMAIL_PUBSUB_TOPIC)
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    let topicName = Deno.env.get("GMAIL_PUBSUB_TOPIC") || "";

    // Allow override from request body
    try {
      const body = await req.json();
      if (body?.topicName) topicName = body.topicName;
    } catch { /* no body */ }

    if (!topicName) {
      return new Response(
        JSON.stringify({ error: "GMAIL_PUBSUB_TOPIC not configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get all users with Gmail listening enabled
    const { data: users, error: usersError } = await adminClient
      .from("user_settings")
      .select("user_id")
      .eq("gmail_label_enabled", true);

    if (usersError) throw usersError;
    console.log(`Registering Gmail watch for ${users?.length ?? 0} user(s)`);

    const results: any[] = [];

    for (const userSettings of users ?? []) {
      const { user_id } = userSettings;

      try {
        const token = await getUserGoogleAccessToken(adminClient, user_id);

        if (!token) {
          results.push({ user_id, status: "error", reason: "no valid token" });
          continue;
        }

        // Call Gmail users.watch()
        const watchRes = await fetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/watch",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              topicName,
              labelIds: ["INBOX"],
              labelFilterBehavior: "INCLUDE",
            }),
          }
        );

        if (!watchRes.ok) {
          const errText = await watchRes.text();
          console.error(`watch() failed for user ${user_id}:`, errText);
          results.push({ user_id, status: "error", reason: errText });
          continue;
        }

        const watchData = await watchRes.json();
        console.log(`Watch registered for user ${user_id}, historyId: ${watchData.historyId}, expiration: ${watchData.expiration}`);

        // Store initial historyId if not set
        await adminClient
          .from("user_settings")
          .update({ gmail_history_id: String(watchData.historyId) })
          .eq("user_id", user_id)
          .is("gmail_history_id", null);

        results.push({
          user_id,
          status: "ok",
          historyId: watchData.historyId,
          expiration: watchData.expiration,
        });
      } catch (userError) {
        console.error(`Error for user ${user_id}:`, userError);
        results.push({ user_id, status: "error", reason: String(userError) });
      }
    }

    // Receiver (deal-inbox) accounts
    const { data: receivers } = await adminClient
      .from("receiver_accounts")
      .select("id, user_id, email, google_access_token, google_refresh_token, gmail_history_id, enabled")
      .eq("enabled", true);
    for (const account of (receivers ?? []) as ReceiverAccount[]) {
      try {
        const token = await getReceiverToken(adminClient, account);
        if (!token) { results.push({ receiver: account.email, status: "error", reason: "no valid token" }); continue; }
        const w = await registerReceiverWatch(adminClient, token, account, topicName);
        results.push({ receiver: account.email, status: "ok", historyId: w.historyId, expiration: w.expiration });
      } catch (e) {
        results.push({ receiver: account.email, status: "error", reason: String(e) });
      }
    }

    return new Response(
      JSON.stringify({ success: true, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("gmail-watch error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
