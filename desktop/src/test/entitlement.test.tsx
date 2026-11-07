import { beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import Main from "@/app/App";
import SignIn from "@/app/auth/SignIn";
import { I18nProvider } from "@/i18n";
import { PrefsProvider } from "@/lib/prefs";
import { tokenClear, tokenSave } from "@/lib/tauri";
import { authServer, keyCache, keyServer } from "./backend/entitlement";

vi.mock("@/app/hub/Hub", () => ({
  default: () => <div data-testid="hub" />
}));

const PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAwa4j6AEjIpXExkBF9NzqXq8MKBY0NQH3qUcl5TCODyY=\n-----END PUBLIC KEY-----\n";
const VALID_TOKEN =
  "eyJhY2NvdW50X2lkIjo3LCJleHAiOjIxMDk0NDEzMjUsImlhdCI6MTc5NDA4MTMyNSwidHlwZSI6Im9mZmxpbmUifQ.HvKEG8FC62DiVeBe5BG9ud4NFweYZp0i-eMMD4tGg3j-ZkoZDVmkogZJ47aBBm3wLGxUkeB6hw1flAtQztGDBw";
const EXPIRED_TOKEN =
  "eyJhY2NvdW50X2lkIjo3LCJleHAiOjE3OTQwODEzMjUsImlhdCI6MTc5NDA4MTMyNSwidHlwZSI6Im9mZmxpbmUifQ.LxqFTvkX9maksuEcKAi_IX2uuCyPVPT8k3Ltb2PMhUZS22e5PlIoCG6o8ztdmjduASKpE-pFbeXkZUMcTweFDw";
const ACCESS_TOKEN =
  "eyJhY2NvdW50X2lkIjo3LCJleHAiOjE3OTQwODQ5MjUsImlhdCI6MTc5NDA4MTMyNSwidHlwZSI6ImFjY2VzcyJ9.qfB8GpHRPpsLSDuwXw90KXrxmHJFXH6f-k0xjM4pg4RiJtcMPYeBjhNnIxSBQqk_ZI526NGVrPTGr8gVEN-2Cg";

function mountMain() {
  return render(
    <PrefsProvider>
      <I18nProvider language="en" onLanguageChange={() => {}}>
        <Main />
      </I18nProvider>
    </PrefsProvider>
  );
}

async function offlineOnly(token: string): Promise<void> {
  await tokenClear();
  await tokenSave("offline", token);
}

beforeEach(async () => {
  await tokenClear();
});

describe("offline entitlement gate", () => {
  test("a verified offline entitlement opens the hub", async () => {
    keyCache.pem = PUBLIC_KEY;
    await offlineOnly(VALID_TOKEN);
    mountMain();
    await screen.findByTestId("hub");
  });

  test("an expired offline entitlement leads to sign in", async () => {
    keyCache.pem = PUBLIC_KEY;
    await offlineOnly(EXPIRED_TOKEN);
    mountMain();
    await screen.findByText("Sign in to StickMate");
  });

  test("an access token presented as offline leads to sign in", async () => {
    keyCache.pem = PUBLIC_KEY;
    await offlineOnly(ACCESS_TOKEN);
    mountMain();
    await screen.findByText("Sign in to StickMate");
  });

  test("a garbage offline token leads to sign in", async () => {
    keyCache.pem = PUBLIC_KEY;
    await offlineOnly("garbage");
    mountMain();
    await screen.findByText("Sign in to StickMate");
  });

  test("a valid token without a cached public key leads to sign in", async () => {
    await offlineOnly(VALID_TOKEN);
    mountMain();
    await screen.findByText("Sign in to StickMate");
  });

  test("a refresh token keeps precedence over an expired entitlement", async () => {
    await tokenSave("offline", EXPIRED_TOKEN);
    await tokenSave("refresh", "refresh-1");
    mountMain();
    await screen.findByTestId("hub");
  });

  test("an access token still opens the hub when no offline token exists", async () => {
    await tokenSave("access", "access-1");
    mountMain();
    await screen.findByTestId("hub");
  });

  test("no credentials leads to sign in", async () => {
    mountMain();
    await screen.findByText("Sign in to StickMate");
  });
});

describe("sign in public key caching", () => {
  function mountSignIn(onSignedIn: (login: string | null) => void) {
    return render(
      <I18nProvider language="en" onLanguageChange={() => {}}>
        <SignIn onSignedIn={onSignedIn} />
      </I18nProvider>
    );
  }

  async function startSignIn(): Promise<void> {
    await act(async () => {
      screen.getByRole("button", { name: "Sign in with GitHub" }).click();
    });
  }

  test("signing in caches the server public key and stores the tokens", async () => {
    keyServer.pem = PUBLIC_KEY;
    authServer.accessToken = ACCESS_TOKEN;
    authServer.refreshToken = "refresh-1";
    authServer.offlineToken = VALID_TOKEN;
    const signedIn = vi.fn();
    mountSignIn(signedIn);
    await startSignIn();
    await waitFor(() => expect(keyCache.pem).toBe(PUBLIC_KEY), { timeout: 4000 });
    expect(signedIn).toHaveBeenCalledWith("octocat");
  });

  test("a failed public key fetch does not break sign in", async () => {
    keyServer.pem = PUBLIC_KEY;
    keyServer.fails = true;
    authServer.accessToken = ACCESS_TOKEN;
    authServer.refreshToken = "refresh-1";
    authServer.offlineToken = VALID_TOKEN;
    const signedIn = vi.fn();
    mountSignIn(signedIn);
    await startSignIn();
    await waitFor(() => expect(signedIn).toHaveBeenCalledWith("octocat"), {
      timeout: 4000
    });
    expect(keyCache.pem).toBeNull();
  });
});