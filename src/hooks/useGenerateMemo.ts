import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAiModelSetting, useLocalLlm } from "@/contexts/LocalLlmContext";
import { buildDealContext } from "@/lib/localContext";
import { DEFAULT_LOCAL_MODEL_ID } from "@/lib/localModels";
import { DEFAULT_MEMO_PROMPT } from "@/lib/memoPrompt";

export function useGenerateMemo() {
  const queryClient = useQueryClient();
  const { resolve: resolveAiModel } = useAiModelSetting();
  const localLlm = useLocalLlm();

  return useMutation({
    mutationFn: async (dealId: string) => {
      const { isLocal, localModelId, memoPrompt } = await resolveAiModel();
      if (isLocal) {
        // In-browser memo: the deal's materials never leave the device. Drive sync
        // still happens through the cloud path if the user runs it there.
        await localLlm.ensureLoaded(localModelId ?? DEFAULT_LOCAL_MODEL_ID);
        const { system, dealName } = await buildDealContext(dealId, undefined, 40_000);
        const result = await localLlm.generate([
          { role: "system", content: system },
          { role: "user", content: `${memoPrompt || DEFAULT_MEMO_PROMPT}\n\nWrite the investment memo for ${dealName} in Markdown.` },
        ]);
        if (!result.text.trim()) throw new Error("The local model returned an empty memo");
        const { error } = await supabase.from("deals")
          .update({ memo_draft: result.text.trim(), updated_at: new Date().toISOString() }).eq("id", dealId);
        if (error) throw error;
        return { success: true, memoLength: result.text.length, driveFileId: null, driveFileName: null, local: true };
      }
      const { data, error } = await supabase.functions.invoke("generate-memo", { body: { dealId } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data as { success: boolean; memoLength: number; driveFileId: string | null; driveFileName: string | null; local?: boolean };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
    },
  });
}
