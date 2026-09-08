import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface Team {
  id: string;
  name: string;
  owner_id: string;
  invite_code: string;
  created_at: string;
}

export interface TeamMember {
  user_id: string;
  role: string;
  joined_at: string;
  email: string | null;
  display_name: string | null;
}

export function useTeam() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const teamQuery = useQuery({
    queryKey: ["team", user?.id],
    queryFn: async (): Promise<Team | null> => {
      const { data: membership, error } = await supabase
        .from("team_members")
        .select("team_id")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      if (!membership) return null;
      const { data: team, error: e2 } = await supabase
        .from("teams")
        .select("*")
        .eq("id", membership.team_id)
        .maybeSingle();
      if (e2) throw e2;
      return (team ?? null) as Team | null;
    },
    enabled: !!user,
  });

  const membersQuery = useQuery({
    queryKey: ["team-roster", teamQuery.data?.id],
    queryFn: async (): Promise<TeamMember[]> => {
      const { data, error } = await supabase.rpc("get_team_roster");
      if (error) throw error;
      return (data ?? []) as TeamMember[];
    },
    enabled: !!user && !!teamQuery.data,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["team"] });
    queryClient.invalidateQueries({ queryKey: ["team-roster"] });
    queryClient.invalidateQueries({ queryKey: ["deals"] });
  };

  const createTeam = useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await supabase.rpc("create_team", { _name: name });
      if (error) throw error;
      return data as unknown as Team;
    },
    onSuccess: invalidate,
  });

  const joinTeam = useMutation({
    mutationFn: async (inviteCode: string) => {
      const { data, error } = await supabase.rpc("join_team", { _invite_code: inviteCode });
      if (error) throw error;
      return data as unknown as Team;
    },
    onSuccess: invalidate,
  });

  const leaveTeam = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("leave_team");
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const removeMember = useMutation({
    mutationFn: async (memberUserId: string) => {
      const { error } = await supabase.rpc("remove_team_member", { _member_user_id: memberUserId });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const team = teamQuery.data ?? null;
  const members = membersQuery.data ?? [];

  return {
    team,
    members,
    isOwner: !!user && !!team && team.owner_id === user.id,
    isLoading: teamQuery.isLoading,
    createTeam,
    joinTeam,
    leaveTeam,
    removeMember,
    /** Map of user_id → short display label, for attributing team deals/notes. */
    memberLabel: (userId: string): string | null => {
      const m = members.find((x) => x.user_id === userId);
      if (!m) return null;
      return m.display_name || m.email?.split("@")[0] || null;
    },
  };
}
