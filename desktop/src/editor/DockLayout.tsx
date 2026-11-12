import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { movePanel, visiblePanels, ZONE_IDS } from "@/lib/workspace-presets";
import type { DockLayout, PanelId, ZoneId } from "@/lib/workspace-presets";
import PanelFrame, { PANEL_TITLE_KEYS } from "./PanelFrame";

interface DropTarget {
  zone: ZoneId;
  index: number | null;
}

interface DockValue {
  layout: DockLayout;
  drag: PanelId | null;
  dropTarget: DropTarget | null;
  beginDrag: (panel: PanelId, event: ReactPointerEvent) => void;
  hover: (target: DropTarget) => void;
  activeIn: (zone: ZoneId) => PanelId | null;
  setActive: (zone: ZoneId, panel: PanelId) => void;
  onDetach: (panel: PanelId) => void;
  onHide: (panel: PanelId) => void;
  onMove: (panel: PanelId, zone: ZoneId) => void;
}

const DockContext = createContext<DockValue | null>(null);

export interface PanelFocus {
  panel: PanelId;
  token: number;
}

export function DockProvider({
  layout,
  focus,
  onChange,
  onDetach,
  onHide,
  onMove,
  children
}: {
  layout: DockLayout;
  focus: PanelFocus | null;
  onChange: (next: DockLayout) => void;
  onDetach: (panel: PanelId) => void;
  onHide: (panel: PanelId) => void;
  onMove: (panel: PanelId, zone: ZoneId) => void;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState<PanelId | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [active, setActiveState] = useState<Record<ZoneId, PanelId | null>>({
    left: null,
    top: null,
    bottom: null,
    right: null
  });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const dragRef = useRef<PanelId | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  const previousZones = useRef(layout.zones);
  const [focused, setFocused] = useState<number | null>(null);

  if (focus && focus.token !== focused) {
    setFocused(focus.token);
    const zone = ZONE_IDS.find((id) => layout.zones[id].includes(focus.panel));
    if (zone) {
      setActiveState((current) => ({ ...current, [zone]: focus.panel }));
    }
  }

  useEffect(() => {
    const previous = previousZones.current;
    previousZones.current = layout.zones;
    const entered: Partial<Record<ZoneId, PanelId>> = {};
    for (const zone of ZONE_IDS) {
      const added = layout.zones[zone].find((id) => !previous[zone].includes(id));
      if (added) {
        entered[zone] = added;
      }
    }
    if (Object.keys(entered).length > 0) {
      setActiveState((current) => ({ ...current, ...entered }));
    }
  }, [layout.zones]);

  const beginDrag = useCallback((panel: PanelId, event: ReactPointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragRef.current = panel;
    dropRef.current = null;
    setDrag(panel);
    setDropTarget(null);
  }, []);

  const hover = useCallback((target: DropTarget) => {
    const current = dropRef.current;
    if (current && current.zone === target.zone && current.index === target.index) {
      return;
    }
    dropRef.current = target;
    setDropTarget(target);
  }, []);

  useEffect(() => {
    if (!drag) {
      return;
    }
    const clear = () => {
      dragRef.current = null;
      dropRef.current = null;
      setDrag(null);
      setDropTarget(null);
    };
    const onUp = () => {
      const panel = dragRef.current;
      const target = dropRef.current;
      clear();
      if (panel && target) {
        onChange(movePanel(layoutRef.current, panel, target.zone, target.index));
      }
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", clear);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", clear);
    };
  }, [drag, onChange]);

  const setActive = useCallback((zone: ZoneId, panel: PanelId) => {
    setActiveState((current) => ({ ...current, [zone]: panel }));
  }, []);

  const activeIn = useCallback(
    (zone: ZoneId): PanelId | null => {
      const visible = visiblePanels(layout, zone);
      const chosen = active[zone];
      return chosen && visible.includes(chosen) ? chosen : visible[0] ?? null;
    },
    [active, layout]
  );

  return (
    <DockContext.Provider
      value={{
        layout,
        drag,
        dropTarget,
        beginDrag,
        hover,
        activeIn,
        setActive,
        onDetach,
        onHide,
        onMove
      }}
    >
      {children}
    </DockContext.Provider>
  );
}

export function useDock(): DockValue {
  const context = useContext(DockContext);
  if (!context) {
    throw new Error("useDock must be used inside DockProvider");
  }
  return context;
}

export function DockZone({
  zone,
  render,
  className
}: {
  zone: ZoneId;
  render: (panel: PanelId) => ReactNode;
  className?: string;
}) {
  const dock = useDock();
  const { t } = useI18n();
  const visible = visiblePanels(dock.layout, zone);
  if (visible.length === 0) {
    return null;
  }
  const active = dock.activeIn(zone) ?? visible[0];
  const targeted = dock.drag !== null && dock.dropTarget?.zone === zone;

  return (
    <div
      data-zone={zone}
      onPointerEnter={() => {
        if (dock.drag !== null) {
          dock.hover({ zone, index: null });
        }
      }}
      onPointerMove={(event) => {
        if (dock.drag !== null) {
          event.stopPropagation();
          dock.hover({ zone, index: null });
        }
      }}
      className={cn(
        "flex min-h-0 min-w-0 flex-col",
        targeted && "bg-accent/40 outline outline-1 -outline-offset-1 outline-ring",
        className
      )}
    >
      {visible.length > 1 && (
        <div
          role="tablist"
          className="flex shrink-0 items-stretch border-b border-border bg-muted/40"
        >
          {visible.map((id, index) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={id === active}
              data-panel-tab={id}
              onClick={() => dock.setActive(zone, id)}
              onPointerDown={(event) => {
                event.stopPropagation();
                dock.beginDrag(id, event);
              }}
              onPointerMove={(event) => {
                if (dock.drag !== null) {
                  event.stopPropagation();
                  dock.hover({ zone, index });
                }
              }}
              className={cn(
                "h-7 cursor-grab select-none border-r border-border px-2 text-xs",
                id === active
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              {t(PANEL_TITLE_KEYS[id])}
            </button>
          ))}
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PanelFrame
          key={active}
          panel={active}
          compact={active === "tools"}
          onDragStart={(event) => dock.beginDrag(active, event)}
          onDetach={() => dock.onDetach(active)}
          onHide={() => dock.onHide(active)}
          onMove={(target) => dock.onMove(active, target)}
        >
          {render(active)}
        </PanelFrame>
      </div>
    </div>
  );
}