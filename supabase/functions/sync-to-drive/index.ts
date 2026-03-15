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

  // Ensure correct extension
  const ext = originalFileName?.toLowerCase().endsWith(".pptx") ? ".pptx"
    : originalFileName?.toLowerCase().endsWith(".ppt") ? ".ppt"
    : ".pdf";
  // Remove any existing extension and add the correct one
  result = result.replace(/\.(pdf|pptx?)\s*$/i, "");
  if (!result.toLowerCase().endsWith(ext)) {
    result += ext;
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

    const { dealId, storagePath, fileName } = await req.json();
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
      .eq("user_id", user.id)
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

    // Resolve or create the target Drive folder
    const folderName = settings.drive_folder || "WAITING ROOM";
    let folderId: string | null = null;

    // Search for existing folder
    const folderSearchRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
      )}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${settings.google_provider_token}` } }
    );
    if (folderSearchRes.ok) {
      const folderData = await folderSearchRes.json();
      if (folderData.files?.length > 0) {
        folderId = folderData.files[0].id;
      }
    }

    // Create folder if it doesn't exist
    if (!folderId) {
      const createFolderRes = await fetch(
        "https://www.googleapis.com/drive/v3/files",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${settings.google_provider_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: folderName,
            mimeType: "application/vnd.google-apps.folder",
          }),
        }
      );
      if (createFolderRes.ok) {
        const created = await createFolderRes.json();
        folderId = created.id;
      }
    }

    // Upload to Google Drive with the formatted name
    const isPptx = fileName.toLowerCase().endsWith(".pptx") || fileName.toLowerCase().endsWith(".ppt");
    const mimeType = isPptx
      ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : "application/pdf";
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
