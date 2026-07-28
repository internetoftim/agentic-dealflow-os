import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPPORTED_HOSTS = /(docsend\.com|papermark\.(com|io)|pandadoc\.com)/i;

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function scheduleBackgroundTask(task: Promise<unknown>) {
  const edgeRuntime = (globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(task);
  else void task;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const email = String(body?.email ?? "").trim().toLowerCase();
    const sourceUrl = String(body?.sourceUrl ?? "").trim();
    const companyName = body?.companyName ? String(body.companyName).trim().slice(0, 200) : null;
    const website = body?.website ? String(body.website).trim().slice(0, 500) : null;
    const linkedinUrl = body?.linkedinUrl ? String(body.linkedinUrl).trim().slice(0, 500) : null;
    const notes = body?.notes ? String(body.notes).trim().slice(0, 2000) : null;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: "Valid email is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
      return new Response(JSON.stringify({ error: "Valid link is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!SUPPORTED_HOSTS.test(sourceUrl)) {
      return new Response(JSON.stringify({ error: "Only DocSend, Papermark, or PandaDoc links are supported" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const token = generateToken();
    const { data: job, error } = await admin
      .from("conversion_jobs")
      .insert({
        token,
        email,
        source_url: sourceUrl,
        company_name: companyName,
        website,
        linkedin_url: linkedinUrl,
        notes,
        status: "pending",
      })
      .select("id, token")
      .single();

    if (error || !job) {
      throw new Error(`Failed to create job: ${error?.message ?? "unknown"}`);
    }

    // Fire background conversion runner (non-blocking)
    const runnerTask = fetch(`${supabaseUrl}/functions/v1/run-conversion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ jobId: job.id }),
    })
      .then(async (r) => {
        if (!r.ok) console.error(`run-conversion dispatch failed [${r.status}]:`, await r.text());
      })
      .catch((e) => console.error("run-conversion dispatch error:", e));

    scheduleBackgroundTask(runnerTask);

    const origin = req.headers.get("origin") || "https://www.onepointsix.ai";
    const dashboardUrl = `${origin}/converted/${token}`;

    return new Response(
      JSON.stringify({ token, dashboardUrl, status: "pending" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("submit-conversion error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
