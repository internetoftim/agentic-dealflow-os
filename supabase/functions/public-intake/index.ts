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
    let userId = formData.get("userId") as string | null;
    const companyNameRaw = ((formData.get("companyName") as string) || "").trim();
    const submitterName = ((formData.get("submitterName") as string) || "").trim();
    const submitterEmail = ((formData.get("submitterEmail") as string) || "").trim();
    const referralSource = ((formData.get("referralSource") as string) || "").trim();
    const docsendUrl = ((formData.get("docsendUrl") as string) || "").trim();
    const linkedinUrl = ((formData.get("linkedinUrl") as string) || "").trim();
    const websiteUrl = ((formData.get("websiteUrl") as string) || "").trim();
    const message = ((formData.get("message") as string) || "").trim();

    // Validate required fields: userId, submitterName, submitterEmail, referralSource
    if (!userId || !submitterName || !submitterEmail || !referralSource) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: name, email, referral source" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submitterEmail)) {
      return new Response(
        JSON.stringify({ error: "Invalid email address" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Length limits
    if (
      submitterName.length > 100 ||
      submitterEmail.length > 255 ||
      referralSource.length > 200 ||
      companyNameRaw.length > 150 ||
      docsendUrl.length > 500 ||
      linkedinUrl.length > 500 ||
      websiteUrl.length > 500 ||
      message.length > 2000
    ) {
      return new Response(
        JSON.stringify({ error: "One or more fields exceed maximum length" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fall back company name when not provided
    const companyName = companyNameRaw || (websiteUrl ? websiteUrl.replace(/^https?:\/\//, "").split("/")[0] : submitterName);

    // Validate file (only if provided)
    if (file) {
      const fileName = file.name.toLowerCase();
      const ext = fileName.slice(fileName.lastIndexOf("."));
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return new Response(
          JSON.stringify({ error: "Only PDF and PPTX files are accepted" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (file.size > MAX_FILE_SIZE) {
        return new Response(
          JSON.stringify({ error: "File must be under 20MB" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Resolve userId: could be a UUID or a custom intake_slug
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);

    if (!isUuid) {
      // Treat as intake_slug — look up the real user_id
      const { data: slugMatch } = await adminClient
        .from("user_settings")
        .select("user_id")
        .eq("intake_slug", userId)
        .single();

      if (!slugMatch) {
        return new Response(
          JSON.stringify({ error: "Invalid intake link" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      userId = slugMatch.user_id;
    } else {
      // Validate UUID userId exists
      const { data: existingSettings } = await adminClient
        .from("user_settings")
        .select("id")
        .eq("user_id", userId)
        .limit(1);

      const { data: existingDeal } = await adminClient
        .from("deals")
        .select("id")
        .eq("user_id", userId)
        .limit(1);

      if ((!existingDeal || existingDeal.length === 0) && (!existingSettings || existingSettings.length === 0)) {
        return new Response(
          JSON.stringify({ error: "Invalid intake link" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Rate limiting: max 50 public-intake deals per user per 24h
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await adminClient
      .from("deals")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("source", "inbound")
      .gte("created_at", twentyFourHoursAgo);

    if ((count ?? 0) >= RATE_LIMIT) {
      return new Response(
        JSON.stringify({ error: "This intake link has reached its daily submission limit. Please try again later." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build a draft note capturing submission metadata
    const submissionNoteLines = [
      `**Inbound submission**`,
      `- Submitted by: ${submitterName} <${submitterEmail}>`,
      `- Heard about us via: ${referralSource}`,
    ];
    if (websiteUrl) submissionNoteLines.push(`- Website: ${websiteUrl}`);
    if (linkedinUrl) submissionNoteLines.push(`- LinkedIn: ${linkedinUrl}`);
    if (docsendUrl) submissionNoteLines.push(`- DocSend: ${docsendUrl}`);
    if (message) submissionNoteLines.push(`\n**Message from founder:**\n${message}`);
    const memoDraft = submissionNoteLines.join("\n");

    // Determine if any agentic processing should run.
    // No deck and no DocSend URL ⇒ this is a "lead-only" submission; skip all agents.
    const hasProcessableSource = Boolean(file) || Boolean(docsendUrl);

    // Create deal record
    const dealInsert: Record<string, unknown> = {
      user_id: userId,
      name: companyName,
      source: "inbound",
      auto_ingested: true,
      status: file ? "uploading" : "inbox",
      memo_draft: memoDraft,
      // If there is nothing to process, mark deep research as skipped so the
      // workspace UI does not show a perpetually "pending" agent step.
      deep_research_status: hasProcessableSource ? "pending" : "skipped",
    };
    if (file) {
      dealInsert.deck_size = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (websiteUrl) dealInsert.website = websiteUrl;
    if (linkedinUrl) dealInsert.linkedin_url = linkedinUrl;

    const { data: deal, error: dealError } = await adminClient
      .from("deals")
      .insert(dealInsert as never)
      .select("id")
      .single();

    if (dealError || !deal) {
      console.error("Failed to create deal:", dealError);
      return new Response(
        JSON.stringify({ error: "Failed to create deal" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let storagePath: string | null = null;

    if (file) {
      // Upload file to storage
      storagePath = `${userId}/${deal.id}/${file.name}`;
      const arrayBuffer = await file.arrayBuffer();
      const { error: uploadError } = await adminClient.storage
        .from("decks")
        .upload(storagePath, new Blob([arrayBuffer], { type: file.type }), { upsert: true });

      if (uploadError) {
        console.error("Storage upload failed:", uploadError);
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
        source_type: "inbound",
        processing_status: "pending",
        storage_path: storagePath,
        original_size: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
      } as never);

      // Fire process-deck (fire-and-forget)
      fetch(`${supabaseUrl}/functions/v1/process-deck`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseServiceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dealId: deal.id, storagePath }),
      }).catch((e) => console.warn("Failed to trigger process-deck:", e));
    } else if (docsendUrl) {
      // No file, but DocSend link provided — kick off link capture
      fetch(`${supabaseUrl}/functions/v1/ingest-relay`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseServiceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dealId: deal.id, url: docsendUrl, userId }),
      }).catch((e) => console.warn("Failed to trigger ingest-relay:", e));
    }

    console.log(
      `Public intake: deal ${deal.id} for user ${userId}, company "${companyName}", submitter: ${submitterName} <${submitterEmail}>, source: ${referralSource}, file: ${file ? file.name : "none"}`
    );

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
