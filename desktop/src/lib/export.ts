import { invoke } from "@tauri-apps/api/core";

export type ExportFormat = "html5" | "canvasjs";

export type ExportRange =
  | { kind: "whole" }
  | { kind: "scene"; sceneId: string }
  | { kind: "frames"; sceneId: string; start: number; end: number };

export interface ExportOptions {
  range: ExportRange;
  scale: number;
  fps: number;
  loop: boolean;
  transparent: boolean;
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