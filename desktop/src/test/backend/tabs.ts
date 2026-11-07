import type { MockExtension } from "../backend";

export const handlers: MockExtension = () => ({
  "plugin:window|get_all_windows": () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          metadata?: { currentWindow?: { label?: string } };
        };
      }
    ).__TAURI_INTERNALS__;
    const label = internals.metadata?.currentWindow?.label;
    return label ? [label] : [];
  }
});