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
  SidebarSeparator,
  SidebarTrigger
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage
} from "@/components/ui/breadcrumb";
import { useI18n } from "@/i18n";
import logoDark from "@/assets/logo-dark.png";
import New from "./New";
import Projects from "./Projects";
import Templates from "./Templates";
import Settings from "./Settings";

type Destination = "new" | "projects" | "templates" | "settings";

const providerStyle = { "--sidebar-width": "18rem" } as CSSProperties;

export default function Hub({
  onSignInRequest
}: {
  onSignInRequest: () => void;
}) {
  const { t } = useI18n();
  const [destination, setDestination] = useState<Destination>("new");

  const items: Array<{ id: Destination; label: string; icon: typeof FilePlus2 }> =
    [
      { id: "new", label: t("sidebar.new"), icon: FilePlus2 },
      { id: "projects", label: t("sidebar.projects"), icon: FolderOpen },
      { id: "templates", label: t("sidebar.templates"), icon: LayoutTemplate }
    ];

  const titles: Record<Destination, string> = {
    new: t("sidebar.new"),
    projects: t("sidebar.projects"),
    templates: t("sidebar.templates"),
    settings: t("sidebar.settings")
  };

  return (
    <SidebarProvider style={providerStyle}>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <div className="flex items-center gap-2">
                  <img
                    src={logoDark}
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
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage>{titles[destination]}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>
        <SidebarSeparator className="mx-0" />
        <div className="flex flex-1 flex-col gap-4 overflow-hidden p-4">
          {destination === "new" && <New />}
          {destination === "projects" && <Projects />}
          {destination === "templates" && <Templates />}
          {destination === "settings" && (
            <Settings onSignInRequest={onSignInRequest} />
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
