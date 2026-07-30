import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Reads / writes the per-user `user_settings.agent_mode_enabled` flag.
 *
 * This is the first react-query hook over `user_settings`; SettingsPage still
 * writes that row imperatively, so we invalidate `["user-settings", user.id]`
 * after the toggle to keep the two coherent. (`as any` mirrors the codebase's
 * existing escape hatch for columns not yet in the generated Supabase types.)
 */
export function useAgentMode() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["user-settings", user?.id],
    queryFn: async () => {
      const { data, error } = await (supabase.from("user_settings" as any) as any)
        .select("agent_mode_enabled")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return (data as { agent_mode_enabled?: boolean } | null) ?? null;
    },
    enabled: !!user,
  });

  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!user) throw new Error("Not authenticated");
      const { error } = await (supabase.from("user_settings" as any) as any).upsert(
        { user_id: user.id, agent_mode_enabled: enabled },
        { onConflict: "user_id" }
      );
      if (error) throw error;
      return enabled;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-settings", user?.id] });
    },
  });

  return {
    agentMode: query.data?.agent_mode_enabled ?? false,
    isLoading: query.isLoading,
    setAgentMode: mutation.mutateAsync,
    isSaving: mutation.isPending,
  };
}
