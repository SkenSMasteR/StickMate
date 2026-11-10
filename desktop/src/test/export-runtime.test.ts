import { runInThisContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Document, Keyframe, Layer, Scene, Shape } from "@/lib/document";
import source from "@/export/runtime.js?raw";

runInThisContext(source);

interface Player {
  mount(canvas: HTMLCanvasElement): void;
  play(): void;
  pause(): void;
  seek(frame: number): void;
  setLoop(value: boolean): void;
  readonly frame: number;
  readonly frameCount: number;
  readonly fps: number;
  readonly playing: boolean;
}

const StickMate = (globalThis as unknown as { StickMate: { load(project: unknown): Player } })
  .StickMate;

type Payload = Document & {
  loop: boolean;
  scale: number;
  startFrame: number;
  endFrame: number | null;
};

const rect: Shape = {
  kind: "Rect",
  x: 10,
  y: 20,
  w: 30,
  h: 40,
  fill: "#3b82f6",
  stroke: "#000000",
  width: 2
};

function key(frame: number, shapes: Shape[] = [rect], patch: Partial<Keyframe> = {}): Keyframe {
  return {
    frame,
    shapes,
    transform: { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 },
    tween: false,
    label: null,
    ...patch
  };
}

function layer(id: string, patch: Partial<Layer> = {}): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    length: 4,
    keys: [key(0)],
    ...patch
  };
}

function scene(id: string, layers: Layer[]): Scene {
  return { id, name: id, layers };
}

function project(patch: Partial<Payload> = {}): Payload {
  return {
    id: "d0",
    name: "Runtime test",
    width: 200,
    height: 100,
    fps: 10,
    background: "#ffffff",
    scenes: [scene("s0", [layer("l0")])],
    loop: true,
    scale: 1,
    startFrame: 0,
    endFrame: null,
    ...patch
  };
}

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

function mountPlayer(payload: Payload): { player: Player; canvas: HTMLCanvasElement } {
  const canvas = document.createElement("canvas");
  const player = StickMate.load(payload);
  player.mount(canvas);
  return { player, canvas };
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
});

afterEach(() => {
  vi.useRealTimers();
});

describe("export runtime", () => {
  test("exposes a global api and a module export without dynamic code", () => {
    expect(typeof StickMate.load).toBe("function");
    expect(source).not.toMatch(/\beval\s*\(|new\s+Function|innerHTML/);
    const wrapped = runInThisContext(
      `(function (module) { ${source}\nreturn module.exports; })`
    ) as (module: { exports: unknown }) => { load: unknown };
    const exported = wrapped({ exports: {} });
    expect(typeof exported.load).toBe("function");
  });

  test("seek is deterministic and clamped", () => {
    const { player } = mountPlayer(project());
    log = [];
    player.seek(2);
    const first = [...log];
    player.seek(0);
    log = [];
    player.seek(2);
    expect(log).toEqual(first);
    expect(player.frame).toBe(2);
    player.seek(-5);
    expect(player.frame).toBe(0);
    player.seek(999);
    expect(player.frame).toBe(3);
    expect(player.frameCount).toBe(4);
    expect(player.fps).toBe(10);
  });

  test("playback advances at the document fps and pause stops it", () => {
    vi.useFakeTimers();
    const { player } = mountPlayer(project());
    player.play();
    expect(player.playing).toBe(true);
    vi.advanceTimersByTime(350);
    expect(player.frame).toBe(3);
    player.pause();
    vi.advanceTimersByTime(1000);
    expect(player.frame).toBe(3);
    expect(player.playing).toBe(false);
  });

  test("loop wraps to zero and non loop stops on the last frame", () => {
    vi.useFakeTimers();
    const { player } = mountPlayer(project());
    player.seek(3);
    player.play();
    vi.advanceTimersByTime(100);
    expect(player.frame).toBe(0);
    player.pause();
    player.setLoop(false);
    player.seek(3);
    player.play();
    vi.advanceTimersByTime(100);
    expect(player.frame).toBe(3);
    expect(player.playing).toBe(false);
    player.setLoop(true);
    player.play();
    vi.advanceTimersByTime(100);
    expect(player.frame).toBe(0);
  });

  test("frameCount concatenates scenes and honors an explicit frame range", () => {
    const multi = project({
      scenes: [
        scene("s0", [layer("l0")]),
        scene("s1", [layer("l1", { length: 3 })])
      ]
    });
    const { player } = mountPlayer(multi);
    expect(player.frameCount).toBe(7);
    const ranged = project({
      scenes: [
        scene("s0", [
          layer("l0", {
            length: 11,
            keys: [
              key(0, [rect], {
                tween: true,
                transform: { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 }
              }),
              key(10, [rect], {
                transform: { x: 100, y: 0, rotation: 0, scale: 1, opacity: 1 }
              })
            ]
          })
        ])
      ],
      startFrame: 2,
      endFrame: 5
    });
    log = [];
    const rangedPlayer = StickMate.load(ranged);
    rangedPlayer.mount(document.createElement("canvas"));
    expect(rangedPlayer.frameCount).toBe(4);
    expect(log.some((call) => call[1] === "translate" && call[2] === 20)).toBe(true);
  });

  test("hidden layers and frames past the layer length are skipped", () => {
    const payload = project({
      scenes: [
        scene("s0", [
          layer("l0"),
          layer("hidden", { visible: false }),
          layer("short", { length: 2 })
        ])
      ]
    });
    const { player } = mountPlayer(payload);
    log = [];
    player.seek(0);
    expect(log.filter((call) => call[1] === "drawImage")).toHaveLength(2);
    log = [];
    player.seek(3);
    expect(log.filter((call) => call[1] === "drawImage")).toHaveLength(1);
  });

  test("locked layers still render and opacity multiplies", () => {
    const payload = project({
      scenes: [
        scene("s0", [
          layer("l0", {
            locked: true,
            opacity: 0.5,
            keys: [
              key(0, [rect], {
                transform: { x: 0, y: 0, rotation: 0, scale: 1, opacity: 0.8 }
              })
            ]
          })
        ])
      ]
    });
    const { player } = mountPlayer(payload);
    expect(log).toContainEqual([0, "set:globalAlpha", 0.4]);
    expect(player.frameCount).toBe(4);
  });

  test("transparent background skips the fill and scale sizes the canvas", () => {
    log = [];
    const clear = mountPlayer(project({ background: "" }));
    expect(log.some((call) => call[1] === "fillRect")).toBe(false);
    expect(clear.canvas.width).toBe(200);
    log = [];
    ids = new Map();
    const scaled = mountPlayer(
      project({ width: 400, height: 200, scale: 2 })
    );
    expect(scaled.canvas.width).toBe(400);
    expect(scaled.canvas.height).toBe(200);
    expect(log).toContainEqual([1, "setTransform", 2, 0, 0, 2, 0, 0]);
  });

  test("tween interpolates transforms and held frames repeat the last key", () => {
    const payload = project({
      scenes: [
        scene("s0", [
          layer("l0", {
            length: 21,
            keys: [
              key(0, [rect], {
                tween: true,
                transform: { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 }
              }),
              key(10, [rect], {
                transform: { x: 100, y: 50, rotation: 90, scale: 2, opacity: 1 }
              }),
              key(15, [rect])
            ]
          })
        ])
      ]
    });
    const { player } = mountPlayer(payload);
    log = [];
    player.seek(5);
    expect(log).toContainEqual([1, "translate", 50, 25]);
    expect(log).toContainEqual([1, "rotate", Math.PI / 4]);
    expect(log).toContainEqual([1, "scale", 1.5, 1.5]);
    log = [];
    player.seek(12);
    expect(log).toContainEqual([1, "translate", 100, 50]);
    log = [];
    player.seek(18);
    expect(log).toContainEqual([1, "translate", 0, 0]);
  });

  test("text draws with the hanging baseline and never touches markup", () => {
    const text: Shape = {
      kind: "Text",
      x: 5,
      y: 6,
      text: "<b>hi</b>",
      size: 24,
      family: "Segoe UI",
      color: "#111111"
    };
    const { player } = mountPlayer(
      project({ scenes: [scene("s0", [layer("l0", { keys: [key(0, [text])] })])] })
    );
    player.seek(0);
    expect(log).toContainEqual([1, "set:font", "24px Segoe UI"]);
    expect(log).toContainEqual([1, "set:textBaseline", "hanging"]);
    expect(log).toContainEqual([1, "fillText", "<b>hi</b>", 5, 6]);
  });

  test("play before mount is a no-op", () => {
    const player = StickMate.load(project());
    player.play();
    expect(player.playing).toBe(false);
  });
});