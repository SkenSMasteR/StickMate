import { invoke } from "@tauri-apps/api/core";

export interface EntitlementStatus {
  valid: boolean;
  account_id: number | null;
  expires_at: number | null;
}

export function entitlementCheck(): Promise<EntitlementStatus> {
  return invoke<EntitlementStatus>("entitlement_check");
}

export function entitlementRefreshKey(): Promise<void> {
  return invoke<void>("entitlement_refresh_key");
}