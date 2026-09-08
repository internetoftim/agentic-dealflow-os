import { useState } from "react";
import { Users, Copy, Check, LogOut, UserMinus, Loader2 } from "lucide-react";
import { useTeam } from "@/hooks/useTeam";
import { useAuth } from "@/contexts/AuthContext";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

function InviteCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 rounded-[5px] border border-input bg-muted/50 px-3 py-2 text-sm font-mono text-muted-foreground select-all truncate">
        {code}
      </code>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 shrink-0"
        onClick={async () => {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        Copy
      </Button>
    </div>
  );
}

export function TeamSection() {
  const { user } = useAuth();
  const { team, members, isOwner, isLoading, createTeam, joinTeam, leaveTeam, removeMember } = useTeam();
  const [teamName, setTeamName] = useState("");
  const [inviteCode, setInviteCode] = useState("");

  return (
    <section className="mb-8">
      <h2 className="eyebrow mb-3 flex items-center gap-2">
        <Users className="h-4 w-4 text-muted-foreground" />
        Team
      </h2>
      <div className="rounded-md border border-border bg-card p-5 space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading team…
          </div>
        ) : team ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">{team.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {members.length} {members.length === 1 ? "member" : "members"} · deals created by
                  members are shared with the whole team
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground hover:text-destructive shrink-0"
                disabled={leaveTeam.isPending}
                onClick={() =>
                  toast.promise(leaveTeam.mutateAsync(), {
                    loading: "Leaving team…",
                    success: "Left the team. Your deals are back in your personal space.",
                    error: (e) => e.message,
                  })
                }
              >
                <LogOut className="h-3.5 w-3.5" /> Leave
              </Button>
            </div>

            <div>
              <p className="text-xs font-medium text-foreground mb-1.5">Invite code</p>
              <InviteCode code={team.invite_code} />
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Teammates join from Settings → Team → "Join a team". Their existing deals move into
                the shared dealflow.
              </p>
            </div>

            <div>
              <p className="text-xs font-medium text-foreground mb-1.5">Members</p>
              <div className="divide-y divide-border rounded-[5px] border border-border">
                {members.map((m) => (
                  <div key={m.user_id} className="flex items-center gap-2.5 px-3 py-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground shrink-0">
                      {(m.display_name || m.email || "?")[0]?.toUpperCase()}
                    </div>
                    <span className="text-sm text-foreground truncate flex-1">
                      {m.display_name || m.email || m.user_id.slice(0, 8)}
                      {m.user_id === user?.id && <span className="text-muted-foreground"> (you)</span>}
                    </span>
                    {m.role === "owner" && <span className="eyebrow text-[9px]">Owner</span>}
                    {isOwner && m.user_id !== user?.id && (
                      <button
                        title="Remove from team"
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        onClick={() =>
                          toast.promise(removeMember.mutateAsync(m.user_id), {
                            loading: "Removing…",
                            success: "Member removed. Their deals returned to their personal space.",
                            error: (e) => e.message,
                          })
                        }
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Teams share one dealflow: every deal a member ingests is visible to the whole team,
              with shared notes on each deal.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">Create a team</p>
                <Input
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="e.g. OnePointSix Capital"
                  maxLength={80}
                />
                <Button
                  size="sm"
                  disabled={teamName.trim().length < 2 || createTeam.isPending}
                  onClick={() =>
                    toast.promise(createTeam.mutateAsync(teamName.trim()), {
                      loading: "Creating team…",
                      success: (t) => `Team "${t.name}" created — share the invite code to add members.`,
                      error: (e) => e.message,
                    })
                  }
                >
                  {createTeam.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Create team
                </Button>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">Join a team</p>
                <Input
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="Paste an invite code"
                  maxLength={64}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={inviteCode.trim().length < 8 || joinTeam.isPending}
                  onClick={() =>
                    toast.promise(joinTeam.mutateAsync(inviteCode.trim()), {
                      loading: "Joining team…",
                      success: (t) => `Welcome to "${t.name}" — the shared dealflow is live.`,
                      error: (e) => e.message,
                    })
                  }
                >
                  {joinTeam.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Join team
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
