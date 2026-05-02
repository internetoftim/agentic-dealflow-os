import { useState } from "react";
import { Copy, Check, Loader2, Link2, Trash2, UserMinus, Share2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDealShareLink, useDealShareAccessList } from "@/hooks/useDealShare";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  dealName: string;
  ownerId: string;
}

export function ShareDealDialog({ open, onOpenChange, dealId, dealName, ownerId }: Props) {
  const { share, shareUrl, isLoading, create, isCreating, revokeLink, isRevoking } = useDealShareLink(dealId, ownerId);
  const { accessList, revokeAccess, isRevoking: isRevokingAccess } = useDealShareAccessList(dealId, ownerId);
  const [copied, setCopied] = useState(false);

  const handleCreate = () => {
    create()
      .then(() => toast.success("Share link created"))
      .catch((e) => toast.error(`Failed: ${e.message}`));
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy — please copy manually");
    }
  };

  const handleRevokeLink = () => {
    if (!share) return;
    if (!confirm("Revoke this link? Anyone who hasn't joined yet will lose access. Existing recipients keep access until revoked individually.")) return;
    revokeLink(share.id)
      .then(() => toast.success("Link revoked"))
      .catch((e) => toast.error(`Failed: ${e.message}`));
  };

  const handleRevokeAccess = (id: string, name: string) => {
    if (!confirm(`Remove ${name}'s access to this deal?`)) return;
    revokeAccess(id)
      .then(() => toast.success("Access revoked"))
      .catch((e) => toast.error(`Failed: ${e.message}`));
  };

  const activeAccess = accessList.filter((a) => !a.revoked_at);
  const revokedAccess = accessList.filter((a) => a.revoked_at);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" /> Share "{dealName}"
          </DialogTitle>
          <DialogDescription>
            Anyone with the link who is signed in to the platform can view this deal and use its chat. They cannot edit it or run agents.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Link section */}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Share link</div>
            {isLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
              </div>
            ) : share && shareUrl ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2">
                  <Link2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <input
                    readOnly
                    value={shareUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 bg-transparent text-xs outline-none text-foreground"
                  />
                  <Button size="sm" variant="ghost" className="h-7 px-2 gap-1" onClick={handleCopy}>
                    {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                    <span className="text-[11px]">{copied ? "Copied" : "Copy"}</span>
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start h-7 px-2 gap-1 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={handleRevokeLink}
                  disabled={isRevoking}
                >
                  {isRevoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  <span className="text-[11px]">Revoke link</span>
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={handleCreate} disabled={isCreating} className="gap-1.5">
                {isCreating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                Generate share link
              </Button>
            )}
          </div>

          {/* Recipients */}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              People with access ({activeAccess.length})
            </div>
            {activeAccess.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nobody has joined yet.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {activeAccess.map((a) => {
                  const display = a.recipient_name || a.recipient_email || "Unknown user";
                  return (
                    <div key={a.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground truncate">{display}</p>
                        {a.recipient_email && a.recipient_name && (
                          <p className="text-[11px] text-muted-foreground truncate">{a.recipient_email}</p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 gap-1 text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                        onClick={() => handleRevokeAccess(a.id, display)}
                        disabled={isRevokingAccess}
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                        <span className="text-[11px]">Revoke</span>
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            {revokedAccess.length > 0 && (
              <p className="text-[11px] text-muted-foreground mt-2">
                {revokedAccess.length} previously revoked
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
