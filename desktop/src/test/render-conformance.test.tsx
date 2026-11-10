import { runInThisContext } from "node:vm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import App from "@/App";
import {
  affineFrom,
  composeAffine,
  cssEffects,
  docEvaluate,
  docNew,
  gradientBox,
  gradientGeometry,
  linearEasing,
  polygonVertices,
  shapeGradient
} from "@/lib/document";
import type { Blend, EvalLayer, Keyframe, Layer, Shape, Transform } from "@/lib/document";
import source from "@/export/runtime.js?raw";
import { installBackend, store } from "./backend";
import { flush, getCanvas, press } from "./utils";

runInThisContext(source);

interface Player {
  mount(canvas: HTMLCanvasElement): void;
  seek(frame: number): void;
  pause(): void;
}

const StickMate = (globalThis as unknown as { StickMate: { load(project: unknown): Player } })
  .StickMate;

interface Paint {
  fill: string;
  stroke: string;
  width: number;
}

interface GradientStub {
  gradientKind: "linear" | "radial";
  coords: number[];
  stops: Array<[number, string]>;
  addColorStop(offset: number, color: string): void;
}

function gradientStub(kind: "linear" | "radial", args: number[]): GradientStub {
  const stub: GradientStub = {
    gradientKind: kind,
    coords: kind === "linear" ? args.slice(0, 4) : [args[0], args[1], args[5]],
    stops: [],
    addColorStop(offset, color) {
      stub.stops.push([offset, color]);
    }
  };
  return stub;
}

function gradientToken(kind: string, coords: number[], stops: Array<[number, string]>): string {
  const box = coords.map((value) => value.toFixed(6)).join(",");
  const list = stops.map(([offset, color]) => `${offset.toFixed(6)}:${color}`).join(",");
  return `gradient:${kind}:${box}:${list}`;
}

function shapePaintFill(shape: Extract<Shape, { fill: string }>): string {
  const gradient = shapeGradient(shape);
  if (!gradient) {
    return shape.fill;
  }
  const [x1, y1, x2, y2, r] = gradientGeometry(gradientBox(shape), gradient);
  return gradient.kind === "linear"
    ? gradientToken("linear", [x1, y1, x2, y2], gradient.stops.map((stop) => [stop.offset, stop.color]))
    : gradientToken("radial", [x1, y1, r], gradient.stops.map((stop) => [stop.offset, stop.color]));
}

function tracePaintFill(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const stub = value as GradientStub;
  return gradientToken(stub.gradientKind, stub.coords, stub.stops);
}

function svgPaintFill(svg: SVGSVGElement, attribute: string): string {
  if (!attribute.startsWith("url(#")) {
    return attribute;
  }
  const def = svg.ownerDocument?.getElementById(attribute.slice(5, -1));
  if (!def) {
    throw new Error(`missing gradient definition for ${attribute}`);
  }
  const stops = Array.from(def.children).map((stop) => [
    Number(stop.getAttribute("offset")),
    stop.getAttribute("stop-color") ?? ""
  ] as [number, string]);
  return def.tagName === "linearGradient"
    ? gradientToken(
        "linear",
        ["x1", "y1", "x2", "y2"].map((name) => Number(def.getAttribute(name))),
        stops
      )
    : gradientToken(
        "radial",
        ["cx", "cy", "r"].map((name) => Number(def.getAttribute(name))),
        stops
      );
}

type NormalShape =
  | { kind: "Stroke"; points: number[]; color: string; width: number }
  | { kind: "Text"; at: number[]; text: string; size: number; family: string; color: string; matrix: number[] }
  | { kind: "Rect"; box: number[]; paint: Paint }
  | { kind: "Ellipse"; box: number[]; paint: Paint }
  | { kind: "Polygon"; points: number[]; paint: Paint }
  | { kind: "Path"; commands: Array<string | number>; closed: boolean; paint: Paint };

interface NormalLayer {
  opacity: number;
  blend: Blend;
  filter: string;
  transform: number[];
  shapes: NormalShape[];
}

const identity: Transform = { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 };

function key(frame: number, shapes: Shape[], patch: Partial<Keyframe> = {}): Keyframe {
  return {
    frame,
    shapes,
    transform: { ...identity },
    tween: false,
    easing: { ...linearEasing },
    label: null,
    ...patch
  };
}

function fixtureShapes(): Shape[] {
  return [
    {
      kind: "Stroke",
      points: [
        { x: 4, y: 8 },
        { x: 18, y: 22 },
        { x: 30, y: 6 }
      ],
      color: "#ef4444",
      width: 3
    },
    {
      kind: "Rect",
      x: 40,
      y: 10,
      w: 30,
      h: 20,
      fill: "#3b82f6",
      stroke: "#111827",
      width: 2,
      gradient: {
        kind: "linear",
        angle: 45,
        stops: [
          { offset: 0, color: "#ff0000" },
          { offset: 0.5, color: "#00ff00" },
          { offset: 1, color: "#0000ff" }
        ]
      }
    },
    { kind: "Ellipse", x: 80, y: 12, w: 24, h: 16, fill: "#22c55e", stroke: "#111827", width: 1.5 },
    {
      kind: "Polygon",
      x: 110,
      y: 8,
      w: 28,
      h: 28,
      sides: 5,
      fill: "#f59e0b",
      stroke: "#111827",
      width: 2,
      gradient: {
        kind: "radial",
        stops: [
          { offset: 0, color: "#ffffff" },
          { offset: 1, color: "#111827" }
        ]
      }
    },
    {
      kind: "Text", x: 12, y: 60, text: "StickMate", size: 14, family: "sans-serif", color: "#111827",
      matrix: composeAffine(
        affineFrom({ x: 10, y: 20 }, 4, -8, 2, 0.5, -30),
        affineFrom({ x: 5, y: 6 }, 2, 3, 1, 1, 60)
      )
    },
    {
      kind: "Path",
      closed: true,
      fill: "#a855f7",
      stroke: "#111827",
      width: 2,
      gradient: {
        kind: "linear",
        angle: -20,
        stops: [
          { offset: 0, color: "#0ea5e9" },
          { offset: 1, color: "#f43f5e" }
        ]
      },
      nodes: [
        { point: { x: 150, y: 20 }, handle_in: null, handle_out: { x: 160, y: 10 } },
        { point: { x: 180, y: 30 }, handle_in: { x: 175, y: 20 }, handle_out: null },
        { point: { x: 160, y: 50 }, handle_in: null, handle_out: null }
      ]
    },
    {
      kind: "Path",
      closed: false,
      fill: "#a855f7",
      stroke: "#0ea5e9",
      width: 4,
      nodes: [
        { point: { x: 20, y: 80 }, handle_in: null, handle_out: { x: 40, y: 95 } },
        { point: { x: 70, y: 85 }, handle_in: { x: 55, y: 70 }, handle_out: null }
      ]
    },
    { kind: "Stroke", points: [{ x: 90, y: 90 }], color: "#ef4444", width: 3 }
  ];
}

function tweenStart(): Shape[] {
  return [
    {
      kind: "Rect",
      x: 10,
      y: 10,
      w: 20,
      h: 20,
      fill: "#000000",
      stroke: "#ffffff",
      width: 2,
      gradient: {
        kind: "linear",
        angle: 0,
        stops: [
          { offset: 0, color: "#ff0000" },
          { offset: 1, color: "#000000" }
        ]
      }
    },
    {
      kind: "Ellipse",
      x: 40,
      y: 10,
      w: 20,
      h: 20,
      fill: "#22c55e",
      stroke: "#111827",
      width: 1,
      gradient: {
        kind: "radial",
        stops: [
          { offset: 0, color: "#ffffff" },
          { offset: 1, color: "#22c55e" }
        ]
      }
    },
    { kind: "Polygon", x: 70, y: 10, w: 24, h: 24, sides: 5, fill: "#f59e0b", stroke: "#111827", width: 2 },
    {
      kind: "Path",
      closed: false,
      fill: "#a855f7",
      stroke: "#111827",
      width: 3,
      nodes: [
        { point: { x: 10, y: 60 }, handle_in: null, handle_out: { x: 20, y: 50 } },
        { point: { x: 40, y: 70 }, handle_in: { x: 30, y: 60 }, handle_out: null }
      ]
    },
    {
      kind: "Stroke",
      points: [
        { x: 60, y: 60 },
        { x: 70, y: 66 },
        { x: 80, y: 60 }
      ],
      color: "#ef4444",
      width: 3
    }
  ];
}

function tweenEnd(): Shape[] {
  return [
    {
      kind: "Rect",
      x: 30,
      y: 18,
      w: 40,
      h: 30,
      fill: "#ffffff",
      stroke: "none",
      width: 6,
      gradient: {
        kind: "linear",
        angle: 90,
        stops: [
          { offset: 0, color: "#0000ff" },
          { offset: 1, color: "#ffffff" }
        ]
      }
    },
    { kind: "Rect", x: 90, y: 20, w: 20, h: 20, fill: "#10b981", stroke: "#111827", width: 1 },
    { kind: "Polygon", x: 70, y: 10, w: 24, h: 24, sides: 3, fill: "#0ea5e9", stroke: "#111827", width: 2 },
    {
      kind: "Path",
      closed: false,
      fill: "#a855f7",
      stroke: "#111827",
      width: 5,
      nodes: [
        { point: { x: 30, y: 60 }, handle_in: { x: 20, y: 70 }, handle_out: { x: 40, y: 50 } },
        { point: { x: 60, y: 70 }, handle_in: null, handle_out: null }
      ]
    },
    {
      kind: "Stroke",
      points: [
        { x: 100, y: 60 },
        { x: 120, y: 70 }
      ],
      color: "#0ea5e9",
      width: 5
    },
    { kind: "Text", x: 10, y: 92, text: "End", size: 16, family: "sans-serif", color: "#111827", matrix: null }
  ];
}

function groupStart(): Shape {
  return {
    kind: "Group",
    children: [
      {
        kind: "Rect",
        x: 10,
        y: 10,
        w: 30,
        h: 20,
        fill: "#3b82f6",
        stroke: "#111827",
        width: 2,
        gradient: {
          kind: "linear",
          angle: 0,
          stops: [
            { offset: 0, color: "#ff0000" },
            { offset: 1, color: "#000000" }
          ]
        }
      },
      { kind: "Ellipse", x: 50, y: 15, w: 24, h: 16, fill: "#22c55e", stroke: "#111827", width: 1.5 }
    ]
  };
}

function groupEnd(): Shape {
  return {
    kind: "Group",
    children: [
      {
        kind: "Rect",
        x: 30,
        y: 20,
        w: 40,
        h: 30,
        fill: "#ef4444",
        stroke: "#111827",
        width: 4,
        gradient: {
          kind: "linear",
          angle: 90,
          stops: [
            { offset: 0, color: "#0000ff" },
            { offset: 1, color: "#ffffff" }
          ]
        }
      },
      { kind: "Ellipse", x: 80, y: 25, w: 30, h: 20, fill: "#0ea5e9", stroke: "#111827", width: 2.5 }
    ]
  };
}

function groupHoldStart(): Shape {
  return {
    kind: "Group",
    children: [
      { kind: "Rect", x: 120, y: 60, w: 20, h: 10, fill: "#f59e0b", stroke: "#111827", width: 1 }
    ]
  };
}

function groupHoldEnd(): Shape {
  return {
    kind: "Group",
    children: [
      { kind: "Rect", x: 140, y: 70, w: 20, h: 10, fill: "#a855f7", stroke: "#111827", width: 1 },
      { kind: "Ellipse", x: 165, y: 70, w: 12, h: 12, fill: "#0ea5e9", stroke: "#111827", width: 1 }
    ]
  };
}

function fixtureScenes() {
  const top: Layer = {
    id: "l-top",
    name: "Top",
    visible: true,
    locked: false,
    opacity: 0.5,
    blend: "multiply",
    effects: [
      { kind: "blur", radius: 6 },
      { kind: "shadow", x: 4, y: -3, blur: 8, color: "#000000" }
    ],
    length: 4,
    keys: [
      key(0, fixtureShapes(), {
        transform: { x: 5, y: 6, rotation: 30, scale: 1.25, opacity: 1 },
        tween: true,
        easing: { x1: 0.42, y1: 0, x2: 1, y2: 1 }
      }),
      key(2, fixtureShapes(), { transform: { x: 25, y: 6, rotation: 30, scale: 2, opacity: 0.5 } })
    ]
  };
  const mid: Layer = {
    id: "l-mid",
    name: "Mid",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    effects: [{ kind: "shadow", x: 0, y: 0, blur: 12, color: "#22c55e" }],
    length: 2,
    keys: [key(0, [fixtureShapes()[1]])]
  };
  const hidden: Layer = {
    id: "l-hidden",
    name: "Hidden",
    visible: false,
    locked: false,
    opacity: 1,
    blend: "normal",
    effects: [],
    length: 4,
    keys: [key(0, [fixtureShapes()[2]])]
  };
  const tweened: Layer = {
    id: "l-tween",
    name: "Tween",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    effects: [],
    length: 3,
    keys: [key(0, tweenStart(), { tween: true }), key(2, tweenEnd())]
  };
  const grouped: Layer = {
    id: "l-group",
    name: "Group",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    effects: [],
    length: 3,
    keys: [
      key(0, [groupStart(), groupHoldStart()], { tween: true }),
      key(2, [groupEnd(), groupHoldEnd()])
    ]
  };
  return [{ id: "s0", name: "Scene 1", layers: [top, mid, hidden, tweened, grouped] }];
}

function flat(points: Array<{ x: number; y: number }>): number[] {
  return points.flatMap((point) => [point.x, point.y]);
}

function pathCommands(shape: Extract<Shape, { kind: "Path" }>): Array<string | number> {
  const nodes = shape.nodes;
  const out: Array<string | number> = ["M", nodes[0].point.x, nodes[0].point.y];
  const segments = shape.closed ? nodes.length : nodes.length - 1;
  for (let index = 0; index < segments; index += 1) {
    const a = nodes[index];
    const b = nodes[(index + 1) % nodes.length];
    const p1 = a.handle_out ?? a.point;
    const p2 = b.handle_in ?? b.point;
    out.push("C", p1.x, p1.y, p2.x, p2.y, b.point.x, b.point.y);
  }
  if (shape.closed) {
    out.push("Z");
  }
  return out;
}

function normalShape(shape: Exclude<Shape, { kind: "Group" }>): NormalShape | null {
  if (shape.kind === "Stroke") {
    if (shape.points.length < 2) {
      return null;
    }
    return { kind: "Stroke", points: flat(shape.points), color: shape.color, width: shape.width };
  }
  if (shape.kind === "Text") {
    return {
      kind: "Text",
      at: [shape.x, shape.y],
      text: shape.text,
      size: shape.size,
      family: shape.family,
      color: shape.color,
      matrix: shape.matrix ? [shape.matrix.a, shape.matrix.b, shape.matrix.c, shape.matrix.d, shape.matrix.e, shape.matrix.f] : [1, 0, 0, 1, 0, 0]
    };
  }
  if (shape.kind === "Path") {
    return {
      kind: "Path",
      commands: pathCommands(shape),
      closed: shape.closed,
      paint: {
        fill: shape.closed ? shapePaintFill(shape) : "none",
        stroke: shape.stroke,
        width: shape.width
      }
    };
  }
  const paint: Paint = { fill: shapePaintFill(shape), stroke: shape.stroke, width: shape.width };
  if (shape.kind === "Rect") {
    return { kind: "Rect", box: [shape.x, shape.y, shape.w, shape.h], paint };
  }
  if (shape.kind === "Ellipse") {
    return {
      kind: "Ellipse",
      box: [shape.x + shape.w / 2, shape.y + shape.h / 2, shape.w / 2, shape.h / 2],
      paint
    };
  }
  return {
    kind: "Polygon",
    points: flat(polygonVertices(shape.x, shape.y, shape.w, shape.h, shape.sides)),
    paint
  };
}

function normalShapes(shape: Shape): NormalShape[] {
  if (shape.kind === "Group") {
    return shape.children.flatMap(normalShapes);
  }
  const single = normalShape(shape);
  return single ? [single] : [];
}

function radians(transform: Transform): number[] {
  return [
    transform.x,
    transform.y,
    (transform.rotation * Math.PI) / 180,
    transform.scale
  ];
}

function fromEvaluation(layers: EvalLayer[]): NormalLayer[] {
  return layers.map((layer) => ({
    opacity: layer.opacity,
    blend: layer.blend,
    filter: cssEffects(layer.effects) || "none",
    transform: radians(layer.transform),
    shapes: layer.shapes.flatMap(normalShapes)
  }));
}

function numbers(value: string | null): number[] {
  return (value ?? "").match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
}

function fromSvg(svg: SVGSVGElement): NormalLayer[] {
  const wrappers = Array.from(svg.querySelectorAll<SVGGElement>(":scope > g"));
  return wrappers.map((wrapper) => {
    const inner = wrapper.querySelector<SVGGElement>("g[transform]");
    if (!inner) {
      throw new Error("layer group is missing its transform");
    }
    const matrix = numbers(inner.getAttribute("transform"));
    const opacity =
      Number(wrapper.getAttribute("opacity") ?? 1) * Number(inner.getAttribute("opacity") ?? 1);
    const blend = cssBlend(inner.getAttribute("style"));
    const filter = cssFilter(inner.getAttribute("style"));
    const shapes: NormalShape[] = [];
    const readShape = (group: Element): void => {
      if (group.hasAttribute("data-group")) {
        for (const child of Array.from(group.children)) {
          readShape(child);
        }
        return;
      }
      const painted = group.querySelector("polyline, text, polygon, path, rect, ellipse");
      if (!painted) {
        return;
      }
      const tag = painted.tagName.toLowerCase();
      const stroke = painted.getAttribute("stroke") ?? "";
      const width = Number(painted.getAttribute("stroke-width") ?? 0);
      if (tag === "polyline") {
        const points = numbers(painted.getAttribute("points"));
        if (points.length >= 4) {
          shapes.push({ kind: "Stroke", points, color: stroke, width });
        }
        return;
      }
      if (tag === "text") {
        shapes.push({
          kind: "Text",
          at: [Number(painted.getAttribute("x")), Number(painted.getAttribute("y"))],
          text: painted.textContent ?? "",
          size: Number(painted.getAttribute("font-size")),
          family: painted.getAttribute("font-family") ?? "",
          color: painted.getAttribute("fill") ?? "",
          matrix: painted.hasAttribute("transform") ? numbers(painted.getAttribute("transform")) : [1, 0, 0, 1, 0, 0]
        });
        return;
      }
      const paint: Paint = {
        fill: svgPaintFill(svg, painted.getAttribute("fill") ?? ""),
        stroke,
        width
      };
      if (tag === "polygon") {
        shapes.push({ kind: "Polygon", points: numbers(painted.getAttribute("points")), paint });
        return;
      }
      if (tag === "path") {
        const tokens = (painted.getAttribute("d") ?? "").match(/[MCZ]|-?\d+(?:\.\d+)?/gi) ?? [];
        const commands = tokens.map((token) =>
          /^[MCZ]$/i.test(token) ? token.toUpperCase() : Number(token)
        );
        shapes.push({ kind: "Path", commands, closed: commands.includes("Z"), paint });
        return;
      }
      if (tag === "rect") {
        shapes.push({
          kind: "Rect",
          box: [
            Number(painted.getAttribute("x")),
            Number(painted.getAttribute("y")),
            Number(painted.getAttribute("width")),
            Number(painted.getAttribute("height"))
          ],
          paint
        });
        return;
      }
      shapes.push({
        kind: "Ellipse",
        box: [
          Number(painted.getAttribute("cx")),
          Number(painted.getAttribute("cy")),
          Number(painted.getAttribute("rx")),
          Number(painted.getAttribute("ry"))
        ],
        paint
      });
    };
    for (const group of Array.from(inner.children)) {
      readShape(group);
    }
    return {
      opacity,
      blend,
      filter,
      transform: [matrix[0], matrix[1], (matrix[2] * Math.PI) / 180, matrix[3]],
      shapes
    };
  }).reverse();
}

function cssBlend(style: string | null): Blend {
  const match = /mix-blend-mode:\s*([a-z-]+)/.exec(style ?? "");
  return match ? (match[1] as Blend) : "normal";
}

function cssFilter(style: string | null): string {
  const match = /(?:^|[;\s])filter:\s*([^;]+)/.exec(style ?? "");
  return match ? match[1].trim() : "none";
}

type Entry = unknown[];

function fromTrace(log: Entry[]): { background: string | null; layers: NormalLayer[] } {
  const layers: NormalLayer[] = [];
  let background: string | null = null;
  let fill: unknown = "";
  let stroke = "";
  let width = 0;
  let font = "";
  let ops: Array<{ name: string; args: number[] }> = [];
  let current: NormalLayer | null = null;
  let cleared = false;
  let textMatrix = [1, 0, 0, 1, 0, 0];
  const matrixStack: number[][] = [];

  const finish = () => {
    if (!current || ops.length === 0) {
      ops = [];
      return;
    }
    const paint: Paint = { fill: tracePaintFill(fill), stroke, width };
    const first = ops[0];
    const closed = ops.some((op) => op.name === "closePath");
    const curves = ops.filter((op) => op.name === "bezierCurveTo");
    const lines = ops.filter((op) => op.name === "lineTo");
    if (first.name === "rect") {
      current.shapes.push({ kind: "Rect", box: first.args, paint });
    } else if (first.name === "ellipse") {
      current.shapes.push({ kind: "Ellipse", box: first.args.slice(0, 4), paint });
    } else if (curves.length > 0) {
      const commands: Array<string | number> = ["M", ...first.args];
      for (const curve of curves) {
        commands.push("C", ...curve.args);
      }
      if (closed) {
        commands.push("Z");
      }
      current.shapes.push({
        kind: "Path",
        commands,
        closed,
        paint: { ...paint, fill: closed ? tracePaintFill(fill) : "none" }
      });
    } else if (closed) {
      current.shapes.push({
        kind: "Polygon",
        points: [first.args, ...lines.map((line) => line.args)].flat(),
        paint
      });
    } else {
      const points = [first.args, ...lines.map((line) => line.args)].flat();
      if (points.length >= 4) {
        current.shapes.push({ kind: "Stroke", points, color: stroke, width });
      }
    }
    ops = [];
  };

  for (const entry of log) {
    const index = entry[0] as number;
    const name = entry[1] as string;
    const args = entry.slice(2) as number[];
    if (index === 0 && name === "set:fillStyle" && entry[2] !== undefined) {
      if (background === null) {
        background = String(entry[2]);
      }
      continue;
    }
    if (index === 0 && name === "set:globalAlpha") {
      if (current && args[0] !== 1) {
        current.opacity = args[0];
      }
      continue;
    }
    if (index === 0 && name === "set:globalCompositeOperation") {
      if (current && entry[2] !== "source-over") {
        current.blend = entry[2] as Blend;
      }
      continue;
    }
    if (index === 0 && name === "set:filter") {
      if (current && entry[2] !== "none") {
        current.filter = String(entry[2]);
      }
      continue;
    }
    if (index !== 1) {
      continue;
    }
    if (name === "clearRect") {
      cleared = true;
      continue;
    }
    if (name === "setTransform") {
      if (cleared) {
        cleared = false;
        finish();
        current = { opacity: 1, blend: "normal", filter: "none", transform: [0, 0, 0, 1], shapes: [] };
        layers.push(current);
      }
      continue;
    }
    if (name === "translate") {
      if (current) {
        current.transform[0] = args[0];
        current.transform[1] = args[1];
      }
      continue;
    }
    if (name === "rotate") {
      if (current) {
        current.transform[2] = args[0];
      }
      continue;
    }
    if (name === "scale") {
      if (current) {
        current.transform[3] = args[0];
      }
      continue;
    }
    if (name === "set:fillStyle") {
      fill = entry[2];
      continue;
    }
    if (name === "set:strokeStyle") {
      stroke = String(entry[2]);
      continue;
    }
    if (name === "set:lineWidth") {
      width = args[0];
      continue;
    }
    if (name === "set:font") {
      font = String(entry[2]);
      continue;
    }
    if (name === "save") {
      matrixStack.push(textMatrix);
      continue;
    }
    if (name === "transform") {
      textMatrix = args;
      continue;
    }
    if (name === "restore") {
      textMatrix = matrixStack.pop()!;
      continue;
    }
    if (name === "fillText") {
      if (current) {
        const size = Number(font.split("px")[0]);
        current.shapes.push({
          kind: "Text",
          at: [args[1], args[2]],
          text: String(entry[2]),
          size,
          family: font.slice(font.indexOf("px ") + 3),
          color: tracePaintFill(fill),
          matrix: textMatrix
        });
      }
      continue;
    }
    if (name === "beginPath") {
      finish();
      ops = [];
      continue;
    }
    if (name === "stroke") {
      finish();
      continue;
    }
    if (name === "fill" || name === "set:lineCap" || name === "set:lineJoin" || name === "set:textBaseline") {
      continue;
    }
    ops.push({ name, args });
  }
  finish();
  return { background, layers: layers.reverse() };
}

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
    "globalCompositeOperation",
    "filter",
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
  target.createLinearGradient = (x1: number, y1: number, x2: number, y2: number) =>
    gradientStub("linear", [x1, y1, x2, y2]);
  target.createRadialGradient = (
    x1: number,
    y1: number,
    r1: number,
    x2: number,
    y2: number,
    r2: number
  ) => gradientStub("radial", [x1, y1, r1, x2, y2, r2]);
  return target as unknown as CanvasRenderingContext2D;
}

function payload(scale = 1) {
  return {
    id: "d0",
    name: "Conformance",
    width: 200,
    height: 100,
    fps: 10,
    background: "#ffffff",
    scenes: fixtureScenes(),
    loop: false,
    scale,
    startFrame: 0,
    endFrame: null
  };
}

function player(scale = 1): Player {
  ids = new Map();
  const canvas = document.createElement("canvas");
  const instance = StickMate.load(payload(scale));
  instance.mount(canvas);
  return instance;
}

function traceAt(frame: number, scale = 1): NormalLayer[] {
  const instance = player(scale);
  log = [];
  instance.seek(frame);
  const parsed = fromTrace(log);
  instance.pause();
  return parsed.layers;
}

async function mountEditor(): Promise<{ id: string; svg: SVGSVGElement }> {
  installBackend("editor");
  const doc = await docNew("Conformance", 200, 100, 10, "#ffffff");
  const state = store.get(doc.id);
  if (!state) {
    throw new Error("document is not in the store");
  }
  state.doc.scenes = fixtureScenes();
  render(<App />);
  await act(async () => {
    await emit("editor-open", doc.id);
  });
  await waitFor(() => getCanvas(200, 100));
  await flush();
  await press("p");
  return { id: doc.id, svg: getCanvas(200, 100) };
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

describe("editor and export renderer conformance", () => {
  test("the svg canvas and the export player paint identical geometry", async () => {
    const { svg } = await mountEditor();
    expect(fromSvg(svg)).toEqual(traceAt(0));
  });

  test("composed text rotation and stretch are isolated from subsequent artwork", async () => {
    const { svg } = await mountEditor();
    const exported = traceAt(0);
    expect(fromSvg(svg)).toEqual(exported);
    const text = exported[0].shapes.find((shape) => shape.kind === "Text")!;
    expect(text).toMatchObject({ kind: "Text", text: "StickMate", size: 14 });
    const transformIndex = log.findIndex((entry) => entry[0] === 1 && entry[1] === "transform");
    expect(log[transformIndex - 1]).toEqual([1, "save"]);
    const fillIndex = log.findIndex((entry) => entry[0] === 1 && entry[1] === "fillText");
    expect(log[fillIndex + 1]).toEqual([1, "restore"]);
    expect(transformIndex).toBeLessThan(fillIndex);
  });

  test("both renderers match the authoritative evaluation", async () => {
    const { id, svg } = await mountEditor();
    const evaluated = await docEvaluate(id, "s0", 0, 0);
    const expected = fromEvaluation(evaluated[0].layers);
    expect(fromSvg(svg)).toEqual(expected);
    expect(traceAt(0)).toEqual(expected);
  });

  test("every shape kind survives the round trip", async () => {
    const { svg } = await mountEditor();
    const kinds = fromSvg(svg)[0].shapes.map((shape) => shape.kind);
    expect(kinds).toEqual(["Stroke", "Rect", "Ellipse", "Polygon", "Text", "Path", "Path"]);
  });

  test("tweens evaluate identically on every frame", async () => {
    const { id } = await mountEditor();
    const evaluated = await docEvaluate(id, "s0", 0, 3);
    for (const frame of evaluated) {
      expect(traceAt(frame.frame)).toEqual(fromEvaluation(frame.layers));
    }
  });

  test("tweened shapes interpolate and hold what cannot be paired", async () => {
    const { id } = await mountEditor();
    const evaluated = await docEvaluate(id, "s0", 0, 2);
    expect(evaluated[0].layers[2].shapes).toEqual(tweenStart());
    expect(evaluated[2].layers[1].shapes).toEqual(tweenEnd());
    const middle = evaluated[1].layers[2].shapes;
    expect(middle).toHaveLength(5);
    expect(middle[0]).toMatchObject({
      kind: "Rect",
      x: 20,
      y: 14,
      w: 30,
      h: 25,
      fill: "#808080",
      stroke: "#ffffff",
      width: 4,
      gradient: {
        kind: "linear",
        angle: 45,
        stops: [
          { offset: 0, color: "#800080" },
          { offset: 1, color: "#808080" }
        ]
      }
    });
    expect(middle[1]).toMatchObject({ kind: "Ellipse", x: 40, y: 10 });
    expect(middle[2]).toMatchObject({ kind: "Polygon", sides: 5 });
    expect(middle[3]).toMatchObject({
      kind: "Path",
      width: 4,
      nodes: [
        {
          point: { x: 20, y: 60 },
          handle_in: { x: 15, y: 65 },
          handle_out: { x: 30, y: 50 }
        },
        { point: { x: 50, y: 70 }, handle_in: { x: 45, y: 65 }, handle_out: null }
      ]
    });
    expect(middle[4]).toMatchObject({ kind: "Stroke", color: "#ef4444", width: 3 });
  });

  test("a non linear curve moves both renderers the same amount", async () => {
    const { id } = await mountEditor();
    const evaluated = await docEvaluate(id, "s0", 1, 1);
    const eased = evaluated[0].layers[0].transform;
    expect(eased.x).toBeCloseTo(5 + 20 * 0.3153568125058931, 12);
    expect(Math.abs(eased.x - 15)).toBeGreaterThan(1);
    expect(eased.scale).toBeCloseTo(1.25 + 0.75 * 0.3153568125058931, 12);
    const exported = traceAt(1)[0].transform;
    expect(exported[0]).toBe(eased.x);
    expect(exported[3]).toBe(eased.scale);
  });

  test("held frames repeat the previous keyframe content", async () => {
    const { id } = await mountEditor();
    const evaluated = await docEvaluate(id, "s0", 0, 3);
    expect(traceAt(1)[0].shapes).toEqual(fromEvaluation(evaluated[0].layers)[0].shapes);
    expect(traceAt(3)[0].shapes).toEqual(fromEvaluation(evaluated[2].layers)[0].shapes);
  });

  test("hidden layers and layers past their length disappear in both", async () => {
    const { id, svg } = await mountEditor();
    expect(fromSvg(svg)).toHaveLength(4);
    const evaluated = await docEvaluate(id, "s0", 3, 3);
    expect(evaluated[0].layers.map((layer) => layer.id)).toEqual(["l-top"]);
    expect(traceAt(3)).toHaveLength(1);
  });

  test("the background is painted from the document in both", async () => {
    const { svg } = await mountEditor();
    const base = svg.querySelector("rect");
    expect(base?.getAttribute("fill")).toBe("#ffffff");
    const instance = player();
    log = [];
    instance.seek(0);
    expect(fromTrace(log).background).toBe("#ffffff");
    instance.pause();
  });

  test("export scale changes the layer transform but not the geometry", async () => {
    const single = traceAt(0, 1);
    const instance = player(2);
    log = [];
    instance.seek(0);
    expect(log).toContainEqual([1, "setTransform", 2, 0, 0, 2, 0, 0]);
    expect(fromTrace(log).layers).toEqual(single);
    instance.pause();
  });

  test("a single point stroke paints nothing in either backend", async () => {
    const { svg } = await mountEditor();
    const painted = fromSvg(svg)[0].shapes.filter((shape) => shape.kind === "Stroke");
    expect(painted).toHaveLength(1);
    expect(traceAt(0)[0].shapes.filter((shape) => shape.kind === "Stroke")).toEqual(painted);
  });

  test("groups flatten to identical child geometry in both backends", async () => {
    const { id, svg } = await mountEditor();
    expect(fromSvg(svg)).toEqual(traceAt(0));
    const evaluated = await docEvaluate(id, "s0", 0, 0);
    expect(fromSvg(svg)[3]).toEqual(fromEvaluation(evaluated[0].layers)[3]);
    expect(fromSvg(svg)[3].shapes).toHaveLength(3);
  });

  test("gradient fills reach both renderers as the same paint", async () => {
    const { id, svg } = await mountEditor();
    const evaluated = await docEvaluate(id, "s0", 0, 0);
    const expected = fromEvaluation(evaluated[0].layers);
    const painted = expected[0].shapes.filter(
      (shape) => "paint" in shape && shape.paint.fill.startsWith("gradient:")
    );
    expect(painted.map((shape) => shape.kind)).toEqual(["Rect", "Polygon", "Path"]);
    const defs = Array.from(svg.querySelectorAll("[gradientUnits]"));
    expect(defs.map((def) => def.getAttribute("gradientUnits"))).toEqual(
      expected.flatMap((layer) =>
        layer.shapes.filter((shape) => "paint" in shape && shape.paint.fill.startsWith("gradient:"))
      ).map(() => "userSpaceOnUse")
    );
    expect(defs.length).toBeGreaterThan(3);
    expect(fromSvg(svg)).toEqual(expected);
    expect(traceAt(0)).toEqual(expected);
  });

  test("matching groups tween child by child while mismatched groups hold", async () => {
    const { id } = await mountEditor();
    const evaluated = await docEvaluate(id, "s0", 0, 2);
    for (const frame of evaluated) {
      expect(traceAt(frame.frame)).toEqual(fromEvaluation(frame.layers));
    }
    expect(evaluated[0].layers[3].shapes).toEqual([groupStart(), groupHoldStart()]);
    expect(evaluated[2].layers[2].shapes).toEqual([groupEnd(), groupHoldEnd()]);
    const middle = evaluated[1].layers[3].shapes;
    expect(middle[0]).toEqual({
      kind: "Group",
      children: [
        {
          kind: "Rect",
          x: 20,
          y: 15,
          w: 35,
          h: 25,
          fill: "#95639d",
          stroke: "#111827",
          width: 3,
          gradient: {
            kind: "linear",
            angle: 45,
            stops: [
              { offset: 0, color: "#800080" },
              { offset: 1, color: "#808080" }
            ]
          }
        },
        { kind: "Ellipse", x: 65, y: 20, w: 27, h: 18, fill: "#18b5a4", stroke: "#111827", width: 2, gradient: null }
      ]
    });
    expect(middle[1]).toEqual(groupHoldStart());
  });
});