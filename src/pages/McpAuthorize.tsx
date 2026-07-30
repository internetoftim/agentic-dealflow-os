import { useEffect, useState } from "react";
import { useSearchParams, Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useAgentMode } from "@/hooks/useAgentMode";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Bot, ShieldCheck } from "lucide-react";

const MCP_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mcp-server`;

export default function McpAuthorize() {
  const { user, loading } = useAuth();
  const [params] = useSearchParams();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const codeChallengeMethod = params.get("code_challenge_method") ?? "S256";
  const state = params.get("state") ?? "";
  const scope = params.get("scope") ?? "mcp";
  const { agentMode } = useAgentMode();
  const [allowWrite, setAllowWrite] = useState(() =>
    scope.split(/\s+/).includes("mcp:write")
  );

  useEffect(() => {
    if (!loading && !user) {
      // Bounce through login, keeping the authorize URL as return target
      const back = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login?next=${back}`;
    }
  }, [user, loading]);

  if (loading) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (!user) return null;

  if (!clientId || !redirectUri || !codeChallenge) {
    return <div className="min-h-screen flex items-center justify-center p-6 text-sm text-destructive">Missing required OAuth parameters.</div>;
  }

  // Only include mcp:write when the user has Agent Mode on and opted in.
  // (The server strips it otherwise — this keeps the request honest.)
  const buildScope = () => {
    const base = scope.split(/\s+/).filter((s) => s && s !== "mcp:write");
    const scopes = agentMode && allowWrite ? [...base, "mcp:write"] : base;
    return scopes.join(" ") || "mcp";
  };

  const approve = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(`${MCP_BASE}/authorize/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          scope: buildScope(),
          state,
        }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.redirect) throw new Error(json.error ?? "Failed to authorize");
      window.location.href = json.redirect;
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  };

  const deny = () => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", "access_denied");
    if (state) url.searchParams.set("state", state);
    window.location.href = url.toString();
  };

  let host = "";
  try { host = new URL(redirectUri).host; } catch {}

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Bot className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Authorize AI agent</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          An AI agent is requesting access to your EasyVC workspace.
        </p>
        <div className="rounded-md border border-border bg-muted/30 p-3 mb-4 text-xs space-y-1">
          <div><span className="text-muted-foreground">Client:</span> <code>{clientId}</code></div>
          <div><span className="text-muted-foreground">Redirect:</span> <code className="break-all">{host || redirectUri}</code></div>
          <div><span className="text-muted-foreground">Scope:</span> <code>{scope}</code></div>
        </div>
        <div className="rounded-md border border-border bg-muted/30 p-3 mb-4 text-xs">
          <p className="font-medium text-foreground mb-1 flex items-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5" /> Permissions
          </p>
          <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
            <li>Read your deals, sources, and key people</li>
            <li>Search and retrieve extracted deck content</li>
            {agentMode && allowWrite && (
              <li className="text-foreground">Create, update &amp; delete deals, people, sources, notes &amp; memos</li>
            )}
          </ul>
          {agentMode ? (
            <label className="mt-2 flex items-start gap-2 cursor-pointer" data-testid="mcp-write-scope">
              <input
                type="checkbox"
                checked={allowWrite}
                onChange={(e) => setAllowWrite(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-muted-foreground">
                Allow this agent to <span className="font-medium text-foreground">make changes</span> on your behalf (write access). Leave unchecked for read-only.
              </span>
            </label>
          ) : (
            <p className="mt-2 text-muted-foreground">
              Read-only. Enable <span className="font-medium">Agent Mode</span> in Settings to let an agent make changes.
            </p>
          )}
        </div>
        {error && <p className="text-xs text-destructive mb-2">{error}</p>}
        <div className="flex gap-2">
          <button
            onClick={deny}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            Deny
          </button>
          <button
            onClick={approve}
            disabled={submitting}
            className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin inline" /> : "Authorize"}
          </button>
        </div>
      </div>
    </div>
  );
}
