import { runInThisContext } from "node:vm";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Canvas from "@/editor/Canvas";
import ExportDialog from "@/editor/ExportDialog";
import { useWorkspace, WorkspaceProvider } from "@/editor/workspace";
import { I18nProvider } from "@/i18n";
import { ConfirmProvider } from "@/lib/confirm";
import type { Document, Keyframe, Layer, Scene, Shape, Transform } from "@/lib/document";
import { exportWeb } from "@/lib/export";
import { PrefsProvider } from "@/lib/prefs";
import source from "@/export/runtime.js?raw";
import { store } from "./backend";
import { disk } from "./backend/export";

runInThisContext(source);

interface Player {
  mount(canvas: HTMLCanvasElement): void;
  play(): void;
  pause(): void;
  seek(frame: number): void;
  setLoop(value: boolean): boolean | void;
  readonly frame: number;
  readonly frameCount: number;
  readonly fps: number;
  readonly playing: boolean;
}

const StickMate = (globalThis as unknown as { StickMate: { load(project: unknown): Player } })
  .StickMate;

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
});

afterEach(() => {
  vi.useRealTimers();
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
    length: 1,
    keys: [key(0, [])],
    ...patch
  };
}

function scene(id: string, layers: Layer[]): Scene {
  return { id, name: id, layers };
}

function pointsAttr(el: Element): number[][] {
  return (el.getAttribute("points") ?? "")
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number));
}

function translateShape(el: Element, calls: unknown[][]): void {
  const tag = el.tagName.toLowerCase();
  if (tag === "polyline") {
    calls.push([1, "set:strokeStyle", el.getAttribute("stroke")]);
    calls.push([1, "set:lineWidth", Number(el.getAttribute("stroke-width"))]);
    calls.push([1, "set:lineCap", "round"]);
    calls.push([1, "set:lineJoin", "round"]);
    calls.push([1, "beginPath"]);
    pointsAttr(el).forEach((point, index) => {
      calls.push([1, index === 0 ? "moveTo" : "lineTo", point[0], point[1]]);
    });
    calls.push([1, "stroke"]);
    return;
  }
  if (tag === "text") {
    calls.push([1, "save"]);
    const matrix = el.getAttribute("transform");
    if (matrix) {
      calls.push([1, "transform", ...(matrix.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? []).map(Number)]);
    }
    calls.push([1, "set:fillStyle", el.getAttribute("fill")]);
    calls.push([
      1,
      "set:font",
      `${el.getAttribute("font-size")}px ${el.getAttribute("font-family")}`
    ]);
    calls.push([1, "set:textBaseline", "hanging"]);
    calls.push([
      1,
      "fillText",
      el.textContent,
      Number(el.getAttribute("x")),
      Number(el.getAttribute("y"))
    ]);
    calls.push([1, "restore"]);
    return;
  }
  if (tag === "path") {
    const d = el.getAttribute("d") ?? "";
    const closed = d.endsWith("Z");
    if (closed) {
      calls.push([1, "set:fillStyle", el.getAttribute("fill")]);
    }
    calls.push([1, "set:strokeStyle", el.getAttribute("stroke")]);
    calls.push([1, "set:lineWidth", Number(el.getAttribute("stroke-width"))]);
    calls.push([1, "set:lineCap", "round"]);
    calls.push([1, "set:lineJoin", "round"]);
    calls.push([1, "beginPath"]);
    for (const part of d.match(/[MCZ][^MCZ]*/g) ?? []) {
      const numbers = part
        .slice(1)
        .trim()
        .split(/[\s,]+/)
        .filter((token) => token !== "")
        .map(Number);
      if (part[0] === "M") {
        calls.push([1, "moveTo", numbers[0], numbers[1]]);
      } else if (part[0] === "C") {
        calls.push([1, "bezierCurveTo", ...numbers]);
      } else {
        calls.push([1, "closePath"]);
      }
    }
    if (closed) {
      calls.push([1, "fill"]);
    }
    calls.push([1, "stroke"]);
    return;
  }
  calls.push([1, "set:fillStyle", el.getAttribute("fill")]);
  calls.push([1, "set:strokeStyle", el.getAttribute("stroke")]);
  calls.push([1, "set:lineWidth", Number(el.getAttribute("stroke-width"))]);
  calls.push([1, "set:lineCap", "butt"]);
  calls.push([1, "set:lineJoin", tag === "polygon" ? "round" : "miter"]);
  calls.push([1, "beginPath"]);
  if (tag === "rect") {
    calls.push([
      1,
      "rect",
      Number(el.getAttribute("x")),
      Number(el.getAttribute("y")),
      Number(el.getAttribute("width")),
      Number(el.getAttribute("height"))
    ]);
  } else if (tag === "ellipse") {
    calls.push([
      1,
      "ellipse",
      Number(el.getAttribute("cx")),
      Number(el.getAttribute("cy")),
      Number(el.getAttribute("rx")),
      Number(el.getAttribute("ry")),
      0,
      0,
      Math.PI * 2
    ]);
  } else {
    pointsAttr(el).forEach((point, index) => {
      calls.push([1, index === 0 ? "moveTo" : "lineTo", point[0], point[1]]);
    });
    calls.push([1, "closePath"]);
  }
  calls.push([1, "fill"]);
  calls.push([1, "stroke"]);
}

function translateSvg(svg: SVGSVGElement, width: number, height: number): unknown[][] {
  const calls: unknown[][] = [];
  calls.push([0, "setTransform", 1, 0, 0, 1, 0, 0]);
  calls.push([0, "clearRect", 0, 0, width, height]);
  const children = [...svg.children];
  const background = children[0];
  calls.push([0, "set:fillStyle", background.getAttribute("fill")]);
  calls.push([0, "fillRect", 0, 0, width, height]);
  for (const outer of children.slice(1)) {
    const inner = outer.querySelector("g");
    if (!inner) {
      throw new Error("layer group is missing");
    }
    const transform = inner.getAttribute("transform") ?? "";
    const match = /^translate\((\S+) (\S+)\) rotate\((\S+)\) scale\((\S+)\)$/.exec(transform);
    if (!match) {
      throw new Error(`unexpected transform ${transform}`);
    }
    calls.push([1, "setTransform", 1, 0, 0, 1, 0, 0]);
    calls.push([1, "clearRect", 0, 0, width, height]);
    calls.push([1, "setTransform", 1, 0, 0, 1, 0, 0]);
    calls.push([1, "translate", Number(match[1]), Number(match[2])]);
    calls.push([1, "rotate", (Number(match[3]) * Math.PI) / 180]);
    calls.push([1, "scale", Number(match[4]), Number(match[4])]);
    for (const wrapper of inner.children) {
      const shape = wrapper.firstElementChild;
      if (!shape) {
        throw new Error("shape element is missing");
      }
      translateShape(shape, calls);
    }
    calls.push([0, "setTransform", 1, 0, 0, 1, 0, 0]);
    calls.push([0, "set:globalAlpha", Number(inner.getAttribute("opacity"))]);
    calls.push([0, "drawImage", 1, 0, 0]);
    calls.push([0, "set:globalAlpha", 1]);
  }
  return calls;
}

function expectCalls(received: unknown[][], expected: unknown[][], label: string): void {
  expect(received.length, `${label} call count`).toBe(expected.length);
  received.forEach((call, index) => {
    const want = expected[index];
    expect(call.length, `${label} call ${index} ${JSON.stringify(want)}`).toBe(want.length);
    call.forEach((value, arg) => {
      const target = want[arg];
      if (typeof target === "number" && typeof value === "number") {
        expect(value, `${label} call ${index} arg ${arg}`).toBeCloseTo(target, 9);
      } else {
        expect(value, `${label} call ${index} arg ${arg}`).toEqual(target);
      }
    });
  });
}

let latest: ReturnType<typeof useWorkspace> | null = null;

function Probe() {
  latest = useWorkspace();
  return <Canvas />;
}

function mountProbe(): void {
  latest = null;
  render(
    <I18nProvider language="en" onLanguageChange={() => {}}>
      <ConfirmProvider>
        <PrefsProvider>
          <WorkspaceProvider>
            <Probe />
          </WorkspaceProvider>
        </PrefsProvider>
      </ConfirmProvider>
    </I18nProvider>
  );
}

async function openDoc(doc: Document): Promise<void> {
  store.set(doc.id, { doc, undo: [], redo: [], updated_at: Date.now() });
  mountProbe();
  await act(async () => {
    await latest?.open(doc.id);
  });
  await waitFor(() => expect(latest?.frames.length).toBeGreaterThan(0));
}

async function seekApp(sceneId: string, frame: number): Promise<void> {
  await act(async () => {
    latest?.setTab({ sceneId, frame, playing: false });
  });
  await waitFor(() => {
    expect(latest?.tab?.sceneId).toBe(sceneId);
    expect(latest?.frames[latest.frames.length - 1]?.frame).toBe(frame);
  });
}

interface Check {
  sceneId: string;
  frame: number;
  global: number;
}

async function conform(doc: Document, checks: Check[]): Promise<void> {
  await openDoc(doc);
  const result = await exportWeb(doc.id, "canvasjs", {
    range: { kind: "whole" },
    scale: 1,
    fps: doc.fps,
    loop: true,
    transparent: false
  });
  const payload = JSON.parse(disk.get(`${result.path}/project.json`) ?? "");
  const player = StickMate.load(payload);
  player.mount(document.createElement("canvas"));
  for (const check of checks) {
    await seekApp(check.sceneId, check.frame);
    const svg = document.querySelector<SVGSVGElement>(
      `svg[viewBox="0 0 ${doc.width} ${doc.height}"]`
    );
    if (!svg) {
      throw new Error("editor canvas is not mounted");
    }
    const expected = translateSvg(svg, doc.width, doc.height);
    log = [];
    player.seek(check.global);
    expectCalls(log, expected, `${doc.name} ${check.sceneId} frame ${check.frame}`);
  }
}

const allShapes: Shape[] = [
  {
    kind: "Stroke",
    points: [
      { x: 10, y: 10 },
      { x: 40, y: 30 },
      { x: 80, y: 15 }
    ],
    color: "#ff0000",
    width: 4
  },
  { kind: "Rect", x: 100, y: 20, w: 60, h: 40, fill: "#3b82f6", stroke: "#000000", width: 2 },
  { kind: "Ellipse", x: 200, y: 20, w: 80, h: 50, fill: "#22c55e", stroke: "#111111", width: 3 },
  {
    kind: "Polygon",
    x: 300,
    y: 20,
    w: 60,
    h: 60,
    sides: 5,
    fill: "#eab308",
    stroke: "#000000",
    width: 2
  },
  {
    kind: "Text",
    x: 20,
    y: 120,
    text: "Hello export",
    size: 24,
    family: "Segoe UI",
    color: "#111111"
  },
  {
    kind: "Path",
    nodes: [
      { point: { x: 20, y: 200 }, handle_in: null, handle_out: { x: 60, y: 160 } },
      { point: { x: 120, y: 220 }, handle_in: { x: 90, y: 240 }, handle_out: null },
      { point: { x: 180, y: 190 }, handle_in: null, handle_out: null }
    ],
    closed: false,
    fill: "#ffffff",
    stroke: "#7c3aed",
    width: 3
  },
  {
    kind: "Path",
    nodes: [
      { point: { x: 250, y: 180 }, handle_in: null, handle_out: null },
      { point: { x: 330, y: 180 }, handle_in: null, handle_out: { x: 350, y: 220 } },
      { point: { x: 290, y: 250 }, handle_in: { x: 260, y: 240 }, handle_out: null }
    ],
    closed: true,
    fill: "#f97316",
    stroke: "#000000",
    width: 2
  }
];

describe("export renderer conformance", () => {
  test("every shape variant draws the same calls as the editor", async () => {
    const doc: Document = {
      id: "shapes",
      name: "Shapes",
      width: 400,
      height: 300,
      fps: 24,
      background: "#ffffff",
      scenes: [scene("s0", [layer("l0", { keys: [key(0, allShapes)] })])]
    };
    await conform(doc, [{ sceneId: "s0", frame: 0, global: 0 }]);
  });

  test("transforms, tweens, held frames, opacity and layer flags match", async () => {
    const doc: Document = {
      id: "motion",
      name: "Motion",
      width: 400,
      height: 300,
      fps: 24,
      background: "#f0f0f0",
      scenes: [
        scene("s0", [
          layer("l0", {
            length: 25,
            keys: [
              key(
                0,
                [
                  { kind: "Rect", x: 10, y: 10, w: 80, h: 60, fill: "#3b82f6", stroke: "#000000", width: 2 },
                  { kind: "Ellipse", x: 40, y: 30, w: 80, h: 60, fill: "#ef4444", stroke: "#000000", width: 2 }
                ],
                { tween: true }
              ),
              key(
                12,
                [
                  { kind: "Rect", x: 10, y: 10, w: 80, h: 60, fill: "#3b82f6", stroke: "#000000", width: 2 },
                  { kind: "Ellipse", x: 40, y: 30, w: 80, h: 60, fill: "#ef4444", stroke: "#000000", width: 2 }
                ],
                {
                  tween: true,
                  transform: { x: 100, y: 50, rotation: 45, scale: 1.5, opacity: 0.4 }
                }
              ),
              key(24, [
                { kind: "Rect", x: 10, y: 10, w: 80, h: 60, fill: "#3b82f6", stroke: "#000000", width: 2 }
              ])
            ]
          }),
          layer("hidden", {
            visible: false,
            length: 25,
            keys: [
              key(0, [
                { kind: "Rect", x: 0, y: 0, w: 400, h: 300, fill: "#000000", stroke: "#000000", width: 1 }
              ])
            ]
          }),
          layer("locked", {
            locked: true,
            opacity: 0.5,
            length: 10,
            keys: [
              key(
                0,
                [
                  {
                    kind: "Stroke",
                    points: [
                      { x: 5, y: 5 },
                      { x: 60, y: 60 }
                    ],
                    color: "#00ff00",
                    width: 5
                  }
                ],
                { transform: { x: 0, y: 0, rotation: 0, scale: 1, opacity: 0.8 } }
              ),
              key(5, [
                {
                  kind: "Text",
                  x: 10,
                  y: 10,
                  text: "held",
                  size: 18,
                  family: "Segoe UI",
                  color: "#333333"
                }
              ])
            ]
          })
        ])
      ]
    };
    await conform(
      doc,
      [0, 6, 12, 18, 24].map((frame) => ({ sceneId: "s0", frame, global: frame }))
    );
  });

  test("multi scene playback and frame labels match across the concatenated timeline", async () => {
    const doc: Document = {
      id: "scenes",
      name: "Scenes",
      width: 200,
      height: 150,
      fps: 12,
      background: "#ffffff",
      scenes: [
        scene("s0", [
          layer("l0", {
            length: 3,
            keys: [
              key(
                0,
                [{ kind: "Rect", x: 10, y: 10, w: 50, h: 40, fill: "#ff0000", stroke: "#000000", width: 2 }],
                { label: "intro" }
              ),
              key(2, [
                { kind: "Ellipse", x: 60, y: 50, w: 70, h: 60, fill: "#00ff00", stroke: "#000000", width: 2 }
              ])
            ]
          })
        ]),
        scene("s1", [
          layer("l1", {
            length: 4,
            keys: [
              key(0, [
                {
                  kind: "Polygon",
                  x: 20,
                  y: 20,
                  w: 80,
                  h: 80,
                  sides: 6,
                  fill: "#0000ff",
                  stroke: "#000000",
                  width: 3
                }
              ]),
              key(3, [
                {
                  kind: "Text",
                  x: 30,
                  y: 40,
                  text: "end",
                  size: 30,
                  family: "Segoe UI",
                  color: "#000000"
                }
              ])
            ]
          })
        ])
      ]
    };
    await conform(doc, [
      { sceneId: "s0", frame: 0, global: 0 },
      { sceneId: "s0", frame: 1, global: 1 },
      { sceneId: "s0", frame: 2, global: 2 },
      { sceneId: "s1", frame: 0, global: 3 },
      { sceneId: "s1", frame: 1, global: 4 },
      { sceneId: "s1", frame: 3, global: 6 }
    ]);
  });
});

function DialogHost({ docId }: { docId: string }) {
  const { open } = useWorkspace();
  useEffect(() => {
    void open(docId);
  }, [docId, open]);
  return <ExportDialog open onClose={() => {}} />;
}

async function mountDialog(doc: Document): Promise<void> {
  store.set(doc.id, { doc, undo: [], redo: [], updated_at: Date.now() });
  render(
    <I18nProvider language="en" onLanguageChange={() => {}}>
      <ConfirmProvider>
        <PrefsProvider>
          <WorkspaceProvider>
            <DialogHost docId={doc.id} />
          </WorkspaceProvider>
        </PrefsProvider>
      </ConfirmProvider>
    </I18nProvider>
  );
  await waitFor(() =>
    expect((screen.getByLabelText("Frame rate") as HTMLInputElement).value).toBe(String(doc.fps))
  );
}

function simpleDoc(id: string, name: string): Document {
  return {
    id,
    name,
    width: 320,
    height: 240,
    fps: 24,
    background: "#ffffff",
    scenes: [
      scene("s0", [
        layer("l0", {
          length: 10,
          keys: [
            key(0, [
              { kind: "Rect", x: 10, y: 10, w: 50, h: 40, fill: "#3b82f6", stroke: "#000000", width: 2 }
            ])
          ]
        })
      ]),
      scene("s1", [layer("l1", { length: 4 })])
    ]
  };
}

async function clickExport(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
  });
}

function payloadOf(path: string): Record<string, unknown> {
  return JSON.parse(disk.get(`${path}/project.json`) ?? "");
}

describe("export dialog", () => {
  test("html5 export writes a page, runtime and project and shows the result", async () => {
    const doc = simpleDoc("d1", "My film");
    await mountDialog(doc);
    expect(screen.queryByLabelText(/audio|codec/i)).toBeNull();
    await clickExport();
    await screen.findByText("Export ready");
    expect(screen.getByText("C:/Users/Test/Downloads/StickMate/My film-html5")).toBeTruthy();
    expect(screen.getByText("stickmate.js, project.json, index.html")).toBeTruthy();
    expect(disk.has("C:/Users/Test/Downloads/StickMate/My film-html5/index.html")).toBe(true);
    const page = disk.get("C:/Users/Test/Downloads/StickMate/My film-html5/index.html") ?? "";
    expect(page).toContain("<title>My film</title>");
    expect(page).toContain("player.play();");
    expect(payloadOf("C:/Users/Test/Downloads/StickMate/My film-html5").loop).toBe(true);
  });

  test("canvasjs export writes only the runtime and project", async () => {
    const doc = simpleDoc("d2", "Embed");
    await mountDialog(doc);
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "canvasjs" } });
    await clickExport();
    await screen.findByText("Export ready");
    expect(screen.getByText("stickmate.js, project.json")).toBeTruthy();
    expect(disk.has("C:/Users/Test/Downloads/StickMate/Embed-canvasjs/index.html")).toBe(false);
    expect(disk.get("C:/Users/Test/Downloads/StickMate/Embed-canvasjs/stickmate.js")).toBe(source);
  });

  test("scene and frame ranges change the exported data", async () => {
    const doc = simpleDoc("d3", "Ranges");
    await mountDialog(doc);
    fireEvent.change(screen.getByLabelText("Range"), { target: { value: "scene" } });
    fireEvent.change(screen.getByLabelText("Scene to export"), { target: { value: "s1" } });
    await clickExport();
    await screen.findByText("Export ready");
    let payload = payloadOf("C:/Users/Test/Downloads/StickMate/Ranges-html5");
    expect((payload.scenes as unknown[]).length).toBe(1);
    expect(screen.getByText(/4 frames/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Range"), { target: { value: "frames" } });
    fireEvent.change(screen.getByLabelText("Scene to export"), { target: { value: "s0" } });
    fireEvent.change(screen.getByLabelText("Start frame"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("End frame"), { target: { value: "7" } });
    await clickExport();
    await waitFor(() => expect(screen.getByText(/6 frames/)).toBeTruthy());
    payload = payloadOf("C:/Users/Test/Downloads/StickMate/Ranges-html5");
    expect(payload.startFrame).toBe(2);
    expect(payload.endFrame).toBe(7);
  });

  test("scale, fps, loop and transparency reach the package", async () => {
    const doc = simpleDoc("d4", "Options");
    await mountDialog(doc);
    fireEvent.change(screen.getByLabelText("Resolution scale"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Frame rate"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("switch", { name: "Loop playback" }));
    fireEvent.click(screen.getByRole("switch", { name: "Transparent background" }));
    await clickExport();
    await screen.findByText("Export ready");
    expect(screen.getByText(/640 × 480 · 60 fps/)).toBeTruthy();
    const payload = payloadOf("C:/Users/Test/Downloads/StickMate/Options-html5");
    expect(payload.width).toBe(640);
    expect(payload.height).toBe(480);
    expect(payload.fps).toBe(60);
    expect(payload.loop).toBe(false);
    expect(payload.background).toBe("");
    expect(payload.scale).toBe(2);
  });

  test("a hostile document name cannot inject script into the page or path", async () => {
    const doc = simpleDoc("d5", "<script>alert(1)</script>");
    await mountDialog(doc);
    await clickExport();
    await screen.findByText("Export ready");
    const dir = "C:/Users/Test/Downloads/StickMate/-script-alert(1)--script-html5";
    expect(screen.getByText(dir)).toBeTruthy();
    const page = disk.get(`${dir}/index.html`) ?? "";
    expect(page).toContain("<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>");
    expect(page).not.toContain("<script>alert(1)");
    expect(page).not.toContain("</script><script>");
  });

  test("names with spaces and non ASCII characters export to a usable folder", async () => {
    const doc = simpleDoc("d6", "Животна 2");
    await mountDialog(doc);
    await clickExport();
    await screen.findByText("Export ready");
    const dir = "C:/Users/Test/Downloads/StickMate/Животна 2-html5";
    expect(screen.getByText(dir)).toBeTruthy();
    expect(disk.has(`${dir}/index.html`)).toBe(true);
    expect(disk.has(`${dir}/project.json`)).toBe(true);
  });

  test("reexport keeps unrelated files in the package folder", async () => {
    const doc = simpleDoc("d7", "Keep");
    disk.set("C:/Users/Test/Downloads/StickMate/Keep-html5/keep.txt", "unrelated");
    await mountDialog(doc);
    await clickExport();
    await screen.findByText("Export ready");
    expect(disk.get("C:/Users/Test/Downloads/StickMate/Keep-html5/keep.txt")).toBe("unrelated");
    expect(disk.has("C:/Users/Test/Downloads/StickMate/Keep-html5/index.html")).toBe(true);
  });

  test("an invalid frame range surfaces the real error", async () => {
    const doc = simpleDoc("d8", "Bad range");
    await mountDialog(doc);
    fireEvent.change(screen.getByLabelText("Range"), { target: { value: "frames" } });
    fireEvent.change(screen.getByLabelText("End frame"), { target: { value: "99" } });
    await clickExport();
    await screen.findByText(/frame range is invalid/);
    expect(screen.queryByText("Export ready")).toBeNull();
  });

  test("an invalid fps surfaces the real error", async () => {
    const doc = simpleDoc("d9", "Bad fps");
    await mountDialog(doc);
    fireEvent.change(screen.getByLabelText("Frame rate"), { target: { value: "0" } });
    await clickExport();
    await screen.findByText(/frame rate must be between 1 and 60/);
  });
});