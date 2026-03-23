import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Run DocSend Capture — Step 2 (heavy work)
 *
 * Called by the frontend after process-docsend creates the deal.
 * Calls the Playwright capture service, stores the PDF, and hands off to process-deck.
 * Runs synchronously — the frontend polls deal status via realtime/polling.
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

    const isDocSend = /docsend\.com/i.test(url);
    const sourceType = isDocSend ? "docsend" : "pandadoc";

    // Step 1: Call capture service
    console.log(`Calling capture service for deal ${dealId}`);
    const captureRes = await fetch(`${captureServiceUrl}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": captureServiceApiKey!,
      },
      body: JSON.stringify({ url, max_pages: 50 }),
    });

    if (!captureRes.ok) {
      const errText = await captureRes.text();
      throw new Error(`Capture service failed [${captureRes.status}]: ${errText}`);
    }

    const captureData = await captureRes.json();
    const pdfBase64: string | null = captureData.pdf_base64 || null;
    const markdown: string = captureData.markdown || "";
    const pageCount = captureData.page_count || 0;

    console.log(`Capture complete: ${pageCount} pages, ${markdown.length} chars markdown`);

    if (!pdfBase64) {
      throw new Error("Capture service returned no PDF");
    }

    // Step 2: Store PDF in Supabase Storage
    const pdfBytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
    const storagePath = `${user.id}/${dealId}/deck.pdf`;

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

    // Update deal with size info and page count
    await adminClient
      .from("deals")
      .update({
        deck_size: `${sizeMB}MB`,
        pages: pageCount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", dealId);

    // Create source record
    const slug = extractSlug(url);
    await adminClient.from("sources").insert({
      deal_id: dealId,
      user_id: user.id,
      file_name: `${sourceType}-${slug}.pdf`,
      original_size: `${sizeMB}MB`,
      storage_path: storagePath,
      source_type: sourceType,
      processing_status: "pending",
      extracted_text: markdown.slice(0, 100_000),
    });

    // Step 3: Hand off to process-deck
    console.log(`Handing off deal ${dealId} to process-deck`);
    const deckRes = await fetch(`${supabaseUrl}/functions/v1/process-deck`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${supabaseServiceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ dealId, storagePath }),
    });

    if (!deckRes.ok) {
      const errText = await deckRes.text();
      console.error(`process-deck failed [${deckRes.status}]: ${errText}`);
      await adminClient.from("deals").update({ status: "error", updated_at: new Date().toISOString() }).eq("id", dealId);
      return new Response(
        JSON.stringify({ error: `process-deck failed: ${errText}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`process-deck accepted deal ${dealId}`);
    return new Response(
      JSON.stringify({ success: true, dealId, pageCount, sizeMB }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("run-docsend-capture error:", error);

    // Try to mark deal as error
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

function extractSlug(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  } catch {
    return "unknown";
  }
}
