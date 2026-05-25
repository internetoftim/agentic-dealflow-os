import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, key);

    // Caller must be an authenticated admin
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const { data: userData } = await admin.auth.getUser(token);
    const userId = userData?.user?.id;
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: isAdmin } = await admin.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { dryRun = false } = await req.json().catch(() => ({}));

    // List all files in decks (paginate)
    const allPaths: string[] = [];
    const walk = async (prefix: string) => {
      const { data, error } = await admin.storage.from("decks").list(prefix, { limit: 1000 });
      if (error) throw error;
      for (const item of data || []) {
        const full = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id === null) {
          // folder
          await walk(full);
        } else {
          allPaths.push(full);
        }
      }
    };
    await walk("");

    // Find orphans: path = {user_id}/{deal_id}/...
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const dealIds = new Set<string>();
    for (const p of allPaths) {
      const parts = p.split("/");
      if (parts.length >= 2 && uuidRe.test(parts[1])) dealIds.add(parts[1]);
    }
    const existing = new Set<string>();
    if (dealIds.size > 0) {
      const { data: deals } = await admin.from("deals").select("id").in("id", [...dealIds]);
      for (const d of deals || []) existing.add(d.id);
    }

    const orphans = allPaths.filter((p) => {
      const parts = p.split("/");
      return parts.length >= 2 && uuidRe.test(parts[1]) && !existing.has(parts[1]);
    });

    if (dryRun || orphans.length === 0) {
      return new Response(JSON.stringify({ totalFiles: allPaths.length, orphanCount: orphans.length, orphans, deleted: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Delete in batches of 100
    let deleted = 0;
    for (let i = 0; i < orphans.length; i += 100) {
      const batch = orphans.slice(i, i + 100);
      const { data, error } = await admin.storage.from("decks").remove(batch);
      if (error) throw error;
      deleted += data?.length || 0;
    }

    return new Response(JSON.stringify({ totalFiles: allPaths.length, orphanCount: orphans.length, deleted }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
