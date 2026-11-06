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
    };

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