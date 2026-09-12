import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { RefreshCw, Clock } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, bootTimedOut } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin-slow h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  // The session lookup hung (typically another tab holds the auth lock while
  // the backend is busy). Don't bounce to /login — the user is probably
  // signed in — give them a one-click retry instead.
  if (!user && bootTimedOut) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6">
        <div className="max-w-sm text-center">
          <p className="text-[15px] font-semibold text-foreground">Still connecting…</p>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            Another tab may be busy with a long-running job. This usually clears in a few seconds.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex items-center gap-1.5 rounded-[5px] bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground hover:opacity-90"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return <ApprovalGate userId={user.id}>{children}</ApprovalGate>;
}

/**
 * The login page promises "invite-only, admin approval". This makes it true:
 * a profile row is created for every sign-up (DB trigger) and only approved
 * profiles reach the app. Absent/failed lookups fail open for existing users
 * (they were all backfilled as approved) so an outage never locks people out.
 */
function ApprovalGate({ userId, children }: { userId: string; children: React.ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ["approval", userId],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("approval_status").eq("user_id", userId).maybeSingle();
      return (data?.approval_status ?? "approved") as "pending" | "approved" | "rejected";
    },
    staleTime: 60_000,
  });
  if (isLoading) return null;
  if (data === "approved") return <>{children}</>;
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-sm text-center">
        <Clock className="h-5 w-5 mx-auto text-brand" />
        <p className="mt-3 text-[15px] font-semibold text-foreground">
          {data === "rejected" ? "This account isn't approved" : "Your account is awaiting approval"}
        </p>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          {data === "rejected"
            ? "Access to this workspace was not granted. Contact the workspace owner if you think that's a mistake."
            : "EasyVC is invite-only. You'll get access as soon as an admin approves your account — usually within a day."}
        </p>
        <button
          onClick={() => supabase.auth.signOut().then(() => window.location.assign("/login"))}
          className="mt-4 text-[12.5px] text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
