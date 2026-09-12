import { useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAiModelSetting, useLocalLlm } from "@/contexts/LocalLlmContext";
import { buildDealContext, toTurns } from "@/lib/localContext";
import { DEFAULT_LOCAL_MODEL_ID } from "@/lib/localModels";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export function useDealChat(dealId?: string, sourceIds?: string[]) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "Upload a deck to get started. I'll analyze it and extract key data points automatically." },
  ]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { resolve: resolveAiModel } = useAiModelSetting();
  const localLlm = useLocalLlm();

  const send = useCallback(async (input: string) => {
    if (!input.trim() || isStreaming) return;

    const userMsg: ChatMessage = { role: "user", content: input };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setIsStreaming(true);

    let assistantSoFar = "";

    // Local (in-browser) path: same grounding, no network round-trip.
    const { isLocal, localModelId } = await resolveAiModel();
    if (isLocal) {
      try {
        await localLlm.ensureLoaded(localModelId ?? DEFAULT_LOCAL_MODEL_ID);
        const { system } = dealId ? await buildDealContext(dealId, sourceIds) : { system: "You are an investment analyst assistant." };
        const history = updatedMessages.filter((m, i) => !(i === 0 && m.role === "assistant"));
        await localLlm.chat(toTurns(system, history), {
          onToken: (token) => {
            assistantSoFar += token;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && prev[prev.length - 2]?.role === "user") {
                return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: assistantSoFar } : m));
              }
              return [...prev, { role: "assistant", content: assistantSoFar }];
            });
          },
          onComplete: () => {},
        });
      } catch (e: any) {
        setMessages((prev) => [...prev, { role: "assistant", content: `Local model error: ${e.message}` }]);
      } finally {
        setIsStreaming(false);
      }
      return;
    }

    try {
      abortRef.current = new AbortController();

      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/deal-chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({
            messages: updatedMessages.map(({ role, content }) => ({ role, content })),
            dealId,
            // NotebookLM-style scoping: when set, only these sources ground the answer.
            sourceIds: sourceIds && sourceIds.length > 0 ? sourceIds : undefined,
          }),
          signal: abortRef.current.signal,
        }
      );

      if (!resp.ok || !resp.body) {
        const err = await resp.text();
        throw new Error(err || "Failed to start stream");
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) {
              assistantSoFar += content;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant" && prev.length > 1 && prev[prev.length - 2]?.role === "user") {
                  return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: assistantSoFar } : m));
                }
                return [...prev, { role: "assistant", content: assistantSoFar }];
              });
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        console.error("Chat error:", e);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${e.message}` },
        ]);
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [messages, isStreaming, dealId, sourceIds, resolveAiModel, localLlm]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    localLlm.interrupt();
  }, [localLlm]);

  return { messages, isStreaming, send, stop };
}
