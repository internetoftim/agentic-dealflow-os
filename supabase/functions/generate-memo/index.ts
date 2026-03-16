import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SAPINSAPIN_BASE = "https://apollo-inference-bridge.am1-aks.apolloglobal.net";
const SAPINSAPIN_MODEL = "/models/gpt-oss-20b-balitanlp-cpt";
const OPENAI_BASE = "https://api.openai.com";

const DEFAULT_MEMO_PROMPT = `You are a VC analyst writing an internal investment memo. Given the extracted deck content and any deep research data, produce a structured memo with the following sections:

1. **Executive Summary** — One paragraph overview of the company, what they do, and why it matters.
2. **Market Opportunity** — TAM/SAM/SOM if available, market trends, and timing thesis.
3. **Product & Traction** — What the product does, key metrics (ARR, growth, NRR, users), and competitive moat.
4. **Team** — Founders' backgrounds, relevant experience, and team composition.
5. **Business Model** — How they make money, unit economics, and pricing strategy.
6. **Competition** — Key competitors and differentiation.
7. **Risks & Concerns** — Red flags, market risks, execution risks.
8. **Investment Thesis** — Bull case and bear case for investing.
9. **Recommendation** — Pass / Follow-up / Invest, with reasoning.

Be concise, data-driven, and flag any missing information. Use bullet points where appropriate.`;

/**
 * Apply a naming pattern to generate a filename.
 */
function applyNamingPattern(
  pattern: string,
  deal: { name: string; website?: string | null; pages?: number | null; sector?: string; stage?: string },
): string {
  const now = new Date();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthYYYY = `${monthNames[now.getMonth()]}${now.getFullYear()}`;

  let websiteName = deal.name;
  if (deal.website) {
    try {
      const url = new URL(deal.website.startsWith("http") ? deal.website : `https://${deal.website}`);
      websiteName = url.hostname.replace(/^www\./, "");
    } catch {
      websiteName = deal.website;
    }
  }

  let result = pattern
    .replace(/<WEBSITE>/gi, websiteName)
    .replace(/<MonthYYYY>/gi, monthYYYY)
    .replace(/<pages>/gi, String(deal.pages ?? 0))
    .replace(/<NAME>/gi, deal.name)
    .replace(/<SECTOR>/gi, deal.sector ?? "Unknown")
    .replace(/<STAGE>/gi, deal.stage ?? "Unknown");

  result = result.replace(/\.(pdf|pptx?)\s*$/i, "");
  result = result.replace(/[\/\\:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
  if (!result.toLowerCase().endsWith(".pdf")) {
    result += ".pdf";
  }

  return result;
}

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

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { dealId } = await req.json();
    if (!dealId) {
      return new Response(JSON.stringify({ error: "Missing dealId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch deal + sources + settings in parallel
    const [dealResult, sourcesResult, settingsResult] = await Promise.all([
      adminClient.from("deals").select("*").eq("id", dealId).eq("user_id", user.id).single(),
      adminClient.from("sources").select("file_name, extracted_text").eq("deal_id", dealId).eq("user_id", user.id),
      adminClient.from("user_settings").select("ai_model, memo_prompt, google_provider_token, drive_sync_enabled, recap_naming_pattern, drive_folder").eq("user_id", user.id).single(),
    ]);

    const deal = dealResult.data;
    if (!deal) throw new Error("Deal not found");

    const settings = settingsResult.data;
    const memoPrompt = (settings as any)?.memo_prompt || DEFAULT_MEMO_PROMPT;

    // Step 1: Trigger deep research if not completed
    if (deal.deep_research_status !== "completed") {
      console.log("Deep research not completed, triggering...");
      const drRes = await fetch(`${supabaseUrl}/functions/v1/deep-research`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          apikey: supabaseAnonKey,
        },
        body: JSON.stringify({ dealId }),
      });
      if (!drRes.ok) {
        console.warn("Deep research failed:", await drRes.text());
      } else {
        console.log("Deep research completed");
      }
      // Re-fetch deal after deep research
      const { data: updatedDeal } = await adminClient.from("deals").select("*").eq("id", dealId).single();
      if (updatedDeal) Object.assign(deal, updatedDeal);
    }

    // Step 2: Build context for memo generation
    const sources = sourcesResult.data ?? [];
    const deckContent = sources
      .filter((s: any) => s.extracted_text)
      .map((s: any) => `=== Source: ${s.file_name} ===\n${s.extracted_text}`)
      .join("\n\n")
      .slice(0, 50_000);

    const dealContext = `
DEAL CONTEXT:
- Company: ${deal.name}
- Stage: ${deal.stage}
- Sector: ${deal.sector}
- Ask Amount: ${deal.ask_amount ?? "Unknown"}
- Valuation: ${deal.valuation ?? "Unknown"}
- Revenue: ${deal.revenue ?? "Unknown"}
- Growth: ${deal.growth ?? "Unknown"}
- NRR: ${deal.nrr ?? "Unknown"}
- Team Size: ${deal.team_size ?? "Unknown"}
- Website: ${deal.website ?? "Unknown"}
- LinkedIn: ${deal.linkedin_url ?? "Unknown"}
`;

    // Step 3: Generate memo via AI
    const aiModel = settings?.ai_model ?? "gpt-5-mini";
    const effectiveModel = aiModel === "local-florence2" ? "gpt-5-mini" : aiModel;
    const isSapinsapin = effectiveModel === "gpt-oss-202b";
    const baseUrl = isSapinsapin ? SAPINSAPIN_BASE : OPENAI_BASE;
    const envKey = isSapinsapin ? "APOLLO_API_KEY" : "OPENAI_API_KEY";
    const rawApiKey = Deno.env.get(envKey)?.trim().replace(/[\r\n]/g, "");

    if (!rawApiKey) throw new Error(`${envKey} is not configured`);

    const aiHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (isSapinsapin) {
      aiHeaders["X-API-Key"] = rawApiKey;
    } else {
      aiHeaders["Authorization"] = `Bearer ${rawApiKey}`;
    }

    console.log(`Generating memo for "${deal.name}" using model: ${effectiveModel}`);

    const aiResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: aiHeaders,
      body: JSON.stringify({
        model: isSapinsapin ? SAPINSAPIN_MODEL : effectiveModel,
        messages: [
          { role: "system", content: memoPrompt },
          {
            role: "user",
            content: `Generate an investment memo for the following deal.\n\n${dealContext}\n\nDECK CONTENT:\n${deckContent || "No deck content available."}`,
          },
        ],
        max_completion_tokens: 4096,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("AI API error:", aiResponse.status, errText);
      throw new Error(`AI API error [${aiResponse.status}]`);
    }

    const aiResult = await aiResponse.json();
    const memoContent = aiResult.choices?.[0]?.message?.content;

    if (!memoContent) throw new Error("No memo content generated");

    // Step 4: Save memo to deal
    await adminClient
      .from("deals")
      .update({ memo_draft: memoContent, updated_at: new Date().toISOString() })
      .eq("id", dealId);

    console.log(`Memo saved (${memoContent.length} chars)`);

    // Step 5: Upload recap PDF to Google Drive
    let driveFileId: string | null = null;
    let driveFileName: string | null = null;

    if (settings?.google_provider_token && settings?.drive_sync_enabled) {
      try {
        const recapPattern = (settings as any)?.recap_naming_pattern || "<WEBSITE> recap <MonthYYYY> p<pages>";
        driveFileName = applyNamingPattern(recapPattern, deal);

        // Create a simple text-based PDF-like content (plain text upload as Google Doc)
        // We'll upload the memo as a plain text file with .pdf naming for consistency
        const memoBlob = new Blob([memoContent], { type: "text/plain" });

        // Resolve drive folder
        const folderPath = (settings as any)?.drive_folder || "WAITING ROOM";
        const folderSegments = folderPath.split("/").map((s: string) => s.trim()).filter(Boolean);
        let parentId: string | null = null;

        for (const segment of folderSegments) {
          const escapedName = segment.replace(/'/g, "\\'");
          const parentQuery = parentId ? ` and '${parentId}' in parents` : "";
          const q = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentQuery}`;
          const folderSearchRes = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
            { headers: { Authorization: `Bearer ${settings.google_provider_token}` } }
          );

          let segmentId: string | null = null;
          if (folderSearchRes.ok) {
            const folderData = await folderSearchRes.json();
            if (folderData.files?.length > 0) segmentId = folderData.files[0].id;
          }

          if (!segmentId) {
            const createBody: Record<string, unknown> = {
              name: segment,
              mimeType: "application/vnd.google-apps.folder",
            };
            if (parentId) createBody.parents = [parentId];
            const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${settings.google_provider_token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(createBody),
            });
            if (createRes.ok) {
              const created = await createRes.json();
              segmentId = created.id;
            }
          }
          parentId = segmentId;
        }

        // Upload memo as Google Doc (converts markdown to doc)
        const metadata: Record<string, unknown> = {
          name: driveFileName.replace(/\.pdf$/, ""),
          mimeType: "application/vnd.google-apps.document",
        };
        if (parentId) metadata.parents = [parentId];

        const form = new FormData();
        form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
        form.append("file", memoBlob);

        const driveRes = await fetch(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&convert=true",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${settings.google_provider_token}` },
            body: form,
          }
        );

        if (driveRes.ok) {
          const driveFile = await driveRes.json();
          driveFileId = driveFile.id;
          console.log(`Recap uploaded to Drive: ${driveFileName} (${driveFileId})`);
        } else {
          const errText = await driveRes.text();
          console.error("Drive upload failed:", driveRes.status, errText);
        }
      } catch (e) {
        console.error("Drive upload error (non-fatal):", e);
      }
    }

    return new Response(
      JSON.stringify({ success: true, memoLength: memoContent.length, driveFileId, driveFileName }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("generate-memo error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
