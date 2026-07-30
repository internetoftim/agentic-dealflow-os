import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { marked } from "https://esm.sh/marked@15.0.4";

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

    const { dealId } = await req.json();
    if (!dealId) {
      return new Response(JSON.stringify({ error: "Missing dealId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Dual-mode auth: a service-role caller (e.g. the MCP server's generate_memo
    // tool) resolves the owner from the deal; otherwise resolve from the JWT.
    // The JWT path is unchanged for the in-app caller.
    let userId: string;
    if (authHeader === `Bearer ${supabaseServiceKey}`) {
      const { data: dealRecord } = await adminClient
        .from("deals").select("user_id").eq("id", dealId).single();
      if (!dealRecord?.user_id) {
        return new Response(JSON.stringify({ error: "Deal not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = dealRecord.user_id;
    } else {
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
      userId = user.id;
    }

    // Fetch deal + sources + settings in parallel
    const [dealResult, sourcesResult, settingsResult] = await Promise.all([
      adminClient.from("deals").select("*").eq("id", dealId).eq("user_id", userId).single(),
      adminClient.from("sources").select("file_name, extracted_text").eq("deal_id", dealId).eq("user_id", userId),
      adminClient.from("user_settings").select("ai_model, memo_prompt, google_provider_token, drive_sync_enabled, recap_naming_pattern, drive_folder").eq("user_id", userId).single(),
    ]);

    const deal = dealResult.data;
    if (!deal) throw new Error("Deal not found");

    const settings = settingsResult.data;
    const memoPrompt = (settings as any)?.memo_prompt || DEFAULT_MEMO_PROMPT;

    // Note: deep-research is auto-triggered by process-deck after extraction completes.
    // We deliberately do NOT block memo generation on it — a sync call here would
    // double the timeout window and was a primary cause of stalls. Memo uses whatever
    // research has been populated so far; users can re-run after deep-research finishes.
    if (deal.deep_research_status !== "completed") {
      console.log(`Generating memo without completed deep-research (status=${deal.deep_research_status ?? "none"})`);
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
    const aiModel = settings?.ai_model ?? "gpt-5.4";
    const effectiveModel = aiModel === "local-florence2" ? "gpt-5.4" : aiModel;
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
        const docTitle = driveFileName.replace(/\.pdf$/, "");

        // Convert markdown memo to professionally styled HTML
        const memoHtml = await marked.parse(memoContent);
        const styledHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  body { font-family: 'Inter', Arial, sans-serif; color: #1a1a1a; line-height: 1.7; margin: 0; padding: 48px 56px; font-size: 11pt; }
  h1 { font-size: 22pt; font-weight: 700; color: #111; margin: 0 0 8px 0; padding-bottom: 12px; border-bottom: 2px solid #111; }
  h2 { font-size: 13pt; font-weight: 600; color: #222; margin: 32px 0 12px 0; padding-bottom: 6px; border-bottom: 1px solid #e0e0e0; text-transform: uppercase; letter-spacing: 0.5px; }
  h3 { font-size: 11pt; font-weight: 600; color: #333; margin: 20px 0 8px 0; }
  p { margin: 0 0 10px 0; }
  ul, ol { margin: 0 0 12px 0; padding-left: 24px; }
  li { margin-bottom: 4px; }
  strong { font-weight: 600; }
  code { background: #f4f4f5; padding: 2px 6px; border-radius: 3px; font-size: 10pt; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #d4d4d8; padding: 8px 12px; text-align: left; font-size: 10pt; }
  th { background: #f4f4f5; font-weight: 600; }
  blockquote { border-left: 3px solid #d4d4d8; margin: 12px 0; padding: 8px 16px; color: #555; background: #fafafa; }
  .header-meta { color: #666; font-size: 9pt; margin-bottom: 24px; }
  hr { border: none; border-top: 1px solid #e0e0e0; margin: 24px 0; }
</style>
</head>
<body>
  <h1>${docTitle}</h1>
  <div class="header-meta">
    <strong>${deal.name}</strong> · ${deal.sector} · ${deal.stage}<br>
    Generated ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
  </div>
  <hr>
  ${memoHtml}
</body>
</html>`;

        const htmlBlob = new Blob([styledHtml], { type: "text/html" });

        // Resolve drive folder
        const folderPath = (settings as any)?.drive_folder || "WAIT ROOM";
        const folderSegments = folderPath.split("/").map((s: string) => s.trim()).filter(Boolean);
        let parentId: string | null = null;

        for (const segment of folderSegments) {
          const escapedName = segment.replace(/'/g, "\\'");
          const parentQuery: string = parentId ? ` and '${parentId}' in parents` : "";
          const q: string = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentQuery}`;
          const folderSearchRes: Response = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
            { headers: { Authorization: `Bearer ${settings.google_provider_token}` } }
          );

          let segmentId: string | null = null;
          if (folderSearchRes.ok) {
            const folderData: any = await folderSearchRes.json();
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

        // Step 5a: Upload styled HTML as temporary Google Doc
        const tempMeta: Record<string, unknown> = {
          name: `_temp_${docTitle}`,
          mimeType: "application/vnd.google-apps.document",
        };
        if (parentId) tempMeta.parents = [parentId];

        const tempForm = new FormData();
        tempForm.append("metadata", new Blob([JSON.stringify(tempMeta)], { type: "application/json" }));
        tempForm.append("file", htmlBlob);

        const tempRes = await fetch(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${settings.google_provider_token}` },
            body: tempForm,
          }
        );

        if (!tempRes.ok) {
          const errText = await tempRes.text();
          console.error("Temp doc upload failed:", tempRes.status, errText);
          throw new Error("Failed to create temporary Google Doc");
        }

        const tempDoc = await tempRes.json();
        const tempDocId = tempDoc.id;
        console.log(`Temp Google Doc created: ${tempDocId}`);

        // Step 5b: Export Google Doc as PDF
        const exportRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${tempDocId}/export?mimeType=application/pdf`,
          { headers: { Authorization: `Bearer ${settings.google_provider_token}` } }
        );

        if (!exportRes.ok) {
          const errText = await exportRes.text();
          console.error("PDF export failed:", exportRes.status, errText);
          // Clean up temp doc
          await fetch(`https://www.googleapis.com/drive/v3/files/${tempDocId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${settings.google_provider_token}` },
          });
          throw new Error("Failed to export PDF from Google Docs");
        }

        const pdfBytes = await exportRes.arrayBuffer();
        console.log(`PDF exported: ${pdfBytes.byteLength} bytes`);

        // Step 5c: Upload the final PDF
        const pdfMeta: Record<string, unknown> = {
          name: driveFileName,
          mimeType: "application/pdf",
        };
        if (parentId) pdfMeta.parents = [parentId];

        const pdfForm = new FormData();
        pdfForm.append("metadata", new Blob([JSON.stringify(pdfMeta)], { type: "application/json" }));
        pdfForm.append("file", new Blob([pdfBytes], { type: "application/pdf" }));

        const pdfUploadRes = await fetch(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${settings.google_provider_token}` },
            body: pdfForm,
          }
        );

        if (pdfUploadRes.ok) {
          const pdfFile = await pdfUploadRes.json();
          driveFileId = pdfFile.id;
          console.log(`PDF recap uploaded to Drive: ${driveFileName} (${driveFileId})`);
        } else {
          const errText = await pdfUploadRes.text();
          console.error("PDF upload failed:", pdfUploadRes.status, errText);
        }

        // Step 5d: Delete temporary Google Doc
        await fetch(`https://www.googleapis.com/drive/v3/files/${tempDocId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${settings.google_provider_token}` },
        }).catch((e) => console.warn("Failed to delete temp doc:", e));

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
