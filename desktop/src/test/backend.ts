import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { flattenPath, polygonVertices, textWidth } from "@/lib/document";
import type {
  Document,
  EvalFrame,
  EvalLayer,
  Keyframe,
  Layer,
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
  const w = textWidth(shape.text, shape.size);
  return (
    p.x >= shape.x - radius &&
    p.x <= shape.x + w + radius &&
    p.y >= shape.y - radius &&
    p.y <= shape.y + shape.size + radius
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
  if (shape.kind === "Polygon" && shape.sides < 3) {
    throw new Error("polygon needs at least 3 sides");
  }
  if (shape.kind === "Text") {
    if (shape.text.trim() === "") {
      throw new Error("text is empty");
    }
    if (shape.size <= 0) {
      throw new Error("text size must be positive");
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

const emptyKey = (frame: number): Keyframe => ({
  frame,
  shapes: [],
  transform: identity(),
  tween: false,
  label: null
});

function newLayer(name: string): Layer {
  return {
    id: id("l"),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    length: 1,
    keys: [emptyKey(0)]
  };
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
  if (key.tween) {
    const next = layer.keys[index + 1];
    if (next) {
      const span = next.frame - key.frame;
      if (span > 0) {
        const t = Math.min(1, Math.max(0, (frame - key.frame) / span));
        transform = lerp(transform, next.transform, t);
      }
    }
  }
  return {
    id: layer.id,
    opacity: Math.min(1, Math.max(0, layer.opacity * transform.opacity)),
    transform,
    shapes: structuredClone(key.shapes)
  };
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

function layer(doc: Document, sceneId: string, layerId: string): Layer {
  const found = scene(doc, sceneId).layers.find((item) => item.id === layerId);
  if (!found) {
    throw new Error("unknown layer");
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

const windowState = { maximized: false, visible: true };

export interface MockContext {
  store: Map<string, State>;
  state: typeof state;
  scene: typeof scene;
  layer: typeof layer;
  edit: typeof edit;
  id: typeof id;
  newLayer: typeof newLayer;
  newScene: typeof newScene;
  keyIndex: typeof keyIndex;
  heldIndex: typeof heldIndex;
  keyAt: typeof keyAt;
  writable: typeof writable;
  evaluateLayer: typeof evaluateLayer;
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
  edit,
  id,
  newLayer,
  newScene,
  keyIndex,
  heldIndex,
  keyAt,
  writable,
  evaluateLayer,
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
  windowState.visible = true;
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
        if (!fps || fps > 60) {
          throw new Error("frame rate must be between 1 and 60");
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
          copy.layers.forEach((item) => {
            item.id = id("l");
          });
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
          target.layers.push(
            newLayer(
              cleanName(a.name as string) ?? `Layer ${target.layers.length + 1}`
            )
          );
        });
      case "doc_set_layer":
        return edit(a.id as string, (doc) => {
          const target = layer(doc, a.sceneId as string, a.layerId as string);
          if (a.name !== null && a.name !== undefined) {
            const name = cleanName(a.name as string);
            if (!name) {
              throw new Error("name is empty");
            }
            target.name = name;
          }
          if (a.visible !== null && a.visible !== undefined) {
            target.visible = a.visible as boolean;
          }
          if (a.locked !== null && a.locked !== undefined) {
            target.locked = a.locked as boolean;
          }
          if (a.opacity !== null && a.opacity !== undefined) {
            target.opacity = Math.min(
              1,
              Math.max(0, a.opacity as number)
            );
          }
        });
      case "doc_remove_layer":
        return edit(a.id as string, (doc) => {
          const target = scene(doc, a.sceneId as string);
          if (target.layers.length < 2) {
            throw new Error("a scene needs at least one layer");
          }
          target.layers.splice(
            target.layers.indexOf(
              layer(doc, a.sceneId as string, a.layerId as string)
            ),
            1
          );
        });
      case "doc_move_layer":
        return edit(a.id as string, (doc) => {
          const target = scene(doc, a.sceneId as string);
          const item = layer(doc, a.sceneId as string, a.layerId as string);
          target.layers.splice(target.layers.indexOf(item), 1);
          target.layers.splice(
            Math.min(a.index as number, target.layers.length),
            0,
            item
          );
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
          target.keys[keyAt(target, a.frame as number)].tween = a.tween as boolean;
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
            if (shape.kind === "Stroke") {
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
              : { ...shape, fill: a.color as string };
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
          frames.push({
            frame,
            layers: target.layers
              .map((item) => evaluateLayer(item, frame))
              .filter((item): item is EvalLayer => item !== null)
          });
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
        windowState.visible = true;
        return null;
      case "plugin:window|hide":
        windowState.visible = false;
        return null;
      case "plugin:window|set_focus":
        return null;
      case "plugin:window|is_visible":
        return windowState.visible;
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