import { invoke } from "@tauri-apps/api/core";
import type { Document, Shape, Transform } from "./document";

export interface ShapeClip {
  shapes: Shape[];
  transform: Transform;
}

export interface ShapePaste {
  document: Document;
  indices: number[];
}

export function docCopyShapes(
  id: string, sceneId: string, layerId: string, frame: number, indices: number[]
): Promise<ShapeClip> {
  return invoke<ShapeClip>("doc_copy_shapes", { id, sceneId, layerId, frame, indices });
}

export function docPasteShapes(
  id: string, sceneId: string, layerId: string, frame: number, clip: ShapeClip
): Promise<ShapePaste> {
  return invoke<ShapePaste>("doc_paste_shapes", { id, sceneId, layerId, frame, clip });
}
