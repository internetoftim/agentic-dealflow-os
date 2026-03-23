import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Process DocSend / PandaDoc Link
 *
 * 1. Creates a deal (status = scraping).
 * 2. Calls the Playwright-based capture service to get a PDF.
 * 3. Stores the PDF in Supabase Storage.
 * 4. Hands off to process-deck (same pipeline as PDF/PPTX uploads).
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // --- Auth ---
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

    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Missing url parameter" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const normalizedUrl = url.trim();
    const isDocSend = /docsend\.com/i.test(normalizedUrl);
    const isPandaDoc = /pandadoc\.com/i.test(normalizedUrl);
    if (!isDocSend && !isPandaDoc) {
      return new Response(
        JSON.stringify({ error: "URL must be a DocSend or PandaDoc link" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!captureServiceUrl || !captureServiceApiKey) {
      return new Response(
        JSON.stringify({ error: "DocSend capture service is not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const sourceType = isDocSend ? "docsend" : "pandadoc";

    // --- Step 1: Create deal (status = scraping) ---
    const dealName = deriveDealName(normalizedUrl);
    const { data: deal, error: dealError } = await adminClient
      .from("deals")
      .insert({
        user_id: user.id,
        name: dealName,
        source: sourceType,
        status: "scraping",
        auto_ingested: false,
      })
      .select()
      .single();

    if (dealError) {
      throw new Error(`Failed to create deal: ${dealError.message}`);
    }

    console.log(`Created deal ${deal.id} for ${sourceType} URL: ${normalizedUrl}`);

    // Return immediately — processing continues in background
    const responsePromise = new Response(
      JSON.stringify({ success: true, dealId: deal.id, status: "scraping" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

    // --- Background: capture PDF, store it, hand off to process-deck ---
    const backgroundWork = (async () => {
      try {
        // Step 2: Call capture service
        console.log(`Calling capture service for deal ${deal.id}`);
        const captureRes = await fetch(`${captureServiceUrl}/capture`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": captureServiceApiKey!,
          },
          body: JSON.stringify({ url: normalizedUrl, max_pages: 50 }),
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

        // Step 3: Store PDF in Supabase Storage
        const pdfBytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
        const storagePath = `${user.id}/${deal.id}/deck.pdf`;

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
          .eq("id", deal.id);

        // Create source record with extracted markdown
        await adminClient.from("sources").insert({
          deal_id: deal.id,
          user_id: user.id,
          file_name: `${sourceType}-${extractSlug(normalizedUrl)}.pdf`,
          original_size: `${sizeMB}MB`,
          storage_path: storagePath,
          source_type: sourceType,
          processing_status: "pending",
          extracted_text: markdown.slice(0, 100_000),
        });

        // Step 4: Hand off to process-deck (same pipeline as PDF/PPTX uploads)
        console.log(`Handing off deal ${deal.id} to process-deck`);
        const deckRes = await fetch(`${supabaseUrl}/functions/v1/process-deck`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${supabaseServiceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ dealId: deal.id, storagePath }),
        });

        if (!deckRes.ok) {
          const errText = await deckRes.text();
          console.error(`process-deck failed [${deckRes.status}]: ${errText}`);
          await adminClient
            .from("deals")
            .update({ status: "error", updated_at: new Date().toISOString() })
            .eq("id", deal.id);
        } else {
          console.log(`process-deck accepted deal ${deal.id}`);
        }
      } catch (bgError) {
        console.error(`Background processing failed for deal ${deal.id}:`, bgError);
        await adminClient
          .from("deals")
          .update({ status: "error", updated_at: new Date().toISOString() })
          .eq("id", deal.id);
      }
    })();

    backgroundWork.catch((e) => console.error("Unhandled background error:", e));

    return responsePromise;
  } catch (error) {
    console.error("process-docsend error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ─── Helpers ───────────────────────────────────────────────

function deriveDealName(url: string): string {
  const slug = extractSlug(url);
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || "DocSend Import";
}

function extractSlug(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  } catch {
    return "unknown";
  }
}
