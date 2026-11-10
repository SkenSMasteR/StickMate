import { invoke } from "@tauri-apps/api/core";

export interface Point {
  x: number;
  y: number;
}

export interface GradientStop {
  offset: number;
  color: string;
}

export type Gradient =
  | { kind: "linear"; angle: number; stops: GradientStop[] }
  | { kind: "radial"; stops: GradientStop[] };

export type Shape =
  | { kind: "Stroke"; points: Point[]; color: string; width: number }
  | {
      kind: "Rect";
      x: number;
      y: number;
      w: number;
      h: number;
      fill: string;
      stroke: string;
      width: number;
      gradient?: Gradient | null;
    }
  | {
      kind: "Ellipse";
      x: number;
      y: number;
      w: number;
      h: number;
      fill: string;
      stroke: string;
      width: number;
      gradient?: Gradient | null;
    }
  | {
      kind: "Polygon";
      x: number;
      y: number;
      w: number;
      h: number;
      sides: number;
      fill: string;
      stroke: string;
      width: number;
      gradient?: Gradient | null;
    }
  | {
      kind: "Text";
      x: number;
      y: number;
      text: string;
      size: number;
      family: string;
      color: string;
      spacing?: number;
      leading?: number;
      align?: TextAlign;
      matrix?: Affine | null;
    }
  | {
      kind: "Path";
      nodes: PathNode[];
      closed: boolean;
      fill: string;
      stroke: string;
      width: number;
      gradient?: Gradient | null;
    }
  | { kind: "Group"; children: Shape[] };

export interface PathNode {
  point: Point;
  handle_in: Point | null;
  handle_out: Point | null;
}

export const PATH_STEPS = 16;

export function flattenPath(nodes: PathNode[], closed: boolean): Point[] {
  const first = nodes[0];
  if (!first) {
    return [];
  }
  const out: Point[] = [first.point];
  const segments = closed ? nodes.length : nodes.length - 1;
  for (let index = 0; index < segments; index += 1) {
    const a = nodes[index];
    const b = nodes[(index + 1) % nodes.length];
    const p0 = a.point;
    const p1 = a.handle_out ?? p0;
    const p3 = b.point;
    const p2 = b.handle_in ?? p3;
    for (let step = 1; step <= PATH_STEPS; step += 1) {
      const t = step / PATH_STEPS;
      const u = 1 - t;
      out.push({
        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
      });
    }
  }
  return out;
}

export const TEXT_ADVANCE = 0.6;
export const TEXT_LEADING = 1.2;

export type TextAlign = "left" | "center" | "right";

export function textLineWidth(line: string, size: number, spacing: number): number {
  const count = [...line].length;
  if (count === 0) {
    return 0;
  }
  return Math.max(0, count * size * TEXT_ADVANCE + spacing * (count - 1));
}

export function textLines(text: string): string[] {
  return text.split("\n");
}

export function textBlockWidth(text: string, size: number, spacing: number): number {
  return Math.max(...textLines(text).map((line) => textLineWidth(line, size, spacing)), 0);
}

export function textBlockHeight(lines: number, size: number, leading: number): number {
  return size + size * leading * Math.max(0, lines - 1);
}

export function textLineOffset(width: number, block: number, align: TextAlign): number {
  if (align === "center") {
    return (block - width) / 2;
  }
  if (align === "right") {
    return block - width;
  }
  return 0;
}

export interface TextLayout {
  lines: string[];
  spacing: number;
  leading: number;
  align: TextAlign;
  block: number;
  height: number;
  lineHeight: number;
}

export function textLayout(shape: Extract<Shape, { kind: "Text" }>): TextLayout {
  const spacing = shape.spacing ?? 0;
  const leading = shape.leading ?? TEXT_LEADING;
  const align = shape.align ?? "left";
  const lines = textLines(shape.text);
  return {
    lines,
    spacing,
    leading,
    align,
    block: textBlockWidth(shape.text, shape.size, spacing),
    height: textBlockHeight(lines.length, shape.size, leading),
    lineHeight: shape.size * leading
  };
}

export function textLinePositions(shape: Extract<Shape, { kind: "Text" }>): Array<{ text: string; x: number; y: number }> {
  const layout = textLayout(shape);
  return layout.lines.map((line, index) => ({
    text: line,
    x: shape.x + textLineOffset(textLineWidth(line, shape.size, layout.spacing), layout.block, layout.align),
    y: shape.y + index * layout.lineHeight
  }));
}

export function polygonVertices(
  x: number,
  y: number,
  w: number,
  h: number,
  sides: number
): Point[] {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const step = (Math.PI * 2) / sides;
  return Array.from({ length: sides }, (_, index) => {
    const angle = -Math.PI / 2 + index * step;
    return { x: cx + (w / 2) * Math.cos(angle), y: cy + (h / 2) * Math.sin(angle) };
  });
}

export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export function affineFrom(
  pivot: Point,
  dx: number,
  dy: number,
  sx: number,
  sy: number,
  rotation: number
): Affine {
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  return {
    a,
    b,
    c,
    d,
    e: pivot.x - a * pivot.x - c * pivot.y + dx,
    f: pivot.y - b * pivot.x - d * pivot.y + dy
  };
}

export function applyAffine(matrix: Affine, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f
  };
}

export function composeAffine(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f
  };
}

export function textCorners(shape: Extract<Shape, { kind: "Text" }>): Point[] {
  const { x, y, matrix } = shape;
  const layout = textLayout(shape);
  return [
    { x, y },
    { x: x + layout.block, y },
    { x: x + layout.block, y: y + layout.height },
    { x, y: y + layout.height }
  ].map((point) => matrix ? applyAffine(matrix, point) : point);
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

function pointsBounds(points: Point[], width: number): Bounds {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const pad = width / 2;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return {
    x,
    y,
    w: Math.max(...xs) + pad - x,
    h: Math.max(...ys) + pad - y
  };
}

export function shapeBounds(shape: Shape): Bounds {
  if (shape.kind === "Stroke") {
    return pointsBounds(shape.points, shape.width);
  }
  if (shape.kind === "Path") {
    return pointsBounds(flattenPath(shape.nodes, shape.closed), shape.width);
  }
  if (shape.kind === "Text") {
    return pointsBounds(textCorners(shape), 0);
  }
  if (shape.kind === "Group") {
    return (
      unionBounds(shape.children, shape.children.map((_, index) => index)) ?? {
        x: 0,
        y: 0,
        w: 0,
        h: 0
      }
    );
  }
  return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
}

export function shapeGradient(shape: Shape): Gradient | null {
  if (
    shape.kind === "Rect" ||
    shape.kind === "Ellipse" ||
    shape.kind === "Polygon" ||
    shape.kind === "Path"
  ) {
    return shape.gradient ?? null;
  }
  return null;
}

export function defaultGradient(kind: "linear" | "radial"): Gradient {
  const stops = [
    { offset: 0, color: "#ffffff" },
    { offset: 1, color: "#000000" }
  ];
  return kind === "radial" ? { kind, stops } : { kind, angle: 0, stops };
}

export function gradientBox(shape: Shape): Bounds {
  if (shape.kind === "Rect" || shape.kind === "Ellipse" || shape.kind === "Polygon") {
    return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  }
  if (shape.kind === "Path") {
    const points: Point[] = [];
    for (const node of shape.nodes) {
      points.push(node.point);
      if (node.handle_in) {
        points.push(node.handle_in);
      }
      if (node.handle_out) {
        points.push(node.handle_out);
      }
    }
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

export function gradientGeometry(
  box: Bounds,
  gradient: Gradient
): [number, number, number, number, number] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (gradient.kind === "radial") {
    return [cx, cy, cx, cy, Math.hypot(box.w / 2, box.h / 2)];
  }
  const rad = (gradient.angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const half = (Math.abs(dx) * box.w + Math.abs(dy) * box.h) / 2;
  return [cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half, 0];
}

export function unionBounds(shapes: Shape[], indices: number[]): Bounds | null {
  let box: Bounds | null = null;
  for (const index of indices) {
    const shape = shapes[index];
    if (!shape) {
      continue;
    }
    const item = shapeBounds(shape);
    if (!box) {
      box = item;
      continue;
    }
    const x = Math.min(box.x, item.x);
    const y = Math.min(box.y, item.y);
    box = {
      x,
      y,
      w: Math.max(box.x + box.w, item.x + item.w) - x,
      h: Math.max(box.y + box.h, item.y + item.h) - y
    };
  }
  return box;
}

export interface Transform {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  opacity: number;
}

export interface Easing {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type EasingPresetId = "linear" | "easeIn" | "easeOut" | "easeInOut";

export const linearEasing: Easing = { x1: 0, y1: 0, x2: 1, y2: 1 };

export const easingPresets: Array<{ id: EasingPresetId; easing: Easing }> = [
  { id: "linear", easing: linearEasing },
  { id: "easeIn", easing: { x1: 0.42, y1: 0, x2: 1, y2: 1 } },
  { id: "easeOut", easing: { x1: 0, y1: 0, x2: 0.58, y2: 1 } },
  { id: "easeInOut", easing: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } }
];

export function isLinearEasing(easing: Easing): boolean {
  return easing.x1 === easing.y1 && easing.x2 === easing.y2;
}

export function clampEasing(easing: Easing): Easing {
  const values = [easing.x1, easing.y1, easing.x2, easing.y2];
  if (values.some((value) => !Number.isFinite(value))) {
    return { ...linearEasing };
  }
  return {
    x1: Math.min(1, Math.max(0, easing.x1)),
    y1: Math.min(2, Math.max(-1, easing.y1)),
    x2: Math.min(1, Math.max(0, easing.x2)),
    y2: Math.min(2, Math.max(-1, easing.y2))
  };
}

export function sameEasing(left: Easing, right: Easing): boolean {
  return (
    left.x1 === right.x1 &&
    left.y1 === right.y1 &&
    left.x2 === right.x2 &&
    left.y2 === right.y2
  );
}

function cubicValue(p1: number, p2: number, u: number): number {
  const inv = 1 - u;
  return 3 * inv * inv * u * p1 + 3 * inv * u * u * p2 + u * u * u;
}

function cubicSlope(p1: number, p2: number, u: number): number {
  const inv = 1 - u;
  return 3 * inv * inv * p1 + 6 * inv * u * (p2 - p1) + 3 * u * u * (1 - p2);
}

function curveUnit(x1: number, x2: number, target: number): number {
  let u = target;
  for (let steps = 0; steps < 8; steps += 1) {
    const error = cubicValue(x1, x2, u) - target;
    if (Math.abs(error) <= 1e-7) {
      return u;
    }
    const slope = cubicSlope(x1, x2, u);
    if (Math.abs(slope) <= 1e-7) {
      break;
    }
    const next = u - error / slope;
    if (next <= 0 || next >= 1) {
      break;
    }
    u = next;
  }
  let low = 0;
  let high = 1;
  for (let index = 0; index < 32; index += 1) {
    const middle = (low + high) / 2;
    if (cubicValue(x1, x2, middle) < target) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

export function easeProgress(t: number, easing: Easing | null | undefined): number {
  if (t <= 0) {
    return 0;
  }
  if (t >= 1) {
    return 1;
  }
  if (!easing || isLinearEasing(easing)) {
    return t;
  }
  return cubicValue(easing.y1, easing.y2, curveUnit(easing.x1, easing.x2, t));
}

export interface Keyframe {
  frame: number;
  shapes: Shape[];
  transform: Transform;
  tween: boolean;
  easing?: Easing;
  label: string | null;
}

export type Blend =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export const blends: Blend[] = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity"
];

export type Effect =
  | { kind: "blur"; radius: number }
  | { kind: "shadow"; x: number; y: number; blur: number; color: string };

export const effectKinds: Effect["kind"][] = ["blur", "shadow"];

export function cssEffects(effects: Effect[]): string {
  return effects
    .map((effect) =>
      effect.kind === "blur"
        ? `blur(${effect.radius}px)`
        : `drop-shadow(${effect.x}px ${effect.y}px ${effect.blur}px ${effect.color})`
    )
    .join(" ");
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: Blend;
  effects: Effect[];
  masked: boolean;
  length: number;
  keys: Keyframe[];
  folder: boolean;
  children: Layer[];
}

export interface Scene {
  id: string;
  name: string;
  layers: Layer[];
}

export interface Document {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  background: string;
  scenes: Scene[];
}

export interface EvalMask {
  transform: Transform;
  shapes: Shape[];
}

export interface EvalLayer {
  id: string;
  folder: boolean;
  opacity: number;
  blend: Blend;
  effects: Effect[];
  mask: EvalMask | null;
  transform: Transform;
  shapes: Shape[];
  children: EvalLayer[];
}

export interface EvalFrame {
  frame: number;
  layers: EvalLayer[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  updated_at: number;
}

export const identityTransform: Transform = {
  x: 0,
  y: 0,
  rotation: 0,
  scale: 1,
  opacity: 1
};

export function layerLength(layer: Layer): number {
  if (!layer.folder) {
    return layer.length;
  }
  return layer.children.reduce((longest, child) => Math.max(longest, layerLength(child)), 1);
}

export function sceneLength(scene: Scene): number {
  return scene.layers.reduce((longest, layer) => Math.max(longest, layerLength(layer)), 1);
}

export function findLayer<T extends { id: string; children: T[] }>(
  layers: T[],
  layerId: string
): T | null {
  for (const layer of layers) {
    if (layer.id === layerId) {
      return layer;
    }
    const nested = findLayer(layer.children, layerId);
    if (nested) {
      return nested;
    }
  }
  return null;
}

export function leafLayers<T extends { folder: boolean; children: T[] }>(layers: T[]): T[] {
  return layers.flatMap((layer) => (layer.folder ? leafLayers(layer.children) : [layer]));
}

export function leafCount(layers: Layer[]): number {
  return layers.reduce((total, layer) => total + (layer.folder ? leafCount(layer.children) : 1), 0);
}

export interface LayerRow {
  layer: Layer;
  depth: number;
  index: number;
  total: number;
  parentId: string | null;
}

export function visibleRows(
  layers: Layer[],
  collapsed: string[],
  depth = 0,
  parentId: string | null = null
): LayerRow[] {
  const rows: LayerRow[] = [];
  layers.forEach((layer, index) => {
    rows.push({ layer, depth, index, total: layers.length, parentId });
    if (layer.folder && !collapsed.includes(layer.id)) {
      rows.push(...visibleRows(layer.children, collapsed, depth + 1, layer.id));
    }
  });
  return rows;
}

export function folderOptions(layers: Layer[], depth = 0): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (const layer of layers) {
    if (layer.folder) {
      options.push({ value: layer.id, label: `${"\u2013 ".repeat(depth)}${layer.name}` });
      options.push(...folderOptions(layer.children, depth + 1));
    }
  }
  return options;
}

export function heldKey(layer: Layer, frame: number): Keyframe | null {
  let found: Keyframe | null = null;
  for (const key of layer.keys) {
    if (key.frame <= frame) {
      found = key;
    }
  }
  return found;
}

export function docNew(
  name: string,
  width: number,
  height: number,
  fps: number,
  background: string
): Promise<Document> {
  return invoke<Document>("doc_new", { name, width, height, fps, background });
}

export function docList(): Promise<ProjectSummary[]> {
  return invoke<ProjectSummary[]>("doc_list");
}

export function docRecoveryReport(): Promise<string[]> {
  return invoke<string[]>("doc_recovery_report");
}

export function docGet(id: string): Promise<Document> {
  return invoke<Document>("doc_get", { id });
}

export function docClose(id: string): Promise<void> {
  return invoke<void>("doc_close", { id });
}

export function docDelete(id: string): Promise<void> {
  return invoke<void>("doc_delete", { id });
}

export function docRename(id: string, name: string): Promise<Document> {
  return invoke<Document>("doc_rename", { id, name });
}

export function docAddScene(id: string, name: string): Promise<Document> {
  return invoke<Document>("doc_add_scene", { id, name });
}

export function docRenameScene(
  id: string,
  sceneId: string,
  name: string
): Promise<Document> {
  return invoke<Document>("doc_rename_scene", { id, sceneId, name });
}

export function docRemoveScene(id: string, sceneId: string): Promise<Document> {
  return invoke<Document>("doc_remove_scene", { id, sceneId });
}

export function docDuplicateScene(id: string, sceneId: string): Promise<Document> {
  return invoke<Document>("doc_duplicate_scene", { id, sceneId });
}

export function docMoveScene(
  id: string,
  sceneId: string,
  index: number
): Promise<Document> {
  return invoke<Document>("doc_move_scene", { id, sceneId, index });
}

export function docAddLayer(
  id: string,
  sceneId: string,
  name: string,
  parentId?: string | null
): Promise<Document> {
  return invoke<Document>("doc_add_layer", { id, sceneId, name, parentId: parentId ?? null });
}

export function docAddFolder(
  id: string,
  sceneId: string,
  name: string,
  parentId?: string | null
): Promise<Document> {
  return invoke<Document>("doc_add_folder", { id, sceneId, name, parentId: parentId ?? null });
}

export function docRemoveFolder(id: string, sceneId: string, folderId: string): Promise<Document> {
  return invoke<Document>("doc_remove_folder", { id, sceneId, folderId });
}

export function docSetLayer(
  id: string,
  sceneId: string,
  layerId: string,
  patch: {
    name?: string;
    visible?: boolean;
    locked?: boolean;
    opacity?: number;
    blend?: Blend;
    effects?: Effect[];
    masked?: boolean;
  }
): Promise<Document> {
  return invoke<Document>("doc_set_layer", {
    id,
    sceneId,
    layerId,
    name: patch.name ?? null,
    visible: patch.visible ?? null,
    locked: patch.locked ?? null,
    opacity: patch.opacity ?? null,
    blend: patch.blend ?? null,
    effects: patch.effects ?? null,
    masked: patch.masked ?? null
  });
}

export function docRemoveLayer(
  id: string,
  sceneId: string,
  layerId: string
): Promise<Document> {
  return invoke<Document>("doc_remove_layer", { id, sceneId, layerId });
}

export function docMoveLayer(
  id: string,
  sceneId: string,
  layerId: string,
  index: number,
  parentId?: string | null
): Promise<Document> {
  return invoke<Document>("doc_move_layer", {
    id,
    sceneId,
    layerId,
    index,
    parentId: parentId ?? null
  });
}

export function docInsertFrame(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number
): Promise<Document> {
  return invoke<Document>("doc_insert_frame", { id, sceneId, layerId, frame });
}

export function docKeyframe(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  blank: boolean
): Promise<Document> {
  return invoke<Document>("doc_keyframe", { id, sceneId, layerId, frame, blank });
}

export function docRemoveFrame(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number
): Promise<Document> {
  return invoke<Document>("doc_remove_frame", { id, sceneId, layerId, frame });
}

export function docSetTween(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  tween: boolean,
  easing?: Easing | null
): Promise<Document> {
  return invoke<Document>("doc_set_tween", {
    id,
    sceneId,
    layerId,
    frame,
    tween,
    easing: easing ?? null
  });
}

export function docSetLabel(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  label: string | null
): Promise<Document> {
  return invoke<Document>("doc_set_label", { id, sceneId, layerId, frame, label });
}

export function docDraw(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  shape: Shape
): Promise<Document> {
  return invoke<Document>("doc_draw", { id, sceneId, layerId, frame, shape });
}

export function docErase(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  path: Point[],
  radius: number
): Promise<Document> {
  return invoke<Document>("doc_erase", { id, sceneId, layerId, frame, path, radius });
}

export function docPaintShape(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  index: number,
  color: string
): Promise<Document> {
  return invoke<Document>("doc_paint_shape", {
    id,
    sceneId,
    layerId,
    frame,
    index,
    color
  });
}

export function docReplaceShape(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  index: number,
  shape: Shape
): Promise<Document> {
  return invoke<Document>("doc_replace_shape", {
    id,
    sceneId,
    layerId,
    frame,
    index,
    shape
  });
}

export function docDeleteShape(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  index: number
): Promise<Document> {
  return invoke<Document>("doc_delete_shape", { id, sceneId, layerId, frame, index });
}

export function docTransformShapes(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  indices: number[],
  pivot: Point,
  dx: number,
  dy: number,
  sx: number,
  sy: number,
  rotation: number
): Promise<Document> {
  return invoke<Document>("doc_transform_shapes", {
    id,
    sceneId,
    layerId,
    frame,
    indices,
    pivot,
    dx,
    dy,
    sx,
    sy,
    rotation
  });
}

export type AlignMode =
  | "left"
  | "center_h"
  | "right"
  | "top"
  | "center_v"
  | "bottom"
  | "distribute_h"
  | "distribute_v";

export type AlignReference = "stage" | "selection";

export function docAlignShapes(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  indices: number[],
  mode: AlignMode,
  reference: AlignReference
): Promise<Document> {
  return invoke<Document>("doc_align_shapes", {
    id,
    sceneId,
    layerId,
    frame,
    indices,
    mode,
    reference
  });
}

export function docGroupShapes(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  indices: number[]
): Promise<Document> {
  return invoke<Document>("doc_group_shapes", { id, sceneId, layerId, frame, indices });
}

export function docUngroupShape(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  index: number
): Promise<Document> {
  return invoke<Document>("doc_ungroup_shape", { id, sceneId, layerId, frame, index });
}

export function docReorderShapes(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  indices: number[],
  toFront: boolean
): Promise<Document> {
  return invoke<Document>("doc_reorder_shapes", {
    id,
    sceneId,
    layerId,
    frame,
    indices,
    toFront
  });
}

export function docDeleteShapes(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  indices: number[]
): Promise<Document> {
  return invoke<Document>("doc_delete_shapes", { id, sceneId, layerId, frame, indices });
}

export function docSetTransform(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  transform: Transform
): Promise<Document> {
  return invoke<Document>("doc_set_transform", {
    id,
    sceneId,
    layerId,
    frame,
    transform
  });
}

export function docUndo(id: string): Promise<Document> {
  return invoke<Document>("doc_undo", { id });
}

export function docRedo(id: string): Promise<Document> {
  return invoke<Document>("doc_redo", { id });
}

export function docEvaluate(
  id: string,
  sceneId: string,
  startFrame: number,
  endFrame: number
): Promise<EvalFrame[]> {
  return invoke<EvalFrame[]>("doc_evaluate", { id, sceneId, startFrame, endFrame });
}