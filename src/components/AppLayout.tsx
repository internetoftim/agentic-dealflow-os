import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { useAgentMode } from "@/hooks/useAgentMode";
import { Bot } from "lucide-react";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { agentMode } = useAgentMode();
  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-12 flex items-center border-b border-border px-4 shrink-0">
            <SidebarTrigger />
            {agentMode && (
              <span
                data-testid="agent-mode-badge"
                title="Agent Mode is on — AI agents with your token can make changes"
                className="ml-auto inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
              >
                <Bot className="h-3 w-3" /> Agent Mode
              </span>
            )}
          </header>
          <main className="flex-1 overflow-auto">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
