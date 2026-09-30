import { useEffect, useState } from "react";
import { Bot, Copy, Plus, Trash2, Loader2, Check, PenLine, History, ExternalLink, Plug, Unplug, Terminal } from "lucide-react";
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

type Connection = {
  client_id: string;
  client_name: string;
  redirect_host: string;
  first_connected_at: string;
  last_issued_at: string;
};

// One-click install links for clients that support them. The rest get a
// copy-the-URL + open-the-settings-page flow; the OAuth consent then happens
// on /mcp/authorize in this app.
const CURSOR_DEEPLINK = `cursor://anysphere.cursor-deeplink/mcp/install?name=easyvc&config=${btoa(JSON.stringify({ url: MCP_URL }))}`;
const VSCODE_DEEPLINK = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "easyvc", type: "http", url: MCP_URL }))}`;
const CLAUDE_CODE_CMD = `claude mcp add --transport http easyvc ${MCP_URL}`;
const CODEX_CMD = `codex mcp add easyvc --url ${MCP_URL} && codex mcp login easyvc`;

type AgentCard = {
  id: string;
  name: string;
  tagline: string;
  steps: string[];
  action: { kind: "link"; label: string; href: string } | { kind: "command"; label: string; command: string };
};

const AGENT_CARDS: AgentCard[] = [
  {
    id: "claude",
    name: "Claude",
    tagline: "claude.ai, Claude Desktop, Cowork",
    steps: [
      "Copy the server URL above.",
      "Open Claude → Settings → Connectors → Add custom connector.",
      "Name it EasyVC, paste the URL, leave client id/secret empty, then Connect.",
      "You'll land back here to approve access.",
    ],
    action: { kind: "link", label: "Open Claude connectors", href: "https://claude.ai/settings/connectors" },
  },
  {
    id: "codex",
    name: "Codex",
    tagline: "Codex app and ChatGPT",
    steps: [
      "Copy the server URL above.",
      "Open Settings → Connectors → Add / Create, paste the URL, choose OAuth.",
      "Click Connect and approve access on the EasyVC page that opens.",
    ],
    action: { kind: "link", label: "Open ChatGPT connectors", href: "https://chatgpt.com/#settings/Connectors" },
  },
  {
    id: "claude-code",
    name: "Claude Code",
    tagline: "Terminal",
    steps: ["Run the command, then in Claude Code type /mcp → easyvc → Authenticate."],
    action: { kind: "command", label: "Copy command", command: CLAUDE_CODE_CMD },
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    tagline: "Terminal",
    steps: ["Run the command; a browser tab opens for you to approve access."],
    action: { kind: "command", label: "Copy command", command: CODEX_CMD },
  },
  {
    id: "cursor",
    name: "Cursor",
    tagline: "One click",
    steps: ["Cursor opens and asks to install the EasyVC server, then prompts you to sign in."],
    action: { kind: "link", label: "Add to Cursor", href: CURSOR_DEEPLINK },
  },
  {
    id: "vscode",
    name: "VS Code",
    tagline: "One click",
    steps: ["VS Code opens and asks to add the EasyVC server, then prompts you to sign in."],
    action: { kind: "link", label: "Add to VS Code", href: VSCODE_DEEPLINK },
  },
];

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

function CommandButton({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <pre className="text-[11px] bg-muted/40 border border-border rounded p-2 overflow-x-auto mb-2 whitespace-pre-wrap break-all">{command}</pre>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="inline-flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 w-full"
      >
        {copied ? <Check className="h-3 w-3" /> : <Terminal className="h-3 w-3" />}
        {copied ? "Copied" : label}
      </button>
    </div>
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
  const [connections, setConnections] = useState<Connection[]>([]);
  const [revoking, setRevoking] = useState<string | null>(null);

  const authHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return { Authorization: `Bearer ${session?.access_token ?? ""}` };
  };

  const loadConnections = async () => {
    try {
      const resp = await fetch(`${MCP_URL}/connections`, { headers: await authHeaders() });
      if (!resp.ok) return;
      const json = await resp.json();
      setConnections(json.connections ?? []);
    } catch {
      /* the list is informational; stay quiet on network errors */
    }
  };

  const disconnect = async (clientId: string) => {
    setRevoking(clientId);
    try {
      const resp = await fetch(`${MCP_URL}/connections/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({ client_id: clientId }),
      });
      if (!resp.ok) throw new Error("Failed to disconnect");
      toast.success("Agent disconnected — it will need to sign in again");
      await loadConnections();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setRevoking(null);
    }
  };

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
    loadConnections();
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
        Connect Claude, Codex, or any MCP client to your EasyVC workspace. Agents sign in with
        your EasyVC account and start read-only; turn on Agent Mode below to let them write.
      </p>

      {/* Server URL */}
      <div className="rounded-md border border-border bg-muted/30 p-3 mb-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground mb-1">MCP server URL</p>
            <code className="text-xs text-muted-foreground break-all">{MCP_URL}</code>
          </div>
          <CopyButton value={MCP_URL} />
        </div>
      </div>

      {/* Connect an agent */}
      <div className="rounded-md border border-border bg-card p-4 mb-4">
        <p className="text-xs font-medium text-foreground mb-3 flex items-center gap-1">
          <Plug className="h-3.5 w-3.5" /> Connect an agent
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {AGENT_CARDS.map((card) => (
            <div key={card.id} className="rounded-md border border-border bg-background p-3 flex flex-col">
              <div className="mb-2">
                <p className="text-xs font-semibold text-foreground">{card.name}</p>
                <p className="text-[11px] text-muted-foreground">{card.tagline}</p>
              </div>
              <ol className="text-[11px] text-muted-foreground space-y-1 mb-3 list-decimal pl-4 flex-1">
                {card.steps.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
              {card.action.kind === "link" ? (
                <a
                  href={card.action.href}
                  target={card.action.href.startsWith("http") ? "_blank" : undefined}
                  rel="noreferrer"
                  className="inline-flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                >
                  {card.action.label} <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <CommandButton label={card.action.label} command={card.action.command} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Connected agents */}
      <div className="rounded-md border border-border bg-card p-4 mb-4">
        <p className="text-xs font-medium text-foreground mb-3">Connected agents</p>
        {connections.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No agents have signed in yet. Once you connect one above, it appears here and you can disconnect it any time.
          </p>
        ) : (
          <ul className="space-y-2">
            {connections.map((c) => (
              <li key={c.client_id} className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <p className="font-medium text-foreground truncate">{c.client_name}</p>
                  <p className="text-muted-foreground truncate">
                    {c.redirect_host && `${c.redirect_host} · `}
                    connected {new Date(c.first_connected_at).toLocaleDateString()}
                    {c.last_issued_at !== c.first_connected_at && ` · last sign-in ${new Date(c.last_issued_at).toLocaleDateString()}`}
                  </p>
                </div>
                <button
                  onClick={() => disconnect(c.client_id)}
                  disabled={revoking === c.client_id}
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-destructive disabled:opacity-50"
                  title="Disconnect"
                >
                  {revoking === c.client_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />}
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

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


      {/* Token creation */}
      <div className="rounded-md border border-border bg-card p-4 mb-4">
        <p className="text-xs font-medium text-foreground mb-1">Personal access token</p>
        <p className="text-xs text-muted-foreground mb-2">
          For clients without OAuth sign-in (scripts, older MCP clients). Sends as a Bearer header.
        </p>
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
        <p className="text-xs font-medium text-foreground mb-2">Manual config (token-based)</p>
        <p className="text-xs text-muted-foreground mb-2">
          For MCP clients configured by JSON file. Generate a token above and paste this in.
        </p>
        <div className="relative">
          <pre className="text-[11px] bg-muted/40 border border-border rounded p-3 overflow-x-auto">{claudeConfig}</pre>
          <div className="absolute top-2 right-2">
            <CopyButton value={claudeConfig} />
          </div>
        </div>
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
