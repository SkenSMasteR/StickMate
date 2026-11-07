import { invoke } from "@tauri-apps/api/core";
import type { Document, Keyframe } from "./document";

export interface FrameClip {
  span: number;
  keys: Keyframe[];
}

let clipboard: FrameClip | null = null;

export function frameClipboard(): FrameClip | null {
  return clipboard;
}

export function setFrameClipboard(clip: FrameClip | null): void {
  clipboard = clip;
}

export function docInsertFrames(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  count: number
): Promise<Document> {
  return invoke<Document>("doc_insert_frames", { id, sceneId, layerId, frame, count });
}

export function docRemoveFrames(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  count: number
): Promise<Document> {
  return invoke<Document>("doc_remove_frames", { id, sceneId, layerId, frame, count });
}

export function docCopyFrames(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  count: number
): Promise<FrameClip> {
  return invoke<FrameClip>("doc_copy_frames", { id, sceneId, layerId, frame, count });
}

export function docPasteFrames(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  clip: FrameClip
): Promise<Document> {
  return invoke<Document>("doc_paste_frames", { id, sceneId, layerId, frame, clip });
}

export function docDuplicateFrames(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  count: number
): Promise<Document> {
  return invoke<Document>("doc_duplicate_frames", { id, sceneId, layerId, frame, count });
}

export function docMoveFrames(
  id: string,
  sceneId: string,
  layerId: string,
  frame: number,
  count: number,
  target: number
): Promise<Document> {
  return invoke<Document>("doc_move_frames", { id, sceneId, layerId, frame, count, target });
}