import { useEffect } from "react";
import { describe, expect, test } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ExportDialog from "@/editor/ExportDialog";
import { useWorkspace, WorkspaceProvider } from "@/editor/workspace";
import { I18nProvider } from "@/i18n";
import { ConfirmProvider } from "@/lib/confirm";
import { defaultSettings } from "@/lib/export-presets";
import type { ExportPreset } from "@/lib/export-presets";
import type { ExportSettings } from "@/lib/export";
import type { Document, Keyframe, Layer, Scene, Shape } from "@/lib/document";
import { PrefsProvider } from "@/lib/prefs";
import { store } from "./backend";
import { server } from "./backend/prefs";

const identity = { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 };

const box: Shape = {
  kind: "Rect",
  x: 10,
  y: 10,
  w: 50,
  h: 40,
  fill: "#3b82f6",
  stroke: "#000000",
  width: 2
};

function key(frame: number, shapes: Shape[]): Keyframe {
  return { frame, shapes, transform: identity, tween: false, label: null };
}

function layer(id: string, length: number): Layer {
  return { id, name: id, visible: true, locked: false, opacity: 1, blend: "normal", effects: [], length, keys: [key(0, [box])] };
}

function scene(id: string, length: number): Scene {
  return { id, name: id, layers: [layer(`${id}l`, length)] };
}

function docFixture(): Document {
  return {
    id: "presetdoc",
    name: "Preset film",
    width: 320,
    height: 240,
    fps: 24,
    background: "#ffffff",
    scenes: [scene("s0", 10), scene("s1", 4)]
  };
}

function presetFixture(
  id: string,
  name: string,
  settings: Partial<ExportSettings> = {}
): ExportPreset {
  return { id, name, updatedAt: 1000, settings: { ...defaultSettings, ...settings } };
}

function seedPresets(list: ExportPreset[]): void {
  server.revision = 1;
  server.data = { exportPresets: list };
}

function Host({ doc }: { doc: Document }) {
  const { open } = useWorkspace();
  useEffect(() => {
    void open(doc.id);
  }, [doc.id, open]);
  return <ExportDialog open onClose={() => {}} />;
}

async function mountDialog(doc: Document): Promise<void> {
  store.set(doc.id, { doc, undo: [], redo: [], updated_at: Date.now() });
  render(
    <I18nProvider language="en" onLanguageChange={() => {}}>
      <ConfirmProvider>
        <PrefsProvider>
          <WorkspaceProvider>
            <Host doc={doc} />
          </WorkspaceProvider>
        </PrefsProvider>
      </ConfirmProvider>
    </I18nProvider>
  );
  await waitFor(() =>
    expect((screen.getByLabelText("Frame rate") as HTMLInputElement).value).toBe(String(doc.fps))
  );
}

function change(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function toggle(name: string): void {
  fireEvent.click(screen.getByRole("switch", { name }));
}

function checked(name: string): boolean {
  return screen.getByRole("switch", { name }).getAttribute("aria-checked") === "true";
}

function clickButton(name: string): Promise<void> {
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

function valueOf(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

describe("export preset dialog", () => {
  test("saving captures every control and persists it", async () => {
    const doc = docFixture();
    await mountDialog(doc);
    expect(screen.getByText("No presets yet")).toBeTruthy();
    change("Format", "canvasjs");
    change("Range", "frames");
    change("Scene to export", "s1");
    change("Start frame", "1");
    change("End frame", "3");
    change("Resolution scale", "0.5");
    change("Frame rate", "30");
    toggle("Loop playback");
    toggle("Transparent background");
    change("Preset name", "Web");
    await clickButton("Save preset");
    expect(screen.getByRole("button", { name: "Apply Web" })).toBeTruthy();
    expect((screen.getByLabelText("Preset name") as HTMLInputElement).value).toBe("");
    await waitFor(() =>
      expect(server.data.exportPresets).toEqual([
        {
          id: expect.any(String),
          name: "Web",
          updatedAt: expect.any(Number),
          settings: {
            format: "canvasjs",
            rangeKind: "frames",
            sceneId: "s1",
            start: 1,
            end: 3,
            scale: 0.5,
            fps: 30,
            loop: false,
            transparent: true
          }
        }
      ])
    );
  });

  test("an empty name gets a generated one", async () => {
    await mountDialog(docFixture());
    change("Frame rate", "60");
    await clickButton("Save preset");
    expect(
      screen.getByRole("button", { name: "Apply HTML5 · Whole · 100% · 60 fps" })
    ).toBeTruthy();
  });

  test("applying a preset updates every control", async () => {
    seedPresets([
      presetFixture("p1", "Web", {
        format: "canvasjs",
        rangeKind: "frames",
        sceneId: "s1",
        start: 1,
        end: 3,
        scale: 2,
        fps: 60,
        loop: false,
        transparent: true
      })
    ]);
    const doc = docFixture();
    await mountDialog(doc);
    expect(valueOf("Frame rate")).toBe("24");
    await clickButton("Apply Web");
    expect(valueOf("Format")).toBe("canvasjs");
    expect(valueOf("Range")).toBe("frames");
    expect(valueOf("Scene to export")).toBe("s1");
    expect(valueOf("Resolution scale")).toBe("2");
    expect(valueOf("Frame rate")).toBe("60");
    expect(valueOf("Start frame")).toBe("1");
    expect(valueOf("End frame")).toBe("3");
    expect(checked("Loop playback")).toBe(false);
    expect(checked("Transparent background")).toBe(true);
  });

  test("applying a whole range preset hides the frame inputs", async () => {
    seedPresets([presetFixture("p1", "Plain", { rangeKind: "whole" })]);
    await mountDialog(docFixture());
    change("Range", "frames");
    await clickButton("Apply Plain");
    expect((screen.getByLabelText("Range") as HTMLSelectElement).value).toBe("whole");
    expect(screen.queryByLabelText("Start frame")).toBeNull();
    expect(screen.queryByLabelText("End frame")).toBeNull();
  });

  test("a preset for a scene that no longer exists keeps the current scene", async () => {
    seedPresets([presetFixture("p1", "Stale", { rangeKind: "scene", sceneId: "gone" })]);
    await mountDialog(docFixture());
    await clickButton("Apply Stale");
    expect((screen.getByLabelText("Scene to export") as HTMLSelectElement).value).toBe("s0");
    expect((screen.getByLabelText("Range") as HTMLSelectElement).value).toBe("scene");
  });

  test("deleting a preset goes through the confirmation dialog", async () => {
    seedPresets([presetFixture("p1", "Web"), presetFixture("p2", "Other")]);
    await mountDialog(docFixture());
    await clickButton("Delete preset Web");
    expect(await screen.findByText("Delete preset")).toBeTruthy();
    await clickButton("Delete");
    await waitFor(() =>
      expect((server.data.exportPresets as ExportPreset[]).map((item) => item.id)).toEqual(["p2"])
    );
    expect(screen.queryByRole("button", { name: "Apply Web" })).toBeNull();
    expect(screen.getByRole("button", { name: "Apply Other" })).toBeTruthy();
  });

  test("cancelling the delete prompt keeps the preset", async () => {
    seedPresets([presetFixture("p1", "Web")]);
    await mountDialog(docFixture());
    await clickButton("Delete preset Web");
    await screen.findByText("Delete preset");
    await clickButton("Cancel");
    await waitFor(() => expect(screen.queryByText("Delete preset")).toBeNull());
    expect(screen.getByRole("button", { name: "Apply Web" })).toBeTruthy();
    expect((server.data.exportPresets as ExportPreset[] | undefined) ?? []).toHaveLength(1);
  });

  test("a duplicate name is refused", async () => {
    seedPresets([presetFixture("p1", "Web")]);
    await mountDialog(docFixture());
    change("Preset name", "web");
    await clickButton("Save preset");
    expect(await screen.findByText("Invalid name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply Web" })).toBeTruthy();
    expect((server.data.exportPresets as ExportPreset[]).map((item) => item.id)).toEqual(["p1"]);
  });

  test("saving degrades to local storage when the preference service is offline", async () => {
    server.online = false;
    await mountDialog(docFixture());
    change("Preset name", "Web");
    await clickButton("Save preset");
    expect(screen.getByRole("button", { name: "Apply Web" })).toBeTruthy();
    const raw = window.localStorage.getItem("stickmate.prefs");
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw as string) as { data: { exportPresets: ExportPreset[] } };
    expect(stored.data.exportPresets[0]?.name).toBe("Web");
    await clickButton("Delete preset Web");
    await screen.findByText("Delete preset");
    await clickButton("Delete");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Apply Web" })).toBeNull());
  });
});
