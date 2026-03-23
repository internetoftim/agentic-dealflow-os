import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Run DocSend Capture — Queue-based
 *
 * Inserts a capture job into the queue and fires off an async capture request
 * to the capture service (with a callback URL). Returns immediately.
 * The capture service will POST results to docsend-callback when done.
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
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const captureServiceUrl = Deno.env.get("DOCSEND_CAPTURE_SERVICE_URL");
    const captureServiceApiKey = Deno.env.get("DOCSEND_CAPTURE_SERVICE_API_KEY");

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { dealId, url } = await req.json();
    if (!dealId || !url) {
      return new Response(JSON.stringify({ error: "Missing dealId or url" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!captureServiceUrl || !captureServiceApiKey) {
      await adminClient.from("deals").update({ status: "error", updated_at: new Date().toISOString() }).eq("id", dealId);
      return new Response(
        JSON.stringify({ error: "DocSend capture service is not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Insert capture job into queue
    const { data: job, error: jobError } = await adminClient
      .from("capture_jobs")
      .insert({
        deal_id: dealId,
        user_id: user.id,
        url,
        status: "pending",
      })
      .select()
      .single();

    if (jobError) {
      throw new Error(`Failed to create capture job: ${jobError.message}`);
    }

    console.log(`Created capture job ${job.id} for deal ${dealId}`);

    // Build callback URL pointing to docsend-callback edge function
    const callbackUrl = `${supabaseUrl}/functions/v1/docsend-callback`;

    // Fire async capture request (don't await the full capture — just send it)
    // The capture service will POST to callbackUrl when done.
    fetch(`${captureServiceUrl}/capture-async`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": captureServiceApiKey,
      },
      body: JSON.stringify({
        url,
        max_pages: 50,
        callback_url: callbackUrl,
        job_id: job.id,
        deal_id: dealId,
        user_id: user.id,
        service_role_key: supabaseServiceKey,
      }),
    }).catch((err) => {
      console.error(`Failed to fire async capture for job ${job.id}:`, err);
    });

    // Update job status to processing
    await adminClient
      .from("capture_jobs")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", job.id);

    console.log(`Fired async capture for job ${job.id}, returning immediately`);

    return new Response(
      JSON.stringify({ success: true, dealId, jobId: job.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("run-docsend-capture error:", error);

    try {
      const { dealId } = await req.clone().json().catch(() => ({ dealId: null }));
      if (dealId) {
        const adminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        await adminClient.from("deals").update({ status: "error", updated_at: new Date().toISOString() }).eq("id", dealId);
      }
    } catch { /* best effort */ }

    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
