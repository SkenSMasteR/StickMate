import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Toaster } from "@/components/ui/sonner";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import type { PrefsData } from "@/lib/prefs";
import {
  comboFromEvent,
  conflictsFor,
  formatCombo,
  parseCombo,
  validateProfile
} from "@/lib/shortcuts";
import { server } from "./backend/prefs";
import { flush, press, renderEditor } from "./utils";

function binding(label: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(
    `[role="dialog"] button[aria-label="${label}"]`
  );
  if (!found) {
    throw new Error(`binding control not found: ${label}`);
  }
  return found;
}

function tool(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")
  ].find((item) => {
    const name = item.getAttribute("aria-label") ?? "";
    return name === label || name.startsWith(`${label} (`);
  });
  if (!found) {
    throw new Error(`tool button not found: ${label}`);
  }
  return found;
}

function pressed(label: string): boolean {
  return tool(label).getAttribute("aria-pressed") === "true";
}

async function openDialog(): Promise<void> {
  await press("k", { ctrlKey: true, altKey: true });
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
}

async function closeDialog(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
  });
  await flush();
}

async function tap(name: string): Promise<void> {
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
  ];
  const found =
    buttons.find((item) => item.textContent === name) ??
    buttons.find((item) => item.getAttribute("aria-label") === name);
  if (!found) {
    throw new Error(`button not found: ${name}`);
  }
  await act(async () => {
    fireEvent.click(found);
  });
  await flush();
}

async function record(
  label: string,
  key: string,
  modifiers: Partial<KeyboardEvent> = {}
): Promise<void> {
  const control = binding(label);
  await act(async () => {
    fireEvent.click(control);
  });
  await act(async () => {
    fireEvent.keyDown(control, { key, ...modifiers, bubbles: true });
  });
  await flush();
}

async function importProfile(text: string): Promise<void> {
  const input = screen.getByTestId("shortcut-profile-file");
  const file = new File([text], "profile.json", { type: "application/json" });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  await flush();
}

describe("combo format", () => {
  it("normalizes a captured key event", () => {
    expect(
      comboFromEvent(new KeyboardEvent("keydown", { key: "K", ctrlKey: true, altKey: true }))
    ).toBe("ctrl+alt+k");
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: " " }))).toBe("space");
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "F6", shiftKey: true }))).toBe("shift+f6");
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "," }))).toBe(",");
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }))).toBeNull();
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }))).toBeNull();
  });

  it("formats a combo for display", () => {
    expect(formatCombo("ctrl+shift+f5")).toBe("Ctrl+Shift+F5");
    expect(formatCombo("space")).toBe("Space");
    expect(formatCombo("escape")).toBe("Esc");
    expect(formatCombo("alt+o")).toBe("Alt+O");
  });

  it("parses only well formed combos", () => {
    expect(parseCombo("Ctrl+P")).toBe("ctrl+p");
    expect(parseCombo("shift+ctrl+z")).toBe("ctrl+shift+z");
    expect(parseCombo("ctrl+ctrl+z")).toBeNull();
    expect(parseCombo("meta+z")).toBeNull();
    expect(parseCombo("ctrl+")).toBeNull();
    expect(parseCombo("banana")).toBeNull();
    expect(parseCombo("f25")).toBeNull();
    expect(parseCombo("")).toBeNull();
  });

  it("reports the commands that share a combo", () => {
    const bindings = [
      { id: "a", keys: "ctrl+p" },
      { id: "b", keys: "ctrl+p" },
      { id: "c", keys: null }
    ];
    expect(conflictsFor(bindings, "ctrl+p", "a")).toEqual(["b"]);
    expect(conflictsFor(bindings, "ctrl+p", "c")).toEqual(["a", "b"]);
    expect(conflictsFor(bindings, "ctrl+q", "a")).toEqual([]);
  });

  it("validates a profile against the catalogue", () => {
    const defaults = [
      { id: "tool.pencil", keys: "p" },
      { id: "tool.brush", keys: "b" }
    ];
    expect(
      validateProfile(
        JSON.stringify({ version: 1, overrides: { "tool.pencil": "m", "tool.brush": null } }),
        defaults
      )
    ).toEqual({ ok: true, overrides: { "tool.pencil": "m", "tool.brush": null } });
    expect(validateProfile("{", defaults).ok).toBe(false);
    expect(validateProfile(JSON.stringify({ version: 2, overrides: {} }), defaults).ok).toBe(false);
    expect(
      validateProfile(JSON.stringify({ version: 1, overrides: { "tool.nope": "m" } }), defaults)
    ).toEqual({ ok: false, error: "shortcuts.error.unknown", detail: "tool.nope" });
    expect(
      validateProfile(JSON.stringify({ version: 1, overrides: { "tool.pencil": "ctrl+banana" } }), defaults)
    ).toEqual({ ok: false, error: "shortcuts.error.combo", detail: "tool.pencil ctrl+banana" });
    expect(
      validateProfile(
        JSON.stringify({ version: 1, overrides: { "tool.pencil": "m", "tool.brush": "m" } }),
        defaults
      )
    ).toEqual({ ok: false, error: "shortcuts.error.duplicate", detail: "m" });
    expect(
      validateProfile(JSON.stringify({ version: 1, overrides: { "tool.brush": "p" } }), defaults)
    ).toEqual({ ok: false, error: "shortcuts.error.duplicate", detail: "p" });
  });
}, 60000);

describe("shortcut editing", () => {
  it("opens from its own command and lists the effective binding", async () => {
    await renderEditor();
    await openDialog();
    expect(binding("Keyboard shortcuts").textContent).toBe("Ctrl+Alt+K");
    expect(binding("Pencil").textContent).toBe("P");
    expect(screen.getByText("Tools")).toBeTruthy();
    expect(screen.getByText("Playback")).toBeTruthy();
    await closeDialog();
  }, 60000);

  it("opens from the tool strip and rebinds its own command", async () => {
    await renderEditor();
    const opener = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Keyboard shortcuts (Ctrl+Alt+K)"]'
    );
    if (!opener) {
      throw new Error("shortcuts button not found");
    }
    await act(async () => {
      fireEvent.click(opener);
    });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    await record("Keyboard shortcuts", "j", { ctrlKey: true, altKey: true });
    expect(binding("Keyboard shortcuts").textContent).toBe("Ctrl+Alt+J");
    await closeDialog();
    expect(
      document.querySelector('button[aria-label="Keyboard shortcuts (Ctrl+Alt+J)"]')
    ).not.toBeNull();
    await press("j", { ctrlKey: true, altKey: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    await closeDialog();
  }, 60000);

  it("rebinding changes the key, the tool hint and the routing", async () => {
    await renderEditor();
    await press("v");
    await openDialog();
    await record("Pencil", "m");
    expect(binding("Pencil").textContent).toBe("M");
    await closeDialog();
    expect(tool("Pencil").getAttribute("aria-label")).toBe("Pencil (M)");
    await press("p");
    expect(pressed("Pencil")).toBe(false);
    expect(pressed("Select")).toBe(true);
    await press("m");
    expect(pressed("Pencil")).toBe(true);
    await waitFor(() =>
      expect(server.data.shortcuts).toEqual({ "tool.pencil": "m" })
    );
  }, 60000);

  it("names the conflicting command and only reassigns on an explicit choice", async () => {
    await renderEditor();
    await press("v");
    await openDialog();
    await record("Brush", "p");
    expect(binding("Brush").textContent).toBe("B");
    expect(screen.getByText("P is already used by Pencil")).toBeTruthy();
    await tap("Cancel");
    expect(screen.queryByText("P is already used by Pencil")).toBeNull();
    expect(binding("Brush").textContent).toBe("B");
    await record("Brush", "p");
    await tap("Reassign");
    expect(binding("Brush").textContent).toBe("P");
    expect(binding("Pencil").textContent).toBe("Not set");
    await closeDialog();
    await press("p");
    expect(pressed("Brush")).toBe(true);
    expect(pressed("Select")).toBe(false);
  }, 60000);

  it("clearing a binding leaves the command inert", async () => {
    await renderEditor();
    await press("v");
    await openDialog();
    await tap("Clear Pencil");
    expect(binding("Pencil").textContent).toBe("Not set");
    await closeDialog();
    expect(tool("Pencil").getAttribute("aria-label")).toBe("Pencil");
    await press("p");
    expect(pressed("Pencil")).toBe(false);
    expect(pressed("Select")).toBe(true);
  }, 60000);

  it("a row reset restores the default binding", async () => {
    await renderEditor();
    await press("v");
    await openDialog();
    await record("Pencil", "m");
    await tap("Reset Pencil");
    expect(binding("Pencil").textContent).toBe("P");
    await closeDialog();
    await press("p");
    expect(pressed("Pencil")).toBe(true);
    await waitFor(() => expect(server.data.shortcuts).toEqual({}));
  }, 60000);

  it("reset all asks first and restores every default", async () => {
    await renderEditor();
    await openDialog();
    await record("Pencil", "m");
    await record("Brush", "j");
    await tap("Reset all");
    await tap("Cancel");
    expect(binding("Pencil").textContent).toBe("M");
    expect(binding("Brush").textContent).toBe("J");
    await tap("Reset all");
    await tap("Reset");
    expect(binding("Pencil").textContent).toBe("P");
    expect(binding("Brush").textContent).toBe("B");
    await waitFor(() => expect(server.data.shortcuts).toEqual({}));
    await closeDialog();
  }, 60000);

  it("search filters the list and typing in the field runs no command", async () => {
    await renderEditor();
    await press("v");
    await openDialog();
    const search = screen.getByLabelText("Search commands");
    await act(async () => {
      fireEvent.change(search, { target: { value: "zoom" } });
    });
    expect(binding("Zoom in")).toBeTruthy();
    expect(
      document.querySelector('[role="dialog"] button[aria-label="Pencil"]')
    ).toBeNull();
    await act(async () => {
      fireEvent.keyDown(search, { key: "p", bubbles: true });
    });
    await closeDialog();
    expect(pressed("Select")).toBe(true);
    expect(pressed("Pencil")).toBe(false);
  }, 60000);

  it("typing in a panel input does not run canvas commands", async () => {
    await renderEditor();
    await press("v");
    const input = screen.getByLabelText("Label");
    await act(async () => {
      fireEvent.keyDown(input, { key: "p", bubbles: true });
    });
    await flush();
    expect(pressed("Pencil")).toBe(false);
    expect(pressed("Select")).toBe(true);
  }, 60000);

  it("exports a profile and imports it back", async () => {
    let exported: Blob | null = null;
    URL.createObjectURL = (blob: Blob) => {
      exported = blob;
      return "blob:profile";
    };
    URL.revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await renderEditor();
    await press("v");
    await openDialog();
    await record("Pencil", "m");
    await tap("Export");
    expect(exported).not.toBeNull();
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(exported as unknown as Blob);
    });
    expect(JSON.parse(text)).toEqual({
      version: 1,
      overrides: { "tool.pencil": "m" }
    });
    await tap("Reset all");
    await tap("Reset");
    expect(binding("Pencil").textContent).toBe("P");
    await importProfile(text);
    await waitFor(() => expect(binding("Pencil").textContent).toBe("M"));
    await closeDialog();
    await press("m");
    expect(pressed("Pencil")).toBe(true);
  }, 60000);

  it("rejects a bad profile without applying any of it", async () => {
    await renderEditor();
    await openDialog();
    await record("Pencil", "m");
    await importProfile("{");
    expect(await screen.findByText("The file is not a shortcut profile.")).toBeTruthy();
    await importProfile(
      JSON.stringify({ version: 1, overrides: { "tool.pencil": "j", "tool.nope": "x" } })
    );
    expect(await screen.findByText("Unknown command tool.nope")).toBeTruthy();
    await importProfile(
      JSON.stringify({ version: 1, overrides: { "tool.pencil": "ctrl+banana" } })
    );
    expect(
      await screen.findByText("Invalid key combination tool.pencil ctrl+banana")
    ).toBeTruthy();
    await importProfile(
      JSON.stringify({ version: 1, overrides: { "tool.pencil": "j", "tool.brush": "j" } })
    );
    expect(await screen.findByText("Duplicate key combination j")).toBeTruthy();
    await importProfile(
      JSON.stringify({ version: 1, overrides: { "tool.brush": "p" } })
    );
    expect(await screen.findByText("Duplicate key combination p")).toBeTruthy();
    expect(binding("Pencil").textContent).toBe("M");
    expect(binding("Brush").textContent).toBe("B");
    await closeDialog();
    await press("v");
    await press("m");
    expect(pressed("Pencil")).toBe(true);
  }, 60000);

  it("rejects an oversized profile file", async () => {
    await renderEditor();
    await openDialog();
    await record("Pencil", "m");
    await importProfile("x".repeat(70000));
    expect(await screen.findByText("The profile file is too large.")).toBeTruthy();
    expect(binding("Pencil").textContent).toBe("M");
    await closeDialog();
  }, 60000);

  it("keeps the profile across a preference reload", async () => {
    const view = await renderEditor();
    await openDialog();
    await record("Pencil", "m");
    await closeDialog();
    await waitFor(() =>
      expect(server.data.shortcuts).toEqual({ "tool.pencil": "m" })
    );
    view.unmount();
    await renderEditor();
    await waitFor(() =>
      expect(tool("Pencil").getAttribute("aria-label")).toBe("Pencil (M)")
    );
    await press("v");
    await press("m");
    expect(pressed("Pencil")).toBe(true);
  }, 60000);
}, 60000);

describe("shortcut sync", () => {
  let api: {
    prefs: PrefsData;
    loaded: boolean;
    update: (patch: Partial<PrefsData>) => Promise<void>;
  };

  function Probe() {
    api = usePrefs();
    return null;
  }

  async function mountPrefs(shortcuts: Record<string, string | null>): Promise<void> {
    server.revision = 1;
    server.data = {
      language: "en",
      theme: "dark",
      channel: "stable",
      login: null,
      shortcuts
    };
    render(
      <PrefsProvider>
        <Toaster />
        <Probe />
      </PrefsProvider>
    );
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(api.loaded).toBe(true));
  }

  it("merges edits to different commands without a conflict prompt", async () => {
    await mountPrefs({ "tool.pencil": "m" });
    server.revision = 2;
    server.data = {
      language: "en",
      theme: "dark",
      channel: "stable",
      login: null,
      shortcuts: { "tool.pencil": "m", "tool.brush": "j" }
    };
    await act(async () => {
      await api.update({ shortcuts: { "tool.pencil": "m", "tool.eraser": "k" } });
    });
    await waitFor(() => expect(server.revision).toBe(3));
    expect(server.data.shortcuts).toEqual({
      "tool.pencil": "m",
      "tool.brush": "j",
      "tool.eraser": "k"
    });
    expect(api.prefs.shortcuts).toEqual({
      "tool.pencil": "m",
      "tool.brush": "j",
      "tool.eraser": "k"
    });
    expect(screen.queryByText("Settings changed on another device.")).toBeNull();
  }, 60000);

  it("takes the remote binding when the local one is unchanged", async () => {
    await mountPrefs({ "tool.pencil": "m" });
    server.revision = 2;
    server.data = {
      language: "en",
      theme: "dark",
      channel: "stable",
      login: null,
      shortcuts: { "tool.pencil": "j" }
    };
    await act(async () => {
      await api.update({ theme: "light" });
    });
    await waitFor(() => expect(server.revision).toBe(3));
    expect(server.data.shortcuts).toEqual({ "tool.pencil": "j" });
    expect(api.prefs.shortcuts).toEqual({ "tool.pencil": "j" });
    expect(screen.queryByText("Settings changed on another device.")).toBeNull();
  }, 60000);

  it("surfaces two devices rebinding the same command", async () => {
    await mountPrefs({ "tool.pencil": "m" });
    server.revision = 2;
    server.data = {
      language: "en",
      theme: "dark",
      channel: "stable",
      login: null,
      shortcuts: { "tool.pencil": "j" }
    };
    await act(async () => {
      await api.update({ shortcuts: { "tool.pencil": "z" } });
    });
    expect(await screen.findByText("Settings changed on another device.")).toBeTruthy();
    expect(server.revision).toBe(2);
    await act(async () => {
      screen.getByRole("button", { name: "Keep mine" }).click();
    });
    await waitFor(() =>
      expect(server.data.shortcuts).toEqual({ "tool.pencil": "z" })
    );
    expect(server.revision).toBe(3);
    expect(api.prefs.shortcuts).toEqual({ "tool.pencil": "z" });
  }, 60000);
}, 60000);