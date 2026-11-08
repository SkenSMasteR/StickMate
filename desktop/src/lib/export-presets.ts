import {
  EXPORT_FORMATS,
  EXPORT_RANGE_KINDS,
  EXPORT_SCALES,
  FPS_LIMITS,
  FRAME_LIMITS
} from "@/lib/export";
import type { ExportFormat, ExportRangeKind, ExportSettings } from "@/lib/export";

export interface ExportPreset {
  id: string;
  name: string;
  updatedAt: number;
  settings: ExportSettings;
}

export const MAX_PRESETS = 24;
export const MAX_NAME_LENGTH = 60;
export const MAX_SCENE_ID_LENGTH = 64;
export const MAX_ID_LENGTH = 64;

export const defaultSettings: ExportSettings = {
  format: "html5",
  rangeKind: "whole",
  sceneId: "",
  start: 0,
  end: 0,
  scale: 1,
  fps: 24,
  loop: true,
  transparent: false
};

export function newPresetId(): string {
  return `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultPresetName(settings: ExportSettings): string {
  const format = settings.format === "html5" ? "HTML5" : "Canvas JS";
  const range =
    settings.rangeKind === "whole"
      ? "Whole"
      : settings.rangeKind === "scene"
        ? "Scene"
        : `Frames ${settings.start} to ${settings.end}`;
  const parts = [format, range, `${Math.round(settings.scale * 100)}%`, `${settings.fps} fps`];
  if (settings.transparent) {
    parts.push("alpha");
  }
  return parts.join(" · ").slice(0, MAX_NAME_LENGTH);
}

function numberValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value);
}

export function sanitizeSettings(raw: unknown): ExportSettings | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const input = raw as Record<string, unknown>;
  if (
    typeof input.format !== "string" ||
    !EXPORT_FORMATS.includes(input.format as ExportFormat) ||
    typeof input.rangeKind !== "string" ||
    !EXPORT_RANGE_KINDS.includes(input.rangeKind as ExportRangeKind) ||
    typeof input.sceneId !== "string" ||
    typeof input.loop !== "boolean" ||
    typeof input.transparent !== "boolean"
  ) {
    return null;
  }
  const start = numberValue(input.start);
  const end = numberValue(input.end);
  const fps = numberValue(input.fps);
  if (
    start === null ||
    end === null ||
    fps === null ||
    start < FRAME_LIMITS.min ||
    end < FRAME_LIMITS.min ||
    start > FRAME_LIMITS.max ||
    end > FRAME_LIMITS.max ||
    end < start ||
    fps < FPS_LIMITS.min ||
    fps > FPS_LIMITS.max ||
    typeof input.scale !== "number" ||
    !EXPORT_SCALES.includes(input.scale)
  ) {
    return null;
  }
  return {
    format: input.format as ExportFormat,
    rangeKind: input.rangeKind as ExportRangeKind,
    sceneId: input.sceneId.trim().slice(0, MAX_SCENE_ID_LENGTH),
    start,
    end,
    scale: input.scale,
    fps,
    loop: input.loop,
    transparent: input.transparent
  };
}

export function sanitizePreset(raw: unknown): ExportPreset | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const input = raw as Record<string, unknown>;
  if (typeof input.id !== "string") {
    return null;
  }
  const id = input.id.trim();
  if (id === "" || id.length > MAX_ID_LENGTH) {
    return null;
  }
  if (typeof input.name !== "string") {
    return null;
  }
  const name = input.name.trim().slice(0, MAX_NAME_LENGTH);
  if (name === "") {
    return null;
  }
  const settings = sanitizeSettings(input.settings);
  if (!settings) {
    return null;
  }
  const updatedAt =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt) && input.updatedAt > 0
      ? Math.round(input.updatedAt)
      : 0;
  return { id, name, updatedAt, settings };
}

export function sanitizePresets(raw: unknown): ExportPreset[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const kept: ExportPreset[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of raw) {
    const preset = sanitizePreset(item);
    if (!preset || ids.has(preset.id)) {
      continue;
    }
    const key = preset.name.toLowerCase();
    if (names.has(key)) {
      continue;
    }
    ids.add(preset.id);
    names.add(key);
    kept.push(preset);
    if (kept.length >= MAX_PRESETS) {
      break;
    }
  }
  return kept;
}

function identical(
  a: ExportPreset | undefined,
  b: ExportPreset | undefined
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function mergePresets(
  ours: ExportPreset[],
  theirs: ExportPreset[],
  base: ExportPreset[]
): { data: ExportPreset[]; contested: boolean } {
  const ids: string[] = [];
  for (const list of [ours, theirs, base]) {
    for (const preset of list) {
      if (!ids.includes(preset.id)) {
        ids.push(preset.id);
      }
    }
  }
  const merged: ExportPreset[] = [];
  for (const id of ids) {
    const a = ours.find((preset) => preset.id === id);
    const b = theirs.find((preset) => preset.id === id);
    const start = base.find((preset) => preset.id === id);
    if (a && b) {
      if (identical(a, b) || a.updatedAt >= b.updatedAt) {
        merged.push(a);
      } else {
        merged.push(b);
      }
      continue;
    }
    if (a) {
      if (!start || !identical(a, start)) {
        merged.push(a);
      }
      continue;
    }
    if (b) {
      if (!start || !identical(b, start)) {
        merged.push(b);
      }
    }
  }
  return { data: sanitizePresets(merged), contested: false };
}
