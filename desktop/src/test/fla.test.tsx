import { describe, expect, test } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Projects from "@/app/hub/Projects";
import { Toaster } from "@/components/ui/sonner";
import { WorkspaceProvider } from "@/editor/workspace";
import { I18nProvider } from "@/i18n";
import { ConfirmProvider } from "@/lib/confirm";
import type { Document, Keyframe, Layer, Scene, Shape } from "@/lib/document";
import { PrefsProvider } from "@/lib/prefs";
import { store } from "./backend";
import { nextImport, written } from "./backend/fla";
import { nextOpenPath, nextSavePath } from "./backend/dialog";

function keyframe(shapes: Shape[], tween = false): Keyframe {
  return {
    frame: 0,
    shapes,
    transform: { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 },
    tween,
    easing: { x1: 0, y1: 0, x2: 1, y2: 1 },
    label: null
  };
}

function layer(patch: Partial<Layer> = {}): Layer {
  return {
    id: "l0",
    name: "Layer 1",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    effects: [],
    masked: false,
    length: 12,
    keys: [keyframe([])],
    folder: false,
    children: [],
    ...patch
  };
}

function square(): Shape {
  return {
    kind: "Rect",
    x: 10,
    y: 10,
    w: 40,
    h: 30,
    fill: "#ff0000",
    stroke: "none",
    width: 0,
    gradient: {
      kind: "linear",
      angle: 45,
      stops: [
        { offset: 0, color: "#ff0000" },
        { offset: 1, color: "#0000ff" }
      ]
    }
  };
}

function seed(doc: Document): void {
  store.set(doc.id, { doc, undo: [], redo: [], updated_at: Date.now() });
}

function mount(): void {
  render(
    <I18nProvider language="en" onLanguageChange={() => {}}>
      <ConfirmProvider>
        <PrefsProvider>
          <WorkspaceProvider>
            <Toaster />
            <Projects onOpened={() => {}} />
          </WorkspaceProvider>
        </PrefsProvider>
      </ConfirmProvider>
    </I18nProvider>
  );
}

async function exportButton(name: string): Promise<HTMLButtonElement> {
  const title = await screen.findByText(name);
  const card = title.parentElement?.parentElement;
  const found = card
    ? [...card.querySelectorAll("button")].find((button) => button.textContent === "Export")
    : undefined;
  if (!found) {
    throw new Error("export button is not mounted");
  }
  return found;
}

describe("animate project exchange", () => {
  test("exports the picked project to the chosen path", async () => {
    seed({
      id: "p1",
      name: "Bounce",
      width: 320,
      height: 240,
      fps: 24,
      background: "#ffffff",
      scenes: [{ id: "s0", name: "Scene 1", layers: [layer()] } satisfies Scene]
    });
    nextSavePath("C:/Users/Test/Downloads/Bounce.fla");
    mount();
    fireEvent.click(await exportButton("Bounce"));
    await waitFor(() =>
      expect(written.get("C:/Users/Test/Downloads/Bounce.fla")).toBe("Bounce")
    );
  });

  test("reports the constructs the export flattened", async () => {
    seed({
      id: "p2",
      name: "Flat",
      width: 320,
      height: 240,
      fps: 24,
      background: "#ffffff",
      scenes: [
        {
          id: "s0",
          name: "Scene 1",
          layers: [layer({ blend: "multiply", keys: [keyframe([square()], true)] })]
        }
      ]
    });
    nextSavePath("C:/Users/Test/Downloads/Flat.fla");
    mount();
    fireEvent.click(await exportButton("Flat"));
    await waitFor(() =>
      expect(written.get("C:/Users/Test/Downloads/Flat.fla")).toBe("Flat")
    );
    expect(await screen.findByText("gradient fills are exported as flat colours")).toBeTruthy();
    expect(screen.getByText("blend modes are not exported")).toBeTruthy();
    expect(screen.getByText("tweens are exported as keyframes that hold until the next key")).toBeTruthy();
  });

  test("imports an animate file as a new project", async () => {
    mount();
    nextOpenPath("C:/Users/Test/Downloads/tut.fla");
    nextImport({ name: "Tut", notes: ["symbol instances were skipped"] });
    fireEvent.click(screen.getByText("Import"));
    expect(await screen.findByText("Tut")).toBeTruthy();
    expect(await screen.findByText("symbol instances were skipped")).toBeTruthy();
  });

  test("does nothing when the save dialog is cancelled", async () => {
    seed({
      id: "p3",
      name: "Kept",
      width: 320,
      height: 240,
      fps: 24,
      background: "#ffffff",
      scenes: [{ id: "s0", name: "Scene 1", layers: [layer()] }]
    });
    nextSavePath(null);
    mount();
    fireEvent.click(await exportButton("Kept"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(written.size).toBe(0);
  });
});
