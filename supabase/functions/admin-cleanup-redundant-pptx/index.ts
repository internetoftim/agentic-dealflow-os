// One-shot admin cleanup: delete .pptx/.ppt originals when a PDF sibling exists for the same deal.
// Uses service role + storage API (recursive list).
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  // Recursively list all files in `decks`
  async function listAll(prefix: string): Promise<{ path: string; size: number }[]> {
    const out: { path: string; size: number }[] = [];
    const stack: string[] = [prefix];
    while (stack.length) {
      const cur = stack.pop()!;
      let offset = 0;
      while (true) {
        const { data, error } = await supabase.storage.from("decks").list(cur, { limit: 1000, offset });
        if (error) throw new Error(`list ${cur}: ${error.message}`);
        if (!data || data.length === 0) break;
        for (const item of data) {
          const full = cur ? `${cur}/${item.name}` : item.name;
          const isFile = (item as any).id !== null && item.metadata != null;
          if (isFile) out.push({ path: full, size: Number(item.metadata?.size ?? 0) });
          else stack.push(full);
        }
        if (data.length < 1000) break;
        offset += 1000;
      }
    }
    return out;
  }

  try {
    // Top-level prefixes are user IDs
    const { data: top, error: topErr } = await supabase.storage.from("decks").list("", { limit: 1000 });
    if (topErr) throw new Error(`list root: ${topErr.message}`);
    const userPrefixes = (top || []).filter((i) => (i as any).id === null).map((i) => i.name);

    let all: { path: string; size: number }[] = [];
    for (const u of userPrefixes) {
      const files = await listAll(u);
      all = all.concat(files);
    }

    const pdfDeals = new Set<string>();
    for (const f of all) {
      const parts = f.path.split("/");
      if (parts.length >= 3 && parts[parts.length - 1].toLowerCase().endsWith(".pdf")) {
        pdfDeals.add(parts[1]);
      }
    }
    const candidates = all.filter((f) => {
      const parts = f.path.split("/");
      if (parts.length < 3) return false;
      const fn = parts[parts.length - 1].toLowerCase();
      return (fn.endsWith(".pptx") || fn.endsWith(".ppt")) && pdfDeals.has(parts[1]);
    });

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
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
