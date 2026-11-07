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

function bytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function signed(token: string, pem: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return false;
  }
  const raw = bytes(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""));
  const key = await crypto.subtle.importKey(
    "raw",
    raw.slice(-32),
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify({ name: "Ed25519" }, key, bytes(parts[1]), bytes(parts[0]));
}

export const handlers: MockExtension = () => ({
  entitlement_refresh_key: () => {
    if (keyServer.fails || !keyServer.pem) {
      throw new Error("public key unavailable");
    }
    keyCache.pem = keyServer.pem;
    return null;
  },
  entitlement_check: async (): Promise<Status> => {
    const token = storedTokens().get("offline");
    if (!token || !keyCache.pem) {
      return invalid;
    }
    let payload: { type?: unknown; exp?: unknown; account_id?: unknown };
    try {
      if (!(await signed(token, keyCache.pem))) {
        return invalid;
      }
      payload = JSON.parse(new TextDecoder().decode(bytes(token.split(".")[0])));
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