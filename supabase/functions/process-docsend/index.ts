import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type CaptureServiceResponse = {
  title?: string | null;
  page_count: number;
  screenshots: Array<{ page: number; data_url: string }>;
  pdf_base64: string;
};

/**
 * Process shared deck links (DocSend, PandaDoc, Papermark, and similar viewers).
 *
 * This flow only captures a clean screenshot-based PDF via the AG2 capture backend,
 * stores the PDF in Supabase Storage, then hands off extraction to process-deck/EasyVC.
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
    const captureServiceUrl = Deno.env.get("DOCSEND_CAPTURE_SERVICE_URL")?.trim();
    const captureServiceApiKey = Deno.env.get("DOCSEND_CAPTURE_SERVICE_API_KEY")?.trim();

    if (!captureServiceUrl || !captureServiceApiKey) {
      return new Response(
        JSON.stringify({
          error: "DOCSEND_CAPTURE_SERVICE_URL and DOCSEND_CAPTURE_SERVICE_API_KEY must be configured",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

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

    const { url, maxPages } = await req.json();
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "Missing url parameter" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const normalizedUrl = url.trim();
    if (!isSupportedDeckViewer(normalizedUrl)) {
      return new Response(
        JSON.stringify({
          error:
            "URL must be a supported shared document viewer link (e.g., DocSend, PandaDoc, Papermark)",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const sourceType = detectSourceType(normalizedUrl);

    const dealName = deriveDealName(normalizedUrl);
    const { data: deal, error: dealError } = await adminClient
      .from("deals")
      .insert({
        user_id: user.id,
        name: dealName,
        source: sourceType,
        status: "scraping",
        auto_ingested: false,
        website: normalizedUrl,
      })
      .select()
      .single();

    if (dealError) {
      throw new Error(`Failed to create deal: ${dealError.message}`);
    }

    console.log(`Created deal ${deal.id} for ${sourceType} URL: ${normalizedUrl}`);

    try {
      await adminClient
        .from("deals")
        .update({ status: "scraping", updated_at: new Date().toISOString() })
        .eq("id", deal.id);

      const capture = await captureDeckPdf({
        captureServiceUrl,
        captureServiceApiKey,
        url: normalizedUrl,
        maxPages: clampMaxPages(maxPages),
        gateEmail: user.email ?? undefined,
      });

      if (!capture.pdf_base64) {
        throw new Error("Capture service returned empty PDF payload");
      }

      const pdfBytes = decodeBase64(capture.pdf_base64);
      const slug = extractSlug(normalizedUrl);
      const pdfStoragePath = `${user.id}/${deal.id}/${sourceType}-${slug}.pdf`;

      const { error: uploadError } = await adminClient.storage
        .from("decks")
        .upload(pdfStoragePath, pdfBytes, {
          contentType: "application/pdf",
          upsert: true,
        });

      if (uploadError) {
        throw new Error(`Failed to upload generated PDF: ${uploadError.message}`);
      }

      await adminClient.from("sources").insert({
        deal_id: deal.id,
        user_id: user.id,
        file_name: `${sourceType}-${slug}.pdf`,
        original_size: `${(pdfBytes.byteLength / 1024).toFixed(0)}KB`,
        storage_path: pdfStoragePath,
        source_type: sourceType,
        processing_status: "uploaded",
      });

      await adminClient
        .from("deals")
        .update({
          pages: capture.page_count,
          deck_size: `${capture.page_count} slides`,
          status: "uploading",
          updated_at: new Date().toISOString(),
        })
        .eq("id", deal.id);

      await triggerProcessDeck({
        supabaseUrl,
        supabaseServiceKey,
        dealId: deal.id,
        storagePath: pdfStoragePath,
      });

      console.log(`Deck capture complete for deal ${deal.id}; handed off PDF to process-deck`);

      return new Response(
        JSON.stringify({
          success: true,
          dealId: deal.id,
          pageCount: capture.page_count,
          sourceType,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (captureError) {
      console.error(`Capture failed for deal ${deal.id}:`, captureError);
      await adminClient
        .from("deals")
        .update({ status: "error", updated_at: new Date().toISOString() })
        .eq("id", deal.id);

      const message = captureError instanceof Error ? captureError.message : "Capture failed";
      return new Response(
        JSON.stringify({ error: message, dealId: deal.id }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } catch (error) {
    console.error("process-docsend error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function captureDeckPdf(params: {
  captureServiceUrl: string;
  captureServiceApiKey: string;
  url: string;
  maxPages: number;
  gateEmail?: string;
}): Promise<CaptureServiceResponse> {
  const { captureServiceUrl, captureServiceApiKey, url, maxPages, gateEmail } = params;

  const res = await fetch(`${captureServiceUrl.replace(/\/$/, "")}/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": captureServiceApiKey,
    },
    body: JSON.stringify({
      url,
      max_pages: maxPages,
      gate_email: gateEmail,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Capture service failed [${res.status}]: ${errText}`);
  }

  return (await res.json()) as CaptureServiceResponse;
}

async function triggerProcessDeck(params: {
  supabaseUrl: string;
  supabaseServiceKey: string;
  dealId: string;
  storagePath: string;
}): Promise<void> {
  const { supabaseUrl, supabaseServiceKey, dealId, storagePath } = params;

  const res = await fetch(`${supabaseUrl}/functions/v1/process-deck`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseServiceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      dealId,
      storagePath,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to trigger process-deck [${res.status}]: ${body}`);
  }
}

function isSupportedDeckViewer(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return [
      "docsend.com",
      "www.docsend.com",
      "pandadoc.com",
      "app.pandadoc.com",
      "papermark.com",
      "www.papermark.com",
    ].includes(host);
  } catch {
    return false;
  }
}

function detectSourceType(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("docsend")) return "docsend";
    if (host.includes("pandadoc")) return "pandadoc";
    if (host.includes("papermark")) return "papermark";
  } catch {
    // no-op
  }
  return "deck-viewer";
}

function deriveDealName(url: string): string {
  const slug = extractSlug(url);
  return (
    slug
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || "Deck Import"
  );
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

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function clampMaxPages(maxPages: unknown): number {
  if (typeof maxPages !== "number" || !Number.isFinite(maxPages)) return 40;
  return Math.max(1, Math.min(100, Math.floor(maxPages)));
}
