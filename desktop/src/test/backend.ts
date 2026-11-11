import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { combineShapes } from "@/lib/boolean";
import type { BoolOp } from "@/lib/boolean";
import {
  affineFrom,
  applyAffine,
  blends,
  clampEasing,
  composeAffine,
  easeProgress,
  flattenPath,
  linearEasing,
  polygonVertices,
  shapeBounds,
  shapeGradient,
  TEXT_LEADING,
  textCorners,
  unionBounds
} from "@/lib/document";
import type {
  Affine,
  AlignMode,
  AlignReference,
  Blend,
  Bounds,
  Document,
  Effect,
  EvalMask,
  Easing,
  EvalFrame,
  EvalLayer,
  Gradient,
  GradientStop,
  Keyframe,
  Layer,
  PathNode,
  Point,
  Scene,
  Shape,
  Transform
} from "@/lib/document";

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(16)}${counter.toString(16)}`;
}

function cleanName(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function clampEffect(value: number): number {
  return Number.isFinite(value) ? Math.min(500, Math.max(0, value)) : 0;
}

function sanitizeEffects(effects: Effect[]): Effect[] {
  return effects.map((effect) =>
    effect.kind === "blur"
      ? { kind: "blur", radius: clampEffect(effect.radius) }
      : {
          kind: "shadow",
          x: Math.min(500, Math.max(-500, effect.x)),
          y: Math.min(500, Math.max(-500, effect.y)),
          blur: clampEffect(effect.blur),
          color: effect.color
        }
  );
}

function maskFrom(provider: Layer | undefined, frame: number): EvalMask | null {
  if (!provider || provider.folder || !provider.visible || frame >= provider.length) {
    return null;
  }
  const evaluated = evaluateLayer(provider, frame);
  if (!evaluated) {
    return null;
  }
  return { transform: evaluated.transform, shapes: evaluated.shapes };
}

function validateLayerMasks(layers: Layer[]): void {
  for (let index = 1; index < layers.length; index += 1) {
    const clipped = layers[index - 1].masked || layers[index - 1].folder;
    if (layers[index].folder || (layers[index].masked && clipped)) {
      layers[index].masked = false;
    }
  }
  if (layers.length > 0) {
    layers[0].masked = false;
  }
  layers.forEach((layer) => validateLayerMasks(layer.children));
}

function validateSceneMasks(target: Scene): void {
  validateFolders(target.layers, 1, []);
  validateLayerMasks(target.layers);
}

const identity = (): Transform => ({
  x: 0,
  y: 0,
  rotation: 0,
  scale: 1,
  opacity: 1
});

function sanitize(t: Transform): Transform {
  return {
    x: t.x,
    y: t.y,
    rotation: t.rotation,
    scale: t.scale <= 0 ? 0.01 : t.scale,
    opacity: Math.min(1, Math.max(0, t.opacity))
  };
}

function lerp(a: Transform, b: Transform, t: number): Transform {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    rotation: a.rotation + (b.rotation - a.rotation) * t,
    scale: a.scale + (b.scale - a.scale) * t,
    opacity: a.opacity + (b.opacity - a.opacity) * t
  };
}

function within(a: Point, b: Point, radius: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= radius * radius;
}

function nearSegment(p: Point, a: Point, b: Point, radius: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 <= Number.EPSILON
      ? 0
      : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return within(p, { x: a.x + dx * t, y: a.y + dy * t }, radius);
}

function insidePolygon(p: Point, vertices: Point[]): boolean {
  let inside = false;
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    if (a.y > p.y !== b.y > p.y) {
      const cross = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (p.x < cross) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function shapeHit(shape: Shape, p: Point, radius: number): boolean {
  if (shape.kind === "Group") {
    const box = shapeBounds(shape);
    return (
      p.x >= box.x - radius &&
      p.x <= box.x + box.w + radius &&
      p.y >= box.y - radius &&
      p.y <= box.y + box.h + radius
    );
  }
  if (shape.kind === "Stroke") {
    const reach = radius + shape.width / 2;
    return (
      shape.points.some(
        (point, index) =>
          index > 0 && nearSegment(p, shape.points[index - 1], point, reach)
      ) || (shape.points.length > 0 && within(p, shape.points[0], reach))
    );
  }
  if (shape.kind === "Rect") {
    return (
      p.x >= shape.x - radius &&
      p.x <= shape.x + shape.w + radius &&
      p.y >= shape.y - radius &&
      p.y <= shape.y + shape.h + radius
    );
  }
  if (shape.kind === "Ellipse") {
    const rx = shape.w / 2 + radius;
    const ry = shape.h / 2 + radius;
    if (rx <= 0 || ry <= 0) {
      return false;
    }
    const dx = (p.x - (shape.x + shape.w / 2)) / rx;
    const dy = (p.y - (shape.y + shape.h / 2)) / ry;
    return dx * dx + dy * dy <= 1;
  }
  if (shape.kind === "Polygon") {
    const vertices = polygonVertices(shape.x, shape.y, shape.w, shape.h, shape.sides);
    return (
      insidePolygon(p, vertices) ||
      vertices.some((a, index) =>
        nearSegment(p, a, vertices[(index + 1) % vertices.length], radius)
      )
    );
  }
  if (shape.kind === "Path") {
    const reach = radius + shape.width / 2;
    const outline = flattenPath(shape.nodes, shape.closed);
    return (
      outline.some(
        (point, index) =>
          index > 0 && nearSegment(p, outline[index - 1], point, reach)
      ) ||
      (outline.length > 0 && within(p, outline[0], reach)) ||
      (shape.closed && insidePolygon(p, outline))
    );
  }
  const vertices = textCorners(shape);
  return (
    insidePolygon(p, vertices) ||
    vertices.some((a, index) =>
      nearSegment(p, a, vertices[(index + 1) % vertices.length], radius)
    )
  );
}

function densify(path: Point[], spacing: number): Point[] {
  const out: Point[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const point = path[index];
    out.push(point);
    const next = path[index + 1];
    if (!next) {
      continue;
    }
    const distance = Math.hypot(next.x - point.x, next.y - point.y);
    const steps = Math.ceil(distance / spacing);
    for (let step = 1; step < steps; step += 1) {
      if (out.length >= 20000) {
        return out;
      }
      const t = step / steps;
      out.push({
        x: point.x + (next.x - point.x) * t,
        y: point.y + (next.y - point.y) * t
      });
    }
  }
  return out;
}

function validateShape(shape: Shape): void {
  if (shape.kind === "Group") {
    if (shape.children.length === 0) {
      throw new Error("group is empty");
    }
    for (const child of shape.children) {
      validateShape(child);
    }
    return;
  }
  const gradient = shapeGradient(shape);
  if (gradient) {
    validateGradient(gradient);
  }
  if (shape.kind === "Polygon" && shape.sides < 3) {
    throw new Error("polygon needs at least 3 sides");
  }
  if (shape.kind === "Text") {
    if (shape.text.trim() === "") {
      throw new Error("text is empty");
    }
    if (!Number.isFinite(shape.size) || shape.size <= 0) {
      throw new Error("text size must be positive");
    }
    if (
      shape.spacing !== undefined &&
      (!Number.isFinite(shape.spacing) || shape.spacing < -500 || shape.spacing > 500)
    ) {
      throw new Error("text spacing must be between -500 and 500");
    }
    if (
      shape.leading !== undefined &&
      (!Number.isFinite(shape.leading) || shape.leading < 0.2 || shape.leading > 10)
    ) {
      throw new Error("text line spacing must be between 0.2 and 10");
    }
    if (
      shape.align !== undefined &&
      shape.align !== "left" &&
      shape.align !== "center" &&
      shape.align !== "right"
    ) {
      throw new Error("unknown text alignment");
    }
    if (!Number.isFinite(shape.x) || !Number.isFinite(shape.y)) {
      throw new Error("text coordinates must be finite");
    }
    if (shape.matrix) {
      const m = shape.matrix;
      if (![m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite)) {
        throw new Error("text matrix must be finite");
      }
    }
  }
  if (shape.kind === "Path") {
    if (shape.closed && shape.nodes.length < 3) {
      throw new Error("closed path needs at least 3 nodes");
    }
    if (shape.nodes.length < 2) {
      throw new Error("path needs at least 2 nodes");
    }
    for (const node of shape.nodes) {
      for (const point of [node.point, node.handle_in, node.handle_out]) {
        if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y))) {
          throw new Error("path coordinates must be finite");
        }
      }
    }
    if (shape.width < 0.5 || shape.width > 200) {
      throw new Error("width must be between 0.5 and 200");
    }
  }
}

function paintFill(shape: Shape, color: string): Shape {
  if (shape.kind === "Group") {
    return {
      kind: "Group",
      children: shape.children.map((child) => paintFill(child, color))
    };
  }
  if (shape.kind === "Stroke" || shape.kind === "Text") {
    return shape;
  }
  return { ...shape, fill: color, gradient: null };
}

function cornersPath(
  corners: Point[],
  matrix: Affine,
  fill: string,
  stroke: string,
  width: number,
  gradient: Gradient | null
): Shape {
  const nodes: PathNode[] = corners.map((point) => ({
    point: applyAffine(matrix, point),
    handle_in: null,
    handle_out: null
  }));
  return { kind: "Path", nodes, closed: true, fill, stroke, width, gradient };
}

function rotatedGradient(gradient: Gradient | null | undefined, rotation: number): Gradient | null {
  if (!gradient) {
    return null;
  }
  return gradient.kind === "linear"
    ? { kind: "linear", angle: gradient.angle + rotation, stops: gradient.stops }
    : gradient;
}

function validateGradient(gradient: Gradient): void {
  if (gradient.stops.length < 2) {
    throw new Error("gradient needs at least 2 stops");
  }
  if (gradient.stops.length > 32) {
    throw new Error("gradient has too many stops");
  }
  if (gradient.kind === "linear" && !Number.isFinite(gradient.angle)) {
    throw new Error("gradient angle must be finite");
  }
  let previous = 0;
  gradient.stops.forEach((stop, index) => {
    if (!Number.isFinite(stop.offset) || stop.offset < 0 || stop.offset > 1) {
      throw new Error("gradient stop offset must be between 0 and 1");
    }
    if (index > 0 && stop.offset < previous) {
      throw new Error("gradient stops must be in order");
    }
    if (stop.color.length > 1024) {
      throw new Error("gradient stop color is too long");
    }
    previous = stop.offset;
  });
}

export function transformShape(
  shape: Shape,
  matrix: Affine,
  sx: number,
  sy: number,
  rotation: number
): Shape {
  if (shape.kind === "Group") {
    return {
      kind: "Group",
      children: shape.children.map((child) => transformShape(child, matrix, sx, sy, rotation))
    };
  }
  if (shape.kind === "Stroke") {
    return {
      ...shape,
      points: shape.points.map((point) => applyAffine(matrix, point))
    };
  }
  if (shape.kind === "Path") {
    return {
      ...shape,
      nodes: shape.nodes.map((node) => ({
        point: applyAffine(matrix, node.point),
        handle_in: node.handle_in ? applyAffine(matrix, node.handle_in) : null,
        handle_out: node.handle_out ? applyAffine(matrix, node.handle_out) : null
      }))
    };
  }
  if (shape.kind === "Text") {
    if (!shape.matrix && rotation === 0 && sx === sy) {
      const q = applyAffine(matrix, { x: shape.x, y: shape.y });
      return {
        ...shape,
        x: q.x,
        y: q.y,
        size: shape.size * sx,
        spacing: (shape.spacing ?? 0) * sx
      };
    }
    return { ...shape, matrix: shape.matrix ? composeAffine(matrix, shape.matrix) : matrix };
  }
  if (shape.kind === "Ellipse" && rotation !== 0) {
    if (rotation % 90 !== 0) {
      throw new Error("ellipse cannot be rotated");
    }
    const center = applyAffine(matrix, {
      x: shape.x + shape.w / 2,
      y: shape.y + shape.h / 2
    });
    const odd = Math.abs(Math.trunc(rotation / 90)) % 2 === 1;
    const nw = odd ? shape.h * sy : shape.w * sx;
    const nh = odd ? shape.w * sx : shape.h * sy;
    return { ...shape, x: center.x - nw / 2, y: center.y - nh / 2, w: nw, h: nh };
  }
  if (shape.kind === "Rect" && rotation !== 0) {
    return cornersPath(
      [
        { x: shape.x, y: shape.y },
        { x: shape.x + shape.w, y: shape.y },
        { x: shape.x + shape.w, y: shape.y + shape.h },
        { x: shape.x, y: shape.y + shape.h }
      ],
      matrix,
      shape.fill,
      shape.stroke,
      shape.width,
      rotatedGradient(shape.gradient, rotation)
    );
  }
  if (shape.kind === "Polygon" && rotation !== 0) {
    return cornersPath(
      polygonVertices(shape.x, shape.y, shape.w, shape.h, shape.sides),
      matrix,
      shape.fill,
      shape.stroke,
      shape.width,
      rotatedGradient(shape.gradient, rotation)
    );
  }
  const q = applyAffine(matrix, { x: shape.x, y: shape.y });
  return { ...shape, x: q.x, y: q.y, w: shape.w * sx, h: shape.h * sy };
}

const alignModes: AlignMode[] = [
  "left",
  "center_h",
  "right",
  "top",
  "center_v",
  "bottom",
  "distribute_h",
  "distribute_v"
];

const alignReferences: AlignReference[] = ["stage", "selection"];

function parseAlignMode(value: unknown): AlignMode {
  if (alignModes.includes(value as AlignMode)) {
    return value as AlignMode;
  }
  throw new Error("unknown align mode");
}

function parseAlignReference(value: unknown): AlignReference {
  if (alignReferences.includes(value as AlignReference)) {
    return value as AlignReference;
  }
  throw new Error("unknown align reference");
}

function alignOffsets(
  stage: Bounds,
  source: Shape[],
  indices: number[],
  mode: AlignMode,
  reference: AlignReference
): Array<[number, number, number]> {
  const referenceBox =
    reference === "stage"
      ? stage
      : unionBounds(source, indices) ?? { x: 0, y: 0, w: 0, h: 0 };
  const offsets: Array<[number, number, number]> = [];
  if (mode === "left" || mode === "center_h" || mode === "right") {
    for (const index of indices) {
      const item = shapeBounds(source[index]);
      const dx =
        mode === "left"
          ? referenceBox.x - item.x
          : mode === "right"
            ? referenceBox.x + referenceBox.w - (item.x + item.w)
            : referenceBox.x + referenceBox.w / 2 - (item.x + item.w / 2);
      offsets.push([index, dx, 0]);
    }
  } else if (mode === "top" || mode === "center_v" || mode === "bottom") {
    for (const index of indices) {
      const item = shapeBounds(source[index]);
      const dy =
        mode === "top"
          ? referenceBox.y - item.y
          : mode === "bottom"
            ? referenceBox.y + referenceBox.h - (item.y + item.h)
            : referenceBox.y + referenceBox.h / 2 - (item.y + item.h / 2);
      offsets.push([index, 0, dy]);
    }
  } else if (indices.length >= 3) {
    const horizontal = mode === "distribute_h";
    const placed = indices
      .map((index) => {
        const item = shapeBounds(source[index]);
        return {
          edge: horizontal ? item.x : item.y,
          size: horizontal ? item.w : item.h,
          index
        };
      })
      .sort((a, b) => a.edge - b.edge || a.index - b.index);
    const start = horizontal ? referenceBox.x : referenceBox.y;
    const span = horizontal ? referenceBox.w : referenceBox.h;
    const total = placed.reduce((sum, item) => sum + item.size, 0);
    const gap = (span - total) / (placed.length - 1);
    let cursor = start;
    for (const item of placed) {
      const delta = cursor - item.edge;
      offsets.push(horizontal ? [item.index, delta, 0] : [item.index, 0, delta]);
      cursor += item.size + gap;
    }
  }
  return offsets.filter(([, dx, dy]) => dx !== 0 || dy !== 0);
}

const emptyKey = (frame: number): Keyframe => ({
  frame,
  shapes: [],
  transform: identity(),
  tween: false,
  easing: { ...linearEasing },
  label: null
});

function newLayer(name: string): Layer {
  return {
    id: id("l"),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    effects: [],
    masked: false,
    length: 1,
    keys: [emptyKey(0)],
    folder: false,
    children: []
  };
}

function newFolder(name: string): Layer {
  return {
    id: id("l"),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    effects: [],
    masked: false,
    length: 0,
    keys: [],
    folder: true,
    children: []
  };
}

const maxFolderDepth = 16;

function findLayer(layers: Layer[], layerId: string): Layer | null {
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

function leafCount(layers: Layer[]): number {
  return layers.reduce((total, layer) => total + (layer.folder ? leafCount(layer.children) : 1), 0);
}

function subtreeLeafCount(layer: Layer): number {
  return layer.folder ? layer.children.reduce((total, child) => total + subtreeLeafCount(child), 0) : 1;
}

function containsLayer(layers: Layer[], layerId: string): boolean {
  return layers.some((layer) => layer.id === layerId || containsLayer(layer.children, layerId));
}

function subtreeHeight(layer: Layer): number {
  return 1 + layer.children.reduce((tallest, child) => Math.max(tallest, subtreeHeight(child)), 0);
}

function layerDepth(layers: Layer[], layerId: string, level: number): number | null {
  for (const layer of layers) {
    if (layer.id === layerId) {
      return level;
    }
    const nested = layerDepth(layer.children, layerId, level + 1);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function ancestorLocked(layers: Layer[], layerId: string, inherited = false): boolean {
  for (const layer of layers) {
    if (layer.id === layerId) {
      return inherited;
    }
    if (ancestorLocked(layer.children, layerId, inherited || layer.locked)) {
      return true;
    }
  }
  return false;
}

function reseedLayer(layer: Layer): void {
  layer.id = id("l");
  layer.children.forEach(reseedLayer);
}

function insertLayerTree(
  layers: Layer[],
  parentId: string | null | undefined,
  index: number,
  layer: Layer
): void {
  if (parentId === null || parentId === undefined) {
    layers.splice(Math.min(index, layers.length), 0, layer);
    return;
  }
  for (const current of layers) {
    if (current.id === parentId) {
      if (!current.folder) {
        throw new Error("target is not a folder");
      }
      current.children.splice(Math.min(index, current.children.length), 0, layer);
      return;
    }
    if (findLayer(current.children, parentId)) {
      insertLayerTree(current.children, parentId, index, layer);
      return;
    }
  }
  throw new Error("unknown folder");
}

function removeLayerTree(layers: Layer[], layerId: string): Layer {
  const index = layers.findIndex((layer) => layer.id === layerId);
  if (index >= 0) {
    return layers.splice(index, 1)[0];
  }
  for (const layer of layers) {
    if (findLayer(layer.children, layerId)) {
      return removeLayerTree(layer.children, layerId);
    }
  }
  throw new Error("unknown layer");
}

function duplicateLayerTree(layers: Layer[], layerId: string): void {
  const index = layers.findIndex((layer) => layer.id === layerId);
  if (index >= 0) {
    const copy = structuredClone(layers[index]);
    reseedLayer(copy);
    copy.name = `${copy.name} copy`;
    layers.splice(index + 1, 0, copy);
    return;
  }
  for (const layer of layers) {
    if (findLayer(layer.children, layerId)) {
      duplicateLayerTree(layer.children, layerId);
      return;
    }
  }
  throw new Error("unknown layer");
}

function openFolderTree(layers: Layer[], folderId: string): void {
  const index = layers.findIndex((layer) => layer.id === folderId);
  if (index >= 0) {
    if (!layers[index].folder) {
      throw new Error("target is not a folder");
    }
    const [folder] = layers.splice(index, 1);
    folder.children.forEach((child, offset) => layers.splice(index + offset, 0, child));
    return;
  }
  for (const layer of layers) {
    if (findLayer(layer.children, folderId)) {
      openFolderTree(layer.children, folderId);
      return;
    }
  }
  throw new Error("unknown folder");
}

function setLayerMask(layers: Layer[], layerId: string, masked: boolean): void {
  for (let index = 0; index < layers.length; index += 1) {
    if (layers[index].id === layerId) {
      if (masked) {
        if (layers[index].folder) {
          throw new Error("folders cannot be clipped");
        }
        if (index === 0) {
          throw new Error("the top layer cannot be clipped");
        }
        if (layers[index - 1].masked) {
          throw new Error("a mask layer cannot itself be clipped");
        }
        if (layers[index - 1].folder) {
          throw new Error("clipping needs a layer directly above");
        }
      }
      layers[index].masked = masked;
      return;
    }
    if (findLayer(layers[index].children, layerId)) {
      setLayerMask(layers[index].children, layerId, masked);
      return;
    }
  }
  throw new Error("unknown layer");
}

function validateFolders(layers: Layer[], level: number, ids: string[]): void {
  for (const layer of layers) {
    if (level > maxFolderDepth) {
      throw new Error("folders cannot nest deeper than 16 levels");
    }
    if (!layer.id || ids.includes(layer.id)) {
      throw new Error("duplicate layer id");
    }
    ids.push(layer.id);
    if (layer.folder) {
      if (layer.keys.length > 0 || layer.masked) {
        throw new Error("folders cannot hold keyframes or clips");
      }
      validateFolders(layer.children, level + 1, ids);
    } else if (layer.children.length > 0) {
      throw new Error("only folders can hold layers");
    }
  }
}

function newScene(name: string): Scene {
  return { id: id("s"), name, layers: [newLayer("Layer 1")] };
}

function keyIndex(layer: Layer, frame: number): number {
  return layer.keys.findIndex((key) => key.frame === frame);
}

function heldIndex(layer: Layer, frame: number): number {
  let found = -1;
  layer.keys.forEach((key, index) => {
    if (key.frame <= frame) {
      found = index;
    }
  });
  return found;
}

function keyAt(layer: Layer, frame: number): number {
  const existing = keyIndex(layer, frame);
  if (existing >= 0) {
    return existing;
  }
  const held = heldIndex(layer, frame);
  const key: Keyframe =
    held >= 0
      ? {
          frame,
          shapes: structuredClone(layer.keys[held].shapes),
          transform: { ...layer.keys[held].transform },
          tween: false,
          easing: { ...linearEasing },
          label: null
        }
      : emptyKey(frame);
  const at = layer.keys.filter((item) => item.frame < frame).length;
  layer.keys.splice(at, 0, key);
  layer.length = Math.max(layer.length, frame + 1);
  return at;
}

function writable(layer: Layer): void {
  if (layer.locked) {
    throw new Error("layer is locked");
  }
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixPoint(a: Point, b: Point, t: number): Point {
  return { x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) };
}

function mixBytes(value: string): number[] | null {
  if (value.charAt(0) !== "#") {
    return null;
  }
  const hex = value.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return [
      parseInt(hex.charAt(0), 16) * 17,
      parseInt(hex.charAt(1), 16) * 17,
      parseInt(hex.charAt(2), 16) * 17
    ];
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16)
    ];
  }
  return null;
}

function mixColor(a: string, b: string, t: number): string {
  const from = mixBytes(a);
  const to = mixBytes(b);
  if (!from || !to) {
    return a;
  }
  let out = "#";
  for (let index = 0; index < 3; index += 1) {
    out += Math.floor(mix(from[index], to[index], t) + 0.5)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

function mixHandle(
  a: Point | null | undefined,
  b: Point | null | undefined,
  aPoint: Point,
  bPoint: Point,
  t: number
): Point | null {
  if (!a && !b) {
    return null;
  }
  return mixPoint(a ?? aPoint, b ?? bPoint, t);
}

function mixAffine(a: Affine, b: Affine, t: number): Affine {
  return {
    a: mix(a.a, b.a, t),
    b: mix(a.b, b.b, t),
    c: mix(a.c, b.c, t),
    d: mix(a.d, b.d, t),
    e: mix(a.e, b.e, t),
    f: mix(a.f, b.f, t)
  };
}

function gradientsMixable(a: Gradient | null, b: Gradient | null): boolean {
  if (!a && !b) {
    return true;
  }
  return !!a && !!b && a.kind === b.kind && a.stops.length === b.stops.length;
}

function mixStops(a: GradientStop[], b: GradientStop[], t: number): GradientStop[] {
  return a.map((stop, index) => ({
    offset: mix(stop.offset, b[index].offset, t),
    color: mixColor(stop.color, b[index].color, t)
  }));
}

function mixGradient(a: Gradient | null, b: Gradient | null, t: number): Gradient | null {
  if (a && b && a.kind === b.kind && a.stops.length === b.stops.length) {
    const stops = mixStops(a.stops, b.stops, t);
    if (a.kind === "linear" && b.kind === "linear") {
      return { kind: "linear", angle: mix(a.angle, b.angle, t), stops };
    }
    return { kind: "radial", stops };
  }
  return a ? structuredClone(a) : null;
}

function mixable(a: Shape, b: Shape): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  const fills = gradientsMixable(shapeGradient(a), shapeGradient(b));
  if (a.kind === "Rect" || a.kind === "Ellipse") {
    return fills;
  }
  if (a.kind === "Text") {
    return true;
  }
  if (a.kind === "Polygon" && b.kind === "Polygon") {
    return a.sides === b.sides && fills;
  }
  if (a.kind === "Stroke" && b.kind === "Stroke") {
    return a.points.length === b.points.length && a.points.length > 1;
  }
  if (a.kind === "Path" && b.kind === "Path") {
    return (
      a.closed === b.closed && a.nodes.length === b.nodes.length && a.nodes.length > 1 && fills
    );
  }
  if (a.kind === "Group" && b.kind === "Group") {
    return (
      a.children.length > 0 &&
      a.children.length === b.children.length &&
      a.children.every((child, index) => mixable(child, b.children[index]))
    );
  }
  return false;
}

function mixShape(a: Shape, b: Shape, t: number): Shape {
  if (t <= 0) {
    return structuredClone(a);
  }
  if (t >= 1) {
    return structuredClone(b);
  }
  if (a.kind === "Group" && b.kind === "Group" && mixable(a, b)) {
    return {
      kind: "Group",
      children: a.children.map((child, index) => mixShape(child, b.children[index], t))
    };
  }
  if (a.kind === "Rect" && b.kind === "Rect") {
    return {
      kind: "Rect",
      x: mix(a.x, b.x, t),
      y: mix(a.y, b.y, t),
      w: mix(a.w, b.w, t),
      h: mix(a.h, b.h, t),
      fill: mixColor(a.fill, b.fill, t),
      stroke: mixColor(a.stroke, b.stroke, t),
      width: mix(a.width, b.width, t),
      gradient: mixGradient(a.gradient ?? null, b.gradient ?? null, t)
    };
  }
  if (a.kind === "Ellipse" && b.kind === "Ellipse") {
    return {
      kind: "Ellipse",
      x: mix(a.x, b.x, t),
      y: mix(a.y, b.y, t),
      w: mix(a.w, b.w, t),
      h: mix(a.h, b.h, t),
      fill: mixColor(a.fill, b.fill, t),
      stroke: mixColor(a.stroke, b.stroke, t),
      width: mix(a.width, b.width, t),
      gradient: mixGradient(a.gradient ?? null, b.gradient ?? null, t)
    };
  }
  if (a.kind === "Polygon" && b.kind === "Polygon" && a.sides === b.sides) {
    return {
      kind: "Polygon",
      sides: a.sides,
      x: mix(a.x, b.x, t),
      y: mix(a.y, b.y, t),
      w: mix(a.w, b.w, t),
      h: mix(a.h, b.h, t),
      fill: mixColor(a.fill, b.fill, t),
      stroke: mixColor(a.stroke, b.stroke, t),
      width: mix(a.width, b.width, t),
      gradient: mixGradient(a.gradient ?? null, b.gradient ?? null, t)
    };
  }
  if (
    a.kind === "Stroke" &&
    b.kind === "Stroke" &&
    a.points.length === b.points.length &&
    a.points.length > 1
  ) {
    return {
      kind: "Stroke",
      points: a.points.map((point, index) => mixPoint(point, b.points[index], t)),
      color: mixColor(a.color, b.color, t),
      width: mix(a.width, b.width, t)
    };
  }
  if (
    a.kind === "Path" &&
    b.kind === "Path" &&
    a.closed === b.closed &&
    a.nodes.length === b.nodes.length &&
    a.nodes.length > 1
  ) {
    return {
      kind: "Path",
      nodes: a.nodes.map((node, index): PathNode => {
        const other = b.nodes[index];
        return {
          point: mixPoint(node.point, other.point, t),
          handle_in: mixHandle(node.handle_in, other.handle_in, node.point, other.point, t),
          handle_out: mixHandle(
            node.handle_out,
            other.handle_out,
            node.point,
            other.point,
            t
          )
        };
      }),
      closed: a.closed,
      fill: mixColor(a.fill, b.fill, t),
      stroke: mixColor(a.stroke, b.stroke, t),
      width: mix(a.width, b.width, t),
      gradient: mixGradient(a.gradient ?? null, b.gradient ?? null, t)
    };
  }
  if (a.kind === "Text" && b.kind === "Text") {
    return {
      kind: "Text",
      x: mix(a.x, b.x, t),
      y: mix(a.y, b.y, t),
      text: a.text,
      size: mix(a.size, b.size, t),
      family: a.family,
      color: mixColor(a.color, b.color, t),
      spacing: mix(a.spacing ?? 0, b.spacing ?? 0, t),
      leading: mix(a.leading ?? TEXT_LEADING, b.leading ?? TEXT_LEADING, t),
      align: a.align ?? "left",
      matrix:
        a.matrix && b.matrix
          ? mixAffine(a.matrix, b.matrix, t)
          : a.matrix ?? b.matrix ?? null
    };
  }
  return structuredClone(a);
}

function evaluateLayer(layer: Layer, frame: number): EvalLayer | null {
  if (!layer.visible || frame >= layer.length) {
    return null;
  }
  const index = heldIndex(layer, frame);
  if (index < 0) {
    return null;
  }
  const key = layer.keys[index];
  let transform = { ...key.transform };
  let shapes = structuredClone(key.shapes);
  if (key.tween) {
    const next = layer.keys[index + 1];
    if (next) {
      const span = next.frame - key.frame;
      if (span > 0) {
        const t = easeProgress(Math.min(1, Math.max(0, (frame - key.frame) / span)), key.easing);
        transform = lerp(transform, next.transform, t);
        shapes = key.shapes.map((shape, position) => {
          const other = next.shapes[position];
          return other ? mixShape(shape, other, t) : structuredClone(shape);
        });
      }
    }
  }
  return {
    id: layer.id,
    folder: false,
    opacity: Math.min(1, Math.max(0, layer.opacity * transform.opacity)),
    blend: layer.blend,
    effects: layer.effects,
    mask: null,
    transform,
    shapes,
    children: []
  };
}

function evaluateFolder(folder: Layer, frame: number): EvalLayer | null {
  if (!folder.visible) {
    return null;
  }
  const children = evaluateLayers(folder.children, frame);
  if (children.length === 0) {
    return null;
  }
  return {
    id: folder.id,
    folder: true,
    opacity: Math.min(1, Math.max(0, folder.opacity)),
    blend: folder.blend,
    effects: folder.effects,
    mask: null,
    transform: identity(),
    shapes: [],
    children
  };
}

function evaluateLayers(layers: Layer[], frame: number): EvalLayer[] {
  const evaluated: EvalLayer[] = [];
  layers.forEach((item, position) => {
    const evaluatedLayer = item.folder ? evaluateFolder(item, frame) : evaluateLayer(item, frame);
    if (!evaluatedLayer) {
      return;
    }
    if (item.masked && position > 0) {
      evaluatedLayer.mask = maskFrom(layers[position - 1], frame);
    }
    evaluated.push(evaluatedLayer);
  });
  return evaluated;
}

export interface State {
  doc: Document;
  undo: Document[];
  redo: Document[];
  updated_at: number;
}

export const store = new Map<string, State>();

function state(docId: string): State {
  const found = store.get(docId);
  if (!found) {
    throw new Error("unknown document");
  }
  return found;
}

function scene(doc: Document, sceneId: string): Scene {
  const found = doc.scenes.find((item) => item.id === sceneId);
  if (!found) {
    throw new Error("unknown scene");
  }
  return found;
}

function anyLayer(doc: Document, sceneId: string, layerId: string): Layer {
  const found = findLayer(scene(doc, sceneId).layers, layerId);
  if (!found) {
    throw new Error("unknown layer");
  }
  return found;
}

function layer(doc: Document, sceneId: string, layerId: string): Layer {
  const layers = scene(doc, sceneId).layers;
  const found = findLayer(layers, layerId);
  if (!found) {
    throw new Error("unknown layer");
  }
  if (found.folder) {
    throw new Error("folders cannot hold frames or shapes");
  }
  if (ancestorLocked(layers, layerId)) {
    throw new Error("layer is locked");
  }
  return found;
}

function edit(docId: string, change: (doc: Document) => void): Document {
  const current = state(docId);
  const before = structuredClone(current.doc);
  const next = structuredClone(current.doc);
  change(next);
  if (JSON.stringify(next) === JSON.stringify(before)) {
    return current.doc;
  }
  current.undo.push(before);
  if (current.undo.length > 100) {
    current.undo.shift();
  }
  current.redo = [];
  current.doc = next;
  current.updated_at = Date.now();
  return next;
}

function summary(): Array<Record<string, unknown>> {
  return [...store.values()]
    .map((item) => ({
      id: item.doc.id,
      name: item.doc.name,
      width: item.doc.width,
      height: item.doc.height,
      fps: item.doc.fps,
      updated_at: item.updated_at
    }))
    .sort((a, b) => (b.updated_at as number) - (a.updated_at as number));
}

export const tokens = new Map<string, string>([
  ["refresh", "mock-refresh"],
  ["access", "mock-access"],
  ["offline", "mock-offline"]
]);

const windowState = {
  maximized: false,
  visible: {} as Record<string, boolean>
};

export interface MockContext {
  store: Map<string, State>;
  state: typeof state;
  scene: typeof scene;
  layer: typeof layer;
  anyLayer: typeof anyLayer;
  findLayer: typeof findLayer;
  leafCount: typeof leafCount;
  newFolder: typeof newFolder;
  insertLayerTree: typeof insertLayerTree;
  removeLayerTree: typeof removeLayerTree;
  duplicateLayerTree: typeof duplicateLayerTree;
  reseedLayer: typeof reseedLayer;
  setLayerMask: typeof setLayerMask;
  edit: typeof edit;
  id: typeof id;
  newLayer: typeof newLayer;
  newScene: typeof newScene;
  keyIndex: typeof keyIndex;
  heldIndex: typeof heldIndex;
  keyAt: typeof keyAt;
  writable: typeof writable;
  evaluateLayer: typeof evaluateLayer;
  evaluateLayers: typeof evaluateLayers;
  validateSceneMasks: typeof validateSceneMasks;
  identity: typeof identity;
}

export type MockHandlers = Record<
  string,
  (args: Record<string, unknown>) => unknown
>;

export type MockExtension = (context: MockContext) => MockHandlers;

const context: MockContext = {
  store,
  state,
  scene,
  layer,
  anyLayer,
  findLayer,
  leafCount,
  newFolder,
  insertLayerTree,
  removeLayerTree,
  duplicateLayerTree,
  reseedLayer,
  setLayerMask,
  edit,
  id,
  newLayer,
  newScene,
  keyIndex,
  heldIndex,
  keyAt,
  writable,
  evaluateLayer,
  evaluateLayers,
  validateSceneMasks,
  identity
};

const modules = import.meta.glob<{
  handlers: MockExtension;
  reset?: () => void;
}>("./backend/*.ts", { eager: true });

const extensions: MockHandlers = Object.assign(
  {},
  ...Object.values(modules).map((module) => module.handlers(context))
);

export function resetBackend(): void {
  store.clear();
  counter = 0;
  tokens.clear();
  tokens.set("refresh", "mock-refresh");
  tokens.set("access", "mock-access");
  tokens.set("offline", "mock-offline");
  windowState.maximized = false;
  windowState.visible = {};
  for (const module of Object.values(modules)) {
    module.reset?.();
  }
}

mockWindows("main");

mockIPC(
  (command, args) => {
    const a = (args ?? {}) as Record<string, never>;
    switch (command) {
      case "doc_new": {
        const width = a.width as number;
        const height = a.height as number;
        const fps = a.fps as number;
        if (!width || !height || width > 8192 || height > 8192) {
          throw new Error("resolution must be between 1 and 8192");
        }
        if (!fps || fps > 120) {
          throw new Error("frame rate must be between 1 and 120");
        }
        const doc: Document = {
          id: id("d"),
          name: cleanName(a.name as string) ?? "Untitled",
          width,
          height,
          fps,
          background: a.background as string,
          scenes: [newScene("Scene 1")]
        };
        store.set(doc.id, {
          doc,
          undo: [],
          redo: [],
          updated_at: Date.now()
        });
        return structuredClone(doc);
      }
      case "doc_list":
        return summary();
      case "doc_recovery_report":
        return [];
      case "doc_get": {
        const current = state(a.id as string);
        current.updated_at = Date.now();
        return structuredClone(current.doc);
      }
      case "doc_close":
        store.delete(a.id as string);
        return null;
      case "doc_delete":
        store.delete(a.id as string);
        return null;
      case "doc_rename":
        return edit(a.id as string, (doc) => {
          const name = cleanName(a.name as string);
          if (!name) {
            throw new Error("name is empty");
          }
          doc.name = name;
        });
      case "doc_add_scene":
        return edit(a.id as string, (doc) => {
          doc.scenes.push(
            newScene(
              cleanName(a.name as string) ?? `Scene ${doc.scenes.length + 1}`
            )
          );
        });
      case "doc_rename_scene":
        return edit(a.id as string, (doc) => {
          const name = cleanName(a.name as string);
          if (!name) {
            throw new Error("name is empty");
          }
          scene(doc, a.sceneId as string).name = name;
        });
      case "doc_remove_scene":
        return edit(a.id as string, (doc) => {
          if (doc.scenes.length < 2) {
            throw new Error("a document needs at least one scene");
          }
          const target = scene(doc, a.sceneId as string);
          doc.scenes.splice(doc.scenes.indexOf(target), 1);
        });
      case "doc_duplicate_scene":
        return edit(a.id as string, (doc) => {
          const index = doc.scenes.indexOf(scene(doc, a.sceneId as string));
          const copy = structuredClone(doc.scenes[index]);
          copy.id = id("s");
          copy.name = `${copy.name} copy`;
          copy.layers.forEach(reseedLayer);
          doc.scenes.splice(index + 1, 0, copy);
        });
      case "doc_move_scene":
        return edit(a.id as string, (doc) => {
          const target = scene(doc, a.sceneId as string);
          doc.scenes.splice(doc.scenes.indexOf(target), 1);
          doc.scenes.splice(
            Math.min(a.index as number, doc.scenes.length),
            0,
            target
          );
        });
      case "doc_add_layer":
        return edit(a.id as string, (doc) => {
          const target = scene(doc, a.sceneId as string);
          insertLayerTree(
            target.layers,
            a.parentId as string | null,
            0,
            newLayer(
              cleanName(a.name as string) ?? `Layer ${leafCount(target.layers) + 1}`
            )
          );
          validateSceneMasks(target);
        });
      case "doc_add_folder":
        return edit(a.id as string, (doc) => {
          const target = scene(doc, a.sceneId as string);
          insertLayerTree(
            target.layers,
            a.parentId as string | null,
            0,
            newFolder(
              cleanName(a.name as string) ?? `Folder ${leafCount(target.layers) + 1}`
            )
          );
          validateSceneMasks(target);
        });
      case "doc_remove_folder":
        return edit(a.id as string, (doc) => {
          const target = scene(doc, a.sceneId as string);
          openFolderTree(target.layers, a.folderId as string);
          validateSceneMasks(target);
        });
      case "doc_set_layer":
        return edit(a.id as string, (doc) => {
          const target = scene(doc, a.sceneId as string);
          const item = anyLayer(doc, a.sceneId as string, a.layerId as string);
          if (a.masked !== null && a.masked !== undefined) {
            setLayerMask(target.layers, a.layerId as string, a.masked as boolean);
          }
          if (a.name !== null && a.name !== undefined) {
            const name = cleanName(a.name as string);
            if (!name) {
              throw new Error("name is empty");
            }
            item.name = name;
          }
          if (a.visible !== null && a.visible !== undefined) {
            item.visible = a.visible as boolean;
          }
          if (a.locked !== null && a.locked !== undefined) {
            item.locked = a.locked as boolean;
          }
          if (a.opacity !== null && a.opacity !== undefined) {
            item.opacity = Math.min(
              1,
              Math.max(0, a.opacity as number)
            );
          }
          if (a.blend !== null && a.blend !== undefined) {
            const value = a.blend as Blend;
            if (!blends.includes(value)) {
              throw new Error(`unknown blend mode ${value}`);
            }
            item.blend = value;
          }
          if (a.effects !== null && a.effects !== undefined) {
            item.effects = sanitizeEffects(a.effects as Effect[]);
          }
          validateSceneMasks(target);
        });
      case "doc_remove_layer":
        return edit(a.id as string, (doc) => {
          const target = scene(doc, a.sceneId as string);
          if (leafCount(target.layers) < 2) {
            throw new Error("a scene needs at least one layer");
          }
          const item = anyLayer(doc, a.sceneId as string, a.layerId as string);
          if (leafCount(target.layers) - subtreeLeafCount(item) < 1) {
            throw new Error("a scene needs at least one layer");
          }
          removeLayerTree(target.layers, a.layerId as string);
          validateSceneMasks(target);
        });
      case "doc_move_layer":
        return edit(a.id as string, (doc) => {
          const target = scene(doc, a.sceneId as string);
          const item = anyLayer(doc, a.sceneId as string, a.layerId as string);
          const height = subtreeHeight(item);
          const parentId = a.parentId as string | null;
          if (parentId !== null && parentId !== undefined) {
            const depth = layerDepth(target.layers, parentId, 1);
            if (depth === null) {
              throw new Error("unknown folder");
            }
            const folder = findLayer(target.layers, parentId);
            if (!folder || !folder.folder) {
              throw new Error("target is not a folder");
            }
            if (parentId === item.id || containsLayer(item.children, parentId)) {
              throw new Error("a folder cannot contain itself");
            }
            if (depth + height > maxFolderDepth) {
              throw new Error("folders cannot nest deeper than 16 levels");
            }
          }
          insertLayerTree(
            target.layers,
            parentId,
            a.index as number,
            removeLayerTree(target.layers, a.layerId as string)
          );
          validateSceneMasks(target);
        });
      case "doc_insert_frame":
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const at = Math.min(a.frame as number, target.length);
          target.keys.forEach((key) => {
            if (key.frame > at) {
              key.frame += 1;
            }
          });
          target.length += 1;
        });
      case "doc_keyframe":
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const index = keyAt(target, a.frame as number);
          if (a.blank) {
            target.keys[index] = emptyKey(a.frame as number);
          }
        });
      case "doc_remove_frame":
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const frame = a.frame as number;
          const index = keyIndex(target, frame);
          if (index >= 0) {
            target.keys.splice(index, 1);
          }
          target.keys.forEach((key) => {
            if (key.frame > frame) {
              key.frame -= 1;
            }
          });
          target.length = Math.max(1, target.length - 1);
          if (target.keys.length === 0) {
            target.keys.push(emptyKey(0));
          }
        });
      case "doc_set_tween":
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const key = target.keys[keyAt(target, a.frame as number)];
          key.tween = a.tween as boolean;
          if (a.easing !== null && a.easing !== undefined) {
            key.easing = clampEasing(a.easing as Easing);
          }
        });
      case "doc_set_label":
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          target.keys[keyAt(target, a.frame as number)].label =
            a.label === null || a.label === undefined
              ? null
              : cleanName(a.label as string);
        });
      case "doc_draw":
        validateShape(a.shape as Shape);
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          target.keys[keyAt(target, a.frame as number)].shapes.push(
            structuredClone(a.shape)
          );
        });
      case "doc_erase": {
        const path = a.path as Point[];
        const radius = a.radius as number;
        if (path.length === 0) {
          throw new Error("eraser path is empty");
        }
        if (path.length > 5000) {
          throw new Error("eraser path is too long");
        }
        if (radius < 0.5) {
          throw new Error("eraser size is too small");
        }
        const samples = densify(path, radius / 2);
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const key = target.keys[keyAt(target, a.frame as number)];
          const kept: Shape[] = [];
          for (const shape of key.shapes) {
            if (shape.kind === "Group") {
              kept.push(shape);
            } else if (shape.kind === "Stroke") {
              const reach = radius + shape.width / 2;
              let run: Point[] = [];
              for (const point of shape.points) {
                if (samples.some((sample) => within(point, sample, reach))) {
                  if (run.length > 1) {
                    kept.push({ ...shape, points: run });
                  }
                  run = [];
                } else {
                  run.push(point);
                }
              }
              if (run.length > 1) {
                kept.push({ ...shape, points: run });
              }
            } else if (!samples.some((sample) => shapeHit(shape, sample, radius))) {
              kept.push(shape);
            }
          }
          key.shapes = kept;
        });
      }
      case "doc_paint_shape":
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const key = target.keys[keyAt(target, a.frame as number)];
          const index = a.index as number;
          if (index >= key.shapes.length) {
            throw new Error("unknown shape");
          }
          const shape = key.shapes[index];
          key.shapes[index] =
            shape.kind === "Stroke" || shape.kind === "Text"
              ? { ...shape, color: a.color as string }
              : paintFill(shape, a.color as string);
        });
      case "doc_replace_shape": {
        const shape = a.shape as Shape;
        validateShape(shape);
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const key = target.keys[keyAt(target, a.frame as number)];
          const index = a.index as number;
          if (index >= key.shapes.length) {
            throw new Error("unknown shape");
          }
          key.shapes[index] = structuredClone(shape);
        });
      }
      case "doc_delete_shape":
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const key = target.keys[keyAt(target, a.frame as number)];
          const index = a.index as number;
          if (index >= key.shapes.length) {
            throw new Error("unknown shape");
          }
          key.shapes.splice(index, 1);
        });
      case "doc_transform_shapes": {
        const indices = a.indices as number[];
        if (indices.length === 0) {
          throw new Error("no shapes selected");
        }
        const sx = a.sx as number;
        const sy = a.sy as number;
        const dx = a.dx as number;
        const dy = a.dy as number;
        const rotation = a.rotation as number;
        const pivot = a.pivot as Point;
        if (!Number.isFinite(sx) || sx <= 0 || !Number.isFinite(sy) || sy <= 0) {
          throw new Error("scale must be positive");
        }
        if (
          !Number.isFinite(dx) ||
          !Number.isFinite(dy) ||
          !Number.isFinite(rotation) ||
          !Number.isFinite(pivot.x) ||
          !Number.isFinite(pivot.y)
        ) {
          throw new Error("transform values must be finite");
        }
        const matrix = affineFrom(pivot, dx, dy, sx, sy, rotation);
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const frame = a.frame as number;
          const held = heldIndex(target, frame);
          const source = held >= 0 ? structuredClone(target.keys[held].shapes) : [];
          const updated: Array<[number, Shape]> = [];
          for (const shapeIndex of indices) {
            const shape = source[shapeIndex];
            if (!shape) {
              throw new Error("unknown shape");
            }
            const next = transformShape(shape, matrix, sx, sy, rotation);
            validateShape(next);
            updated.push([shapeIndex, next]);
          }
          const key = target.keys[keyAt(target, frame)];
          for (const [shapeIndex, next] of updated) {
            key.shapes[shapeIndex] = next;
          }
        });
      }
      case "doc_align_shapes": {
        const mode = parseAlignMode(a.mode);
        const reference = parseAlignReference(a.reference);
        const indices = a.indices as number[];
        if (indices.length === 0) {
          throw new Error("no shapes selected");
        }
        const sorted = [...new Set(indices)].sort((x, y) => x - y);
        return edit(a.id as string, (doc) => {
          const stage: Bounds = { x: 0, y: 0, w: doc.width, h: doc.height };
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const frame = a.frame as number;
          const held = heldIndex(target, frame);
          const source = held >= 0 ? structuredClone(target.keys[held].shapes) : [];
          for (const shapeIndex of sorted) {
            if (shapeIndex >= source.length) {
              throw new Error("unknown shape");
            }
          }
          const offsets = alignOffsets(stage, source, sorted, mode, reference);
          if (offsets.length === 0) {
            return;
          }
          const pivot: Point = { x: 0, y: 0 };
          const updated: Array<[number, Shape]> = [];
          for (const [shapeIndex, dx, dy] of offsets) {
            const matrix = affineFrom(pivot, dx, dy, 1, 1, 0);
            const next = transformShape(source[shapeIndex], matrix, 1, 1, 0);
            validateShape(next);
            updated.push([shapeIndex, next]);
          }
          const key = target.keys[keyAt(target, frame)];
          for (const [shapeIndex, next] of updated) {
            key.shapes[shapeIndex] = next;
          }
        });
      }
      case "doc_group_shapes": {
        const indices = a.indices as number[];
        const sorted = [...new Set(indices)].sort((x, y) => x - y);
        if (sorted.length < 2) {
          throw new Error("select at least two shapes");
        }
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const frame = a.frame as number;
          const held = heldIndex(target, frame);
          const source = held >= 0 ? structuredClone(target.keys[held].shapes) : [];
          for (const shapeIndex of sorted) {
            if (shapeIndex >= source.length) {
              throw new Error("unknown shape");
            }
          }
          const group: Shape = {
            kind: "Group",
            children: sorted.map((shapeIndex) => source[shapeIndex])
          };
          validateShape(group);
          const key = target.keys[keyAt(target, frame)];
          for (const shapeIndex of [...sorted].reverse()) {
            key.shapes.splice(shapeIndex, 1);
          }
          key.shapes.splice(sorted[0], 0, group);
        });
      }
      case "doc_shape_bool": {
        const op = a.op as BoolOp;
        const indices = a.indices as number[];
        const sorted = [...new Set(indices)].sort((x, y) => x - y);
        if (sorted.length < 2) {
          throw new Error("select at least two shapes");
        }
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const frame = a.frame as number;
          const held = heldIndex(target, frame);
          const source = held >= 0 ? structuredClone(target.keys[held].shapes) : [];
          for (const shapeIndex of sorted) {
            if (shapeIndex >= source.length) {
              throw new Error("unknown shape");
            }
          }
          const merged = combineShapes(source, sorted, op);
          for (const shape of merged) {
            validateShape(shape);
          }
          const at = sorted[0];
          const key = target.keys[keyAt(target, frame)];
          for (const shapeIndex of [...sorted].reverse()) {
            key.shapes.splice(shapeIndex, 1);
          }
          for (let offset = 0; offset < merged.length; offset += 1) {
            key.shapes.splice(at + offset, 0, merged[offset]);
          }
        });
      }
      case "doc_ungroup_shape":
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const frame = a.frame as number;
          const held = heldIndex(target, frame);
          const source = held >= 0 ? structuredClone(target.keys[held].shapes) : [];
          const index = a.index as number;
          const shape = source[index];
          if (!shape) {
            throw new Error("unknown shape");
          }
          if (shape.kind !== "Group") {
            throw new Error("shape is not a group");
          }
          for (const child of shape.children) {
            validateShape(child);
          }
          const key = target.keys[keyAt(target, frame)];
          key.shapes.splice(index, 1, ...shape.children);
        });
      case "doc_reorder_shapes": {
        const indices = a.indices as number[];
        if (indices.length === 0) {
          throw new Error("no shapes selected");
        }
        const sorted = [...new Set(indices)].sort((x, y) => x - y);
        const toFront = a.toFront as boolean;
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const frame = a.frame as number;
          const held = heldIndex(target, frame);
          const len = held >= 0 ? target.keys[held].shapes.length : 0;
          for (const shapeIndex of sorted) {
            if (shapeIndex >= len) {
              throw new Error("unknown shape");
            }
          }
          const key = target.keys[keyAt(target, frame)];
          const moved: Shape[] = [];
          for (const shapeIndex of [...sorted].reverse()) {
            moved.push(key.shapes.splice(shapeIndex, 1)[0]);
          }
          moved.reverse();
          if (toFront) {
            key.shapes.push(...moved);
          } else {
            key.shapes.unshift(...moved);
          }
        });
      }
      case "doc_delete_shapes": {
        const indices = a.indices as number[];
        if (indices.length === 0) {
          throw new Error("no shapes selected");
        }
        const sorted = [...new Set(indices)].sort((x, y) => x - y);
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          const frame = a.frame as number;
          const held = heldIndex(target, frame);
          const len = held >= 0 ? target.keys[held].shapes.length : 0;
          for (const shapeIndex of sorted) {
            if (shapeIndex >= len) {
              throw new Error("unknown shape");
            }
          }
          const key = target.keys[keyAt(target, frame)];
          for (const shapeIndex of [...sorted].reverse()) {
            key.shapes.splice(shapeIndex, 1);
          }
        });
      }
      case "doc_set_transform":
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          writable(target);
          target.keys[keyAt(target, a.frame as number)].transform = sanitize(
            a.transform as Transform
          );
        });
      case "doc_undo": {
        const current = state(a.id as string);
        const previous = current.undo.pop();
        if (!previous) {
          throw new Error("nothing to undo");
        }
        current.redo.push(current.doc);
        current.doc = previous;
        current.updated_at = Date.now();
        return structuredClone(previous);
      }
      case "doc_redo": {
        const current = state(a.id as string);
        const next = current.redo.pop();
        if (!next) {
          throw new Error("nothing to redo");
        }
        current.undo.push(current.doc);
        current.doc = next;
        current.updated_at = Date.now();
        return structuredClone(next);
      }
      case "doc_evaluate": {
        const current = state(a.id as string);
        const start = a.startFrame as number;
        const end = a.endFrame as number;
        if (end < start || end - start > 600) {
          throw new Error("frame range is invalid");
        }
        const target = scene(current.doc, a.sceneId as string);
        const frames: EvalFrame[] = [];
        for (let frame = start; frame <= end; frame += 1) {
          frames.push({ frame, layers: evaluateLayers(target.layers, frame) });
        }
        return frames;
      }
      case "token_load":
        return tokens.get(a.kind as string) ?? null;
      case "token_save":
        tokens.set(a.kind as string, a.value as string);
        return null;
      case "token_clear":
        tokens.clear();
        return null;
      case "auth_refresh":
        return {
          access_token: "mock-access",
          refresh_token: "mock-refresh",
          offline_token: "mock-offline"
        };
      case "auth_logout":
        tokens.clear();
        return null;
      case "app_version":
        return "0.1.2";
      case "check_for_update":
        return null;
      case "install_update":
        return null;
      case "open_url":
        return null;
      case "plugin:window|is_maximized":
        return windowState.maximized;
      case "plugin:window|maximize":
        windowState.maximized = true;
        return null;
      case "plugin:window|unmaximize":
        windowState.maximized = false;
        return null;
      case "plugin:window|minimize":
        return null;
      case "plugin:window|close":
        return null;
      case "plugin:window|show":
        windowState.visible[a.label as string] = true;
        return null;
      case "plugin:window|hide":
        windowState.visible[a.label as string] = false;
        return null;
      case "plugin:window|set_focus":
        return null;
      case "plugin:window|is_visible":
        return windowState.visible[a.label as string] ?? true;
      case "plugin:window|inner_size":
        return { width: 1280, height: 800 };
      case "plugin:window|scale_factor":
        return 1;
      default: {
        const handler = extensions[command];
        if (!handler) {
          throw new Error(`unmocked command ${command}`);
        }
        return handler(a as Record<string, unknown>);
      }
    }
  },
  { shouldMockEvents: true }
);

Object.assign(window, { __stickmateMock: { store, tokens } });

const delegate = (
  window as unknown as {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: unknown) => Promise<unknown>;
    };
  }
).__TAURI_INTERNALS__.invoke;

export function installBackend(label = "main"): void {
  mockWindows(label);
  mockIPC(delegate, { shouldMockEvents: true });
}