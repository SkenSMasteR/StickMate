import type { Document } from "@/lib/document";

export type PanelId = "tools" | "scenes" | "timeline" | "side" | "history" | "view";
export type ZoneId = "left" | "top" | "bottom" | "right";

export const PANEL_IDS: PanelId[] = ["tools", "scenes", "timeline", "side", "history", "view"];
export const ZONE_IDS: ZoneId[] = ["left", "top", "bottom", "right"];

export const WORKSPACE_ICONS = [
  "layout",
  "film",
  "layers",
  "pencil",
  "monitor",
  "grid",
  "star",
  "frame"
] as const;

export type WorkspaceIcon = (typeof WORKSPACE_ICONS)[number];

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DockLayout {
  zones: Record<ZoneId, PanelId[]>;
  sizes: { left: number; right: number; bottom: number };
  hidden: PanelId[];
  detached: PanelId[];
  windows: Partial<Record<PanelId, WindowRect>>;
}

export interface WorkspacePreset {
  id: string;
  name: string;
  icon: WorkspaceIcon;
  layout: DockLayout;
}

export const SIZE_LIMITS: Record<"left" | "right" | "bottom", [number, number]> = {
  left: [40, 480],
  right: [220, 480],
  bottom: [120, 520]
};

export const WINDOW_LIMITS = {
  width: [240, 8192] as [number, number],
  height: [160, 8192] as [number, number],
  offset: 100000
};

export const MAX_PRESET_BYTES = 65536;

export const defaultLayout: DockLayout = {
  zones: {
    left: ["tools"],
    top: ["scenes"],
    bottom: ["timeline"],
    right: ["side", "history", "view"]
  },
  sizes: { left: 40, right: 264, bottom: 220 },
  hidden: ["history"],
  detached: [],
  windows: {}
};

export function homeZone(panel: PanelId): ZoneId {
  if (panel === "tools") {
    return "left";
  }
  if (panel === "scenes") {
    return "top";
  }
  if (panel === "timeline") {
    return "bottom";
  }
  return "right";
}

export function cloneLayout(layout: DockLayout): DockLayout {
  return {
    zones: {
      left: [...layout.zones.left],
      top: [...layout.zones.top],
      bottom: [...layout.zones.bottom],
      right: [...layout.zones.right]
    },
    sizes: { ...layout.sizes },
    hidden: [...layout.hidden],
    detached: [...layout.detached],
    windows: Object.fromEntries(
      Object.entries(layout.windows).map(([key, value]) => [key, { ...value }])
    ) as Partial<Record<PanelId, WindowRect>>
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function visiblePanels(layout: DockLayout, zone: ZoneId): PanelId[] {
  return layout.zones[zone].filter((id) => !layout.hidden.includes(id));
}

export function movePanel(
  layout: DockLayout,
  panel: PanelId,
  zone: ZoneId,
  index?: number | null
): DockLayout {
  const next = cloneLayout(layout);
  for (const id of ZONE_IDS) {
    next.zones[id] = next.zones[id].filter((item) => item !== panel);
  }
  const target = next.zones[zone];
  const at =
    index === undefined || index === null
      ? target.length
      : clamp(Math.trunc(index), 0, target.length);
  target.splice(at, 0, panel);
  if (zone === "left" && panel !== "tools" && next.sizes.left < SIZE_LIMITS.right[0]) {
    next.sizes.left = 264;
  }
  return next;
}

export function setPanelVisible(
  layout: DockLayout,
  panel: PanelId,
  visible: boolean
): DockLayout {
  const next = cloneLayout(layout);
  next.hidden = visible
    ? next.hidden.filter((id) => id !== panel)
    : next.hidden.includes(panel)
      ? next.hidden
      : [...next.hidden, panel];
  return next;
}

export function detachLayout(layout: DockLayout, panel: PanelId): DockLayout {
  const next = movePanel(layout, panel, homeZone(panel));
  for (const id of ZONE_IDS) {
    next.zones[id] = next.zones[id].filter((item) => item !== panel);
  }
  if (!next.detached.includes(panel)) {
    next.detached.push(panel);
  }
  return next;
}

export function reattachLayout(
  layout: DockLayout,
  panel: PanelId,
  zone?: ZoneId,
  index?: number | null
): DockLayout {
  const next = cloneLayout(layout);
  next.detached = next.detached.filter((id) => id !== panel);
  delete next.windows[panel];
  const target = zone ?? homeZone(panel);
  return movePanel(next, panel, target, index);
}

export function clampRect(rect: WindowRect, monitors: MonitorRect[]): WindowRect {
  const width = clamp(rect.width, WINDOW_LIMITS.width[0], WINDOW_LIMITS.width[1]);
  const height = clamp(rect.height, WINDOW_LIMITS.height[0], WINDOW_LIMITS.height[1]);
  if (monitors.length === 0) {
    return { x: rect.x, y: rect.y, width, height };
  }
  const centerX = rect.x + width / 2;
  const centerY = rect.y + height / 2;
  const monitor =
    monitors.find(
      (item) =>
        centerX >= item.x &&
        centerX <= item.x + item.width &&
        centerY >= item.y &&
        centerY <= item.y + item.height
    ) ??
    monitors.find(
      (item) =>
        rect.x >= item.x &&
        rect.x <= item.x + item.width &&
        rect.y >= item.y &&
        rect.y <= item.y + item.height
    ) ??
    monitors[0];
  const fittedWidth = Math.min(width, monitor.width);
  const fittedHeight = Math.min(height, monitor.height);
  return {
    x: clamp(rect.x, monitor.x, monitor.x + monitor.width - fittedWidth),
    y: clamp(rect.y, monitor.y, monitor.y + monitor.height - fittedHeight),
    width: fittedWidth,
    height: fittedHeight
  };
}

export function newPresetId(): string {
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export type LayoutResult =
  | { ok: true; layout: DockLayout }
  | { ok: false; error: string; detail: string };

function isPanel(value: unknown): value is PanelId {
  return typeof value === "string" && (PANEL_IDS as string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateLayout(raw: unknown): LayoutResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "workspace.error.layout", detail: "" };
  }
  const input = raw as Record<string, unknown>;
  const zonesRaw = input.zones;
  if (typeof zonesRaw !== "object" || zonesRaw === null || Array.isArray(zonesRaw)) {
    return { ok: false, error: "workspace.error.layout", detail: "zones" };
  }
  const zonesInput = zonesRaw as Record<string, unknown>;
  const zones: Record<ZoneId, PanelId[]> = { left: [], top: [], bottom: [], right: [] };
  const seen = new Set<PanelId>();
  for (const zone of ZONE_IDS) {
    const list = zonesInput[zone];
    if (!Array.isArray(list)) {
      return { ok: false, error: "workspace.error.layout", detail: zone };
    }
    for (const item of list) {
      if (!isPanel(item)) {
        return { ok: false, error: "workspace.error.panel", detail: String(item) };
      }
      if (seen.has(item)) {
        return { ok: false, error: "workspace.error.panel", detail: item };
      }
      seen.add(item);
      zones[zone].push(item);
    }
  }
  const detachedRaw = input.detached;
  if (!Array.isArray(detachedRaw)) {
    return { ok: false, error: "workspace.error.layout", detail: "detached" };
  }
  const detached: PanelId[] = [];
  for (const item of detachedRaw) {
    if (!isPanel(item)) {
      return { ok: false, error: "workspace.error.panel", detail: String(item) };
    }
    if (seen.has(item)) {
      return { ok: false, error: "workspace.error.panel", detail: item };
    }
    seen.add(item);
    detached.push(item);
  }
  if (seen.size !== PANEL_IDS.length) {
    return { ok: false, error: "workspace.error.layout", detail: "panels" };
  }
  const hiddenRaw = input.hidden;
  if (!Array.isArray(hiddenRaw)) {
    return { ok: false, error: "workspace.error.layout", detail: "hidden" };
  }
  const hidden: PanelId[] = [];
  for (const item of hiddenRaw) {
    if (!isPanel(item)) {
      return { ok: false, error: "workspace.error.panel", detail: String(item) };
    }
    if (hidden.includes(item)) {
      return { ok: false, error: "workspace.error.panel", detail: item };
    }
    hidden.push(item);
  }
  const sizesRaw = input.sizes;
  if (typeof sizesRaw !== "object" || sizesRaw === null || Array.isArray(sizesRaw)) {
    return { ok: false, error: "workspace.error.layout", detail: "sizes" };
  }
  const sizesInput = sizesRaw as Record<string, unknown>;
  const sizes = { left: 0, right: 0, bottom: 0 };
  for (const key of ["left", "right", "bottom"] as const) {
    const value = sizesInput[key];
    const [low, high] = SIZE_LIMITS[key];
    if (!isFiniteNumber(value) || value < low || value > high) {
      return { ok: false, error: "workspace.error.range", detail: key };
    }
    sizes[key] = value;
  }
  const windowsRaw = input.windows;
  if (typeof windowsRaw !== "object" || windowsRaw === null || Array.isArray(windowsRaw)) {
    return { ok: false, error: "workspace.error.layout", detail: "windows" };
  }
  const windows: Partial<Record<PanelId, WindowRect>> = {};
  for (const [key, value] of Object.entries(windowsRaw as Record<string, unknown>)) {
    if (!isPanel(key) || !detached.includes(key)) {
      return { ok: false, error: "workspace.error.panel", detail: key };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: "workspace.error.window", detail: key };
    }
    const rect = value as Record<string, unknown>;
    if (
      !isFiniteNumber(rect.x) ||
      !isFiniteNumber(rect.y) ||
      Math.abs(rect.x) > WINDOW_LIMITS.offset ||
      Math.abs(rect.y) > WINDOW_LIMITS.offset ||
      !isFiniteNumber(rect.width) ||
      rect.width < WINDOW_LIMITS.width[0] ||
      rect.width > WINDOW_LIMITS.width[1] ||
      !isFiniteNumber(rect.height) ||
      rect.height < WINDOW_LIMITS.height[0] ||
      rect.height > WINDOW_LIMITS.height[1]
    ) {
      return { ok: false, error: "workspace.error.window", detail: key };
    }
    windows[key] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  return { ok: true, layout: { zones, sizes, hidden, detached, windows } };
}

export type PresetFileResult =
  | { ok: true; name: string; icon: WorkspaceIcon; layout: DockLayout }
  | { ok: false; error: string; detail: string };

export function parsePresetFile(text: string): PresetFileResult {
  if (text.length > MAX_PRESET_BYTES) {
    return { ok: false, error: "workspace.error.size", detail: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "workspace.error.file", detail: "" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "workspace.error.file", detail: "" };
  }
  const file = parsed as Record<string, unknown>;
  if (file.version !== 1) {
    return { ok: false, error: "workspace.error.file", detail: "" };
  }
  if (typeof file.name !== "string" || file.name.trim() === "" || file.name.length > 60) {
    return { ok: false, error: "workspace.error.name", detail: "" };
  }
  if (
    typeof file.icon !== "string" ||
    !(WORKSPACE_ICONS as readonly string[]).includes(file.icon)
  ) {
    return { ok: false, error: "workspace.error.icon", detail: String(file.icon) };
  }
  const result = validateLayout(file.layout);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    name: file.name.trim(),
    icon: file.icon as WorkspaceIcon,
    layout: result.layout
  };
}

export function serializePreset(preset: WorkspacePreset): string {
  return JSON.stringify(
    { version: 1, name: preset.name, icon: preset.icon, layout: preset.layout },
    null,
    2
  );
}

export interface PanelDocPayload {
  id: string;
  doc: Document;
}