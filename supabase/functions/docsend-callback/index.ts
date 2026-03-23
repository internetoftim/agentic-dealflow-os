import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * DocSend Callback — receives capture results from the capture service.
 * Stores the PDF, creates source record, and hands off to process-deck.
 * Authenticated via service_role_key passed in the body (from the capture service).
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      job_id,
      deal_id,
      user_id,
      service_role_key,
      pdf_base64,
      markdown,
      page_count,
      error: captureError,
    } = body;

    if (!job_id || !deal_id) {
      return new Response(JSON.stringify({ error: "Missing job_id or deal_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const expectedServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Validate the service role key for auth
    if (service_role_key !== expectedServiceKey) {
      return new Response(JSON.stringify({ error: "Unauthorized callback" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, expectedServiceKey);

    // Handle capture failure
    if (captureError) {
      console.error(`Capture failed for job ${job_id}: ${captureError}`);
      await adminClient
        .from("capture_jobs")
        .update({ status: "failed", error_message: captureError, updated_at: new Date().toISOString() })
        .eq("id", job_id);
      await adminClient
        .from("deals")
        .update({ status: "error", updated_at: new Date().toISOString() })
        .eq("id", deal_id);
      return new Response(JSON.stringify({ success: false, error: captureError }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!pdf_base64) {
      throw new Error("Callback received no PDF data");
    }

    console.log(`Callback received for job ${job_id}: ${page_count} pages, ${(markdown || "").length} chars markdown`);

    // Store PDF in Supabase Storage
    const pdfBytes = Uint8Array.from(atob(pdf_base64), (c) => c.charCodeAt(0));
    const storagePath = `${user_id}/${deal_id}/deck.pdf`;

    const { error: uploadError } = await adminClient.storage
      .from("decks")
      .upload(storagePath, new Blob([pdfBytes], { type: "application/pdf" }), {
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Failed to upload PDF: ${uploadError.message}`);
    }

    const sizeMB = (pdfBytes.length / (1024 * 1024)).toFixed(1);
    console.log(`Stored PDF (${sizeMB}MB) at ${storagePath}`);

    // Update deal
    await adminClient
      .from("deals")
      .update({
        deck_size: `${sizeMB}MB`,
        pages: page_count || 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", deal_id);

    // Determine source type from job URL
    const { data: jobData } = await adminClient
      .from("capture_jobs")
      .select("url")
      .eq("id", job_id)
      .single();
    const jobUrl = jobData?.url || "";
    const isDocSend = /docsend\.com/i.test(jobUrl);
    const sourceType = isDocSend ? "docsend" : "pandadoc";
    const slug = extractSlug(jobUrl);

    // Create source record
    await adminClient.from("sources").insert({
      deal_id: deal_id,
      user_id: user_id,
      file_name: `${sourceType}-${slug}.pdf`,
      original_size: `${sizeMB}MB`,
      storage_path: storagePath,
      source_type: sourceType,
      processing_status: "pending",
      extracted_text: (markdown || "").slice(0, 100_000),
    });

    // Mark job as completed
    await adminClient
      .from("capture_jobs")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .eq("id", job_id);

    // Hand off to process-deck
    console.log(`Handing off deal ${deal_id} to process-deck`);
    const deckRes = await fetch(`${supabaseUrl}/functions/v1/process-deck`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${expectedServiceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ dealId: deal_id, storagePath }),
    });

    if (!deckRes.ok) {
      const errText = await deckRes.text();
      console.error(`process-deck failed [${deckRes.status}]: ${errText}`);
      await adminClient.from("deals").update({ status: "error", updated_at: new Date().toISOString() }).eq("id", deal_id);
      return new Response(
        JSON.stringify({ error: `process-deck failed: ${errText}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`process-deck accepted deal ${deal_id}`);
    return new Response(
      JSON.stringify({ success: true, dealId: deal_id, pageCount: page_count, sizeMB }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("docsend-callback error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function extractSlug(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  } catch {
    return "unknown";
  }
}
