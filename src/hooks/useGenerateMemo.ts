import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function useGenerateMemo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (dealId: string) => {
      const { data, error } = await supabase.functions.invoke("generate-memo", {
        body: { dealId },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data as { success: boolean; memoLength: number; driveFileId: string | null; driveFileName: string | null };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
    },
  });
}
