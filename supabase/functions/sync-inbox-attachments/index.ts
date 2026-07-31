import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { renderReport, runAttachmentPipeline } from "../_shared/attachmentPipeline.ts";
import { createDriveHttpPort, createGmailHttpPort } from "../_shared/googlePorts.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_QUERY = "has:attachment newer_than:30d";
const DEFAULT_FOLDER = "EasyVC/Deal Inbox";

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
  adminClient: ReturnType<typeof createClient>,
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
    await adminClient
      .from("user_settings")
      .update({ google_provider_token: newToken })
      .eq("user_id", userId);
  }
  return newToken;
}

/**
 * sync-inbox-attachments Edge Function
 *
 * Runs the Gmail → Drive attachment pipeline for the calling user, using the
 * Google token captured at sign-in (user_settings) — no separate OAuth flow.
 * Searches Gmail threads (finding attachments on replies deep inside long
 * threads), downloads each attachment by its real (messageId, attachmentId)
 * pair, dedupes, uploads into the target Drive folder, and returns a report
 * of exactly what was uploaded, skipped, duplicated, or unsupported.
 *
 * Body (all optional): { query, folderPath, maxThreads, userId }
 *   query      Gmail search query      (default: "has:attachment newer_than:30d")
 *   folderPath Drive folder path       (default: user's drive_folder setting)
 *   maxThreads max threads to expand   (default: pipeline default)
 *   userId     required only for service-role calls
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    let body: {
      query?: string;
      folderPath?: string;
      maxThreads?: number;
      userId?: string;
    } = {};
    try {
      body = await req.json();
    } catch {
      // empty body is fine — defaults apply
    }

    // Support both user JWT and service-role key auth (same as sync-to-drive)
    const isServiceRole = authHeader === `Bearer ${supabaseServiceKey}`;
    let resolvedUserId: string;
    if (isServiceRole) {
      if (!body.userId) {
        return new Response(
          JSON.stringify({ error: "userId required for service-role calls" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      resolvedUserId = body.userId;
    } else {
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: userError } = await userClient.auth.getUser();
      if (userError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      resolvedUserId = user.id;
    }

    // The Google token captured at sign-in — the user's one-time consent.
    const { data: settings } = await adminClient
      .from("user_settings")
      .select("google_provider_token, google_provider_refresh_token, drive_folder")
      .eq("user_id", resolvedUserId)
      .single();

    if (!settings?.google_provider_token && !settings?.google_provider_refresh_token) {
      return new Response(
        JSON.stringify({ error: "Google account not connected — sign in with Google first" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = await getValidToken(
      adminClient,
      resolvedUserId,
      settings.google_provider_token,
      settings.google_provider_refresh_token
    );
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Google token expired and could not be refreshed — sign in with Google again" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const getToken = async () => token;
    const report = await runAttachmentPipeline(
      createGmailHttpPort(getToken),
      createDriveHttpPort(getToken),
      {
        query: body.query ?? DEFAULT_QUERY,
        driveFolderPath: body.folderPath ?? settings.drive_folder ?? DEFAULT_FOLDER,
        ...(body.maxThreads ? { maxThreads: body.maxThreads } : {}),
      }
    );

    console.log(
      `sync-inbox-attachments for user ${resolvedUserId}: ` +
        `${report.uploaded.length} uploaded, ${report.duplicated.length} duplicated, ` +
        `${report.skipped.length} skipped, ${report.unsupported.length} unsupported`
    );

    return new Response(
      JSON.stringify({ success: true, report, rendered: renderReport(report) }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("sync-inbox-attachments error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
