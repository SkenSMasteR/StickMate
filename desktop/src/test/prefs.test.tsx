import { expect, test } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Toaster } from "@/components/ui/sonner";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import type { PrefsData } from "@/lib/prefs";
import { defaultSettings } from "@/lib/export-presets";
import type { ExportPreset } from "@/lib/export-presets";
import { defaultView } from "@/lib/view";
import { server } from "./backend/prefs";
import { channelState } from "./backend/updater";

const defaults: PrefsData = {
  language: "en",
  theme: "dark",
  channel: "stable",
  login: null,
  shortcuts: {},
  view: defaultView,
  exportPresets: []
};

function preset(id: string, name = id, updatedAt = 1000): ExportPreset {
  return { id, name, updatedAt, settings: { ...defaultSettings, fps: 30 } };
}

let api: {
  prefs: PrefsData;
  loaded: boolean;
  update: (patch: Partial<PrefsData>) => Promise<void>;
};

function Probe() {
  api = usePrefs();
  return <div data-testid="theme">{api.prefs.theme}</div>;
}

async function mount() {
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

async function change(patch: Partial<PrefsData>) {
  await act(async () => {
    await api.update(patch);
  });
}

function seed(data: Partial<PrefsData>, revision = 1) {
  server.revision = revision;
  server.data = { ...defaults, ...data };
}

test("a plain update reaches the server and bumps the revision", async () => {
  await mount();
  await change({ theme: "light" });
  expect(server.revision).toBe(1);
  expect(server.data.theme).toBe("light");
  expect(api.prefs.theme).toBe("light");
});

test("a remote-only change is merged instead of overwritten", async () => {
  seed({ channel: "nightly" });
  await mount();
  server.revision = 2;
  server.data = { ...defaults, channel: "nightly", language: "mk" };
  await change({ theme: "light" });
  expect(server.revision).toBe(3);
  expect(server.data).toMatchObject({
    theme: "light",
    language: "mk",
    channel: "nightly"
  });
  expect(api.prefs.language).toBe("mk");
  expect(screen.queryByText("Settings changed on another device.")).toBeNull();
});

test("a contested field asks which side to keep", async () => {
  seed({});
  await mount();
  server.revision = 2;
  server.data = { ...defaults, login: "other" };
  await change({ login: "mine" });
  expect(await screen.findByText("Settings changed on another device.")).toBeTruthy();
  expect(server.revision).toBe(2);
  await act(async () => {
    screen.getByRole("button", { name: "Keep mine" }).click();
  });
  await waitFor(() => expect(server.data.login).toBe("mine"));
  expect(server.revision).toBe(3);
  expect(api.prefs.login).toBe("mine");
});

test("using theirs discards the local value", async () => {
  seed({});
  await mount();
  server.revision = 2;
  server.data = { ...defaults, login: "other" };
  await change({ login: "mine" });
  await screen.findByText("Settings changed on another device.");
  await act(async () => {
    screen.getByRole("button", { name: "Use theirs" }).click();
  });
  await waitFor(() => expect(api.prefs.login).toBe("other"));
  expect(server.data.login).toBe("other");
  expect(server.revision).toBe(3);
});

test("an unreachable server keeps the change locally", async () => {
  server.online = false;
  await mount();
  await change({ theme: "light" });
  expect(api.prefs.theme).toBe("light");
  const raw = window.localStorage.getItem("stickmate.prefs");
  expect(raw).not.toBeNull();
  expect(JSON.parse(raw as string).data.theme).toBe("light");
});

test("the chosen update channel reaches the native updater", async () => {
  await mount();
  expect(channelState.channel).toBe("stable");
  await change({ channel: "nightly" });
  expect(channelState.channel).toBe("nightly");
  expect(server.data.channel).toBe("nightly");
});

test("a channel synced from another device is applied on load", async () => {
  seed({ channel: "nightly" });
  await mount();
  await waitFor(() => expect(channelState.channel).toBe("nightly"));
});

test("stored presets are sanitised on load", async () => {
  server.revision = 1;
  server.data = {
    ...defaults,
    exportPresets: [
      preset("a", "Alpha"),
      { ...preset("b"), name: "  " },
      { ...preset("c", "alpha"), settings: { ...defaultSettings, fps: 900 } },
      "not a preset"
    ]
  };
  await mount();
  await waitFor(() => expect(api.loaded).toBe(true));
  expect(api.prefs.exportPresets).toEqual([preset("a", "Alpha")]);
});

test("a preset added on another device is kept beside the local one", async () => {
  seed({});
  await mount();
  server.revision = 2;
  server.data = { ...defaults, exportPresets: [preset("r", "Remote")] };
  await change({ exportPresets: [preset("l", "Local")] });
  expect(server.revision).toBe(3);
  expect(api.prefs.exportPresets.map((item) => item.name).sort()).toEqual(["Local", "Remote"]);
});

test("the newer edit of a shared preset wins without a prompt", async () => {
  seed({ exportPresets: [preset("a", "Old", 100)] });
  await mount();
  server.revision = 2;
  server.data = { ...defaults, exportPresets: [preset("a", "Theirs", 300)] };
  await change({ exportPresets: [preset("a", "Mine", 200)] });
  await waitFor(() => expect(server.revision).toBe(3));
  expect(api.prefs.exportPresets).toEqual([preset("a", "Theirs", 300)]);
});

test("deleting a preset locally is not undone by an untouched remote copy", async () => {
  seed({ exportPresets: [preset("a", "Old"), preset("b", "Other")] });
  await mount();
  server.revision = 2;
  server.data = { ...defaults, exportPresets: [preset("a", "Old"), preset("b", "Other")] };
  await change({ exportPresets: [preset("b", "Other")] });
  await waitFor(() => expect(server.revision).toBe(3));
  expect(api.prefs.exportPresets).toEqual([preset("b", "Other")]);
});

test("editing a preset the remote side deleted brings it back", async () => {
  seed({ exportPresets: [preset("a", "Old", 100)] });
  await mount();
  server.revision = 2;
  server.data = { ...defaults, exportPresets: [] };
  await change({ exportPresets: [preset("a", "Mine", 200)] });
  await waitFor(() => expect(server.revision).toBe(3));
  expect(api.prefs.exportPresets).toEqual([preset("a", "Mine", 200)]);
});