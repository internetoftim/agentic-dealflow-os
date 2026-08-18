import { LayoutDashboard, FileSearch, FolderOpen, Settings, LogOut, Link2 } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { BrandWordmark } from "@/components/BrandMark";
import { useNavigate } from "react-router-dom";
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

const navGroups = [
  {
    label: "Deal flow",
    items: [
      { title: "Deal Workspace", url: "/", icon: FileSearch, disabled: false },
      { title: "Pipeline", url: "/pipeline", icon: LayoutDashboard, disabled: false },
      { title: "Data Room", url: "/data-room", icon: FolderOpen, disabled: true },
    ],
  },
  {
    label: "Firm",
    items: [
      { title: "Intake", url: "/intake", icon: Link2, disabled: false },
      { title: "Settings", url: "/settings", icon: Settings, disabled: false },
    ],
  },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
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
      <SidebarContent className="gap-0">
        <div
          className={`flex items-center px-3.5 h-14 border-b border-sidebar-border/70 ${
            collapsed ? "justify-center px-0" : ""
          }`}
        >
          <BrandWordmark collapsed={collapsed} />
        </div>

        <div className="flex flex-col gap-5 py-4">
          {navGroups.map((group) => (
            <SidebarGroup key={group.label} className="py-0">
              {!collapsed && (
                <div className="eyebrow px-3.5 pb-1.5">{group.label}</div>
              )}
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild={!item.disabled}
                        className="h-8 rounded-[5px] text-[13px] font-normal text-sidebar-foreground"
                      >
                        {item.disabled ? (
                          <span className="flex w-full items-center opacity-40 cursor-not-allowed">
                            <item.icon className="mr-2.5 h-[15px] w-[15px]" />
                            {!collapsed && (
                              <>
                                <span className="flex-1">{item.title}</span>
                                <span className="eyebrow text-[9px] shrink-0">Soon</span>
                              </>
                            )}
                          </span>
                        ) : (
                          <NavLink
                            to={item.url}
                            end={item.url === "/"}
                            className="relative before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[2px] before:-translate-y-1/2 before:rounded-full before:bg-transparent before:transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground font-medium before:bg-brand"
                          >
                            <item.icon className="mr-2.5 h-[15px] w-[15px]" />
                            {!collapsed && <span>{item.title}</span>}
                          </NavLink>
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </div>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border/70 p-2.5">
        <div className={`flex items-center gap-2.5 ${collapsed ? "justify-center" : ""}`}>
          <div className="flex h-7 w-7 items-center justify-center rounded-full border border-sidebar-border bg-sidebar-accent text-[11px] font-semibold text-sidebar-accent-foreground shrink-0">
            {initial}
          </div>
          {!collapsed && (
            <div className="flex flex-1 items-center justify-between min-w-0">
              <p className="text-xs text-sidebar-foreground truncate">{email}</p>
              <button
                onClick={handleSignOut}
                title="Sign out"
                aria-label="Sign out"
                className="text-muted-foreground hover:text-destructive transition-colors shrink-0 ml-2"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
