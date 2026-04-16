import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, FileUp, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";

const BASE_APP_URL = "https://easyvc.lovable.app";

export default function IntakePage() {
  const { user } = useAuth();
  const [intakeSlug, setIntakeSlug] = useState("");
  const [savingSlug, setSavingSlug] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user) return;

    supabase
      .from("user_settings")
      .select("intake_slug")
      .eq("user_id", user.id)
      .single()
      .then(({ data }) => {
        if (data?.intake_slug) {
          setIntakeSlug(data.intake_slug);
        }
        setLoaded(true);
      });
  }, [user]);

  const resolvedSlug = useMemo(() => {
    if (!user) return "";
    return intakeSlug.trim() || user.id;
  }, [intakeSlug, user]);

  const publicIntakeUrl = `${BASE_APP_URL}/intake/${resolvedSlug}`;

  const saveSlug = async () => {
    if (!user) return;

    setSavingSlug(true);
    const slugValue = intakeSlug.trim() || null;
    const { error } = await supabase
      .from("user_settings")
      .upsert({ user_id: user.id, intake_slug: slugValue } as any, { onConflict: "user_id" });
    setSavingSlug(false);

    if (error) {
      if (error.message?.includes("duplicate") || error.code === "23505") {
        toast.error("This slug is already taken. Try another one.");
      } else {
        toast.error("Failed to save slug");
      }
      return;
    }

    toast.success(slugValue ? `Slug set to "${slugValue}"` : "Slug removed, using default UUID");
  };

  if (!user) return null;

  return (
    <div className="p-6 max-w-4xl space-y-8">
      <section>
        <h1 className="text-xl font-semibold text-foreground mb-2 flex items-center gap-2">
          <Link2 className="h-5 w-5 text-muted-foreground" />
          External Intake
        </h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Share this page externally so founders can submit decks directly into your pipeline.
          You can customize the slug and preview exactly what the intake experience looks like.
        </p>
      </section>

      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-foreground">Shareable Intake Link</h2>
          <p className="text-xs text-muted-foreground">
            Use this link for external deal intake forms. Submissions from this page are tagged as inbound.
          </p>
        </div>

        <div className="flex gap-2 items-center">
          <input
            type="text"
            readOnly
            value={publicIntakeUrl}
            className="flex-1 rounded-md border border-input bg-muted/50 px-3 py-2 text-sm font-mono outline-none text-muted-foreground select-all"
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <button
            onClick={() => {
              navigator.clipboard.writeText(publicIntakeUrl);
              toast.success("Intake link copied!");
            }}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </button>
          <a
            href={publicIntakeUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open
          </a>
        </div>

        <div>
          <label className="text-xs font-medium text-foreground mb-1 block">Custom Slug</label>
          <div className="flex gap-2 items-center">
            <span className="text-xs text-muted-foreground whitespace-nowrap">/intake/</span>
            <input
              type="text"
              value={intakeSlug}
              onChange={(e) => setIntakeSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              placeholder={user.id}
              className="flex-1 rounded-md border border-input bg-card px-3 py-2 text-sm font-mono outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
            />
            <button
              onClick={saveSlug}
              disabled={savingSlug || !loaded}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            >
              {savingSlug ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Letters, numbers, and dashes only. Leave blank to use your default ID.
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground mb-2">Intake Page Preview</h2>
        <p className="text-xs text-muted-foreground mb-4">
          This is a preview of the external form founders will see when they open your intake link.
        </p>

        <div className="rounded-lg border border-dashed border-border p-6 bg-background">
          <div className="max-w-md mx-auto">
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-primary/10 mb-3">
                <FileUp className="h-6 w-6 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-foreground">Submit Your Deck</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Upload your pitch deck for review. We accept PDF and PPTX files up to 20MB.
              </p>
            </div>

            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">Company Name *</label>
                <div className="h-9 rounded-md border border-input bg-muted/40" />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">Pitch Deck *</label>
                <div className="h-24 rounded-md border-2 border-dashed border-border bg-muted/30" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-foreground">Your Name</label>
                  <div className="h-9 rounded-md border border-input bg-muted/40" />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-foreground">Your Email</label>
                  <div className="h-9 rounded-md border border-input bg-muted/40" />
                </div>
              </div>
              <div className="h-9 rounded-md bg-primary/90" />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
