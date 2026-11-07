import { invoke } from "@tauri-apps/api/core";

export interface TemplateEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  min_app_version: string;
  width: number;
  height: number;
  fps: number;
  supported: boolean;
  project_cached: boolean;
}

export interface TemplateCatalog {
  cached: boolean;
  templates: TemplateEntry[];
}

export function templatesCatalog(): Promise<TemplateCatalog> {
  return invoke<TemplateCatalog>("templates_catalog");
}

export function templatesPreview(id: string): Promise<string> {
  return invoke<string>("templates_preview", { id });
}

export function templatesOpen(id: string): Promise<string> {
  return invoke<string>("templates_open", { id });
}