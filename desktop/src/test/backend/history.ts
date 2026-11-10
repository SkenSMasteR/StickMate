import type { MockExtension } from "../backend";
import type { Document, Keyframe, Layer, Scene, Shape } from "@/lib/document";

const NAME_LIMIT = 64;
const COUNT_LIMIT = 20;
const SIZE_LIMIT = 8 * 1024 * 1024;

interface CheckpointFile {
  id: string;
  name: string;
  created_at: number;
  document: Document;
}

const checkpoints = new Map<string, Map<string, CheckpointFile>>();
const nameOverrides = new WeakMap<Document, string>();
const stepTimes = new WeakMap<Document, number>();

export function reset(): void {
  checkpoints.clear();
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function safeComponent(value: string): void {
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..") ||
    hasControl(value)
  ) {
    throw new Error("invalid identifier");
  }
}

function cleanCheckpointName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("checkpoint name is empty");
  }
  if ([...trimmed].length > NAME_LIMIT) {
    throw new Error("checkpoint name is too long");
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    hasControl(trimmed)
  ) {
    throw new Error("checkpoint name is invalid");
  }
  return trimmed;
}

function drawName(kind: Shape["kind"]): string {
  switch (kind) {
    case "Stroke":
      return "draw_stroke";
    case "Rect":
      return "draw_rect";
    case "Ellipse":
      return "draw_ellipse";
    case "Polygon":
      return "draw_polygon";
    case "Text":
      return "draw_text";
    case "Path":
      return "draw_path";
    default:
      return "update_document";
  }
}

function diffShapes(prev: Shape[], next: Shape[]): string | null {
  if (next.length > prev.length) {
    return drawName(next[next.length - 1].kind);
  }
  if (next.length < prev.length) {
    return next.length === 0 ? "blank_keyframe" : "delete_shapes";
  }
  const prevKinds = prev.map((shape) => shape.kind).join(",");
  const nextKinds = next.map((shape) => shape.kind).join(",");
  if (prevKinds !== nextKinds) {
    return "reorder_shapes";
  }
  for (let index = 0; index < next.length; index += 1) {
    const before = prev[index];
    const after = next[index];
    if (JSON.stringify(before) === JSON.stringify(after)) {
      continue;
    }
    if (before.kind === "Stroke" && after.kind === "Stroke") {
      return before.color !== after.color ? "paint_shape" : "move_shapes";
    }
    if (before.kind === "Text" && after.kind === "Text") {
      if (before.color !== after.color) {
        return "paint_shape";
      }
      const words =
        before.text !== after.text ||
        before.family !== after.family ||
        before.spacing !== after.spacing ||
        before.leading !== after.leading ||
        before.align !== after.align;
      return words ? "replace_shape" : "move_shapes";
    }
    if (
      (before.kind === "Rect" && after.kind === "Rect") ||
      (before.kind === "Ellipse" && after.kind === "Ellipse") ||
      (before.kind === "Polygon" && after.kind === "Polygon")
    ) {
      const painted =
        before.fill !== after.fill || before.stroke !== after.stroke;
      return painted ? "paint_shape" : "move_shapes";
    }
    return "replace_shape";
  }
  return null;
}

function diffKeys(prev: Layer, next: Layer): string | null {
  if (next.length > prev.length) {
    return next.length - prev.length === 1 ? "insert_frame" : "insert_frames";
  }
  if (next.length < prev.length) {
    return prev.length - next.length === 1 ? "remove_frame" : "remove_frames";
  }
  if (next.keys.length > prev.keys.length) {
    return "add_keyframe";
  }
  if (next.keys.length < prev.keys.length) {
    return "remove_frame";
  }
  for (let index = 0; index < next.keys.length; index += 1) {
    const before: Keyframe | undefined = prev.keys[index];
    const after = next.keys[index];
    if (!before) {
      continue;
    }
    if (before.frame !== after.frame) {
      return "move_frames";
    }
    if (before.tween !== after.tween) {
      return after.tween ? "add_tween" : "remove_tween";
    }
    if (before.label !== after.label) {
      return after.label ? "set_label" : "clear_label";
    }
    if (JSON.stringify(before.transform) !== JSON.stringify(after.transform)) {
      return "set_transform";
    }
    const shapes = diffShapes(before.shapes, after.shapes);
    if (shapes) {
      return shapes;
    }
  }
  return null;
}

function layersOf(layers: Layer[], into: Layer[] = []): Layer[] {
  for (const layer of layers) {
    into.push(layer);
    layersOf(layer.children, into);
  }
  return into;
}

function diffLayers(prev: Scene, next: Scene): string | null {
  const before = layersOf(prev.layers);
  const after = layersOf(next.layers);
  const missing = (item: Layer, list: Layer[]) => !list.some((other) => other.id === item.id);
  const added = after.filter((item) => missing(item, before));
  const removed = before.filter((item) => missing(item, after));
  if (added.some((item) => item.folder)) {
    return "add_folder";
  }
  for (const gone of removed) {
    if (!gone.folder) {
      continue;
    }
    const opened = gone.children.some((child) => after.some((item) => item.id === child.id));
    return opened ? "remove_folder" : "remove_layer";
  }
  if (added.length > 0) {
    return added[added.length - 1].name.endsWith(" copy") ? "duplicate_layer" : "add_layer";
  }
  if (removed.length > 0) {
    return "remove_layer";
  }
  if (before.map((item) => item.id).join(",") !== after.map((item) => item.id).join(",")) {
    return "move_layer";
  }
  for (const current of after) {
    const previous = before.find((item) => item.id === current.id);
    if (!previous) {
      continue;
    }
    if (previous.name !== current.name) {
      return "rename_layer";
    }
    if (previous.visible !== current.visible) {
      return "layer_visibility";
    }
    if (previous.locked !== current.locked) {
      return "layer_lock";
    }
    if (previous.opacity !== current.opacity) {
      return "layer_opacity";
    }
    if (previous.blend !== current.blend) {
      return "layer_blend";
    }
    if (JSON.stringify(previous.effects) !== JSON.stringify(current.effects)) {
      return "layer_effects";
    }
    if (previous.masked !== current.masked) {
      return "layer_mask";
    }
    const keys = diffKeys(previous, current);
    if (keys) {
      return keys;
    }
  }
  return null;
}

function diffName(prev: Document, next: Document): string {
  if (prev.name !== next.name) {
    return "rename_project";
  }
  if (next.scenes.length > prev.scenes.length) {
    const added = next.scenes.find(
      (item) => !prev.scenes.some((other) => other.id === item.id)
    );
    return added && added.name.endsWith(" copy") ? "duplicate_scene" : "add_scene";
  }
  if (next.scenes.length < prev.scenes.length) {
    return "remove_scene";
  }
  const prevIds = prev.scenes.map((item) => item.id).join(",");
  const nextIds = next.scenes.map((item) => item.id).join(",");
  if (prevIds !== nextIds) {
    return "move_scene";
  }
  for (let index = 0; index < next.scenes.length; index += 1) {
    const before = prev.scenes[index];
    const after = next.scenes[index];
    if (before.name !== after.name) {
      return "rename_scene";
    }
    const layers = diffLayers(before, after);
    if (layers) {
      return layers;
    }
  }
  return "update_document";
}

export const handlers: MockExtension = (context) => {
  const { state, edit, id } = context;

  return {
    doc_history: (args) => {
      const current = state(args.id as string);
      const snapshots: Document[] = [
        ...current.undo,
        current.doc,
        ...[...current.redo].reverse()
      ];
      return snapshots.map((doc, index) => {
        const override = nameOverrides.get(doc);
        const name =
          override ??
          (index === 0 ? "new_document" : diffName(snapshots[index - 1], doc));
        if (!stepTimes.has(doc)) {
          stepTimes.set(doc, Date.now());
        }
        const kind =
          index < current.undo.length
            ? "undo"
            : index === current.undo.length
              ? "current"
              : "redo";
        return { index, name, at: stepTimes.get(doc) ?? 0, kind };
      });
    },
    doc_history_jump: (args) => {
      const current = state(args.id as string);
      const index = args.index as number;
      const total = current.undo.length + 1 + current.redo.length;
      if (index >= total) {
        throw new Error("history step is out of range");
      }
      while (current.undo.length > index) {
        const previous = current.undo.pop() as Document;
        current.redo.push(current.doc);
        current.doc = previous;
      }
      while (current.undo.length < index) {
        const next = current.redo.pop() as Document;
        current.undo.push(current.doc);
        current.doc = next;
      }
      current.updated_at = Date.now();
      return structuredClone(current.doc);
    },
    doc_checkpoint_save: (args) => {
      const name = cleanCheckpointName(args.name as string);
      const current = state(args.id as string);
      const file: CheckpointFile = {
        id: id("c"),
        name,
        created_at: Date.now(),
        document: structuredClone(current.doc)
      };
      if (JSON.stringify(file).length > SIZE_LIMIT) {
        throw new Error("checkpoint is too large");
      }
      let bucket = checkpoints.get(args.id as string);
      if (!bucket) {
        bucket = new Map();
        checkpoints.set(args.id as string, bucket);
      }
      if (bucket.size >= COUNT_LIMIT) {
        throw new Error("too many checkpoints");
      }
      bucket.set(file.id, file);
      return { id: file.id, name: file.name, created_at: file.created_at };
    },
    doc_checkpoint_list: (args) => {
      const bucket = checkpoints.get(args.id as string);
      if (!bucket) {
        return [];
      }
      return [...bucket.values()]
        .map((file) => ({
          id: file.id,
          name: file.name,
          created_at: file.created_at
        }))
        .sort(
          (a, b) =>
            b.created_at - a.created_at ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        );
    },
    doc_checkpoint_restore: (args) => {
      const checkpointId = args.checkpointId as string;
      safeComponent(checkpointId);
      const file = checkpoints.get(args.id as string)?.get(checkpointId);
      if (!file) {
        throw new Error("unknown checkpoint");
      }
      const document = structuredClone(file.document);
      const before = state(args.id as string).undo.length;
      const restored = edit(args.id as string, (doc) => {
        doc.name = document.name;
        doc.width = document.width;
        doc.height = document.height;
        doc.fps = document.fps;
        doc.background = document.background;
        doc.scenes = document.scenes;
      });
      if (state(args.id as string).undo.length > before) {
        nameOverrides.set(restored, "restore_checkpoint");
      }
      return structuredClone(restored);
    },
    doc_checkpoint_delete: (args) => {
      const checkpointId = args.checkpointId as string;
      safeComponent(checkpointId);
      const bucket = checkpoints.get(args.id as string);
      if (!bucket || !bucket.has(checkpointId)) {
        throw new Error("unknown checkpoint");
      }
      bucket.delete(checkpointId);
      return null;
    }
  };
};