import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Refresh a Google access token using the refresh token */
async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

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
      .select("user_id, google_provider_token, google_provider_refresh_token")
      .eq("gmail_label_enabled", true);

    if (usersError) throw usersError;
    if (!users || users.length === 0) {
      return new Response(
        JSON.stringify({ message: "No users with Gmail listening enabled" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Registering Gmail watch for ${users.length} user(s)`);

    const results: any[] = [];

    for (const userSettings of users) {
      const { user_id } = userSettings;

      try {
        const token = await getValidToken(
          adminClient,
          user_id,
          userSettings.google_provider_token,
          userSettings.google_provider_refresh_token
        );

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
