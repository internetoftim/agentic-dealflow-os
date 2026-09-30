import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveChatProvider } from "../_shared/ai-provider.ts";

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

    const { messages, dealId, sourceIds } = await req.json();
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
    // Chat needs a cloud model: local/browser selections fall back to the default (GLM via NYO).
    const provider = resolveChatProvider(settings?.ai_model, (k) => Deno.env.get(k));

    // Fetch deal context if dealId provided.
    // Access = owner, explicit share, or same team (can_access_deal covers all three).
    let dealContext = "";
    let deckContent = "";
    if (dealId) {
      const { data: canAccess } = await adminClient
        .rpc("can_access_deal", { _deal_id: dealId, _user_id: user.id });
      if (!canAccess) {
        return new Response(JSON.stringify({ error: "Deal not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      let sourcesQuery = adminClient
        .from("sources")
        .select("file_name, extracted_text")
        .eq("deal_id", dealId);
      // NotebookLM-style scoping: restrict grounding to the selected sources.
      if (Array.isArray(sourceIds) && sourceIds.length > 0) {
        sourcesQuery = sourcesQuery.in("id", sourceIds.map(String).slice(0, 50));
      }
      const [dealResult, sourcesResult] = await Promise.all([
        adminClient
          .from("deals")
          .select("*")
          .eq("id", dealId)
          .single(),
        sourcesQuery,
      ]);

      const deal = dealResult.data;
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

      // Include extracted slide/page text from uploaded sources
      const sources = sourcesResult.data ?? [];
      const sourceTexts = sources
        .filter((s: any) => s.extracted_text)
        .map((s: any) => `=== Source: ${s.file_name} ===\n${s.extracted_text}`)
        .join("\n\n");
      if (sourceTexts) {
        // Truncate to ~50K chars to stay within context limits
        deckContent = `\n\nFULL DECK CONTENT:\n${sourceTexts.slice(0, 50_000)}`;
      }
    }

    const systemPrompt = `You are a senior VC analyst assistant called EasyVC. You help venture capital investors analyze startup pitch decks and deals.

You have access to the deal data extracted from pitch decks AND the full text content of uploaded deck slides/pages. Use this content to answer detailed questions about the deal, provide analysis, and help draft investment memos.

Be concise, data-driven, and opinionated when asked for your take. Use markdown formatting for structured responses.

${dealContext}${deckContent}`;

    console.log("Using model:", provider.model, "via", provider.id);

    const aiResponse = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: provider.headers,
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        stream: true,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("LLM API error:", provider.id, aiResponse.status, errText);
      return new Response(JSON.stringify({ error: `${provider.id} error [${aiResponse.status}]` }), {
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
