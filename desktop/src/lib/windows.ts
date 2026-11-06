import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

const EDITOR_OPEN = "editor-open";

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