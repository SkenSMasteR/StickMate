import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface MediaInfo {
  source: string;
  width: number;
  height: number;
  kind: string;
}

export interface AnimationFrame {
  source: string;
  width: number;
  height: number;
  delay: number;
}

const FILTERS = [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "svg"] }];
const GIF_FILTERS = [{ name: "GIF animation", extensions: ["gif"] }];

export function mediaRead(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("media_read", { path });
}

export function mediaSequence(path: string): Promise<MediaInfo[]> {
  return invoke<MediaInfo[]>("media_sequence", { path });
}

export function mediaGif(path: string): Promise<AnimationFrame[]> {
  return invoke<AnimationFrame[]>("media_gif", { path });
}

export async function askImageOpen(): Promise<string | null> {
  const value = await open({ multiple: false, filters: FILTERS });
  return typeof value === "string" ? value : null;
}

export async function askGifOpen(): Promise<string | null> {
  const value = await open({ multiple: false, filters: GIF_FILTERS });
  return typeof value === "string" ? value : null;
}
