import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface MediaInfo {
  source: string;
  width: number;
  height: number;
  kind: string;
}

const FILTERS = [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif"] }];

export function mediaRead(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("media_read", { path });
}

export async function askImageOpen(): Promise<string | null> {
  const value = await open({ multiple: false, filters: FILTERS });
  return typeof value === "string" ? value : null;
}
