import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Inbox, Plus, Trash2, Loader2, AlertCircle } from "lucide-react";
import { useReceiverAccounts } from "@/hooks/useReceiverAccounts";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

function relative(iso: string | null): string {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Deal inbox: a second Gmail account connected purely as a receiver. Anything
 * forwarded to it with a deck attached is ingested — no label required.
 */
export function ReceiverInboxSection() {
  const { accounts, isLoading, connect, setEnabled, disconnect } = useReceiverAccounts();
  const [searchParams, setSearchParams] = useSearchParams();

  // Google bounces back here with ?receiver=connected|error
  useEffect(() => {
    const status = searchParams.get("receiver");
    if (!status) return;
    if (status === "connected") toast.success(`Deal inbox connected: ${searchParams.get("email") ?? ""}`);
    else toast.error(`Could not connect inbox: ${searchParams.get("reason") ?? "unknown error"}`);
    searchParams.delete("receiver"); searchParams.delete("email"); searchParams.delete("reason");
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const startConnect = () =>
    toast.promise(
      connect.mutateAsync(`${window.location.origin}/settings`).then((url) => { window.location.assign(url); }),
      { loading: "Opening Google…", success: "Redirecting to Google", error: (e) => e.message },
    );

  return (
    <section className="mb-8">
      <h2 className="eyebrow mb-3 flex items-center gap-2">
        <Inbox className="h-4 w-4 text-muted-foreground" />
        Deal Inbox
      </h2>
      <div className="rounded-md border border-border bg-card p-5 space-y-4">
        <p className="text-xs text-muted-foreground">
          Connect a separate Gmail address as a pure receiver. Every email it gets — forwarded by
          you, founders, or anyone — is checked for a deck; when one is attached, the full
          ingestion pipeline runs into your workspace. No label needed.
        </p>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : accounts.length > 0 ? (
          <div className="divide-y divide-border rounded-[5px] border border-border">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{a.email}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {a.enabled ? "Listening" : "Paused"} · last checked {relative(a.last_polled_at)}
                  </p>
                  {a.last_error && (
                    <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-destructive">
                      <AlertCircle className="h-3 w-3" /> {a.last_error}
                    </p>
                  )}
                </div>
                <Switch
                  checked={a.enabled}
                  aria-label={a.enabled ? "Pause inbox" : "Resume inbox"}
                  onCheckedChange={(v) =>
                    toast.promise(setEnabled.mutateAsync({ id: a.id, enabled: v }), {
                      loading: "Saving…", success: v ? "Inbox listening" : "Inbox paused", error: (e) => e.message,
                    })
                  }
                />
                <button
                  title="Disconnect inbox"
                  aria-label={`Disconnect ${a.email}`}
                  className="text-muted-foreground hover:text-destructive transition-colors"
                  onClick={() =>
                    toast.promise(disconnect.mutateAsync(a.id), {
                      loading: "Disconnecting…", success: "Inbox disconnected", error: (e) => e.message,
                    })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">No deal inbox connected yet.</p>
        )}

        <Button size="sm" variant="outline" className="gap-1.5" disabled={connect.isPending} onClick={startConnect}>
          {connect.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Connect a receiver Gmail
        </Button>
        <p className="text-[11px] text-muted-foreground">
          You'll sign in to the <em>receiver</em> account on Google and grant read access. Your primary
          sign-in is unaffected. Tip: set up a forwarding rule from your main mailbox to it.
        </p>
      </div>
    </section>
  );
}
