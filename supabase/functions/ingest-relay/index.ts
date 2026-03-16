import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { images, userId, userEmail, sourceName, sourceUrl } = await req.json();

    if (!images || !Array.isArray(images) || images.length === 0) {
      return new Response(JSON.stringify({ error: "No images provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: "No userId provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Create a deal record
    const { data: deal, error: dealError } = await supabase
      .from("deals")
      .insert({
        user_id: userId,
        name: sourceName || "DocSend Deck",
        source: "docsend-bookmarklet",
        status: "extracting",
        deck_size: `${images.length} slides`,
        pages: images.length,
        website: sourceUrl || null,
      })
      .select()
      .single();

    if (dealError) throw dealError;

    // 2. Convert base64 images to a simple concatenated format and upload
    // Each image is a data:image/jpeg;base64,... string
    // We'll store them as individual files in storage
    const storagePaths: string[] = [];

    for (let i = 0; i < images.length; i++) {
      const base64 = images[i].replace(/^data:image\/\w+;base64,/, "");
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const path = `${userId}/${deal.id}/slide_${String(i + 1).padStart(3, "0")}.jpg`;

      const { error: uploadErr } = await supabase.storage
        .from("decks")
        .upload(path, bytes, { contentType: "image/jpeg" });

      if (uploadErr) {
        console.error(`Failed to upload slide ${i + 1}:`, uploadErr);
      } else {
        storagePaths.push(path);
      }
    }

    // 3. Create source record
    const { error: sourceError } = await supabase.from("sources").insert({
      deal_id: deal.id,
      user_id: userId,
      file_name: `${sourceName || "docsend-deck"}.jpg`,
      source_type: "docsend-bookmarklet",
      processing_status: "uploaded",
      storage_path: `${userId}/${deal.id}/`,
      original_size: `${images.length} slides`,
    });

    if (sourceError) console.error("Source insert error:", sourceError);

    // 4. Trigger the process-deck pipeline (fire-and-forget)
    // The process-deck function will handle extraction from the uploaded images
    try {
      await supabase.functions.invoke("process-deck", {
        body: {
          dealId: deal.id,
          storagePath: `${userId}/${deal.id}/`,
          fromBookmarklet: true,
          slideCount: images.length,
        },
      });
    } catch (e) {
      console.warn("process-deck invocation failed (non-fatal):", e);
    }

    return new Response(
      JSON.stringify({
        status: "success",
        dealId: deal.id,
        slidesUploaded: storagePaths.length,
        totalSlides: images.length,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("ingest-relay error:", e);
    return new Response(
      JSON.stringify({ error: e.message || "Internal error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
