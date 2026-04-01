import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Process DocSend / PandaDoc Link — Step 1
 *
 * Creates a deal (status = scraping) and returns immediately.
 * The frontend then invokes run-docsend-capture to do the heavy work.
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
    const isPapermark = /papermark\.(com|io)/i.test(normalizedUrl);
    const isDocViewer = isDocSend || isPandaDoc || isPapermark;
    if (!isDocViewer) {
      return new Response(
        JSON.stringify({ error: "URL must be a DocSend, PandaDoc, or Papermark link" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const sourceType = isDocSend ? "docsend" : isPandaDoc ? "pandadoc" : "papermark";
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

    return new Response(
      JSON.stringify({ success: true, dealId: deal.id, url: normalizedUrl, status: "scraping" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("process-docsend error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

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
