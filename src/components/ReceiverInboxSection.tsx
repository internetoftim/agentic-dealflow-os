import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Inbox, Plus, Trash2, Loader2, AlertCircle, Link2, Copy, Check, Mail, X } from "lucide-react";
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
  const { accounts, invites, isLoading, connect, setEnabled, disconnect, createInvite, revokeInvite } = useReceiverAccounts();
  const [inviteNote, setInviteNote] = useState("");
  const [latestInvite, setLatestInvite] = useState<{ url: string; expires_at: string } | null>(null);
  const [copied, setCopied] = useState(false);
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

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">You control the mailbox</p>
            <Button size="sm" variant="outline" className="gap-1.5" disabled={connect.isPending} onClick={startConnect}>
              {connect.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Connect a receiver Gmail
            </Button>
            <p className="text-[11px] text-muted-foreground">
              You'll sign in to the <em>receiver</em> account on Google and grant read access. Your
              primary sign-in is unaffected.
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">Someone else controls it</p>
            <input
              value={inviteNote}
              onChange={(e) => setInviteNote(e.target.value)}
              maxLength={200}
              placeholder="Optional note for them, e.g. “deals@ inbox”"
              className="w-full rounded-[5px] border border-input bg-background px-2.5 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground focus:border-brand/50"
            />
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={createInvite.isPending}
              onClick={() =>
                toast.promise(
                  createInvite.mutateAsync(inviteNote.trim() || undefined).then((inv) => {
                    setLatestInvite(inv);
                    setInviteNote("");
                  }),
                  { loading: "Creating invite…", success: "Invite link ready — send it to the mailbox owner", error: (e) => e.message },
                )
              }
            >
              {createInvite.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              Create an authorization link
            </Button>
            <p className="text-[11px] text-muted-foreground">
              They open the link, see who's asking and why, and sign in with the mailbox's Google
              account. No EasyVC account needed. Single use, expires in 7 days.
            </p>
          </div>
        </div>

        {latestInvite && (
          <div className="rounded-[5px] border border-brand/40 bg-brand-muted/30 p-3 space-y-2">
            <p className="text-xs font-medium text-foreground">Send this link to the mailbox owner</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-[4px] bg-card border border-border px-2 py-1.5 text-[11px] font-mono text-muted-foreground select-all">
                {latestInvite.url}
              </code>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 shrink-0"
                onClick={async () => {
                  await navigator.clipboard.writeText(latestInvite.url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                Copy
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 shrink-0" asChild>
                <a
                  href={`mailto:?subject=${encodeURIComponent("Connect your mailbox as a deal inbox")}&body=${encodeURIComponent(
                    `Please open this link and sign in with the mailbox's Google account to connect it as a deal inbox:\n\n${latestInvite.url}\n\nIt's single-use and expires in 7 days.`,
                  )}`}
                >
                  <Mail className="h-3.5 w-3.5" /> Email
                </a>
              </Button>
            </div>
          </div>
        )}

        {invites.length > 0 && (
          <div>
            <p className="text-xs font-medium text-foreground mb-1.5">Authorization links</p>
            <div className="divide-y divide-border rounded-[5px] border border-border">
              {invites.map((inv) => {
                const expired = !inv.used_at && new Date(inv.expires_at) < new Date();
                const status = inv.used_at
                  ? `Used by ${inv.used_by_email ?? "the mailbox owner"}`
                  : expired ? "Expired" : `Pending · expires ${relative(inv.expires_at).replace(" ago", "")}`;
                return (
                  <div key={inv.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] text-foreground truncate">{inv.note || "Deal inbox invite"}</p>
                      <p className={`text-[11px] ${inv.used_at ? "text-success" : expired ? "text-muted-foreground" : "text-muted-foreground"}`}>{status}</p>
                    </div>
                    {!inv.used_at && (
                      <button
                        title="Revoke link"
                        aria-label={`Revoke invite ${inv.id}`}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        onClick={() =>
                          toast.promise(revokeInvite.mutateAsync(inv.id), {
                            loading: "Revoking…", success: "Link revoked", error: (e) => e.message,
                          })
                        }
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
