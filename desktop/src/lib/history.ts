import { invoke } from "@tauri-apps/api/core";
import type { Document } from "@/lib/document";

export type HistoryKind = "undo" | "current" | "redo";

export interface HistoryStep {
  index: number;
  name: string;
  at: number;
  kind: HistoryKind;
}

export interface CheckpointInfo {
  id: string;
  name: string;
  created_at: number;
}

export function docHistory(id: string): Promise<HistoryStep[]> {
  return invoke<HistoryStep[]>("doc_history", { id });
}

export function docHistoryJump(id: string, index: number): Promise<Document> {
  return invoke<Document>("doc_history_jump", { id, index });
}

export function docCheckpointSave(
  id: string,
  name: string
): Promise<CheckpointInfo> {
  return invoke<CheckpointInfo>("doc_checkpoint_save", { id, name });
}

export function docCheckpointList(id: string): Promise<CheckpointInfo[]> {
  return invoke<CheckpointInfo[]>("doc_checkpoint_list", { id });
}

export function docCheckpointRestore(
  id: string,
  checkpointId: string
): Promise<Document> {
  return invoke<Document>("doc_checkpoint_restore", { id, checkpointId });
}

export function docCheckpointDelete(
  id: string,
  checkpointId: string
): Promise<void> {
  return invoke<void>("doc_checkpoint_delete", { id, checkpointId });
}