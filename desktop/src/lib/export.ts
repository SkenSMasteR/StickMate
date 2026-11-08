import { invoke } from "@tauri-apps/api/core";

export type ExportFormat = "html5" | "canvasjs";

export type ExportRangeKind = "whole" | "scene" | "frames";

export type ExportRange =
  | { kind: "whole" }
  | { kind: "scene"; sceneId: string }
  | { kind: "frames"; sceneId: string; start: number; end: number };

export interface ExportSettings {
  format: ExportFormat;
  rangeKind: ExportRangeKind;
  sceneId: string;
  start: number;
  end: number;
  scale: number;
  fps: number;
  loop: boolean;
  transparent: boolean;
}

export const EXPORT_FORMATS: ExportFormat[] = ["html5", "canvasjs"];

export const EXPORT_RANGE_KINDS: ExportRangeKind[] = ["whole", "scene", "frames"];

export const EXPORT_SCALES = [0.5, 1, 2];

export const FPS_LIMITS = { min: 1, max: 60 };

export const FRAME_LIMITS = { min: 0, max: 99999 };

export interface ExportOptions {
  range: ExportRange;
  scale: number;
  fps: number;
  loop: boolean;
  transparent: boolean;
}

export function toExportOptions(settings: ExportSettings): ExportOptions {
  const range: ExportRange =
    settings.rangeKind === "whole"
      ? { kind: "whole" }
      : settings.rangeKind === "scene"
        ? { kind: "scene", sceneId: settings.sceneId }
        : {
            kind: "frames",
            sceneId: settings.sceneId,
            start: settings.start,
            end: settings.end
          };
  return {
    range,
    scale: settings.scale,
    fps: settings.fps,
    loop: settings.loop,
    transparent: settings.transparent
  };
}

export interface ExportResult {
  path: string;
  files: string[];
  width: number;
  height: number;
  fps: number;
  frames: number;
}

export function exportWeb(
  id: string,
  format: ExportFormat,
  options: ExportOptions
): Promise<ExportResult> {
  return invoke<ExportResult>("export_web", { id, format, options });
}