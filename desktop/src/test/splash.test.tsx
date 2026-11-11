import { beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Window } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import App from "@/App";
import { installBackend } from "./backend";
import { flush } from "./utils";

const state = vi.hoisted(() => ({
  available: true,
  showFails: false,
  showGate: null as Promise<void> | null,
  installGate: null as Promise<void> | null,
  show: vi.fn(),
  setFocus: vi.fn(),
  update: null as string | null,
  updateFails: false,
  installs: 0,
  refreshFails: false
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: async (label: string) => {
      if (label !== "main" || !state.available) {
        return null;
      }
      return {
        show: () => {
          state.show();
          if (state.showFails) {
            return Promise.reject(new Error("show denied"));
          }
          return state.showGate ?? Promise.resolve();
        },
        setFocus: () => {
          state.setFocus();
          return Promise.resolve();
        }
      };
    }
  }
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    checkForUpdate: async () => {
      if (state.updateFails) {
        throw new Error("feed unreachable");
      }
      return state.update;
    },
    installUpdate: async () => {
      state.installs += 1;
      if (state.installGate) {
        await state.installGate;
      }
      return null;
    },
    tokenLoad: async (kind: string) => (kind === "refresh" ? "mock-refresh" : null),
    authRefresh: async () => {
      if (state.refreshFails) {
        throw new Error("refresh denied");
      }
      return { access_token: "a", refresh_token: "r", expires_in: 900 };
    }
  };
});

function loader(): Element | null {
  return document.querySelector(".loader");
}

function bar(): Element | null {
  return document.querySelector(".progress");
}

function hidden(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(Window.prototype, "hide").mockResolvedValue(undefined);
}

async function mount() {
  installBackend("splash");
  const view = render(<App />);
  await flush();
  return view;
}

beforeEach(() => {
  state.available = true;
  state.showFails = false;
  state.showGate = null;
  state.installGate = null;
  state.update = null;
  state.updateFails = false;
  state.installs = 0;
  state.refreshFails = false;
  state.show.mockClear();
  state.setFocus.mockClear();
});

describe("splash", () => {
  test("shows the loader while startup is still running", async () => {
    let release = () => {};
    state.showGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hide = hidden();
    await mount();
    expect(loader()).not.toBeNull();
    expect(screen.queryByText("Startup failed")).toBeNull();
    expect(hide).not.toHaveBeenCalled();
    release();
    await flush();
    expect(hide).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  test("hands over to the main window and hides itself", async () => {
    const hide = hidden();
    await mount();
    await waitFor(() => expect(state.show).toHaveBeenCalledTimes(1));
    expect(state.setFocus).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Startup failed")).toBeNull();
    vi.restoreAllMocks();
  });

  test("installs a pending update before handing over", async () => {
    state.update = "0.2.0";
    hidden();
    await mount();
    await waitFor(() => expect(state.show).toHaveBeenCalledTimes(1));
    expect(state.installs).toBe(1);
    vi.restoreAllMocks();
  });

  test("swaps the bouncing loader for a progress bar while updating", async () => {
    state.update = "0.2.0";
    let release = () => {};
    state.installGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hide = hidden();
    await mount();
    await waitFor(() => expect(screen.getByRole("progressbar")).toBeTruthy());
    expect(loader()).toBeNull();
    expect(bar()).not.toBeNull();
    expect(bar()?.getAttribute("aria-valuenow")).toBe("0");
    await act(async () => {
      await emit("update-progress", 45);
    });
    expect(bar()?.getAttribute("aria-valuenow")).toBe("45");
    expect((bar()?.firstElementChild as HTMLElement).style.width).toBe("45%");
    await act(async () => {
      await emit("update-progress", 100);
    });
    expect(bar()?.getAttribute("aria-valuenow")).toBe("100");
    release();
    await flush();
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    expect(bar()).toBeNull();
    vi.restoreAllMocks();
  });

  test("keeps the bouncing loader when there is no update", async () => {
    let release = () => {};
    state.showGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hidden();
    await mount();
    expect(loader()).not.toBeNull();
    expect(bar()).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    release();
    await flush();
    vi.restoreAllMocks();
  });

  test("a failed update check does not block startup", async () => {
    state.updateFails = true;
    const hide = hidden();
    await mount();
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    expect(state.installs).toBe(0);
    expect(screen.queryByText("Startup failed")).toBeNull();
    vi.restoreAllMocks();
  });

  test("a failed token refresh does not block startup", async () => {
    state.refreshFails = true;
    const hide = hidden();
    await mount();
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Startup failed")).toBeNull();
    vi.restoreAllMocks();
  });

  test("a missing main window shows an error and a retry button", async () => {
    state.available = false;
    await mount();
    await waitFor(() => expect(screen.getByText("Startup failed")).toBeTruthy());
    expect(screen.getByText("Error: main window is unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(loader()).toBeNull();
  });

  test("a rejected show shows the error text", async () => {
    state.showFails = true;
    await mount();
    await waitFor(() => expect(screen.getByText("Startup failed")).toBeTruthy());
    expect(screen.getByText("Error: show denied")).toBeTruthy();
    expect(loader()).toBeNull();
  });

  test("retry starts over and succeeds once the window exists", async () => {
    state.available = false;
    const hide = hidden();
    await mount();
    await waitFor(() => expect(screen.getByText("Startup failed")).toBeTruthy());
    expect(state.show).not.toHaveBeenCalled();
    state.available = true;
    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
    });
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    expect(state.show).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Startup failed")).toBeNull();
    vi.restoreAllMocks();
  });

  test("retry is repeatable while the failure persists", async () => {
    state.available = false;
    await mount();
    await waitFor(() => expect(screen.getByText("Startup failed")).toBeTruthy());
    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
    });
    await flush();
    expect(screen.getByText("Startup failed")).toBeTruthy();
    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
    });
    await flush();
    expect(screen.getByText("Startup failed")).toBeTruthy();
    expect(state.show).not.toHaveBeenCalled();
  });
});