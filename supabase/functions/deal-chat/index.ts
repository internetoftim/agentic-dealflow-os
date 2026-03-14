import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
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
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
    const apolloApiKey = Deno.env.get("APOLLO_API_KEY");

    const APOLLO_BASE = "https://apollo-inference-bridge.am1-aks.apolloglobal.net";
    const OPENAI_BASE = "https://api.openai.com";

    // Authenticate user
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { messages, dealId } = await req.json();
    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "Missing messages array" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Fetch user's model preference
    const { data: settings } = await adminClient
      .from("user_settings")
      .select("ai_model")
      .eq("user_id", user.id)
      .single();
    const model = settings?.ai_model ?? "gpt-4o";

    // Fetch deal context if dealId provided
    let dealContext = "";
    if (dealId) {
      const { data: deal } = await adminClient
        .from("deals")
        .select("*")
        .eq("id", dealId)
        .eq("user_id", user.id)
        .single();

      if (deal) {
        dealContext = `
CURRENT DEAL CONTEXT:
- Company: ${deal.name}
- Stage: ${deal.stage}
- Sector: ${deal.sector}
- Status: ${deal.status}
- Ask Amount: ${deal.ask_amount ?? "Unknown"}
- Valuation: ${deal.valuation ?? "Unknown"}
- Revenue: ${deal.revenue ?? "Unknown"}
- Growth: ${deal.growth ?? "Unknown"}
- NRR: ${deal.nrr ?? "Unknown"}
- Team Size: ${deal.team_size ?? "Unknown"}
- Pages: ${deal.pages ?? "Unknown"}
- Website: ${deal.website ?? "Unknown"}
- Memo Draft: ${deal.memo_draft ?? "None yet"}
`;
      }
    }

    const systemPrompt = `You are a senior VC analyst assistant called AgenticVC. You help venture capital investors analyze startup pitch decks and deals.

You have access to the deal data extracted from pitch decks. Answer questions about the deal, provide analysis, and help draft investment memos.

Be concise, data-driven, and opinionated when asked for your take. Use markdown formatting for structured responses.

${dealContext}`;

    // Route to correct endpoint based on model
    const isApollo = model === "gpt-oss-202b";
    const baseUrl = isApollo ? APOLLO_BASE : OPENAI_BASE;
    const apiKey = isApollo ? apolloApiKey : openaiApiKey;

    if (!apiKey) {
      throw new Error(isApollo ? "APOLLO_API_KEY is not configured" : "OPENAI_API_KEY is not configured");
    }

    const aiResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        stream: true,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("OpenAI API error:", aiResponse.status, errText);
      return new Response(JSON.stringify({ error: `OpenAI error [${aiResponse.status}]` }), {
        status: aiResponse.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(aiResponse.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("deal-chat error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
