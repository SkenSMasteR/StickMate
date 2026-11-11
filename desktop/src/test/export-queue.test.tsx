import { beforeEach, describe, expect, test, vi } from "vitest";
import { exportWeb, toExportOptions } from "@/lib/export";
import type { ExportResult, ExportSettings } from "@/lib/export";
import { defaultSettings } from "@/lib/export-presets";
import {
  cancelAllExportJobs,
  cancelExportJob,
  enqueueExportJob,
  exportQueueProgress,
  getExportQueue,
  resetExportQueue,
  startExportQueue
} from "@/lib/export-queue";

vi.mock("@/lib/export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export")>();
  return { ...actual, exportWeb: vi.fn() };
});

const exportWebMock = vi.mocked(exportWeb);

const exportResult: ExportResult = {
  path: "C:/out",
  files: ["stickmate.js", "project.json"],
  width: 320,
  height: 240,
  fps: 24,
  frames: 10
};

function settings(patch: Partial<ExportSettings> = {}): ExportSettings {
  return { ...defaultSettings, sceneId: "s0", ...patch };
}

interface Gate {
  promise: Promise<ExportResult>;
  resolve: (value: ExportResult) => void;
  reject: (reason: Error) => void;
}

function gate(): Gate {
  let resolve!: (value: ExportResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ExportResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  resetExportQueue();
  exportWebMock.mockReset();
});

describe("export queue store", () => {
  test("enqueue refuses invalid settings and adds no job", () => {
    expect(enqueueExportJob("d1", settings({ fps: 0 }))).toBeNull();
    expect(enqueueExportJob("d1", settings({ fps: 121 }))).toBeNull();
    expect(enqueueExportJob("d1", settings({ end: -1 }))).toBeNull();
    expect(enqueueExportJob("d1", settings({ start: 5, end: 2 }))).toBeNull();
    expect(enqueueExportJob("d1", settings({ scale: 3 }))).toBeNull();
    expect(getExportQueue().jobs).toEqual([]);
    expect(getExportQueue().running).toBe(false);
  });

  test("enqueue appends a named queued job bound to its document", () => {
    const job = enqueueExportJob("d1", settings({ fps: 30 }));
    expect(job).not.toBeNull();
    expect(job?.name).toBe("HTML5 · Whole · 100% · 30 fps");
    expect(job?.docId).toBe("d1");
    expect(job?.status).toBe("queued");
    const second = enqueueExportJob("d2", settings({ format: "canvasjs" }));
    expect(second?.name).toBe("Canvas JS · Whole · 100% · 24 fps");
    expect(getExportQueue().jobs.map((item) => item.id)).toEqual([job?.id, second?.id]);
  });

  test("start runs jobs FIFO one at a time with each job's own document", async () => {
    const first = gate();
    const second = gate();
    exportWebMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = enqueueExportJob("d1", settings());
    const b = enqueueExportJob("d2", settings({ format: "canvasjs" }));
    const running = startExportQueue();
    expect(getExportQueue().running).toBe(true);
    expect(exportWebMock).toHaveBeenCalledTimes(1);
    expect(exportWebMock).toHaveBeenNthCalledWith(1, "d1", "html5", toExportOptions(a!.settings));
    expect(getExportQueue().jobs[0].status).toBe("running");
    expect(getExportQueue().jobs[1].status).toBe("queued");
    first.resolve(exportResult);
    await flush();
    expect(exportWebMock).toHaveBeenCalledTimes(2);
    expect(exportWebMock).toHaveBeenNthCalledWith(
      2,
      "d2",
      "canvasjs",
      toExportOptions(b!.settings)
    );
    second.resolve(exportResult);
    await running;
    expect(getExportQueue().running).toBe(false);
    expect(getExportQueue().jobs.map((item) => item.status)).toEqual(["done", "done"]);
    expect(getExportQueue().jobs[0].result).toEqual(exportResult);
    expect(getExportQueue().jobs[1].result).toEqual(exportResult);
  });

  test("starting an already running queue is a no-op", async () => {
    const first = gate();
    exportWebMock.mockReturnValueOnce(first.promise);
    enqueueExportJob("d1", settings());
    const running = startExportQueue();
    await startExportQueue();
    expect(exportWebMock).toHaveBeenCalledTimes(1);
    first.resolve(exportResult);
    await running;
    expect(getExportQueue().jobs[0].status).toBe("done");
  });

  test("a failed job records the error and the queue continues", async () => {
    exportWebMock
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(exportResult);
    enqueueExportJob("d1", settings());
    enqueueExportJob("d1", settings());
    await startExportQueue();
    const jobs = getExportQueue().jobs;
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].error).toContain("disk full");
    expect(jobs[0].result).toBeUndefined();
    expect(jobs[1].status).toBe("done");
    expect(getExportQueue().running).toBe(false);
  });

  test("a cancelled queued job is skipped by start", async () => {
    exportWebMock.mockResolvedValue(exportResult);
    enqueueExportJob("d1", settings());
    const second = enqueueExportJob("d1", settings());
    cancelExportJob(second!.id);
    expect(getExportQueue().jobs[1].status).toBe("cancelled");
    await startExportQueue();
    expect(exportWebMock).toHaveBeenCalledTimes(1);
    expect(getExportQueue().jobs.map((item) => item.status)).toEqual(["done", "cancelled"]);
  });

  test("cancel only affects queued jobs", async () => {
    const first = gate();
    exportWebMock.mockReturnValueOnce(first.promise);
    const job = enqueueExportJob("d1", settings());
    const running = startExportQueue();
    cancelExportJob(job!.id);
    expect(getExportQueue().jobs[0].status).toBe("running");
    first.resolve(exportResult);
    await running;
    expect(getExportQueue().jobs[0].status).toBe("done");
    cancelExportJob(job!.id);
    expect(getExportQueue().jobs[0].status).toBe("done");
    cancelExportJob("missing");
    expect(getExportQueue().jobs).toHaveLength(1);
  });

  test("cancelAll cancels queued jobs and lets the running job finish", async () => {
    const first = gate();
    exportWebMock.mockReturnValueOnce(first.promise);
    enqueueExportJob("d1", settings());
    enqueueExportJob("d1", settings());
    const running = startExportQueue();
    cancelAllExportJobs();
    expect(getExportQueue().jobs.map((item) => item.status)).toEqual(["running", "cancelled"]);
    first.resolve(exportResult);
    await running;
    expect(exportWebMock).toHaveBeenCalledTimes(1);
    expect(getExportQueue().jobs.map((item) => item.status)).toEqual(["done", "cancelled"]);
    expect(getExportQueue().running).toBe(false);
  });

  test("jobs enqueued while running are processed in the same run", async () => {
    const first = gate();
    exportWebMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(exportResult);
    enqueueExportJob("d1", settings());
    const running = startExportQueue();
    enqueueExportJob("d2", settings());
    expect(getExportQueue().jobs[1].status).toBe("queued");
    first.resolve(exportResult);
    await running;
    expect(exportWebMock).toHaveBeenCalledTimes(2);
    expect(exportWebMock).toHaveBeenNthCalledWith(
      2,
      "d2",
      "html5",
      toExportOptions(settings())
    );
    expect(getExportQueue().jobs.map((item) => item.status)).toEqual(["done", "done"]);
  });

  test("progress counts done, failed and cancelled jobs out of the total", async () => {
    const first = gate();
    exportWebMock.mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error("nope"));
    enqueueExportJob("d1", settings());
    enqueueExportJob("d1", settings());
    const third = enqueueExportJob("d1", settings());
    cancelExportJob(third!.id);
    expect(exportQueueProgress(getExportQueue().jobs)).toEqual({ done: 1, total: 3 });
    const running = startExportQueue();
    expect(exportQueueProgress(getExportQueue().jobs)).toEqual({ done: 1, total: 3 });
    first.resolve(exportResult);
    await running;
    expect(getExportQueue().jobs.map((item) => item.status)).toEqual([
      "done",
      "failed",
      "cancelled"
    ]);
    expect(exportQueueProgress(getExportQueue().jobs)).toEqual({ done: 3, total: 3 });
    expect(exportQueueProgress([])).toEqual({ done: 0, total: 0 });
  });
});