import { LayoutDashboard, FileSearch, FolderOpen, Settings, LogOut, Zap, Link2 } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";

const navItems = [
  { title: "Deal Workspace", url: "/", icon: FileSearch, disabled: false },
  { title: "Kanban Pipeline", url: "/pipeline", icon: LayoutDashboard, disabled: false },
  { title: "Data Room", url: "/data-room", icon: FolderOpen, disabled: true },
  { title: "Intake", url: "/intake", icon: Link2, disabled: false },
  { title: "Settings", url: "/settings", icon: Settings, disabled: false },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const email = user?.email ?? "";
  const initial = email ? email[0].toUpperCase() : "?";

  const handleSignOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      toast.error("Sign out failed");
    } else {
      navigate("/login");
    }
  };

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarContent>
        <div className={`flex items-center gap-2 px-4 py-5 ${collapsed ? "justify-center" : ""}`}>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <Zap className="h-4 w-4 text-primary-foreground" />
          </div>
          {!collapsed && (
            <span className="text-base font-semibold text-foreground tracking-tight">EasyVC</span>
          )}
        </div>

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild={!item.disabled}>
                    {item.disabled ? (
                      <span className="flex items-center opacity-40 cursor-not-allowed">
                        <item.icon className="mr-2 h-4 w-4" />
                        {!collapsed && (
                          <>
                            <span>{item.title}</span>
                            <span className="ml-auto text-[9px] font-medium uppercase tracking-wider text-muted-foreground bg-muted rounded px-1 py-0.5">Soon</span>
                          </>
                        )}
                      </span>
                    ) : (
                      <NavLink
                        to={item.url}
                        end={item.url === "/"}
                        className="hover:bg-accent"
                        activeClassName="bg-accent text-foreground font-medium"
                      >
                        <item.icon className="mr-2 h-4 w-4" />
                        {!collapsed && <span>{item.title}</span>}
                      </NavLink>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-3">
        <div className={`flex items-center gap-3 ${collapsed ? "justify-center" : ""}`}>
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-medium text-accent-foreground shrink-0">
            {initial}
          </div>
          {!collapsed && (
            <div className="flex flex-1 items-center justify-between min-w-0">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{email}</p>
              </div>
              <button
                onClick={handleSignOut}
                title="Sign out"
                className="text-muted-foreground hover:text-destructive transition-colors shrink-0 ml-2"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
