import { createPublicKey, verify } from "node:crypto";
import type { MockExtension } from "../backend";

export const keyServer = {
  pem: null as string | null,
  fails: false
};

export const keyCache = {
  pem: null as string | null
};

export const authServer = {
  login: "octocat",
  accessToken: "",
  refreshToken: "",
  offlineToken: ""
};

export function reset(): void {
  keyServer.pem = null;
  keyServer.fails = false;
  keyCache.pem = null;
  authServer.login = "octocat";
  authServer.accessToken = "";
  authServer.refreshToken = "";
  authServer.offlineToken = "";
}

function storedTokens(): Map<string, string> {
  return (window as unknown as { __stickmateMock: { tokens: Map<string, string> } })
    .__stickmateMock.tokens;
}

interface Status {
  valid: boolean;
  account_id: number | null;
  expires_at: number | null;
}

const invalid: Status = { valid: false, account_id: null, expires_at: null };

export const handlers: MockExtension = () => ({
  entitlement_refresh_key: () => {
    if (keyServer.fails || !keyServer.pem) {
      throw new Error("public key unavailable");
    }
    keyCache.pem = keyServer.pem;
    return null;
  },
  entitlement_check: (): Status => {
    const token = storedTokens().get("offline");
    if (!token || !keyCache.pem) {
      return invalid;
    }
    const parts = token.split(".");
    if (parts.length !== 2) {
      return invalid;
    }
    const body = Buffer.from(parts[0], "base64url");
    const signature = Buffer.from(parts[1], "base64url");
    let payload: { type?: unknown; exp?: unknown; account_id?: unknown };
    try {
      if (!verify(null, body, createPublicKey(keyCache.pem), signature)) {
        return invalid;
      }
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return invalid;
    }
    if (payload.type !== "offline") {
      return invalid;
    }
    const exp = payload.exp;
    if (
      typeof exp !== "number" ||
      !Number.isInteger(exp) ||
      exp < 0 ||
      exp <= Math.floor(Date.now() / 1000)
    ) {
      return invalid;
    }
    return {
      valid: true,
      account_id: typeof payload.account_id === "number" ? payload.account_id : null,
      expires_at: exp
    };
  },
  auth_start: () => ({
    device_code: "device-1",
    user_code: "ABCD1234",
    verification_uri: "https://example.invalid/auth/verify",
    interval: 1,
    expires_in: 600
  }),
  auth_poll: () => ({
    status: "ok",
    access_token: authServer.accessToken,
    refresh_token: authServer.refreshToken,
    offline_token: authServer.offlineToken,
    account: { id: 7, login: authServer.login }
  })
});