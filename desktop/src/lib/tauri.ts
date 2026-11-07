import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface DeviceAuth {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface PollResult {
  status: "ok" | "pending" | "expired" | string;
  access_token?: string;
  refresh_token?: string;
  offline_token?: string;
  account?: { id: number; login: string };
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  offline_token?: string;
}

export interface PrefsGet {
  revision: number;
  data: unknown;
}

export interface PrefsPut {
  conflict: boolean;
  revision: number;
}

export function authStart(): Promise<DeviceAuth> {
  return invoke<DeviceAuth>("auth_start");
}

export function authPoll(deviceCode: string): Promise<PollResult> {
  return invoke<PollResult>("auth_poll", { deviceCode });
}

export function authRefresh(refreshToken: string): Promise<Tokens> {
  return invoke<Tokens>("auth_refresh", { refreshToken });
}

export function authLogout(refreshToken: string): Promise<unknown> {
  return invoke<unknown>("auth_logout", { refreshToken });
}

export function openUrl(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}

export function tokenSave(kind: string, value: string): Promise<void> {
  return invoke<void>("token_save", { kind, value });
}

export function tokenLoad(kind: string): Promise<string | null> {
  return invoke<string | null>("token_load", { kind });
}

export function tokenClear(): Promise<void> {
  return invoke<void>("token_clear", {});
}

export function prefsGet(): Promise<PrefsGet> {
  return invoke<PrefsGet>("prefs_get", {});
}

export function prefsPut(
  baseRevision: number,
  data: Record<string, unknown>
): Promise<PrefsPut> {
  return invoke<PrefsPut>("prefs_put", { baseRevision, data });
}

export function appVersion(): Promise<string> {
  return invoke<string>("app_version", {});
}

export function checkForUpdate(): Promise<string | null> {
  return invoke<string | null>("check_for_update", {});
}

export function installUpdate(): Promise<unknown> {
  return invoke<unknown>("install_update", {});
}

export function setUpdateChannel(channel: string): Promise<unknown> {
  return invoke<unknown>("set_update_channel", { channel });
}

export function onUpdateProgress(
  callback: (percent: number) => void
): Promise<() => void> {
  return listen<number>("update-progress", (event) => callback(event.payload));
}
