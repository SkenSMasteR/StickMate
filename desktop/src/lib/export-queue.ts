import { useSyncExternalStore } from "react";
import { exportWeb, toExportOptions } from "@/lib/export";
import type { ExportResult, ExportSettings } from "@/lib/export";
import { defaultPresetName, newPresetId, sanitizeSettings } from "@/lib/export-presets";

export type ExportJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ExportJob {
  id: string;
  docId: string;
  name: string;
  settings: ExportSettings;
  status: ExportJobStatus;
  error?: string;
  result?: ExportResult;
}

export interface ExportQueueState {
  jobs: ExportJob[];
  running: boolean;
}

let state: ExportQueueState = { jobs: [], running: false };
const listeners = new Set<() => void>();

function setState(next: ExportQueueState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getExportQueue(): ExportQueueState {
  return state;
}

export function useExportQueue(): ExportQueueState {
  return useSyncExternalStore(subscribe, getExportQueue, getExportQueue);
}

export function enqueueExportJob(docId: string, settings: ExportSettings): ExportJob | null {
  const captured = sanitizeSettings(settings);
  if (!captured) {
    return null;
  }
  const job: ExportJob = {
    id: newPresetId(),
    docId,
    name: defaultPresetName(captured),
    settings: captured,
    status: "queued"
  };
  setState({ ...state, jobs: [...state.jobs, job] });
  return job;
}

function updateJob(id: string, patch: Partial<ExportJob>): void {
  setState({
    ...state,
    jobs: state.jobs.map((item) => (item.id === id ? { ...item, ...patch } : item))
  });
}

export async function startExportQueue(): Promise<void> {
  if (state.running) {
    return;
  }
  setState({ ...state, running: true });
  try {
    for (;;) {
      const job = state.jobs.find((item) => item.status === "queued");
      if (!job) {
        break;
      }
      updateJob(job.id, { status: "running" });
      try {
        const result = await exportWeb(
          job.docId,
          job.settings.format,
          toExportOptions(job.settings)
        );
        updateJob(job.id, { status: "done", result });
      } catch (failure) {
        updateJob(job.id, { status: "failed", error: String(failure) });
      }
    }
  } finally {
    setState({ ...state, running: false });
  }
}

export function cancelExportJob(jobId: string): void {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job || job.status !== "queued") {
    return;
  }
  updateJob(jobId, { status: "cancelled" });
}

export function cancelAllExportJobs(): void {
  setState({
    ...state,
    jobs: state.jobs.map((item) =>
      item.status === "queued" ? { ...item, status: "cancelled" } : item
    )
  });
}

export function exportQueueProgress(jobs: ExportJob[]): { done: number; total: number } {
  return {
    done: jobs.filter((item) => item.status !== "queued" && item.status !== "running").length,
    total: jobs.length
  };
}

export function resetExportQueue(): void {
  setState({ jobs: [], running: false });
}