import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { toast } from "sonner";
import { useI18n } from "@/i18n";
import { useConfirm } from "@/lib/confirm";
import { usePrefs } from "@/lib/prefs";
import {
  cloneLayout,
  defaultLayout,
  detachLayout,
  movePanel,
  reattachLayout,
  setPanelVisible,
  SIZE_LIMITS,
  visiblePanels,
  ZONE_IDS
} from "@/lib/workspace-presets";
import type { DockLayout, PanelId, ZoneId } from "@/lib/workspace-presets";
import {
  destroyPanelWindow,
  emitPanelDoc,
  onPanelChanged,
  onPanelClosed,
  onPanelReady,
  openPanelWindow,
  setPanelWindowRect
} from "@/lib/windows";
import Canvas from "./Canvas";
import CommandPalette from "./CommandPalette";
import { DockProvider, DockZone } from "./DockLayout";
import type { PanelFocus } from "./DockLayout";
import ExportDialog from "./ExportDialog";
import FileMenu from "./FileMenu";
import HistoryPanel from "./HistoryPanel";
import ReportPanel from "./ReportPanel";
import ScenesBar from "./ScenesBar";
import ShortcutsDialog from "./ShortcutsDialog";
import SidePanel from "./SidePanel";
import Timeline from "./Timeline";
import ToolsPanel from "./ToolsPanel";
import ViewPanel from "./ViewPanel";
import WorkspacePresetsDialog, { WorkspaceMenu } from "./WorkspacePresetsDialog";
import { buildCommands, useCommandKeys } from "./commands";
import { useAnimateExchange } from "./animate-exchange";
import { useWorkspace } from "./workspace";

interface Resize {
  side: "left" | "right" | "bottom";
  start: number;
  size: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export default function Editor() {
  const { doc, tab, docs, ids, activeId, scene, layer, frame, total, open, activate, close, actions } =
    useWorkspace();
  const { t } = useI18n();
  const { prefs, update } = usePrefs();
  const confirm = useConfirm();
  const [layout, setLayout] = useState<DockLayout>(() => cloneLayout(defaultLayout));
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteCommand, setPaletteCommand] = useState<string | null>(null);
  const [reportFocus, setReportFocus] = useState<PanelFocus | null>(null);
  const resizeRef = useRef<Resize | null>(null);
  const origins = useRef(new Map<PanelId, { zone: ZoneId; index: number }>());
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const lastSent = useRef(new Map<string, string>());

  const openPalette = useCallback((commandId?: string) => {
    setPaletteCommand(commandId ?? null);
    setPaletteOpen(true);
  }, []);

  const revealReport = useCallback(() => {
    setLayout((prev) => setPanelVisible(prev, "report", true));
    setReportFocus((prev) => ({ panel: "report", token: (prev?.token ?? 0) + 1 }));
  }, []);

  const { importFlow, exportFlow } = useAnimateExchange({
    activeId,
    name: doc?.name ?? null,
    open,
    reveal: revealReport
  });

  const commands = buildCommands(
    actions,
    t,
    prefs.shortcuts,
    () => setShortcutsOpen(true),
    () => setExportOpen(true),
    {
      state: { doc, scene, layer, tab, frame, total, ids, docs, activeId },
      openPalette,
      confirm,
      activate,
      close,
      importAnimate: () => void importFlow(),
      exportAnimate: () => void exportFlow()
    }
  );

  useCommandKeys(
    commands,
    Boolean(doc && tab) &&
      !shortcutsOpen &&
      !exportOpen &&
      !presetsOpen &&
      !paletteOpen
  );

  const detach = useCallback(
    (panel: PanelId) => {
      const current = layoutRef.current;
      for (const zone of ZONE_IDS) {
        const index = current.zones[zone].indexOf(panel);
        if (index >= 0) {
          origins.current.set(panel, { zone, index });
        }
      }
      void openPanelWindow(panel, current.windows[panel]).then((ok) => {
        if (!ok) {
          toast.error(t("workspace.detachFailed"));
          return;
        }
        setLayout((prev) => detachLayout(prev, panel));
      });
    },
    [t]
  );

  const reattach = useCallback((panel: PanelId) => {
    const origin = origins.current.get(panel);
    origins.current.delete(panel);
    setLayout((prev) => reattachLayout(prev, panel, origin?.zone, origin?.index));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onPanelClosed((panel) => reattach(panel)).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reattach]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onPanelChanged(({ id, doc: incoming }) => {
      if (!idsRef.current.includes(id)) {
        return;
      }
      if (JSON.stringify(docsRef.current[id]) === JSON.stringify(incoming)) {
        return;
      }
      const previous = activeIdRef.current;
      if (id === previous) {
        void open(id);
        return;
      }
      void open(id).then(() => {
        if (previous) {
          activate(previous);
        }
      });
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open, activate]);

  useEffect(() => {
    if (!doc || !activeId) {
      return;
    }
    const json = JSON.stringify(doc);
    if (lastSent.current.get(activeId) === json) {
      return;
    }
    lastSent.current.set(activeId, json);
    void emitPanelDoc(activeId, doc);
  }, [doc, activeId]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onPanelReady(() => {
      const id = activeIdRef.current;
      const current = id ? docsRef.current[id] : null;
      if (id && current) {
        void emitPanelDoc(id, current);
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const move = useCallback((panel: PanelId, zone: ZoneId) => {
    setLayout((prev) => movePanel(prev, panel, zone));
  }, []);

  const hide = useCallback((panel: PanelId) => {
    setLayout((prev) => setPanelVisible(prev, panel, false));
  }, []);

  const togglePanel = useCallback((panel: PanelId, visible: boolean) => {
    setLayout((prev) => setPanelVisible(prev, panel, visible));
  }, []);

  const applyLayout = useCallback(
    (next: DockLayout) => {
      void (async () => {
        let target = cloneLayout(next);
        const current = layoutRef.current;
        for (const panel of current.detached) {
          if (!target.detached.includes(panel)) {
            void destroyPanelWindow(panel);
          }
        }
        for (const panel of target.detached) {
          const rect = target.windows[panel];
          if (!current.detached.includes(panel)) {
            const ok = await openPanelWindow(panel, rect);
            if (!ok) {
              toast.error(t("workspace.detachFailed"));
              target = reattachLayout(target, panel);
            }
          } else if (rect) {
            await setPanelWindowRect(panel, rect);
          }
        }
        setLayout(target);
      })();
    },
    [t]
  );

  const resetLayout = useCallback(() => {
    void confirm({
      title: t("workspace.resetTitle"),
      confirmLabel: t("workspace.reset"),
      cancelLabel: t("editor.cancel"),
      destructive: true
    }).then((accepted) => {
      if (!accepted) {
        return;
      }
      for (const panel of layoutRef.current.detached) {
        void destroyPanelWindow(panel);
      }
      setLayout(cloneLayout(defaultLayout));
    });
  }, [confirm, t]);

  const beginResize = (
    side: "left" | "right" | "bottom",
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    resizeRef.current = {
      side,
      start: side === "bottom" ? event.clientY : event.clientX,
      size: layout.sizes[side]
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize) {
      return;
    }
    const delta =
      (resize.side === "bottom" ? event.clientY : event.clientX) - resize.start;
    const [low, high] = SIZE_LIMITS[resize.side];
    const value = resize.side === "left" ? resize.size + delta : resize.size - delta;
    setLayout((prev) => ({
      ...prev,
      sizes: { ...prev.sizes, [resize.side]: clamp(value, low, high) }
    }));
  };

  const endResize = () => {
    resizeRef.current = null;
  };

  if (!doc || !tab) {
    return null;
  }

  const renderPanel = (panel: PanelId): ReactNode => {
    if (panel === "tools") {
      return (
        <div className="flex min-h-0 flex-1">
          <ToolsPanel
            onShortcuts={() => setShortcutsOpen(true)}
            onExport={() => setExportOpen(true)}
            onPalette={() => openPalette()}
          />
        </div>
      );
    }
    if (panel === "scenes") {
      return <ScenesBar />;
    }
    if (panel === "timeline") {
      return <Timeline />;
    }
    if (panel === "history") {
      return <HistoryPanel />;
    }
    if (panel === "view") {
      return <ViewPanel />;
    }
    if (panel === "report") {
      return <ReportPanel />;
    }
    return <SidePanel />;
  };

  const leftVisible = visiblePanels(layout, "left").length > 0;
  const rightVisible = visiblePanels(layout, "right").length > 0;
  const bottomVisible = visiblePanels(layout, "bottom").length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <DockProvider
        layout={layout}
        focus={reportFocus}
        onChange={setLayout}
        onDetach={detach}
        onHide={hide}
        onMove={move}
      >
        <div className="flex shrink-0 items-stretch">
          <FileMenu commands={commands} />
          <div className="min-w-0 flex-1">
            <DockZone zone="top" render={renderPanel} />
          </div>
          <WorkspaceMenu
            layout={layout}
            onApply={applyLayout}
            onManage={() => setPresetsOpen(true)}
            onTogglePanel={togglePanel}
            onReset={resetLayout}
          />
        </div>
        <div className="flex min-h-0 flex-1">
          {leftVisible && (
            <div className="flex shrink-0" style={{ width: layout.sizes.left }}>
              <DockZone zone="left" render={renderPanel} className="flex-1" />
            </div>
          )}
          {leftVisible && (
            <div
              data-resize="left"
              onPointerDown={(event) => beginResize("left", event)}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-ring"
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <Canvas />
            {bottomVisible && (
              <div
                data-resize="bottom"
                onPointerDown={(event) => beginResize("bottom", event)}
                onPointerMove={moveResize}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                className="h-1 shrink-0 cursor-row-resize bg-border hover:bg-ring"
              />
            )}
            {bottomVisible && (
              <div
                className="flex shrink-0 flex-col"
                style={{ height: layout.sizes.bottom }}
              >
                <DockZone zone="bottom" render={renderPanel} className="flex-1" />
              </div>
            )}
          </div>
          {rightVisible && (
            <div
              data-resize="right"
              onPointerDown={(event) => beginResize("right", event)}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-ring"
            />
          )}
          {rightVisible && (
            <div className="flex shrink-0" style={{ width: layout.sizes.right }}>
              <DockZone
                zone="right"
                render={renderPanel}
                className="flex-1 border-l border-border bg-background"
              />
            </div>
          )}
        </div>
      </DockProvider>
      <ShortcutsDialog
        open={shortcutsOpen}
        commands={commands}
        overrides={prefs.shortcuts}
        onChange={(next) => void update({ shortcuts: next })}
        onClose={() => setShortcutsOpen(false)}
      />
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        initialCommand={paletteCommand}
        onClose={() => {
          setPaletteOpen(false);
          setPaletteCommand(null);
        }}
      />
      <WorkspacePresetsDialog
        open={presetsOpen}
        onClose={() => setPresetsOpen(false)}
        layout={layout}
        onApply={applyLayout}
      />
    </div>
  );
}