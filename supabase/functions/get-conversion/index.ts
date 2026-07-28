import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { token, email } = await req.json();
    if (!token || !email) {
      return new Response(JSON.stringify({ error: "token and email required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await admin.rpc("get_conversion_job", {
      _token: String(token),
      _email: String(email),
    });

    if (error) throw error;
    const job = Array.isArray(data) ? data[0] : data;
    if (!job) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let downloadUrl: string | null = null;
    if (job.pdf_storage_path) {
      const { data: signed } = await admin.storage
        .from("decks")
        .createSignedUrl(job.pdf_storage_path, 3600);
      downloadUrl = signed?.signedUrl ?? null;
    }

    return new Response(
      JSON.stringify({
        job: {
          token: job.token,
          status: job.status,
          error_message: job.error_message,
          source_url: job.source_url,
          company_name: job.company_name,
          website: job.website,
          linkedin_url: job.linkedin_url,
          notes: job.notes,
          page_count: job.page_count,
          title: job.title,
          created_at: job.created_at,
          updated_at: job.updated_at,
        },
        downloadUrl,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("get-conversion error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
