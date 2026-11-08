import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { ZONE_IDS } from "@/lib/workspace-presets";
import type { PanelId, ZoneId } from "@/lib/workspace-presets";

export const PANEL_TITLE_KEYS: Record<PanelId, string> = {
  tools: "panel.tools",
  scenes: "panel.scenes",
  timeline: "panel.timeline",
  side: "panel.side",
  history: "panel.history",
  view: "panel.view"
};

const menuItem = "rounded-none text-xs";

export default function PanelFrame({
  panel,
  compact = false,
  detached = false,
  children,
  onDetach,
  onReattach,
  onHide,
  onMove,
  onDragStart
}: {
  panel: PanelId;
  compact?: boolean;
  detached?: boolean;
  children: ReactNode;
  onDetach?: () => void;
  onReattach?: () => void;
  onHide?: () => void;
  onMove?: (zone: ZoneId) => void;
  onDragStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const title = t(PANEL_TITLE_KEYS[panel]);
  const menuLabel = `${title} ${t("panel.menu")}`;

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onDragStart || detached) {
      return;
    }
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }
    onDragStart(event);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        data-panel-handle={panel}
        onPointerDown={startDrag}
        className={cn(
          "flex shrink-0 items-center border-b border-border bg-muted/40",
          compact ? "h-6 justify-center" : "h-7 gap-1 px-2",
          onDragStart && !detached && "cursor-grab select-none"
        )}
      >
        {!compact && (
          <span className="min-w-0 flex-1 truncate text-[10px] uppercase tracking-wide text-muted-foreground">
            {title}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={menuLabel}
              title={menuLabel}
              className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44 rounded-none">
            {detached ? (
              <DropdownMenuItem className={menuItem} onSelect={() => onReattach?.()}>
                {t("panel.reattach")}
              </DropdownMenuItem>
            ) : (
              <>
                {onDetach && (
                  <DropdownMenuItem className={menuItem} onSelect={onDetach}>
                    {t("panel.detach")}
                  </DropdownMenuItem>
                )}
                {onHide && (
                  <DropdownMenuItem className={menuItem} onSelect={onHide}>
                    {t("panel.hide")}
                  </DropdownMenuItem>
                )}
                {onMove && (
                  <>
                    <DropdownMenuSeparator />
                    {ZONE_IDS.map((zone) => (
                      <DropdownMenuItem
                        key={zone}
                        className={menuItem}
                        onSelect={() => onMove(zone)}
                      >
                        {t(`panel.dock.${zone}`)}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          panel === "scenes" ? "overflow-visible" : "overflow-auto"
        )}
      >
        {children}
      </div>
    </div>
  );
}