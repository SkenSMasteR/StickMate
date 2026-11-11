import type { MockExtension } from "../backend";

let savePath: string | null = null;
let openPath: string | null = null;

export function reset(): void {
  savePath = null;
  openPath = null;
}

export function nextSavePath(path: string | null): void {
  savePath = path;
}

export function nextOpenPath(path: string | null): void {
  openPath = path;
}

export const handlers: MockExtension = () => ({
  "plugin:dialog|save": () => savePath,

  "plugin:dialog|open": () => openPath
});
