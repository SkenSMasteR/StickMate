import { runInThisContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import en from "@/i18n/en.json";
import source from "@/export/runtime.js?raw";
import {
  clampEasing,
  docDraw,
  docEvaluate,
  docKeyframe,
  docNew,
  docSetTween,
  easeProgress,
  easingPresets,
  linearEasing,
  sameEasing
} from "@/lib/document";
import type {
  Document,
  Easing,
  Keyframe,
  Layer,
  Shape,
  Transform
} from "@/lib/document";
import { installBackend, store } from "./backend";
import { flush, press, renderEditor } from "./utils";

runInThisContext(source);

interface Player {
  mount(canvas: HTMLCanvasElement): void;
  seek(frame: number): void;
  pause(): void;
}

const StickMate = (
  globalThis as unknown as { StickMate: { load(project: unknown): Player } }
).StickMate;

const easeIn: Easing = { x1: 0.42, y1: 0, x2: 1, y2: 1 };
const easeOut: Easing = { x1: 0, y1: 0, x2: 0.58, y2: 1 };
const easeInOut: Easing = { x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
const springy: Easing = { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };
const half = 0.3153568125058931;
const presetIds = ["linear", "easeIn", "easeOut", "easeInOut", "custom"];
const still: Transform = { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 };

type Entry = unknown[];
let log: Entry[] = [];
let ids = new Map<HTMLCanvasElement, number>();

function recorder(index: number): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {};
  for (const name of [
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
  ]) {
    target[name] = (...args: unknown[]) => {
      log.push([index, name, ...args]);
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

function recordCanvas(): void {
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
}

function box(x: number): Shape {
  return {
    kind: "Rect",
    x,
    y: 20,
    w: 30,
    h: 20,
    fill: "#3b82f6",
    stroke: "#000000",
    width: 2
  };
}

function at(frame: number, patch: Partial<Keyframe> = {}): Keyframe {
  return {
    frame,
    shapes: [],
    transform: { ...still },
    tween: false,
    easing: { ...linearEasing },
    label: null,
    ...patch
  };
}

function animated(easing: Easing | undefined): Layer {
  return {
    id: "l0",
    name: "Layer 1",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    effects: [],
    masked: false,
    length: 11,
    keys: [
      at(0, { tween: true, easing, shapes: [box(0)] }),
      at(10, { shapes: [box(100)], transform: { ...still, x: 200 } })
    ]
  };
}

function state(id: string) {
  const found = store.get(id);
  if (!found) {
    throw new Error("document is not in the store");
  }
  return found;
}

function firstKey(id: string): Keyframe {
  return state(id).doc.scenes[0].layers[0].keys[0];
}

function curve(id: string): Easing {
  return firstKey(id).easing ?? linearEasing;
}

async function engineDoc(layer: Layer): Promise<{ doc: Document; scene: string }> {
  installBackend("editor");
  const doc = await docNew("Easing", 200, 100, 10, "#ffffff");
  const current = state(doc.id);
  current.doc.scenes[0].layers = [layer];
  return { doc: current.doc, scene: current.doc.scenes[0].id };
}

function painted(shape: Shape | undefined): number {
  const item = shape as Extract<Shape, { kind: "Rect" }>;
  return item.x;
}

describe("curve maths", () => {
  test("the endpoints and the straight line never move", () => {
    expect(easeProgress(0, easeIn)).toBe(0);
    expect(easeProgress(1, easeIn)).toBe(1);
    expect(easeProgress(-1, springy)).toBe(0);
    expect(easeProgress(2, springy)).toBe(1);
    expect(easeProgress(0.37, linearEasing)).toBe(0.37);
    expect(easeProgress(0.37, null)).toBe(0.37);
    expect(easeProgress(0.37, undefined)).toBe(0.37);
    expect(easeProgress(0.37, { x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.8 })).toBe(0.37);
  });

  test("every preset keeps the css signature at the middle", () => {
    expect(easingPresets.map((preset) => preset.id)).toEqual([
      "linear",
      "easeIn",
      "easeOut",
      "easeInOut"
    ]);
    expect(sameEasing(easingPresets[1].easing, easeIn)).toBe(true);
    expect(sameEasing(easingPresets[2].easing, easeOut)).toBe(true);
    expect(sameEasing(easingPresets[3].easing, easeInOut)).toBe(true);
    expect(easeProgress(0.5, easeIn)).toBeCloseTo(half, 9);
    expect(easeProgress(0.5, easeOut)).toBeCloseTo(1 - half, 9);
    expect(easeProgress(0.5, easeInOut)).toBeCloseTo(0.5, 9);
  });

  test("progress climbs without turning back", () => {
    for (const easing of [linearEasing, easeIn, easeOut, easeInOut]) {
      let previous = 0;
      for (let step = 0; step <= 20; step += 1) {
        const value = easeProgress(step / 20, easing);
        if (step > 0) {
          expect(value, JSON.stringify(easing)).toBeGreaterThanOrEqual(previous);
        }
        previous = value;
      }
      expect(previous).toBe(1);
    }
  });

  test("an overshoot leaves the unit band and still closes on one", () => {
    const samples = Array.from({ length: 19 }, (_, index) =>
      easeProgress((index + 1) / 20, springy)
    );
    expect(Math.max(...samples)).toBeGreaterThan(1);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThanOrEqual(2);
    expect(easeProgress(1, springy)).toBe(1);
  });

  test("ease in crawls and ease out rushes", () => {
    expect(easeProgress(0.25, easeIn)).toBeLessThan(0.25);
    expect(easeProgress(0.75, easeIn)).toBeLessThan(0.75);
    expect(easeProgress(0.75, easeIn)).toBeGreaterThan(0.5);
    expect(easeProgress(0.25, easeOut)).toBeGreaterThan(0.25);
    expect(easeProgress(0.75, easeOut)).toBeGreaterThan(0.75);
    expect(easeProgress(0.25, easeInOut)).toBeLessThan(0.25);
  });

  test("control points are bounded and junk falls back to linear", () => {
    expect(clampEasing({ x1: -2, y1: 5, x2: 3, y2: -3 })).toEqual({
      x1: 0,
      y1: 2,
      x2: 1,
      y2: -1
    });
    expect(clampEasing({ x1: Number.NaN, y1: 0, x2: 1, y2: 1 })).toEqual(linearEasing);
    expect(clampEasing({ x1: 0, y1: Number.POSITIVE_INFINITY, x2: 1, y2: 1 })).toEqual(
      linearEasing
    );
    expect(clampEasing(easeInOut)).toEqual(easeInOut);
  });
});

describe("eased evaluation", () => {
  test("a tween eases the middle and holds both ends", async () => {
    const { doc, scene } = await engineDoc(animated({ ...easeIn }));
    const frames = await docEvaluate(doc.id, scene, 0, 10);
    expect(frames).toHaveLength(11);
    expect(painted(frames[0].layers[0].shapes[0])).toBe(0);
    expect(frames[0].layers[0].transform.x).toBe(0);
    expect(painted(frames[10].layers[0].shapes[0])).toBe(100);
    expect(frames[10].layers[0].transform.x).toBe(200);
    expect(painted(frames[5].layers[0].shapes[0])).toBeCloseTo(100 * half, 9);
    expect(frames[5].layers[0].transform.x).toBeCloseTo(200 * half, 9);
    expect(frames[5].layers[0].transform.x).not.toBe(100);
  });

  test("a missing curve stays exactly linear", async () => {
    const { doc, scene } = await engineDoc(animated(undefined));
    const frames = await docEvaluate(doc.id, scene, 0, 10);
    const track = frames.map((item) => painted(item.layers[0].shapes[0]));
    expect(track[5]).toBe(50);
    expect(track).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  test("an overshoot passes the far key and still lands on it", async () => {
    const { doc, scene } = await engineDoc(animated({ ...springy }));
    const frames = await docEvaluate(doc.id, scene, 0, 10);
    const moved = frames.map((item) => item.layers[0].transform.x);
    expect(Math.max(...moved)).toBeGreaterThan(200);
    expect(moved[10]).toBe(200);
    expect(painted(frames[10].layers[0].shapes[0])).toBe(100);
    expect(painted(frames[0].layers[0].shapes[0])).toBe(0);
  });

  test("the stored curve survives toggles and clamps on write", async () => {
    const { doc } = await engineDoc(animated({ ...easeIn }));
    const scene = doc.scenes[0].id;
    await docSetTween(doc.id, scene, "l0", 0, true, easeIn);
    expect(firstKey(doc.id).tween).toBe(true);
    expect(curve(doc.id)).toEqual(easeIn);
    await docSetTween(doc.id, scene, "l0", 0, false);
    expect(firstKey(doc.id).tween).toBe(false);
    expect(curve(doc.id)).toEqual(easeIn);
    await docSetTween(doc.id, scene, "l0", 0, true);
    expect(firstKey(doc.id).tween).toBe(true);
    expect(curve(doc.id)).toEqual(easeIn);
    await docSetTween(doc.id, scene, "l0", 0, true, { x1: -2, y1: 5, x2: 3, y2: -3 });
    expect(curve(doc.id)).toEqual({ x1: 0, y1: 2, x2: 1, y2: -1 });
    await docSetTween(doc.id, scene, "l0", 0, true, {
      x1: Number.NaN,
      y1: 0,
      x2: 1,
      y2: 1
    });
    expect(curve(doc.id)).toEqual(linearEasing);
  });

  test("the exported player reads the same curve", async () => {
    const { doc, scene } = await engineDoc(animated({ ...easeIn }));
    const middle = await docEvaluate(doc.id, scene, 5, 5);
    const layer = middle[0].layers[0];
    recordCanvas();
    const canvas = document.createElement("canvas");
    const player = StickMate.load({
      ...doc,
      loop: false,
      scale: 1,
      startFrame: 0,
      endFrame: null
    });
    player.mount(canvas);
    log = [];
    player.seek(5);
    const moved = log
      .filter((entry) => entry[1] === "translate")
      .map((entry) => [entry[2], entry[3]]);
    expect(moved).toContainEqual([layer.transform.x, layer.transform.y]);
    const drawn = log.filter((entry) => entry[1] === "rect").map((entry) => entry.slice(2, 6));
    expect(drawn).toEqual([
      [
        painted(layer.shapes[0]),
        20,
        30,
        20
      ]
    ]);
    player.pause();
  });
});

function propertiesPanel(): HTMLElement {
  const section = screen
    .getByRole("heading", { name: en["editor.properties"] })
    .closest("section");
  if (!section) {
    throw new Error("the properties panel is not mounted");
  }
  return section as HTMLElement;
}

function preset(id: string): HTMLButtonElement {
  const button = propertiesPanel().querySelector<HTMLButtonElement>(`[data-easing-preset="${id}"]`);
  if (!button) {
    throw new Error(`the ${id} easing control is not mounted`);
  }
  return button;
}

function handle(hook: string): HTMLInputElement {
  const input = propertiesPanel().querySelector<HTMLInputElement>(
    `[data-easing-handle="${hook}"]`
  );
  if (!input) {
    throw new Error(`the ${hook} handle is not mounted`);
  }
  return input;
}

function pressed(button: HTMLButtonElement): boolean {
  return button.getAttribute("aria-pressed") === "true";
}

function tweenToggle(): HTMLButtonElement {
  return within(propertiesPanel()).getByRole("button", {
    name: en["editor.tween"]
  }) as HTMLButtonElement;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(target);
  });
  await flush();
}

async function write(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
  await act(async () => {
    fireEvent.blur(input);
  });
  await flush();
}

async function stage(): Promise<Document> {
  const { doc } = await renderEditor();
  const scene = doc.scenes[0].id;
  const layer = doc.scenes[0].layers[0].id;
  await docDraw(doc.id, scene, layer, 0, box(0));
  await docKeyframe(doc.id, scene, layer, 10, true);
  await docDraw(doc.id, scene, layer, 10, box(100));
  await press("f6");
  return doc;
}

describe("easing controls", () => {
  test("the curve stays off until the keyframe tweens", async () => {
    const doc = await stage();
    for (const id of presetIds) {
      expect(preset(id).disabled, id).toBe(true);
    }
    expect(handle("1x").disabled).toBe(true);
    expect(handle("2y").disabled).toBe(true);
    await click(tweenToggle());
    expect(firstKey(doc.id).tween).toBe(true);
    expect(curve(doc.id)).toEqual(linearEasing);
    for (const id of presetIds) {
      expect(preset(id).disabled, id).toBe(false);
    }
    expect(pressed(preset("linear"))).toBe(true);
    expect(handle("1x").disabled).toBe(false);
    expect(handle("1x").value).toBe("0");
    await click(preset("easeIn"));
    expect(sameEasing(curve(doc.id), easeIn)).toBe(true);
    expect(pressed(preset("easeIn"))).toBe(true);
    expect(pressed(preset("linear"))).toBe(false);
    expect(handle("1x").value).toBe("0.42");
    const eased = await docEvaluate(doc.id, doc.scenes[0].id, 5, 5);
    expect(painted(eased[0].layers[0].shapes[0])).toBeCloseTo(100 * half, 9);
    await click(preset("linear"));
    const straight = await docEvaluate(doc.id, doc.scenes[0].id, 5, 5);
    expect(painted(straight[0].layers[0].shapes[0])).toBe(50);
    await click(preset("easeIn"));
    await click(tweenToggle());
    expect(firstKey(doc.id).tween).toBe(false);
    expect(sameEasing(curve(doc.id), easeIn)).toBe(true);
    for (const id of presetIds) {
      expect(pressed(preset(id)), id).toBe(false);
    }
    await click(tweenToggle());
    expect(pressed(preset("easeIn"))).toBe(true);
  });

  test("a typed handle writes a clamped custom curve", async () => {
    const doc = await stage();
    await click(tweenToggle());
    await click(preset("easeOut"));
    expect(sameEasing(curve(doc.id), easeOut)).toBe(true);
    expect(handle("1x")).toBe(screen.getByLabelText(`${en["easing.handle1"]} x`));
    expect(handle("2y")).toBe(screen.getByLabelText(`${en["easing.handle2"]} y`));
    await write(handle("1x"), "0.5");
    expect(curve(doc.id)).toEqual({ x1: 0.5, y1: 0, x2: 0.58, y2: 1 });
    expect(pressed(preset("custom"))).toBe(true);
    expect(pressed(preset("easeOut"))).toBe(false);
    const input = handle("1y");
    await act(async () => {
      fireEvent.change(input, { target: { value: "0.9" } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    await flush();
    expect(curve(doc.id).y1).toBe(0);
    await write(handle("2y"), "3");
    expect(curve(doc.id).y2).toBe(2);
    await write(handle("1y"), "-0.5");
    expect(curve(doc.id).y1).toBe(-0.5);
    const eased = await docEvaluate(doc.id, doc.scenes[0].id, 5, 5);
    expect(painted(eased[0].layers[0].shapes[0])).toBeGreaterThan(50);
  });

  test("undo returns the curve to the previous shape", async () => {
    const doc = await stage();
    await click(tweenToggle());
    const before = JSON.stringify(firstKey(doc.id));
    await click(preset("easeInOut"));
    expect(JSON.stringify(firstKey(doc.id))).not.toBe(before);
    await press("z", { ctrlKey: true });
    expect(JSON.stringify(firstKey(doc.id))).toBe(before);
  });
});
