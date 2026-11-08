import type { MockExtension } from "../backend";
import { dockingState } from "./docking";

export const handlers: MockExtension = () => ({
  "plugin:window|get_all_windows": () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          metadata?: { currentWindow?: { label?: string } };
        };
      }
    ).__TAURI_INTERNALS__;
    const labels = ["splash", "main", "editor"];
    const current = internals.metadata?.currentWindow?.label;
    if (current) {
      labels.push(current);
    }
    for (const item of dockingState.created) {
      labels.push(item.label);
    }
    return [...new Set(labels)];
  }
});