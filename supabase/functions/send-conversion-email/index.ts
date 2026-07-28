import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GATEWAY_URL = "https://connector-gateway.lovable.dev/resend";
const DASHBOARD_BASE = Deno.env.get("PUBLIC_APP_URL") || "https://www.onepointsix.ai";
const FROM_ADDRESS = Deno.env.get("CONVERSION_FROM_EMAIL") || "EasyVC <onboarding@resend.dev>";

function buildHtml(dashboardUrl: string, companyName: string | null) {
  const label = companyName ? `for ${companyName}` : "your deck";
  return `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
      <h1 style="font-size:20px;margin:0 0 12px">Your PDF is ready</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 20px">
        We finished converting ${label}. Open your dashboard to download the PDF and view the details you submitted.
      </p>
      <p style="margin:24px 0">
        <a href="${dashboardUrl}" style="background:#0f172a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-size:14px;display:inline-block">
          View your deck
        </a>
      </p>
      <p style="font-size:13px;color:#64748b;line-height:1.6;margin:20px 0 0">
        Or copy this link: <br/><a href="${dashboardUrl}" style="color:#64748b;word-break:break-all">${dashboardUrl}</a>
      </p>
      <p style="font-size:12px;color:#94a3b8;margin-top:32px">
        You'll be asked to confirm your email address once to unlock the dashboard.
      </p>
    </div>
  `;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { jobId } = await req.json();
    if (!jobId) throw new Error("jobId required");

    const lovableKey = Deno.env.get("LOVABLE_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!lovableKey || !resendKey) {
      throw new Error("Email is not configured (missing LOVABLE_API_KEY or RESEND_API_KEY)");
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: job, error } = await admin
      .from("conversion_jobs")
      .select("id, email, token, company_name, notified_at, status")
      .eq("id", jobId)
      .single();

    if (error || !job) throw new Error("Job not found");
    if (job.status !== "complete") throw new Error(`Job not complete (status=${job.status})`);
    if (job.notified_at) {
      return new Response(JSON.stringify({ skipped: "already notified" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const dashboardUrl = `${DASHBOARD_BASE}/converted/${job.token}`;

    const resp = await fetch(`${GATEWAY_URL}/emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": resendKey,
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [job.email],
        subject: job.company_name
          ? `Your ${job.company_name} deck PDF is ready`
          : "Your deck PDF is ready",
        html: buildHtml(dashboardUrl, job.company_name),
      }),
    });

    if (!resp.ok) {
      const bodyText = await resp.text();
      console.error(`Resend error [${resp.status}]:`, bodyText);
      return new Response(
        JSON.stringify({ error: "Email send failed", status: resp.status, details: bodyText }),
        { status: resp.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    await admin
      .from("conversion_jobs")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", jobId);

    return new Response(JSON.stringify({ sent: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("send-conversion-email error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
