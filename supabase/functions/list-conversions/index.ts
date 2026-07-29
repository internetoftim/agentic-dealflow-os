import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { email } = await req.json();
    if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return new Response(JSON.stringify({ error: "valid email required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await admin
      .from("conversion_jobs")
      .select("token,status,source_url,company_name,website,linkedin_url,page_count,title,created_at,updated_at,pdf_storage_path")
      .ilike("email", email.trim())
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;

    const jobs = (data ?? []).map((j) => ({
      token: j.token,
      status: j.status,
      source_url: j.source_url,
      company_name: j.company_name,
      website: j.website,
      linkedin_url: j.linkedin_url,
      page_count: j.page_count,
      title: j.title,
      created_at: j.created_at,
      updated_at: j.updated_at,
      has_pdf: !!j.pdf_storage_path,
    }));

    return new Response(JSON.stringify({ jobs }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("list-conversions error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
