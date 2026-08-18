import { useLocation } from "react-router-dom";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { ThemeToggle } from "@/components/ThemeToggle";

const PAGE_TITLES: Record<string, string> = {
  "/": "Deal Workspace",
  "/pipeline": "Pipeline",
  "/data-room": "Data Room",
  "/intake": "Intake",
  "/settings": "Settings",
};

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const title = PAGE_TITLES[pathname];

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-14 flex items-center gap-3 border-b border-border bg-card px-4 shrink-0">
            <SidebarTrigger className="h-7 w-7 text-muted-foreground hover:text-foreground" />
            <div className="h-4 w-px bg-border" aria-hidden="true" />
            {title && (
              <h1 className="text-[13px] font-medium tracking-tight text-foreground">{title}</h1>
            )}
            <div className="ml-auto flex items-center gap-1">
              <ThemeToggle />
            </div>
          </header>
          <main className="flex-1 overflow-auto">{children}</main>
        </div>
      </div>
    </SidebarProvider>
  );
}
