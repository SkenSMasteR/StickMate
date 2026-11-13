import { beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import Projects from "@/app/hub/Projects";
import { Toaster } from "@/components/ui/sonner";
import { WorkspaceProvider } from "@/editor/workspace";
import { I18nProvider } from "@/i18n";
import en from "@/i18n/en.json";
import { ConfirmProvider } from "@/lib/confirm";
import { humanoidFigure } from "@/lib/document";
import type { Document, Keyframe, Layer, Scene, Shape } from "@/lib/document";
import { clearFlaReport, getFlaReport } from "@/lib/fla-report";
import { PrefsProvider } from "@/lib/prefs";
import { store } from "./backend";
import { nextImport, written } from "./backend/fla";
import { nextOpenPath, nextSavePath } from "./backend/dialog";
import { flush, getCanvas, renderEditor } from "./utils";

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

function instance(): Shape {
  return {
    kind: "Instance",
    symbol: "y0",
    name: "Guy",
    visible: true,
    firstFrame: 0,
    looping: "loop"
  };
}

function seed(doc: Document): void {
  store.set(doc.id, { doc, undo: [], redo: [], updated_at: Date.now() });
}

function mount(onReport = () => {}): void {
  render(
    <I18nProvider language="en" onLanguageChange={() => {}}>
      <ConfirmProvider>
        <PrefsProvider>
          <WorkspaceProvider>
            <Toaster />
            <Projects onOpened={() => {}} onReport={onReport} />
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
  beforeEach(() => {
    clearFlaReport();
    toast.dismiss();
  });

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

  test("keeps the constructs the export flattened in the report", async () => {
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
          layers: [
            layer({
              blend: "multiply",
              keys: [
                keyframe(
                  [
                    square(),
                    { kind: "Figure", figure: humanoidFigure(10, 10, 100) },
                    { kind: "Group", children: [instance()] }
                  ],
                  true
                )
              ]
            })
          ]
        }
      ]
    });
    const onReport = vi.fn();
    nextSavePath("C:/Users/Test/Downloads/Flat.fla");
    mount(onReport);
    fireEvent.click(await exportButton("Flat"));
    await waitFor(() =>
      expect(written.get("C:/Users/Test/Downloads/Flat.fla")).toBe("Flat")
    );
    const entry = await screen.findByText("Open report");
    expect(getFlaReport()).toHaveLength(1);
    expect(getFlaReport()[0].kind).toBe("export");
    expect(getFlaReport()[0].lines).toEqual([
      "blend modes are not exported",
      "tweens are exported as keyframes that hold until the next key",
      "stick figures are exported as the lines they draw, without the rig"
    ]);
    expect(screen.queryByText("blend modes are not exported")).toBeNull();
    fireEvent.click(entry);
    expect(onReport).toHaveBeenCalledOnce();
  });

  test("imports an animate file as a new project", async () => {
    mount();
    nextOpenPath("C:/Users/Test/Downloads/tut.fla");
    nextImport({ name: "Tut", notes: ["6577 library symbols were not imported"] });
    fireEvent.click(screen.getByText("Import"));
    expect(await screen.findByText("Tut")).toBeTruthy();
    expect(getFlaReport()).toHaveLength(1);
    expect(getFlaReport()[0].kind).toBe("import");
    expect(getFlaReport()[0].name).toBe("C:/Users/Test/Downloads/tut.fla");
    expect(getFlaReport()[0].lines).toEqual(["6577 library symbols were not imported"]);
    expect(screen.queryByText("6577 library symbols were not imported")).toBeNull();
  });

  test("keeps the report empty when nothing was flattened", async () => {
    seed({
      id: "p4",
      name: "Clean",
      width: 320,
      height: 240,
      fps: 24,
      background: "#ffffff",
      scenes: [{ id: "s0", name: "Scene 1", layers: [layer()] }]
    });
    nextSavePath("C:/Users/Test/Downloads/Clean.fla");
    mount();
    fireEvent.click(await exportButton("Clean"));
    await waitFor(() =>
      expect(written.get("C:/Users/Test/Downloads/Clean.fla")).toBe("Clean")
    );
    expect(getFlaReport()).toHaveLength(0);
    expect(screen.queryByText("Open report")).toBeNull();
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

describe("animate exchange in the editor", () => {
  beforeEach(() => {
    clearFlaReport();
    toast.dismiss();
  });

  async function openFileMenu(): Promise<void> {
    fireEvent.pointerDown(screen.getByRole("button", { name: en["menu.file"] }), {
      button: 0
    });
    await flush();
  }

  test("the file menu imports an animate file into the report panel", async () => {
    await renderEditor();
    nextOpenPath("C:/Users/Test/Downloads/tut.fla");
    nextImport({ name: "Tut", notes: ["6577 library symbols were not imported"] });
    await openFileMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: en["command.importAnimate"] })
    );
    await waitFor(() => expect(getCanvas(640, 360)).toBeTruthy());
    expect(screen.getByRole("tab", { name: en["panel.report"] })).toBeTruthy();
    expect(screen.getByText("library symbols were not imported")).toBeTruthy();
    expect(screen.getByText("6577")).toBeTruthy();
  }, 30000);

  test("the file menu exports the open project through the same command", async () => {
    const { doc } = await renderEditor();
    nextSavePath("C:/Users/Test/Downloads/Test.fla");
    await openFileMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: en["command.exportAnimate"] })
    );
    await waitFor(() => expect(written.get("C:/Users/Test/Downloads/Test.fla")).toBe(doc.name));
    expect(getFlaReport()).toHaveLength(0);
    expect(screen.queryByRole("tab", { name: en["panel.report"] })).toBeNull();
  }, 30000);
});
