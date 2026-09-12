import { supabase } from "@/integrations/supabase/client";
import type { ChatTurn } from "@/lib/inference/types";

/**
 * Build the grounding the cloud deal-chat function builds server-side, but in
 * the browser, for the local model: deal facts + extracted deck text of the
 * selected sources (or all). Kept under a budget so small models don't
 * overflow their context window.
 */
export async function buildDealContext(dealId: string, sourceIds?: string[], maxChars = 24_000): Promise<{ system: string; dealName: string }> {
  const { data: deal } = await supabase.from("deals").select("*").eq("id", dealId).maybeSingle();
  let q = supabase.from("sources").select("file_name, extracted_text").eq("deal_id", dealId);
  if (sourceIds?.length) q = q.in("id", sourceIds);
  const { data: sources } = await q;
  const d: any = deal ?? {};
  const facts = [
    ["Company", d.name], ["Stage", d.stage], ["Sector", d.sector], ["Status", d.status],
    ["Ask", d.ask_amount], ["Valuation", d.valuation], ["Revenue", d.revenue], ["Growth", d.growth], ["NRR", d.nrr],
    ["Team size", d.team_size], ["Website", d.website], ["Investors", d.investors], ["Funding total", d.funding_total], ["Last round", d.last_funding_round],
  ].filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  let budget = maxChars;
  const docs: string[] = [];
  for (const s of sources ?? []) {
    if (!s.extracted_text || budget <= 0) continue;
    const chunk = s.extracted_text.slice(0, Math.min(s.extracted_text.length, budget));
    docs.push(`=== ${s.file_name} ===\n${chunk}`); budget -= chunk.length;
  }
  const system = [
    "You are an investment analyst assistant inside EasyVC. Answer from the deal materials below; say when something is not in them. Be concise and quantitative.",
    facts ? `DEAL FACTS\n${facts}` : "",
    docs.length ? `DEAL MATERIALS\n${docs.join("\n\n")}` : "No deck text is available yet.",
  ].filter(Boolean).join("\n\n");
  return { system, dealName: d.name ?? "this deal" };
}

export const toTurns = (system: string, messages: Array<{ role: "user" | "assistant"; content: string }>): ChatTurn[] =>
  [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))];
