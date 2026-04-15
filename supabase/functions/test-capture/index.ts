import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { captureSync } from "../_shared/docsend-capture-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Test Capture — bypasses user auth to smoke-test the capture service directly.
 * Accepts: { url: string }
 * Creates a deal and capture job, then runs the same sync capture client used by
 * run-docsend-capture without handing off to process-deck.
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

    // Update job to processing before invoking the capture service.
    await adminClient
      .from("capture_jobs")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", job.id);

    console.log(`Firing capture to ${captureServiceUrl}/capture`);

    try {
      const captureResult = await captureSync({
        apiKey: captureServiceApiKey,
        baseUrl: captureServiceUrl,
        maxPages: 50,
        url,
      });

      const pdfSizeBytes = Uint8Array.from(
        atob(captureResult.pdfBase64),
        (char) => char.charCodeAt(0),
      ).length;
      const deckSize = `${(pdfSizeBytes / (1024 * 1024)).toFixed(1)}MB`;

      await adminClient
        .from("capture_jobs")
        .update({ status: "completed", error_message: null, updated_at: new Date().toISOString() })
        .eq("id", job.id);

      await adminClient
        .from("deals")
        .update({
          deck_size: deckSize,
          pages: captureResult.pageCount || 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", deal.id);

      return new Response(
        JSON.stringify({
          success: true,
          dealId: deal.id,
          jobId: job.id,
          title: captureResult.title,
          pageCount: captureResult.pageCount,
          deckSize,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } catch (captureError) {
      const message = captureError instanceof Error ? captureError.message : "Capture failed";

      await adminClient
        .from("capture_jobs")
        .update({ status: "failed", error_message: message, updated_at: new Date().toISOString() })
        .eq("id", job.id);

      await adminClient
        .from("deals")
        .update({ status: "error", updated_at: new Date().toISOString() })
        .eq("id", deal.id);

      throw captureError;
    }

  } catch (error) {
    console.error("test-capture error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
