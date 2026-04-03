import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Test Capture — bypasses user auth to test the capture service directly.
 * Accepts: { url: string }
 * Creates a deal, inserts a capture job, and fires the async capture request.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url } = await req.json();
    if (!url) {
      return new Response(JSON.stringify({ error: "Missing url" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const captureServiceUrl = Deno.env.get("DOCSEND_CAPTURE_SERVICE_URL");
    const captureServiceApiKey = Deno.env.get("DOCSEND_CAPTURE_SERVICE_API_KEY");

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Use a known test user
    const testUserId = "94be3aba-486c-4af3-b3a7-f8dd1cf0ca25";

    console.log(`Capture service URL: ${captureServiceUrl ? "SET" : "NOT SET"}`);
    console.log(`Capture service API key: ${captureServiceApiKey ? "SET" : "NOT SET"}`);

    if (!captureServiceUrl || !captureServiceApiKey) {
      return new Response(
        JSON.stringify({ error: "Capture service not configured", captureServiceUrl: !!captureServiceUrl, captureServiceApiKey: !!captureServiceApiKey }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create a test deal
    const { data: deal, error: dealError } = await adminClient
      .from("deals")
      .insert({
        user_id: testUserId,
        name: `Test Papermark Capture`,
        source: "papermark",
        status: "scraping",
        auto_ingested: false,
      })
      .select()
      .single();

    if (dealError) throw new Error(`Failed to create deal: ${dealError.message}`);
    console.log(`Created test deal: ${deal.id}`);

    // Create capture job
    const { data: job, error: jobError } = await adminClient
      .from("capture_jobs")
      .insert({
        deal_id: deal.id,
        user_id: testUserId,
        url,
        status: "pending",
      })
      .select()
      .single();

    if (jobError) throw new Error(`Failed to create job: ${jobError.message}`);
    console.log(`Created capture job: ${job.id}`);

    // Build callback URL
    const callbackUrl = `${supabaseUrl}/functions/v1/docsend-callback`;

    // Fire synchronous capture
    console.log(`Firing capture to ${captureServiceUrl}/capture`);
    const captureRes = await fetch(`${captureServiceUrl}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": captureServiceApiKey,
      },
      body: JSON.stringify({
        url,
        max_pages: 50,
      }),
    });

    const captureStatus = captureRes.status;
    const captureBody = await captureRes.text();
    console.log(`Capture service responded: ${captureStatus} — ${captureBody}`);

    // Update job to processing
    await adminClient
      .from("capture_jobs")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", job.id);

    return new Response(
      JSON.stringify({
        success: true,
        dealId: deal.id,
        jobId: job.id,
        captureServiceStatus: captureStatus,
        captureServiceResponse: captureBody,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("test-capture error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
