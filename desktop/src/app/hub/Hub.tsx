import { useState } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider
} from "@/components/ui/sidebar";
import { useI18n } from "@/i18n";
import Blank from "./Blank";
import Projects from "./Projects";
import Templates from "./Templates";
import Settings from "./Settings";

type Destination = "blank" | "projects" | "templates" | "settings";

export default function Hub({
  onSignInRequest
}: {
  onSignInRequest: () => void;
}) {
  const { t } = useI18n();
  const [destination, setDestination] = useState<Destination>("blank");

  const items: Array<{ id: Destination; label: string }> = [
    { id: "blank", label: t("sidebar.blank") },
    { id: "projects", label: t("sidebar.projects") },
    { id: "templates", label: t("sidebar.templates") }
  ];

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <span className="text-sm font-semibold">{t("app.name")}</span>
        </SidebarHeader>
        <SidebarContent>
          <SidebarMenu>
            {items.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  active={destination === item.id}
                  onClick={() => setDestination(item.id)}
                >
                  {item.label}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                active={destination === "settings"}
                onClick={() => setDestination("settings")}
              >
                {t("sidebar.settings")}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <div className="h-full overflow-hidden border border-[hsl(var(--border))] bg-[hsl(var(--background))]">
          {destination === "blank" && <Blank />}
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
