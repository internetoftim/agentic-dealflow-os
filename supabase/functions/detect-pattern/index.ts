import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { sampleFilename } = await req.json();
    if (!sampleFilename) {
      return new Response(JSON.stringify({ error: "Missing sampleFilename" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get user's preferred AI model
    const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: settings } = await adminClient
      .from("user_settings")
      .select("ai_model")
      .eq("user_id", user.id)
      .single();

    const aiModel = settings?.ai_model || "gpt-oss-202b";

    // Map model to provider
    let apiUrl: string;
    let apiKey: string;
    let modelId: string;
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (aiModel === "gpt-oss-202b") {
      apiUrl = "https://api.sapinsapin.com/v1/chat/completions";
      apiKey = Deno.env.get("APOLLO_API_KEY") || "";
      modelId = "/models/gpt-oss-20b-balitanlp-cpt";
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else {
      apiUrl = "https://api.openai.com/v1/chat/completions";
      apiKey = Deno.env.get("OPENAI_API_KEY") || "";
      modelId = aiModel;
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const systemPrompt = `You are a filename pattern analyzer. Given a sample filename, deduce the naming pattern using these tokens:
- <WEBSITE> — the company website/domain
- <NAME> — the company name
- <MonthYYYY> — month and year like "Mar2026"
- <SECTOR> — industry sector
- <STAGE> — funding stage
- <pages> — page count number

Rules:
- Return ONLY the pattern string, nothing else
- Keep literal text (like "deck", "p", spaces, hyphens, dots) as-is
- The .pdf extension should be included
- Example: for "novastar.ai deck Mar2026 p24.pdf" → "<WEBSITE> deck <MonthYYYY> p<pages>.pdf"
- Example: for "Acme Corp - Series A - Q1 2026.pdf" → "<NAME> - <STAGE> - <MonthYYYY>.pdf"`;

    const llmRes = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Deduce the naming pattern from this filename: "${sampleFilename}"` },
        ],
        temperature: 0,
        max_tokens: 200,
      }),
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text();
      console.error("LLM error:", llmRes.status, errText);
      throw new Error(`LLM request failed: ${llmRes.status}`);
    }

    const llmData = await llmRes.json();
    const pattern = llmData.choices?.[0]?.message?.content?.trim() || "";

    return new Response(
      JSON.stringify({ pattern }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("detect-pattern error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
