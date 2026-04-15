import { useState, useEffect } from "react";
import { Copy, Check, Loader2, Link2, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

const BASE_URL = "https://easyvc.lovable.app/intake";

export default function InboundPage() {
  const { user } = useAuth();
  const [intakeSlug, setIntakeSlug] = useState("");
  const [savingSlug, setSavingSlug] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("user_settings")
      .select("intake_slug")
      .eq("user_id", user.id)
      .single()
      .then(({ data }) => {
        if ((data as any)?.intake_slug) {
          setIntakeSlug((data as any).intake_slug);
        }
        setLoading(false);
      });
  }, [user]);

  const intakeUrl = `${BASE_URL}/${intakeSlug || user?.id}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(intakeUrl);
    setCopied(true);
    toast.success("Intake link copied!");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveSlug = async () => {
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
    } else {
      toast.success(slugValue ? `Slug set to "${slugValue}"` : "Slug removed, using default UUID");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-10 px-6 space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Inbound Intake</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Share this link with founders so they can submit their pitch decks directly into your pipeline.
        </p>
      </div>

      {/* Shareable Link */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 className="text-sm font-medium text-foreground flex items-center gap-2">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          Shareable Link
        </h2>

        <div className="flex gap-2 items-center">
          <input
            type="text"
            readOnly
            value={intakeUrl}
            className="flex-1 rounded-md border border-input bg-muted/50 px-3 py-2 text-sm font-mono outline-none text-muted-foreground select-all"
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <Button onClick={handleCopy} size="sm" className="gap-1.5">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>

        <a
          href={intakeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          Preview intake page
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {/* Custom Slug */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h2 className="text-sm font-medium text-foreground">Custom Slug</h2>
        <p className="text-xs text-muted-foreground">
          Customize the URL path for a cleaner, branded intake link.
        </p>

        <div className="flex gap-2 items-center">
          <span className="text-sm text-muted-foreground whitespace-nowrap font-mono">/intake/</span>
          <input
            type="text"
            value={intakeSlug}
            onChange={(e) => setIntakeSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
            placeholder={user?.id}
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
          <Button
            onClick={handleSaveSlug}
            disabled={savingSlug}
            size="sm"
            variant="outline"
          >
            {savingSlug ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
