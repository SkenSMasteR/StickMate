import { useEffect } from "react";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import ExportDialog from "@/editor/ExportDialog";
import { useWorkspace, WorkspaceProvider } from "@/editor/workspace";
import { I18nProvider } from "@/i18n";
import { ConfirmProvider } from "@/lib/confirm";
import { exportWeb } from "@/lib/export";
import type { ExportResult } from "@/lib/export";
import { resetExportQueue } from "@/lib/export-queue";
import { PrefsProvider } from "@/lib/prefs";
import type { Document, Keyframe, Layer, Scene, Shape } from "@/lib/document";
import { store } from "./backend";
import { disk } from "./backend/export";

vi.mock("@/lib/export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export")>();
  return { ...actual, exportWeb: vi.fn() };
});

const exportWebMock = vi.mocked(exportWeb);
let realExportWeb: typeof exportWeb;

const identity = { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 };

const box: Shape = {
  kind: "Rect",
  x: 10,
  y: 10,
  w: 50,
  h: 40,
  fill: "#3b82f6",
  stroke: "#000000",
  width: 2
};

function key(frame: number): Keyframe {
  return { frame, shapes: [box], transform: identity, tween: false, label: null };
}

function layer(id: string, length: number): Layer {
  return { id, name: id, visible: true, locked: false, opacity: 1, blend: "normal", effects: [], length, keys: [key(0)] };
}

function scene(id: string, length: number): Scene {
  return { id, name: id, layers: [layer(`${id}l`, length)] };
}

function docFixture(): Document {
  return {
    id: "queuedoc",
    name: "Queue film",
    width: 320,
    height: 240,
    fps: 24,
    background: "#ffffff",
    scenes: [scene("s0", 10), scene("s1", 4)]
  };
}

const exportResult: ExportResult = {
  path: "C:/out",
  files: ["stickmate.js", "project.json"],
  width: 320,
  height: 240,
  fps: 24,
  frames: 10
};

function Host({ doc }: { doc: Document }) {
  const { open } = useWorkspace();
  useEffect(() => {
    void open(doc.id);
  }, [doc.id, open]);
  return <ExportDialog open onClose={() => {}} />;
}

async function mountDialog(doc: Document): Promise<RenderResult> {
  store.set(doc.id, { doc, undo: [], redo: [], updated_at: Date.now() });
  const view = render(
    <I18nProvider language="en" onLanguageChange={() => {}}>
      <ConfirmProvider>
        <PrefsProvider>
          <WorkspaceProvider>
            <Host doc={doc} />
          </WorkspaceProvider>
        </PrefsProvider>
      </ConfirmProvider>
    </I18nProvider>
  );
  await waitFor(() =>
    expect((screen.getByLabelText("Frame rate") as HTMLInputElement).value).toBe(String(doc.fps))
  );
  return view;
}

function change(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function clickButton(name: string): Promise<void> {
  return act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function deferExport(): { resolve: (value: ExportResult) => void } {
  let resolve!: (value: ExportResult) => void;
  exportWebMock.mockImplementationOnce(
    () =>
      new Promise<ExportResult>((res) => {
        resolve = res;
      })
  );
  return { resolve: (value) => resolve(value) };
}

beforeAll(async () => {
  const actual = await vi.importActual<typeof import("@/lib/export")>("@/lib/export");
  realExportWeb = actual.exportWeb;
});

beforeEach(() => {
  resetExportQueue();
  exportWebMock.mockReset();
  exportWebMock.mockImplementation(realExportWeb);
});

describe("export queue dialog", () => {
  test("add to queue lists a job and start queue runs it to done", async () => {
    const doc = docFixture();
    await mountDialog(doc);
    expect(button("Start queue").disabled).toBe(true);
    expect(button("Cancel all").disabled).toBe(true);
    await clickButton("Add to queue");
    expect(screen.getByText("Job 1: HTML5 · Whole · 100% · 24 fps")).toBeTruthy();
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(button("Start queue").disabled).toBe(false);
    expect(button("Cancel all").disabled).toBe(false);
    await clickButton("Start queue");
    await waitFor(() => expect(screen.getByText("Done")).toBeTruthy());
    expect(exportWebMock).toHaveBeenCalledTimes(1);
    expect(exportWebMock).toHaveBeenCalledWith(doc.id, "html5", {
      range: { kind: "whole" },
      scale: 1,
      fps: 24,
      loop: true,
      transparent: false
    });
    expect(disk.has("C:/Users/Test/Downloads/StickMate/Queue film-html5/index.html")).toBe(true);
    expect(screen.queryByText(/Progress:/)).toBeNull();
    expect(button("Start queue").disabled).toBe(true);
    expect(button("Cancel all").disabled).toBe(true);
  });

  test("invalid settings show the inline error and add no job", async () => {
    await mountDialog(docFixture());
    change("Frame rate", "0");
    await clickButton("Add to queue");
    expect(screen.getByText("The size is out of range.")).toBeTruthy();
    expect(screen.queryByText(/^Job 1:/)).toBeNull();
    expect(button("Start queue").disabled).toBe(true);
    expect(button("Cancel all").disabled).toBe(true);
  });

  test("a queued job can be cancelled and is skipped when the queue runs", async () => {
    await mountDialog(docFixture());
    await clickButton("Add to queue");
    change("Frame rate", "30");
    await clickButton("Add to queue");
    await clickButton("Cancel HTML5 · Whole · 100% · 30 fps");
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel HTML5 · Whole · 100% · 30 fps" })).toBeNull();
    await clickButton("Start queue");
    await waitFor(() => expect(screen.getByText("Done")).toBeTruthy());
    expect(exportWebMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel HTML5 · Whole · 100% · 24 fps" })).toBeNull();
  });

  test("a failed job shows its error and the next job still runs", async () => {
    await mountDialog(docFixture());
    change("Range", "frames");
    change("End frame", "99");
    await clickButton("Add to queue");
    change("Range", "whole");
    await clickButton("Add to queue");
    await clickButton("Start queue");
    await waitFor(() => expect(screen.getByText("Failed")).toBeTruthy());
    expect(screen.getByText(/frame range is invalid/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Done")).toBeTruthy());
    expect(exportWebMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Progress:/)).toBeNull();
  });

  test("cancel all leaves the running job to finish and progress counts it", async () => {
    await mountDialog(docFixture());
    await clickButton("Add to queue");
    change("Frame rate", "30");
    await clickButton("Add to queue");
    const pending = deferExport();
    await clickButton("Start queue");
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Progress: 0/2")).toBeTruthy();
    expect(button("Start queue").disabled).toBe(true);
    expect(button("Cancel all").disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Cancel HTML5 · Whole · 100% · 24 fps" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel HTML5 · Whole · 100% · 30 fps" })).toBeTruthy();
    await clickButton("Cancel all");
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("Progress: 1/2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Cancel HTML5/ })).toBeNull();
    expect(button("Cancel all").disabled).toBe(true);
    await act(async () => {
      pending.resolve(exportResult);
    });
    await waitFor(() => expect(screen.getByText("Done")).toBeTruthy());
    expect(exportWebMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.queryByText(/Progress:/)).toBeNull();
    expect(button("Start queue").disabled).toBe(true);
  });

  test("a job enqueued while the queue runs is picked up", async () => {
    await mountDialog(docFixture());
    await clickButton("Add to queue");
    const pending = deferExport();
    await clickButton("Start queue");
    change("Frame rate", "30");
    await clickButton("Add to queue");
    expect(screen.getByText("Queued")).toBeTruthy();
    await act(async () => {
      pending.resolve(exportResult);
    });
    await waitFor(() => expect(screen.getAllByText("Done")).toHaveLength(2));
    expect(exportWebMock).toHaveBeenCalledTimes(2);
  });

  test("the queue survives closing and reopening the dialog", async () => {
    const doc = docFixture();
    const view = await mountDialog(doc);
    await clickButton("Add to queue");
    const pending = deferExport();
    await clickButton("Start queue");
    expect(screen.getByText("Running")).toBeTruthy();
    view.unmount();
    await mountDialog(doc);
    expect(screen.getByText("Job 1: HTML5 · Whole · 100% · 24 fps")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(button("Start queue").disabled).toBe(true);
    expect(button("Cancel all").disabled).toBe(true);
    await act(async () => {
      pending.resolve(exportResult);
    });
    await waitFor(() => expect(screen.getByText("Done")).toBeTruthy());
  });
});