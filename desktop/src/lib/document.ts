import { invoke } from "@tauri-apps/api/core";

export interface Point {
  x: number;
  y: number;
}

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
    }
  | {
      kind: "Text";
      x: number;
      y: number;
      text: string;
      size: number;
      family: string;
      color: string;
    }
  | {
      kind: "Path";
      nodes: PathNode[];
      closed: boolean;
      fill: string;
      stroke: string;
      width: number;
    };

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

export function textWidth(text: string, size: number): number {
  return [...text].length * size * TEXT_ADVANCE;
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

export interface Transform {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  opacity: number;
}

export interface Keyframe {
  frame: number;
  shapes: Shape[];
  transform: Transform;
  tween: boolean;
  label: string | null;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  length: number;
  keys: Keyframe[];
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

export interface EvalLayer {
  id: string;
  opacity: number;
  transform: Transform;
  shapes: Shape[];
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

export function sceneLength(scene: Scene): number {
  return scene.layers.reduce((longest, layer) => Math.max(longest, layer.length), 1);
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
  name: string
): Promise<Document> {
  return invoke<Document>("doc_add_layer", { id, sceneId, name });
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
  }
): Promise<Document> {
  return invoke<Document>("doc_set_layer", {
    id,
    sceneId,
    layerId,
    name: patch.name ?? null,
    visible: patch.visible ?? null,
    locked: patch.locked ?? null,
    opacity: patch.opacity ?? null
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
  index: number
): Promise<Document> {
  return invoke<Document>("doc_move_layer", { id, sceneId, layerId, index });
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
  tween: boolean
): Promise<Document> {
  return invoke<Document>("doc_set_tween", { id, sceneId, layerId, frame, tween });
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