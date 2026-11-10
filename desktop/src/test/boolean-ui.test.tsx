import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import en from "@/i18n/en.json";
import { docDraw, docSetLayer } from "@/lib/document";
import type { Document, Shape } from "@/lib/document";
import { store } from "./backend";
import { drag, flush, getCanvas, press, renderEditor } from "./utils";

function state(id: string) {
  const found = store.get(id);
  if (!found) {
    throw new Error("document is not in the store");
  }
  return found;
}

function shapes(id: string): Shape[] {
  return state(id).doc.scenes[0].layers[0].keys[0].shapes;
}

function target(id: string): { sceneId: string; layerId: string } {
  const doc = state(id).doc;
  return { sceneId: doc.scenes[0].id, layerId: doc.scenes[0].layers[0].id };
}

function undoLen(id: string): number {
  return state(id).undo.length;
}

function json(id: string): string {
  return JSON.stringify(state(id).doc);
}

function rectAt(x: number, y: number): Shape {
  return {
    kind: "Rect",
    x,
    y,
    w: 20,
    h: 20,
    fill: "#3b82f6",
    stroke: "#000000",
    width: 2
  };
}

function corners(shape: Shape): [number, number, number, number] {
  if (shape.kind !== "Path") {
    throw new Error("path expected");
  }
  const points = shape.nodes.map((node) => node.point);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const lowX = Math.min(...xs);
  const highX = Math.max(...xs);
  const lowY = Math.min(...ys);
  const highY = Math.max(...ys);
  return [
    Math.round(lowX * 1000) / 1000,
    Math.round(lowY * 1000) / 1000,
    Math.round(highX * 1000) / 1000,
    Math.round(highY * 1000) / 1000
  ];
}

function boolButton(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

async function pressButton(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(boolButton(name));
  });
  await flush();
}

async function run(name: string): Promise<void> {
  await press("k", { ctrlKey: true });
  await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
  const box = screen.getByRole("combobox") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(box, { target: { value: name } });
  });
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter", bubbles: true });
  });
  await flush();
}

async function opened(list: Shape[]): Promise<Document> {
  const { doc } = await renderEditor();
  const { sceneId, layerId } = target(doc.id);
  for (const shape of list) {
    await docDraw(doc.id, sceneId, layerId, 0, shape);
  }
  await act(async () => {
    await emit("editor-open", doc.id);
  });
  await flush();
  await marquee();
  return doc;
}

async function marquee(): Promise<void> {
  await press("v");
  await drag(getCanvas(), [
    [5, 5],
    [780, 580]
  ]);
  await flush();
}

describe("boolean UI", () => {
  test("combines the selection into one closed path and keeps one undo step", async () => {
    const doc = await opened([rectAt(100, 100), rectAt(110, 100)]);
    const steps = undoLen(doc.id);
    await press("u", { ctrlKey: true, altKey: true });
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(1));
    expect(shapes(doc.id)[0].kind).toBe("Path");
    expect(corners(shapes(doc.id)[0])).toEqual([100, 100, 130, 120]);
    expect(undoLen(doc.id)).toBe(steps + 1);
    await waitFor(() =>
      expect(screen.getByText(`${en["editor.shape.Path"]} 1`)).toBeTruthy()
    );
    await press("z", { ctrlKey: true });
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(2));
  }, 20000);

  test("runs every operation from the side panel", async () => {
    const doc = await opened([rectAt(100, 100), rectAt(110, 100)]);
    await pressButton(en["command.combine"]);
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(1));
    expect(corners(shapes(doc.id)[0])).toEqual([100, 100, 130, 120]);
    await press("z", { ctrlKey: true });
    await marquee();
    await pressButton(en["command.subtract"]);
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(1));
    expect(corners(shapes(doc.id)[0])).toEqual([100, 100, 110, 120]);
    await press("z", { ctrlKey: true });
    await marquee();
    await pressButton(en["command.intersect"]);
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(1));
    expect(corners(shapes(doc.id)[0])).toEqual([110, 100, 120, 120]);
    await press("z", { ctrlKey: true });
    await marquee();
    await pressButton(en["command.cut"]);
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(2));
    const arms = shapes(doc.id)
      .map(corners)
      .sort((a, b) => a[0] - b[0]);
    expect(arms[0]).toEqual([100, 100, 110, 120]);
    expect(arms[1]).toEqual([120, 100, 130, 120]);
  }, 30000);

  test("disables the operations below two shapes", async () => {
    const doc = await opened([rectAt(100, 100), rectAt(400, 400)]);
    await drag(getCanvas(), [
      [90, 90],
      [130, 130]
    ]);
    await waitFor(() => expect(boolButton(en["command.combine"]).disabled).toBe(true));
    const before = json(doc.id);
    const steps = undoLen(doc.id);
    await press("u", { ctrlKey: true, altKey: true });
    await flush();
    expect(json(doc.id)).toBe(before);
    expect(undoLen(doc.id)).toBe(steps);
  }, 20000);

  test("refuses a locked layer", async () => {
    const doc = await opened([rectAt(100, 100), rectAt(110, 100)]);
    const { sceneId, layerId } = target(doc.id);
    await docSetLayer(doc.id, sceneId, layerId, { locked: true });
    await flush();
    const before = json(doc.id);
    const steps = undoLen(doc.id);
    await press("s", { ctrlKey: true, altKey: true });
    await flush();
    expect(json(doc.id)).toBe(before);
    expect(undoLen(doc.id)).toBe(steps);
  }, 20000);

  test("combines from the command palette and renders one path", async () => {
    const doc = await opened([rectAt(100, 100), rectAt(110, 100)]);
    await run(en["command.combine"]);
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(1));
    expect(shapes(doc.id)[0].kind).toBe("Path");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getCanvas().querySelectorAll('path[fill="#3b82f6"]').length).toBe(1);
  }, 20000);

  test("selects every ring produced by a cut", async () => {
    const doc = await opened([rectAt(100, 100), rectAt(110, 100)]);
    await press("x", { ctrlKey: true, altKey: true });
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(2));
    await press("Delete");
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(0));
  }, 20000);
});
