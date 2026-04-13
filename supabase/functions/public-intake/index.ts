import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_EXTENSIONS = [".pdf", ".pptx", ".ppt"];
const RATE_LIMIT = 50; // max public-intake deals per user per 24h

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Parse multipart form data
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const userId = formData.get("userId") as string | null;
    const companyName = (formData.get("companyName") as string | "").trim();
    const submitterName = (formData.get("submitterName") as string | "")?.trim() || null;
    const submitterEmail = (formData.get("submitterEmail") as string | "")?.trim() || null;

    // Validate required fields
    if (!file || !userId || !companyName) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: file, userId, companyName" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate file extension
    const fileName = file.name.toLowerCase();
    const ext = fileName.slice(fileName.lastIndexOf("."));
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return new Response(
        JSON.stringify({ error: "Only PDF and PPTX files are accepted" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: "File must be under 20MB" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate userId exists (check user_settings or deals for any row with this user_id)
    const { data: existingDeal } = await adminClient
      .from("deals")
      .select("id")
      .eq("user_id", userId)
      .limit(1);

    const { data: existingSettings } = await adminClient
      .from("user_settings")
      .select("id")
      .eq("user_id", userId)
      .limit(1);

    if ((!existingDeal || existingDeal.length === 0) && (!existingSettings || existingSettings.length === 0)) {
      return new Response(
        JSON.stringify({ error: "Invalid intake link" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Rate limiting: max 50 public-intake deals per user per 24h
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await adminClient
      .from("deals")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("source", "public-intake")
      .gte("created_at", twentyFourHoursAgo);

    if ((count ?? 0) >= RATE_LIMIT) {
      return new Response(
        JSON.stringify({ error: "This intake link has reached its daily submission limit. Please try again later." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create deal record
    const { data: deal, error: dealError } = await adminClient
      .from("deals")
      .insert({
        user_id: userId,
        name: companyName,
        source: "public-intake",
        auto_ingested: true,
        status: "uploading",
        deck_size: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
      })
      .select("id")
      .single();

    if (dealError || !deal) {
      console.error("Failed to create deal:", dealError);
      return new Response(
        JSON.stringify({ error: "Failed to create deal" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Upload file to storage
    const storagePath = `${userId}/${deal.id}/${file.name}`;
    const arrayBuffer = await file.arrayBuffer();
    const { error: uploadError } = await adminClient.storage
      .from("decks")
      .upload(storagePath, new Blob([arrayBuffer], { type: file.type }), { upsert: true });

    if (uploadError) {
      console.error("Storage upload failed:", uploadError);
      // Clean up the deal
      await adminClient.from("deals").delete().eq("id", deal.id);
      return new Response(
        JSON.stringify({ error: "Failed to upload file" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create source record
    await adminClient.from("sources").insert({
      deal_id: deal.id,
      user_id: userId,
      file_name: file.name,
      source_type: "public-intake",
      processing_status: "pending",
      storage_path: storagePath,
      original_size: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
    });

    // Fire process-deck (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/process-deck`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${supabaseServiceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ dealId: deal.id, storagePath }),
    }).catch((e) => console.warn("Failed to trigger process-deck:", e));

    console.log(`Public intake: deal ${deal.id} created for user ${userId}, company "${companyName}", submitter: ${submitterName ?? "anonymous"} (${submitterEmail ?? "no email"})`);

    return new Response(
      JSON.stringify({ status: "success", dealId: deal.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Public intake error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
