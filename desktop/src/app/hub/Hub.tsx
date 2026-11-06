import { useState } from "react";
import type { CSSProperties } from "react";
import {
  FolderOpen,
  LayoutTemplate,
  FilePlus2,
  Settings as SettingsIcon
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { useTheme } from "next-themes";
import { useWorkspace } from "@/editor/workspace";
import { useI18n } from "@/i18n";
import logoDark from "@/assets/logo-dark.png";
import logoLight from "@/assets/logo-light.png";
import Titlebar from "@/app/Titlebar";
import New from "./New";
import Projects from "./Projects";
import Templates from "./Templates";
import Settings from "./Settings";

type Destination = "new" | "projects" | "templates" | "settings";

const providerStyle = { "--sidebar-width": "18rem" } as CSSProperties;

export default function Hub({
  onSignInRequest,
  onOpenEditor
}: {
  onSignInRequest: () => void;
  onOpenEditor: () => void;
}) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const { ids } = useWorkspace();
  const [destination, setDestination] = useState<Destination>("new");

  const items: Array<{ id: Destination; label: string; icon: typeof FilePlus2 }> =
    [
      { id: "new", label: t("sidebar.new"), icon: FilePlus2 },
      { id: "projects", label: t("sidebar.projects"), icon: FolderOpen },
      { id: "templates", label: t("sidebar.templates"), icon: LayoutTemplate }
    ];

  const titles: Record<Destination, string> = {
    new: t("new.title"),
    projects: t("projects.title"),
    templates: t("templates.title"),
    settings: t("settings.title")
  };

  return (
    <SidebarProvider style={providerStyle} className="h-full min-h-0 flex-col">
      <Titlebar sidebar>
        {ids.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-2"
            onClick={onOpenEditor}
          >
            {t("editor.return")}
          </Button>
        )}
      </Titlebar>
      <div className="flex min-h-0 flex-1">
        <Sidebar
          variant="inset"
          collapsible="icon"
          className="inset-y-auto top-10 h-[calc(100svh-2.5rem)]"
        >
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" asChild>
                  <div className="flex items-center gap-2">
                    <img
                      src={resolvedTheme === "light" ? logoLight : logoDark}
                      alt=""
                      className="h-8 w-8 object-contain"
                      draggable={false}
                    />
                    <span className="text-sm font-semibold">
                      {t("app.name")}
                    </span>
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={destination === item.id}
                        tooltip={item.label}
                      >
                        <button
                          type="button"
                          onClick={() => setDestination(item.id)}
                        >
                          <item.icon />
                          <span>{item.label}</span>
                        </button>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={destination === "settings"}
                  tooltip={t("sidebar.settings")}
                >
                  <button
                    type="button"
                    onClick={() => setDestination("settings")}
                  >
                    <SettingsIcon />
                    <span>{t("sidebar.settings")}</span>
                  </button>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="-ml-1" />
              <h1 className="text-lg font-semibold">{titles[destination]}</h1>
            </div>
            {destination === "new" && <New onOpened={onOpenEditor} />}
            {destination === "projects" && <Projects onOpened={onOpenEditor} />}
            {destination === "templates" && (
              <Templates onOpened={onOpenEditor} />
            )}
            {destination === "settings" && (
              <Settings onSignInRequest={onSignInRequest} />
            )}
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
