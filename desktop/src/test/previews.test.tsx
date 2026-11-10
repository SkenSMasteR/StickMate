import { runInThisContext } from "node:vm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import Projects from "@/app/hub/Projects";
import { Toaster } from "@/components/ui/sonner";
import { WorkspaceProvider } from "@/editor/workspace";
import { I18nProvider } from "@/i18n";
import { ConfirmProvider } from "@/lib/confirm";
import type { Document, Keyframe, Layer, Scene, Shape, Transform } from "@/lib/document";
import { PrefsProvider } from "@/lib/prefs";
import source from "@/export/runtime.js?raw";
import { store } from "./backend";

runInThisContext(source);

let log: unknown[][] = [];
let ids = new Map<HTMLCanvasElement, number>();

function recorder(index: number): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {};
  const methods = [
    "setTransform",
    "clearRect",
    "fillRect",
    "translate",
    "rotate",
    "scale",
    "drawImage",
    "beginPath",
    "moveTo",
    "lineTo",
    "bezierCurveTo",
    "closePath",
    "rect",
    "ellipse",
    "fill",
    "stroke",
    "fillText",
    "save",
    "transform",
    "restore"
  ];
  for (const name of methods) {
    target[name] = (...args: unknown[]) => {
      log.push([
        index,
        name,
        ...args.map((arg) => (arg instanceof HTMLCanvasElement ? ids.get(arg) : arg))
      ]);
    };
  }
  for (const name of [
    "fillStyle",
    "strokeStyle",
    "lineWidth",
    "lineCap",
    "lineJoin",
    "globalAlpha",
    "font",
    "textBaseline"
  ]) {
    let value: unknown = null;
    Object.defineProperty(target, name, {
      get: () => value,
      set: (next: unknown) => {
        value = next;
        log.push([index, `set:${name}`, next]);
      }
    });
  }
  return target as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  log = [];
  ids = new Map();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string
  ) {
    if (kind !== "2d") {
      return null;
    }
    let index = ids.get(this);
    if (index === undefined) {
      index = ids.size;
      ids.set(this, index);
    }
    return recorder(index);
  } as unknown as () => CanvasRenderingContext2D);
  vi.spyOn(globalThis, "setInterval");
});

const identity: Transform = { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 };

function key(frame: number, shapes: Shape[], patch: Partial<Keyframe> = {}): Keyframe {
  return { frame, shapes, transform: identity, tween: false, label: null, ...patch };
}

function layer(id: string, patch: Partial<Layer> = {}): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    effects: [],
    masked: false,
    length: 1,
    keys: [key(0, [])],
    folder: false,
    children: [],
    ...patch
  };
}

function scene(id: string, layers: Layer[]): Scene {
  return { id, name: id, layers };
}

function rect(fill: string): Shape {
  return { kind: "Rect", x: 10, y: 20, w: 30, h: 40, fill, stroke: "#000000", width: 2 };
}

function makeDoc(id: string, name: string, patch: Partial<Document> = {}): Document {
  return {
    id,
    name,
    width: 320,
    height: 240,
    fps: 24,
    background: "#ffffff",
    scenes: [scene("s0", [layer("l0")])],
    ...patch
  };
}

function seed(doc: Document): void {
  store.set(doc.id, { doc, undo: [], redo: [], updated_at: Date.now() });
}

let opened: string[] = [];

function mount(): RenderResult {
  opened = [];
  return render(
    <I18nProvider language="en" onLanguageChange={() => {}}>
      <ConfirmProvider>
        <PrefsProvider>
          <WorkspaceProvider>
            <Toaster />
            <Projects
              onOpened={(id) => {
                opened.push(id);
              }}
            />
          </WorkspaceProvider>
        </PrefsProvider>
      </ConfirmProvider>
    </I18nProvider>
  );
}

function card(name: string): HTMLElement {
  const found = screen.getByText(name).parentElement?.parentElement;
  if (!found) {
    throw new Error("project card is not mounted");
  }
  return found;
}

function canvasOf(name: string): HTMLCanvasElement {
  const found = card(name).querySelector("canvas");
  if (!found) {
    throw new Error("preview canvas is not mounted");
  }
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(target);
  });
}

function playbackTimers(): unknown[] {
  return vi
    .mocked(globalThis.setInterval)
    .mock.calls.filter((call) => (call[0] as () => void).name === "tick");
}

describe("project previews", () => {
  test("renders frame 0 with the shared export renderer and never plays", async () => {
    seed(
      makeDoc("d1", "Ball", {
        width: 320,
        height: 180,
        background: "#223344",
        scenes: [
          scene("s0", [
            layer("l0", {
              length: 10,
              keys: [
                key(0, [rect("#ff0000")], { tween: true }),
                key(9, [rect("#00ff00")], {
                  transform: { x: 100, y: 0, rotation: 0, scale: 1, opacity: 1 }
                })
              ]
            })
          ])
        ]
      })
    );
    mount();
    await screen.findByText("Ball");
    await waitFor(() =>
      expect(log.some((call) => call[1] === "fillRect")).toBe(true)
    );
    const canvas = canvasOf("Ball");
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(180);
    expect(canvas.className).toContain("max-h-full");
    expect(canvas.className).toContain("max-w-full");
    expect(log).toContainEqual([0, "set:fillStyle", "#223344"]);
    expect(log).toContainEqual([0, "fillRect", 0, 0, 320, 180]);
    expect(log).toContainEqual([1, "set:fillStyle", "#ff0000"]);
    expect(log).toContainEqual([1, "rect", 10, 20, 30, 40]);
    expect(log).toContainEqual([1, "translate", 0, 0]);
    expect(log.some((call) => call[2] === "#00ff00")).toBe(false);
    expect(playbackTimers()).toHaveLength(0);
    expect(screen.getByRole("img", { name: "Project preview" })).toBeTruthy();
  });

  test("each project renders at its own size and aspect ratio", async () => {
    seed(makeDoc("d1", "Wide", { width: 320, height: 180 }));
    seed(makeDoc("d2", "Square", { width: 200, height: 200 }));
    mount();
    await screen.findByText("Wide");
    await screen.findByText("Square");
    await waitFor(() =>
      expect(log.filter((call) => call[1] === "fillRect")).toHaveLength(2)
    );
    expect(canvasOf("Wide").width).toBe(320);
    expect(canvasOf("Wide").height).toBe(180);
    expect(canvasOf("Square").width).toBe(200);
    expect(canvasOf("Square").height).toBe(200);
    expect(screen.getAllByRole("img", { name: "Project preview" })).toHaveLength(2);
  });

  test("a project without scenes shows the neutral empty thumbnail", async () => {
    seed(makeDoc("d1", "Empty", { scenes: [] }));
    mount();
    await screen.findByText("Empty");
    await waitFor(() =>
      expect(
        within(card("Empty")).getByRole("img", { name: "No preview" })
      ).toBeTruthy()
    );
    expect(log.some((call) => call[1] === "fillRect")).toBe(false);
    await click(within(card("Empty")).getByRole("button", { name: "Pin" }));
    expect(
      within(card("Empty")).getByRole("button", { name: "Unpin" })
    ).toBeTruthy();
  });

  test("a project that cannot render keeps open, pin and delete working", async () => {
    seed(makeDoc("d1", "Good"));
    const brokenStroke = { kind: "Stroke", color: "#000000", width: 3 } as unknown as Shape;
    seed(
      makeDoc("d2", "Broken", {
        scenes: [scene("s0", [layer("l0", { keys: [key(0, [brokenStroke])] })])]
      })
    );
    mount();
    await screen.findByText("Broken");
    await waitFor(() =>
      expect(
        within(card("Broken")).getByRole("img", { name: "No preview" })
      ).toBeTruthy()
    );
    expect(
      within(card("Good")).getByRole("img", { name: "Project preview" })
    ).toBeTruthy();
    await click(within(card("Broken")).getByRole("button", { name: "Pin" }));
    expect(
      within(card("Broken")).getByRole("button", { name: "Unpin" })
    ).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("stickmate.pins") ?? "{}").d2).toBe(true);
    await click(within(card("Broken")).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(opened).toContain("d2"));
    await click(within(card("Broken")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Broken")).toBeNull());
    expect(store.has("d2")).toBe(false);
    expect(screen.getByText("Good")).toBeTruthy();
  });

  test("refresh updates previews, drops removed projects and unmount leaks nothing", async () => {
    seed(makeDoc("d1", "Alpha"));
    seed(makeDoc("d2", "Beta"));
    const view = mount();
    await screen.findByText("Alpha");
    await screen.findByText("Beta");
    await waitFor(() =>
      expect(log.filter((call) => call[1] === "fillRect")).toHaveLength(2)
    );
    store.delete("d2");
    await click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText("Beta")).toBeNull());
    expect(document.querySelectorAll("canvas")).toHaveLength(1);
    const entry = store.get("d1");
    if (!entry) {
      throw new Error("document is not in the store");
    }
    entry.doc.background = "#abcdef";
    entry.updated_at = Date.now() + 1000;
    await click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        log.some((call) => call[1] === "set:fillStyle" && call[2] === "#abcdef")
      ).toBe(true)
    );
    expect(document.querySelectorAll("canvas")).toHaveLength(1);
    view.unmount();
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
    expect(playbackTimers()).toHaveLength(0);
  });
});