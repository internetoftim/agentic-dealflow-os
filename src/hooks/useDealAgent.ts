import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export type AgentAction = { tool: string; ok: boolean; summary: string; revisionId?: string | null; undone?: boolean };
export type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions?: AgentAction[];
  /** Server id of the logged turn; what a rating refers to. */
  turnId?: string | null;
  rating?: 1 | -1;
  error?: boolean;
};

const AGENT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/deal-agent`;
let seq = 0;
const localId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

async function callAgent(body: Record<string, unknown>) {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(AGENT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token ?? ""}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json?.error ?? json?.summary ?? `Request failed (${resp.status})`);
  return json;
}

/**
 * The deal agent: a conversation that changes the deal's data room through
 * server-side tools. Every reply lists what was actually changed; each change
 * can be undone, and each reply can be rated. All of it is logged server-side.
 */
export function useDealAgent(dealId?: string) {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const dealRef = useRef(dealId);

  // A conversation belongs to one deal.
  useEffect(() => {
    dealRef.current = dealId;
    setMessages([]);
    setIsWorking(false);
  }, [dealId]);

  const refreshDeal = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["deals"] });
    if (!dealId) return;
    for (const key of ["deal-people", "deal-notes", "sources", "deal-revisions"]) {
      queryClient.invalidateQueries({ queryKey: [key, dealId] });
    }
  }, [queryClient, dealId]);

  const send = useCallback(async (input: string) => {
    const text = input.trim();
    if (!text || !dealId || isWorking) return;
    const userMsg: AgentMessage = { id: localId(), role: "user", content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setIsWorking(true);
    try {
      const result = await callAgent({
        dealId,
        // Only the words go back to the model; action chips are UI state.
        messages: history.filter((m) => !m.error).map(({ role, content }) => ({ role, content })),
      });
      if (dealRef.current !== dealId) return;
      setMessages((prev) => [...prev, {
        id: localId(), role: "assistant", content: result.reply ?? "", actions: result.actions ?? [], turnId: result.turnId ?? null,
      }]);
      if (result.changed) refreshDeal();
    } catch (e) {
      if (dealRef.current !== dealId) return;
      setMessages((prev) => [...prev, { id: localId(), role: "assistant", content: e instanceof Error ? e.message : "Something went wrong", error: true }]);
    } finally {
      if (dealRef.current === dealId) setIsWorking(false);
    }
  }, [dealId, isWorking, messages, refreshDeal]);

  const undo = useCallback(async (revisionId: string) => {
    if (!dealId) return;
    const result = await callAgent({ dealId, undoRevisionId: revisionId });
    setMessages((prev) => prev.map((m) => ({
      ...m,
      actions: m.actions?.map((a) => (a.revisionId === revisionId ? { ...a, undone: true } : a)),
    })));
    refreshDeal();
    return result as { ok: boolean; summary: string };
  }, [dealId, refreshDeal]);

  const rate = useCallback(async (turnId: string, rating: 1 | -1, comment?: string) => {
    if (!dealId) return;
    // Optimistic: a rating is the user's statement, show it immediately.
    setMessages((prev) => prev.map((m) => (m.turnId === turnId ? { ...m, rating } : m)));
    await callAgent({ dealId, rateTurnId: turnId, rating, comment });
  }, [dealId]);

  return { messages, isWorking, send, undo, rate };
}

export type DealRevision = {
  id: string;
  version: number;
  actor: string;
  tool: string;
  summary: string;
  reverts: string | null;
  reverted_at: string | null;
  created_at: string;
};

/** The deal's change history, newest first (numbered revisions). */
export function useDealRevisions(dealId?: string, enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["deal-revisions", dealId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deal_revisions")
        .select("id, version, actor, tool, summary, reverts, reverted_at, created_at")
        .eq("deal_id", dealId!)
        .order("version", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as DealRevision[];
    },
    enabled: !!user && !!dealId && enabled,
  });
}
