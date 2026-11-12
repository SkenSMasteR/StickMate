import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { recordFlaReport } from "@/lib/fla-report";

export interface FlaExportResult {
  path: string;
  warnings: string[];
}

export interface FlaImportResult {
  id: string;
  name: string;
  notes: string[];
}

const FILTERS = [{ name: "Adobe Animate", extensions: ["fla"] }];

function exportFla(id: string, path: string): Promise<FlaExportResult> {
  return invoke<FlaExportResult>("project_export_fla", { id, path });
}

function importFla(path: string): Promise<FlaImportResult> {
  return invoke<FlaImportResult>("project_import_fla", { path });
}

async function askFlaSave(name: string): Promise<string | null> {
  const value = await save({
    defaultPath: `${name}.fla`,
    filters: FILTERS
  });
  return typeof value === "string" ? value : null;
}

async function askFlaOpen(): Promise<string | null> {
  const value = await open({ multiple: false, filters: FILTERS });
  return typeof value === "string" ? value : null;
}

export async function importAnimate(): Promise<FlaImportResult | null> {
  const path = await askFlaOpen();
  if (!path) {
    return null;
  }
  const result = await importFla(path);
  recordFlaReport("import", path, result.notes);
  return result;
}

export async function exportAnimate(id: string, name: string): Promise<FlaExportResult | null> {
  const path = await askFlaSave(name);
  if (!path) {
    return null;
  }
  const result = await exportFla(id, path);
  recordFlaReport("export", result.path, result.warnings);
  return result;
}
