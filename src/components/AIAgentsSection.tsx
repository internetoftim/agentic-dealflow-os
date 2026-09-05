import { useEffect, useState } from "react";
import { Bot, Copy, Plus, Trash2, Loader2, Check, PenLine, History } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type TokenRow = {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type ToolCallRow = {
  id: string;
  tool_name: string;
  deal_id: string | null;
  success: boolean;
  error_message: string | null;
  created_at: string;
};

const MCP_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mcp-server`;

const WRITE_TOOLS = [
  "create_deal",
  "update_deal",
  "upsert_deal_person",
  "delete_deal_person",
  "update_memo",
  "ingest_deck_link",
  "run_deep_research",
  "generate_memo",
  "cancel_deal_processing",
  "delete_deal",
  "share_deal",
  "revoke_deal_share",
  "update_workspace_settings",
];


function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function AIAgentsSection({ userId }: { userId?: string }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [savingMode, setSavingMode] = useState(false);
  const [calls, setCalls] = useState<ToolCallRow[]>([]);

  const refresh = async () => {
    if (!userId) return;
    setLoading(true);
    const [tokenRes, settingsRes, callsRes] = await Promise.all([
      supabase
        .from("mcp_access_tokens")
        .select("id, name, token_prefix, created_at, last_used_at, revoked_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("user_settings")
        .select("agent_mode_enabled")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("mcp_tool_calls")
        .select("id, tool_name, deal_id, success, error_message, created_at")
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    if (tokenRes.error) toast.error(tokenRes.error.message);
    setTokens((tokenRes.data ?? []) as TokenRow[]);
    setAgentMode(Boolean((settingsRes.data as any)?.agent_mode_enabled));
    setCalls((callsRes.data ?? []) as ToolCallRow[]);
    setLoading(false);
  };

  useEffect(() => { refresh(); }, [userId]);

  const toggleAgentMode = async (next: boolean) => {
    if (!userId) return;
    setSavingMode(true);
    setAgentMode(next);
    const { error } = await supabase
      .from("user_settings")
      .upsert({ user_id: userId, agent_mode_enabled: next } as any, { onConflict: "user_id" });
    setSavingMode(false);
    if (error) {
      setAgentMode(!next);
      toast.error(error.message);
      return;
    }
    toast.success(next ? "Agent Mode enabled — agents can now write" : "Agent Mode disabled — read-only");
  };


  const createToken = async () => {
    if (!newName.trim() || !userId) return;
    setCreating(true);
    try {
      // Generate random token client-side; only hash is stored
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const b64 = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
      const token = `pat_${b64}`;
      const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const hash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      const prefix = token.slice(0, 12);

      const { error } = await supabase.from("mcp_access_tokens").insert({
        user_id: userId, name: newName.trim(), token_hash: hash, token_prefix: prefix,
      });
      if (error) throw error;
      setFreshToken(token);
      setNewName("");
      await refresh();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to create token");
    } finally {
      setCreating(false);
    }
  };

  const revokeToken = async (id: string) => {
    const { error } = await supabase.from("mcp_access_tokens")
      .update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Token revoked");
    await refresh();
  };

  const claudeConfig = JSON.stringify({
    mcpServers: {
      easyvc: {
        url: MCP_URL,
        headers: { Authorization: `Bearer ${freshToken ?? "<your_pat_token>"}` },
      },
    },
  }, null, 2);

  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">AI Agents (MCP)</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-4 max-w-2xl">
        Let AI agents like Claude Desktop, Cursor, or ChatGPT call your EasyVC workspace.
        Generate a personal access token below and paste it into your agent's MCP config.
      </p>

      {/* Agent Mode */}
      <div className="rounded-md border border-border bg-card p-4 mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground mb-1 flex items-center gap-1">
              <PenLine className="h-3.5 w-3.5" /> Agent Mode (write access)
            </p>
            <p className="text-xs text-muted-foreground max-w-xl">
              Default mode is read-only. Turn this on to let your own agent write research back into
              EasyVC — create and update deals, founder profiles, and memo drafts. Every write is
              logged below.
            </p>
          </div>
          <button
            onClick={() => toggleAgentMode(!agentMode)}
            disabled={savingMode || !userId}
            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
              agentMode ? "bg-primary" : "bg-muted"
            }`}
            aria-label="Toggle Agent Mode"
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-card shadow-sm transition-transform ${
                agentMode ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {WRITE_TOOLS.map((t) => (
            <code
              key={t}
              className={`rounded px-1.5 py-0.5 text-[11px] border ${
                agentMode
                  ? "border-primary/30 bg-primary/5 text-foreground"
                  : "border-border bg-muted/40 text-muted-foreground line-through"
              }`}
            >
              {t}
            </code>
          ))}
        </div>
      </div>


      {/* Server URL */}
      <div className="rounded-md border border-border bg-muted/30 p-3 mb-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground mb-1">MCP Server URL</p>
            <code className="text-xs text-muted-foreground break-all">{MCP_URL}</code>
          </div>
          <CopyButton value={MCP_URL} />
        </div>
      </div>

      {/* Token creation */}
      <div className="rounded-md border border-border bg-card p-4 mb-4">
        <p className="text-xs font-medium text-foreground mb-2">Create a token</p>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="e.g. Claude Desktop"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={createToken}
            disabled={creating || !newName.trim()}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Generate
          </button>
        </div>

        {freshToken && (
          <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 p-3">
            <p className="text-xs font-medium text-foreground mb-1">
              Copy this token now — it won't be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-foreground break-all bg-background rounded px-2 py-1 border border-border">{freshToken}</code>
              <CopyButton value={freshToken} />
            </div>
          </div>
        )}
      </div>

      {/* Existing tokens */}
      <div className="rounded-md border border-border bg-card p-4 mb-4">
        <p className="text-xs font-medium text-foreground mb-3">Active tokens</p>
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tokens yet.</p>
        ) : (
          <ul className="space-y-2">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <p className="font-medium text-foreground truncate">
                    {t.name}{" "}
                    {t.revoked_at && <span className="text-destructive">(revoked)</span>}
                  </p>
                  <p className="text-muted-foreground">
                    {t.token_prefix}… · created {new Date(t.created_at).toLocaleDateString()}
                    {t.last_used_at && ` · last used ${new Date(t.last_used_at).toLocaleDateString()}`}
                  </p>
                </div>
                {!t.revoked_at && (
                  <button
                    onClick={() => revokeToken(t.id)}
                    className="text-muted-foreground hover:text-destructive"
                    title="Revoke"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Client configs */}
      <div className="rounded-md border border-border bg-card p-4">
        <p className="text-xs font-medium text-foreground mb-2">Claude Desktop / Cursor config</p>
        <p className="text-xs text-muted-foreground mb-2">
          Add this to <code>claude_desktop_config.json</code> or your MCP client of choice.
        </p>
        <div className="relative">
          <pre className="text-[11px] bg-muted/40 border border-border rounded p-3 overflow-x-auto">{claudeConfig}</pre>
          <div className="absolute top-2 right-2">
            <CopyButton value={claudeConfig} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Clients that support OAuth (Claude, ChatGPT) can also connect via one-click using the server URL above —
          no token needed.
        </p>
      </div>

      {/* Agent activity log */}
      <div className="rounded-md border border-border bg-card p-4 mt-4">
        <p className="text-xs font-medium text-foreground mb-3 flex items-center gap-1">
          <History className="h-3.5 w-3.5" /> Recent agent writes
        </p>
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : calls.length === 0 ? (
          <p className="text-xs text-muted-foreground">No agent writes yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {calls.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <code className="text-foreground">{c.tool_name}</code>
                  {c.deal_id && (
                    <span className="text-muted-foreground"> · deal {c.deal_id.slice(0, 8)}</span>
                  )}
                  {!c.success && c.error_message && (
                    <p className="text-destructive truncate">{c.error_message}</p>
                  )}
                </div>
                <span className="shrink-0 text-muted-foreground">
                  {c.success ? "ok" : "failed"} · {new Date(c.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

    </section>
  );
}
