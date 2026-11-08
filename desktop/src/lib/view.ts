export type ViewPrefs = {
  grid: boolean;
  gridSize: number;
  rulers: boolean;
  safeAreas: boolean;
  checkerboard: boolean;
  backdrop: string;
  onionMode: "ghost" | "trace";
  onionOpacity: number;
};

export const defaultView: ViewPrefs = {
  grid: false,
  gridSize: 50,
  rulers: false,
  safeAreas: false,
  checkerboard: false,
  backdrop: "#1f2430",
  onionMode: "ghost",
  onionOpacity: 0.25
};

export const VIEW_KEYS: (keyof ViewPrefs)[] = [
  "grid",
  "gridSize",
  "rulers",
  "safeAreas",
  "checkerboard",
  "backdrop",
  "onionMode",
  "onionOpacity"
];

const COLOR = /^#[0-9a-fA-F]{6}$/;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function sanitizeView(raw: unknown): ViewPrefs {
  const input = (raw ?? {}) as Record<string, unknown>;
  return {
    grid: typeof input.grid === "boolean" ? input.grid : defaultView.grid,
    gridSize:
      typeof input.gridSize === "number" && Number.isFinite(input.gridSize)
        ? clamp(Math.round(input.gridSize), 4, 400)
        : defaultView.gridSize,
    rulers: typeof input.rulers === "boolean" ? input.rulers : defaultView.rulers,
    safeAreas:
      typeof input.safeAreas === "boolean" ? input.safeAreas : defaultView.safeAreas,
    checkerboard:
      typeof input.checkerboard === "boolean"
        ? input.checkerboard
        : defaultView.checkerboard,
    backdrop:
      typeof input.backdrop === "string" && COLOR.test(input.backdrop)
        ? input.backdrop.toLowerCase()
        : defaultView.backdrop,
    onionMode: input.onionMode === "trace" ? "trace" : "ghost",
    onionOpacity:
      typeof input.onionOpacity === "number" && Number.isFinite(input.onionOpacity)
        ? clamp(input.onionOpacity, 0.05, 1)
        : defaultView.onionOpacity
  };
}

export function mergeView(
  ours: ViewPrefs,
  theirs: ViewPrefs,
  base: ViewPrefs
): { data: ViewPrefs; contested: boolean } {
  const merged: ViewPrefs = { ...ours };
  let contested = false;
  for (const key of VIEW_KEYS) {
    const a = ours[key];
    const b = theirs[key];
    if (a === b) {
      continue;
    }
    if (a === base[key]) {
      (merged as Record<string, unknown>)[key] = b;
    } else if (b !== base[key]) {
      contested = true;
    }
  }
  return { data: merged, contested };
}
