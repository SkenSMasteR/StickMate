import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  availableMonitors,
  PhysicalPosition,
  PhysicalSize
} from "@tauri-apps/api/window";
import { clampRect, PANEL_IDS } from "@/lib/workspace-presets";
import type {
  MonitorRect,
  PanelDocPayload,
  PanelId,
  WindowRect
} from "@/lib/workspace-presets";

const EDITOR_OPEN = "editor-open";
const PANEL_DOC = "panel-doc";
const PANEL_CHANGED = "panel-changed";
const PANEL_CLOSED = "panel-closed";
const PANEL_READY = "panel-ready";
const PANEL_PREFIX = "panel-";

export async function showEditor(docId?: string): Promise<void> {
  const win = await WebviewWindow.getByLabel("editor");
  if (!win) {
    return;
  }
  if (docId) {
    await emit(EDITOR_OPEN, docId);
  }
  await win.show();
  await win.setFocus();
  const main = await WebviewWindow.getByLabel("main");
  if (main) {
    await main.hide();
  }
}

export async function showHub(): Promise<void> {
  const editor = await WebviewWindow.getByLabel("editor");
  if (editor) {
    await editor.hide();
  }
  const hub = await WebviewWindow.getByLabel("main");
  if (hub) {
    await hub.show();
    await hub.setFocus();
  }
}

export function onEditorOpen(callback: (id: string) => void): Promise<UnlistenFn> {
  return listen<string>(EDITOR_OPEN, (event) => callback(event.payload));
}

export function panelWindowLabel(panel: PanelId): string {
  return `${PANEL_PREFIX}${panel}`;
}

export function panelFromLabel(label: string): PanelId | null {
  if (!label.startsWith(PANEL_PREFIX)) {
    return null;
  }
  const id = label.slice(PANEL_PREFIX.length);
  return (PANEL_IDS as string[]).includes(id) ? (id as PanelId) : null;
}

interface MonitorInfo {
  rect: MonitorRect;
  scale: number;
}

async function monitorInfos(): Promise<MonitorInfo[]> {
  try {
    const monitors = await availableMonitors();
    return monitors.map((monitor) => ({
      rect: {
        x: monitor.workArea.position.x,
        y: monitor.workArea.position.y,
        width: monitor.workArea.size.width,
        height: monitor.workArea.size.height
      },
      scale: monitor.scaleFactor || 1
    }));
  } catch {
    return [];
  }
}

function scaleFor(infos: MonitorInfo[], rect: WindowRect): number {
  const found = infos.find(
    (info) =>
      rect.x >= info.rect.x &&
      rect.x < info.rect.x + info.rect.width &&
      rect.y >= info.rect.y &&
      rect.y < info.rect.y + info.rect.height
  );
  return found?.scale ?? infos[0]?.scale ?? 1;
}

export async function openPanelWindow(
  panel: PanelId,
  rect?: WindowRect
): Promise<boolean> {
  const label = panelWindowLabel(panel);
  try {
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.show();
      await existing.setFocus();
      return true;
    }
    const infos = await monitorInfos();
    const bounds = clampRect(
      rect ?? { x: 120, y: 120, width: 420, height: 520 },
      infos.map((info) => info.rect)
    );
    const scale = scaleFor(infos, bounds);
    const win = new WebviewWindow(label, {
      url: "/",
      decorations: false,
      minWidth: 240,
      minHeight: 160,
      width: Math.round(bounds.width / scale),
      height: Math.round(bounds.height / scale),
      x: Math.round(bounds.x / scale),
      y: Math.round(bounds.y / scale)
    });
    return await new Promise<boolean>((resolve) => {
      void win.once("tauri://created", () => resolve(true));
      void win.once("tauri://error", () => resolve(false));
    });
  } catch {
    return false;
  }
}

export async function setPanelWindowRect(
  panel: PanelId,
  rect: WindowRect
): Promise<void> {
  try {
    const win = await WebviewWindow.getByLabel(panelWindowLabel(panel));
    if (!win) {
      return;
    }
    const infos = await monitorInfos();
    const bounds = clampRect(rect, infos.map((info) => info.rect));
    await win.setPosition(new PhysicalPosition(bounds.x, bounds.y));
    await win.setSize(new PhysicalSize(bounds.width, bounds.height));
  } catch {
    return;
  }
}

export async function panelWindowBounds(
  panel: PanelId
): Promise<WindowRect | null> {
  try {
    const win = await WebviewWindow.getByLabel(panelWindowLabel(panel));
    if (!win) {
      return null;
    }
    const position = await win.outerPosition();
    const size = await win.outerSize();
    return { x: position.x, y: position.y, width: size.width, height: size.height };
  } catch {
    return null;
  }
}

export async function destroyPanelWindow(panel: PanelId): Promise<void> {
  try {
    const win = await WebviewWindow.getByLabel(panelWindowLabel(panel));
    if (win) {
      await win.destroy();
    }
  } catch {
    return;
  }
}

export function emitPanelDoc(id: string, doc: PanelDocPayload["doc"]): Promise<void> {
  return emit(PANEL_DOC, { id, doc });
}

export function emitPanelChanged(id: string, doc: PanelDocPayload["doc"]): Promise<void> {
  return emit(PANEL_CHANGED, { id, doc });
}

export function emitPanelClosed(panel: PanelId): Promise<void> {
  return emit(PANEL_CLOSED, panel);
}

export function emitPanelReady(panel: PanelId): Promise<void> {
  return emit(PANEL_READY, panel);
}

export function onPanelDoc(
  callback: (payload: PanelDocPayload) => void
): Promise<UnlistenFn> {
  return listen<PanelDocPayload>(PANEL_DOC, (event) => callback(event.payload));
}

export function onPanelChanged(
  callback: (payload: PanelDocPayload) => void
): Promise<UnlistenFn> {
  return listen<PanelDocPayload>(PANEL_CHANGED, (event) => callback(event.payload));
}

export function onPanelClosed(callback: (panel: PanelId) => void): Promise<UnlistenFn> {
  return listen<PanelId>(PANEL_CLOSED, (event) => callback(event.payload));
}

export function onPanelReady(callback: (panel: PanelId) => void): Promise<UnlistenFn> {
  return listen<PanelId>(PANEL_READY, (event) => callback(event.payload));
}