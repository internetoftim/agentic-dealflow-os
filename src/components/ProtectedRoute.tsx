import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { RefreshCw } from "lucide-react";

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
  return <>{children}</>;
}
