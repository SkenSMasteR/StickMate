import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Titlebar from "@/app/Titlebar";
import { useI18n } from "@/i18n";
import { useConfirm } from "@/lib/confirm";
import { usePrefs } from "@/lib/prefs";
import {
  emitPanelChanged,
  emitPanelClosed,
  emitPanelReady,
  onPanelDoc,
  panelFromLabel
} from "@/lib/windows";
import CommandPalette from "./CommandPalette";
import { buildCommands, useCommandKeys } from "./commands";
import ExportDialog from "./ExportDialog";
import HistoryPanel from "./HistoryPanel";
import PanelFrame, { PANEL_TITLE_KEYS } from "./PanelFrame";
import ScenesBar from "./ScenesBar";
import ShortcutsDialog from "./ShortcutsDialog";
import SidePanel from "./SidePanel";
import Timeline from "./Timeline";
import ToolsPanel from "./ToolsPanel";
import ViewPanel from "./ViewPanel";
import { useWorkspace } from "./workspace";

export default function DetachedPanel() {
  const { t } = useI18n();
  const { prefs, update } = usePrefs();
  const confirm = useConfirm();
  const {
    doc,
    docs,
    ids,
    activeId,
    scene,
    layer,
    tab,
    frame,
    total,
    open,
    activate,
    close,
    actions
  } = useWorkspace();
  const [panel] = useState(() => panelFromLabel(getCurrentWindow().label));
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteCommand, setPaletteCommand] = useState<string | null>(null);
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const lastSent = useRef<string | null>(null);

  const openPalette = useCallback((commandId?: string) => {
    setPaletteCommand(commandId ?? null);
    setPaletteOpen(true);
  }, []);

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
      close
    }
  );

  useCommandKeys(
    commands,
    Boolean(panel && activeId) &&
      !shortcutsOpen &&
      !exportOpen &&
      !paletteOpen
  );

  useEffect(() => {
    if (panel) {
      void getCurrentWindow().setTitle(t(PANEL_TITLE_KEYS[panel]));
    }
  }, [panel, t]);

  useEffect(() => {
    if (!panel) {
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onPanelDoc(({ id, doc }) => {
      if (JSON.stringify(docsRef.current[id]) === JSON.stringify(doc)) {
        return;
      }
      void open(id);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
        void emitPanelReady(panel);
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [panel, open]);

  useEffect(() => {
    if (!panel || !activeId) {
      return;
    }
    const doc = docs[activeId];
    if (!doc) {
      return;
    }
    const json = JSON.stringify(doc);
    if (lastSent.current === json) {
      return;
    }
    lastSent.current = json;
    void emitPanelChanged(activeId, doc);
  }, [docs, activeId, panel]);

  useEffect(() => {
    if (!panel) {
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        void emitPanelClosed(panel).then(() => getCurrentWindow().destroy());
      })
      .then((fn) => {
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
  }, [panel]);

  if (!panel) {
    return null;
  }

  const reattach = () => {
    void emitPanelClosed(panel).then(() => getCurrentWindow().destroy());
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <Titlebar>
        <span className="px-1 text-sm font-semibold">
          {t(PANEL_TITLE_KEYS[panel])}
        </span>
      </Titlebar>
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelFrame
          panel={panel}
          compact={panel === "tools"}
          detached
          onReattach={reattach}
        >
          {panel === "tools" && (
            <div className="flex min-h-0 flex-1">
              <ToolsPanel
                onShortcuts={() => setShortcutsOpen(true)}
                onExport={() => setExportOpen(true)}
                onPalette={() => openPalette()}
              />
            </div>
          )}
          {panel === "scenes" && <ScenesBar />}
          {panel === "timeline" && <Timeline />}
          {panel === "side" && <SidePanel />}
          {panel === "history" && <HistoryPanel />}
          {panel === "view" && <ViewPanel />}
        </PanelFrame>
      </div>
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
    </div>
  );
}