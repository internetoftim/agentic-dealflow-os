import { useAgentMode } from "@/hooks/useAgentMode";
import NotFound from "@/pages/NotFound";

/**
 * Gate for agent-only routes: renders {children} only when Agent Mode is on.
 * While the flag is loading it shows a spinner; when off it renders NotFound
 * (a 404), so the agent deep-link surface is invisible unless opted in.
 */
export function AgentRoute({ children }: { children: React.ReactNode }) {
  const { agentMode, isLoading } = useAgentMode();
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin-slow h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }
  if (!agentMode) return <NotFound />;
  return <>{children}</>;
}
