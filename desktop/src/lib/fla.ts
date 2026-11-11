import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface FlaExportResult {
  path: string;
  warnings: string[];
}

export interface FlaImportResult {
  id: string;
  name: string;
  notes: string[];
}

const FILTERS = [{ name: "Adobe Animate", extensions: ["fla", "xfl"] }];

export function exportFla(id: string, path: string): Promise<FlaExportResult> {
  return invoke<FlaExportResult>("project_export_fla", { id, path });
}

export function importFla(path: string): Promise<FlaImportResult> {
  return invoke<FlaImportResult>("project_import_fla", { path });
}

export async function askFlaSave(name: string): Promise<string | null> {
  const value = await save({
    defaultPath: `${name}.fla`,
    filters: FILTERS
  });
  return typeof value === "string" ? value : null;
}

export async function askFlaOpen(): Promise<string | null> {
  const value = await open({ multiple: false, filters: FILTERS });
  return typeof value === "string" ? value : null;
}
