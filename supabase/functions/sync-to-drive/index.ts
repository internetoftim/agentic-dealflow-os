import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Apply a naming pattern to generate a Drive filename.
 * Supported tokens: <WEBSITE>, <MonthYYYY>, <pages>, <NAME>, <SECTOR>, <STAGE>
 */
function applyNamingPattern(
  pattern: string,
  deal: { name: string; website?: string | null; pages?: number | null; sector?: string; stage?: string },
  originalFileName?: string
): string {
  const now = new Date();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthYYYY = `${monthNames[now.getMonth()]}${now.getFullYear()}`;

  // Extract domain from website URL or fall back to deal name
  let websiteName = deal.name;
  if (deal.website) {
    try {
      const url = new URL(deal.website.startsWith("http") ? deal.website : `https://${deal.website}`);
      websiteName = url.hostname.replace(/^www\./, "");
    } catch {
      websiteName = deal.website;
    }
  }

  let result = pattern
    .replace(/<WEBSITE>/gi, websiteName)
    .replace(/<MonthYYYY>/gi, monthYYYY)
    .replace(/<pages>/gi, String(deal.pages ?? 0))
    .replace(/<NAME>/gi, deal.name)
    .replace(/<SECTOR>/gi, deal.sector ?? "Unknown")
    .replace(/<STAGE>/gi, deal.stage ?? "Unknown");

  // Always use .pdf extension since PPTX files are now converted to PDF before syncing
  result = result.replace(/\.(pdf|pptx?)\s*$/i, "");
  // Sanitize: remove illegal filename chars
  result = result.replace(/[\/\\:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  if (!result.toLowerCase().endsWith(".pdf")) {
    result += ".pdf";
  }

  return result;
}

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

    // Support both user JWT and service-role key auth
    const isServiceRole = authHeader === `Bearer ${supabaseServiceKey}`;
    let resolvedUserId: string;

    const body = await req.json();
    const { dealId, storagePath, fileName } = body;

    if (isServiceRole) {
      // Called from process-deck with service role — userId must be in body
      if (!body.userId) {
        return new Response(JSON.stringify({ error: "userId required for service-role calls" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
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
    if (!dealId || !storagePath || !fileName) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get user's Google token and naming settings
    const { data: settings } = await adminClient
      .from("user_settings")
      .select("google_provider_token, drive_sync_enabled, naming_pattern, naming_mode, drive_folder")
      .eq("user_id", resolvedUserId)
      .single();

    if (!settings?.google_provider_token || !settings?.drive_sync_enabled) {
      return new Response(
        JSON.stringify({ error: "Google Drive not connected or sync disabled" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get deal details for naming pattern
    const { data: deal } = await adminClient
      .from("deals")
      .select("name, website, pages, sector, stage")
      .eq("id", dealId)
      .single();

    // Determine the file name for Drive
    const namingPattern = settings.naming_pattern || "<WEBSITE> deck <MonthYYYY> p<pages>";
    const driveFileName = deal
      ? applyNamingPattern(namingPattern, deal, fileName)
      : fileName;

    // Download file from Supabase storage
    const { data: fileData, error: downloadError } = await adminClient.storage
      .from("decks")
      .download(storagePath);
    if (downloadError || !fileData) {
      throw new Error(`Failed to download file: ${downloadError?.message}`);
    }

    // Resolve or create the target Drive folder (supports nested paths like "Folder/Sub Folder")
    const folderPath = settings.drive_folder || "WAIT ROOM";
    const folderSegments = folderPath.split("/").map((s: string) => s.trim()).filter(Boolean);
    let folderId: string | null = null;

    // Walk each segment, creating folders as needed
    let parentId: string | null = null;
    for (const segment of folderSegments) {
      // Search for existing folder (properly escape single quotes in folder names)
      const escapedName = segment.replace(/'/g, "\\'");
      const parentQuery = parentId
        ? ` and '${parentId}' in parents`
        : "";
      const q = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentQuery}`;
      const folderSearchRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
        { headers: { Authorization: `Bearer ${settings.google_provider_token}` } }
      );

      let segmentId: string | null = null;
      if (folderSearchRes.ok) {
        const folderData = await folderSearchRes.json();
        if (folderData.files?.length > 0) {
          segmentId = folderData.files[0].id;
        }
      }

      // Create folder if it doesn't exist
      if (!segmentId) {
        const createBody: Record<string, unknown> = {
          name: segment,
          mimeType: "application/vnd.google-apps.folder",
        };
        if (parentId) {
          createBody.parents = [parentId];
        }
        const createFolderRes = await fetch(
          "https://www.googleapis.com/drive/v3/files",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${settings.google_provider_token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(createBody),
          }
        );
        if (createFolderRes.ok) {
          const created = await createFolderRes.json();
          segmentId = created.id;
        }
      }

      parentId = segmentId;
    }
    folderId = parentId;

    // Upload to Google Drive with the formatted name
    // Files are always PDF at this point (PPTX converted upstream)
    const mimeType = "application/pdf";
    const metadata: Record<string, unknown> = {
      name: driveFileName,
      mimeType,
    };
    if (folderId) {
      metadata.parents = [folderId];
    }

    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" })
    );
    form.append("file", fileData);

    const driveRes = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.google_provider_token}`,
        },
        body: form,
      }
    );

    if (!driveRes.ok) {
      const errText = await driveRes.text();
      throw new Error(`Google Drive upload failed [${driveRes.status}]: ${errText}`);
    }

    const driveFile = await driveRes.json();

    await adminClient
      .from("deals")
      .update({ gdrive_file_id: driveFile.id, status: "memo-ready" })
      .eq("id", dealId);

    return new Response(
      JSON.stringify({ success: true, driveFileId: driveFile.id, driveFileName }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("sync-to-drive error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
