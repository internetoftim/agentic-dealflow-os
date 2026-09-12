import { useState } from "react";
import { ShieldCheck, Unplug, Trash2, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

const ACCOUNT_FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/account`;

async function callAccount(action: "disconnect_google" | "delete_account", extra: Record<string, unknown> = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not signed in");
  const res = await fetch(ACCOUNT_FN, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, ...extra }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Request failed");
  return body;
}

/** The controls a published Google app must offer: revoke access, delete data. */
export function DataPrivacySection() {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"disconnect" | "delete" | null>(null);

  return (
    <section className="mb-8">
      <h2 className="eyebrow mb-3 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        Data &amp; privacy
      </h2>
      <div className="rounded-md border border-border bg-card p-5 space-y-5">
        <p className="text-xs text-muted-foreground">
          Google tokens are encrypted at rest and never leave our servers. See the{" "}
          <Link to="/privacy" className="underline underline-offset-2 hover:text-foreground">Privacy Policy</Link>.
        </p>

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-foreground">Disconnect Google</p>
            <p className="text-xs text-muted-foreground">
              Revokes EasyVC's access at Google and deletes the stored tokens. Drive sync and Gmail
              ingestion switch off; sign-in keeps working.
            </p>
          </div>
          <Button
            variant="outline" size="sm" className="gap-1.5 shrink-0" disabled={busy !== null}
            onClick={() => {
              setBusy("disconnect");
              toast.promise(callAccount("disconnect_google").finally(() => { setBusy(null); queryClient.invalidateQueries(); }), {
                loading: "Revoking access…", success: "Google disconnected", error: (e) => e.message,
              });
            }}
          >
            {busy === "disconnect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />}
            Disconnect
          </Button>
        </div>

        <div className="rounded-[5px] border border-destructive/30 p-4 space-y-3">
          <div>
            <p className="text-sm text-foreground">Delete account</p>
            <p className="text-xs text-muted-foreground">
              Permanently deletes your deals, documents, notes, inboxes, tokens and profile, and removes you
              from your team. This cannot be undone.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder='Type DELETE to confirm'
              aria-label="Type DELETE to confirm"
              className="max-w-[220px]"
            />
            <Button
              variant="destructive" size="sm" className="gap-1.5"
              disabled={confirm !== "DELETE" || busy !== null}
              onClick={() => {
                setBusy("delete");
                toast.promise(
                  callAccount("delete_account", { confirm: "DELETE" }).then(async () => {
                    await supabase.auth.signOut();
                    window.location.assign("/login");
                  }).finally(() => setBusy(null)),
                  { loading: "Deleting everything…", success: "Account deleted", error: (e) => e.message },
                );
              }}
            >
              {busy === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Delete my account
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
