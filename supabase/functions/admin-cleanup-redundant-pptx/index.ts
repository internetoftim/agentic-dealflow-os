// One-shot admin cleanup: delete .pptx/.ppt originals when a PDF sibling exists for the same deal.
// Uses service role. Returns counts. No request body required.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Fetch all decks-bucket objects via storage.objects table
  const { data: rows, error } = await supabase
    .schema("storage")
    .from("objects")
    .select("name, metadata")
    .eq("bucket_id", "decks")
    .limit(10000);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const pdfDeals = new Set<string>();
  const candidates: { path: string; size: number }[] = [];
  for (const r of rows ?? []) {
    const name = (r as any).name as string;
    const parts = name.split("/");
    const dealId = parts[1];
    const fname = parts[parts.length - 1].toLowerCase();
    if (fname.endsWith(".pdf")) pdfDeals.add(dealId);
  }
  for (const r of rows ?? []) {
    const name = (r as any).name as string;
    const parts = name.split("/");
    const dealId = parts[1];
    const fname = parts[parts.length - 1].toLowerCase();
    if ((fname.endsWith(".pptx") || fname.endsWith(".ppt")) && pdfDeals.has(dealId)) {
      candidates.push({ path: name, size: Number((r as any).metadata?.size ?? 0) });
    }
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const totalBytes = candidates.reduce((a, b) => a + b.size, 0);

  if (dryRun) {
    return new Response(JSON.stringify({ dryRun: true, count: candidates.length, totalBytes }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let deleted = 0;
  const errors: string[] = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const batch = candidates.slice(i, i + 100).map((c) => c.path);
    const { data, error: delErr } = await supabase.storage.from("decks").remove(batch);
    if (delErr) errors.push(delErr.message);
    else deleted += data?.length ?? 0;
  }

  return new Response(
    JSON.stringify({ count: candidates.length, deleted, totalBytes, errors }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
