import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import en from "@/i18n/en.json";
import {
  docDraw,
  docErase,
  docGroupShapes,
  docNew,
  docPaintShape,
  docRedo,
  docSetLayer,
  docTransformShapes,
  docUndo,
  docUngroupShape,
  shapeBounds
} from "@/lib/document";
import type { Document, Shape } from "@/lib/document";
import { installBackend, store } from "./backend";
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

function ellipseAt(x: number, y: number): Shape {
  return {
    kind: "Ellipse",
    x,
    y,
    w: 40,
    h: 20,
    fill: "#22c55e",
    stroke: "#000000",
    width: 2
  };
}

function axisX(list: Shape[]): number[] {
  return list.map((shape) => shapeBounds(shape).x);
}

function groupChildren(shape: Shape): Shape[] {
  if (shape.kind !== "Group") {
    throw new Error("shape is not a group");
  }
  return shape.children;
}

async function create(list: Shape[]): Promise<string> {
  const doc = await docNew("Test", 800, 600, 24, "#ffffff");
  const { sceneId, layerId } = target(doc.id);
  for (const shape of list) {
    await docDraw(doc.id, sceneId, layerId, 0, shape);
  }
  return doc.id;
}

async function group(id: string, indices: number[]): Promise<Shape[]> {
  const { sceneId, layerId } = target(id);
  const next = await docGroupShapes(id, sceneId, layerId, 0, indices);
  return next.scenes[0].layers[0].keys[0].shapes;
}

async function ungroup(id: string, index: number): Promise<Shape[]> {
  const { sceneId, layerId } = target(id);
  const next = await docUngroupShape(id, sceneId, layerId, 0, index);
  return next.scenes[0].layers[0].keys[0].shapes;
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
  await press("v");
  await drag(getCanvas(), [
    [5, 5],
    [780, 580]
  ]);
  return doc;
}

describe("group engine", () => {
  test("groups the selection in index order at the lowest slot", async () => {
    installBackend("editor");
    const id = await create([rectAt(100, 100), ellipseAt(200, 100), rectAt(300, 100)]);
    const list = await group(id, [2, 0, 2]);
    expect(list).toHaveLength(2);
    expect(list[1].kind).toBe("Ellipse");
    expect(groupChildren(list[0]).map((child) => child.kind)).toEqual(["Rect", "Rect"]);
    const box = shapeBounds(list[0]);
    expect([box.x, box.y, box.w, box.h]).toEqual([100, 100, 220, 20]);
  });

  test("ungroup splices the children back into place one level at a time", async () => {
    installBackend("editor");
    const id = await create([rectAt(100, 100), ellipseAt(200, 100), rectAt(300, 100)]);
    await group(id, [0, 1]);
    const nested = await group(id, [0, 1]);
    expect(nested).toHaveLength(1);
    const outer = groupChildren(nested[0]);
    expect(outer.map((child) => child.kind)).toEqual(["Group", "Rect"]);
    expect(groupChildren(outer[0])).toHaveLength(2);
    const once = await ungroup(id, 0);
    expect(once).toHaveLength(2);
    expect(once[0].kind).toBe("Group");
    expect(groupChildren(once[0])).toHaveLength(2);
    const twice = await ungroup(id, 0);
    expect(twice).toHaveLength(3);
    expect(twice.map((shape) => shape.kind)).toEqual(["Rect", "Ellipse", "Rect"]);
    expect(axisX(twice)).toEqual([100, 200, 300]);
  });

  test("moves a group as one unit and keeps every child", async () => {
    installBackend("editor");
    const id = await create([rectAt(100, 100), ellipseAt(200, 100), rectAt(600, 500)]);
    await group(id, [0, 1]);
    const { sceneId, layerId } = target(id);
    const moved = await docTransformShapes(
      id,
      sceneId,
      layerId,
      0,
      [0],
      { x: 0, y: 0 },
      30,
      -20,
      1,
      1,
      0
    );
    const list = moved.scenes[0].layers[0].keys[0].shapes;
    expect(list).toHaveLength(2);
    expect(groupChildren(list[0]).map((child) => shapeBounds(child).x)).toEqual([130, 230]);
    expect(groupChildren(list[0]).map((child) => shapeBounds(child).y)).toEqual([80, 80]);
    expect(shapeBounds(list[1])).toEqual({ x: 600, y: 500, w: 20, h: 20 });
  });

  test("paints every fillable child and leaves groups untouched by the eraser", async () => {
    installBackend("editor");
    const id = await create([rectAt(100, 100), ellipseAt(200, 100)]);
    await group(id, [0, 1]);
    const { sceneId, layerId } = target(id);
    const painted = await docPaintShape(id, sceneId, layerId, 0, 0, "#ff0000");
    const children = groupChildren(painted.scenes[0].layers[0].keys[0].shapes[0]);
    expect(children.map((child) => (child as { fill: string }).fill)).toEqual([
      "#ff0000",
      "#ff0000"
    ]);
    const before = json(id);
    await docErase(id, sceneId, layerId, 0, [{ x: 110, y: 110 }], 8);
    expect(json(id)).toBe(before);
  });

  test("rejects small selections, unknown shapes and locked layers without history", async () => {
    installBackend("editor");
    const id = await create([rectAt(100, 100), ellipseAt(200, 100)]);
    const { sceneId, layerId } = target(id);
    const before = json(id);
    const steps = undoLen(id);
    await expect(docGroupShapes(id, sceneId, layerId, 0, [0])).rejects.toThrow(
      "select at least two shapes"
    );
    await expect(
      docGroupShapes(id, sceneId, layerId, 0, [0, 1, 9])
    ).rejects.toThrow("unknown shape");
    await expect(docUngroupShape(id, sceneId, layerId, 0, 4)).rejects.toThrow("unknown shape");
    await expect(docUngroupShape(id, sceneId, layerId, 0, 0)).rejects.toThrow(
      "shape is not a group"
    );
    expect(json(id)).toBe(before);
    expect(undoLen(id)).toBe(steps);
    await docSetLayer(id, sceneId, layerId, { locked: true });
    const locked = json(id);
    await expect(
      docGroupShapes(id, sceneId, layerId, 0, [0, 1])
    ).rejects.toThrow("layer is locked");
    await expect(docUngroupShape(id, sceneId, layerId, 0, 0)).rejects.toThrow("layer is locked");
    expect(json(id)).toBe(locked);
  });

  test("undoes and redoes grouping and ungrouping as single steps", async () => {
    installBackend("editor");
    const id = await create([rectAt(100, 100), ellipseAt(200, 100), rectAt(300, 100)]);
    const { sceneId, layerId } = target(id);
    const before = json(id);
    await docGroupShapes(id, sceneId, layerId, 0, [0, 1]);
    const grouped = json(id);
    expect(grouped).not.toBe(before);
    await docUndo(id);
    expect(json(id)).toBe(before);
    await docRedo(id);
    expect(json(id)).toBe(grouped);
    await docUngroupShape(id, sceneId, layerId, 0, 0);
    expect(json(id)).toBe(before);
    const steps = undoLen(id);
    await expect(docUngroupShape(id, sceneId, layerId, 0, 7)).rejects.toThrow("unknown shape");
    expect(undoLen(id)).toBe(steps);
  });
});

describe("group UI", () => {
  test("groups the marquee selection and selects the new group", async () => {
    const doc = await opened([rectAt(100, 100), ellipseAt(200, 100), rectAt(300, 100)]);
    const steps = undoLen(doc.id);
    await press("g", { ctrlKey: true });
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(1));
    expect(shapes(doc.id)[0].kind).toBe("Group");
    expect(groupChildren(shapes(doc.id)[0])).toHaveLength(3);
    expect(undoLen(doc.id)).toBe(steps + 1);
    await waitFor(() =>
      expect(screen.getByText(`${en["command.group"]} 1`)).toBeTruthy()
    );
    await press("G", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(3));
    expect(shapes(doc.id).map((shape) => shape.kind)).toEqual([
      "Rect",
      "Ellipse",
      "Rect"
    ]);
    expect(undoLen(doc.id)).toBe(steps + 2);
  }, 20000);

  test("leaves the document alone below two shapes and for non-groups", async () => {
    const doc = await opened([rectAt(100, 100)]);
    const before = json(doc.id);
    const steps = undoLen(doc.id);
    await press("g", { ctrlKey: true });
    await flush();
    expect(json(doc.id)).toBe(before);
    expect(undoLen(doc.id)).toBe(steps);
    await press("G", { ctrlKey: true, shiftKey: true });
    await flush();
    expect(json(doc.id)).toBe(before);
    expect(undoLen(doc.id)).toBe(steps);
  }, 20000);

  test("selects the released children after ungrouping", async () => {
    const doc = await opened([rectAt(100, 100), ellipseAt(200, 100)]);
    await press("g", { ctrlKey: true });
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(1));
    await press("G", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(2));
    await press("Delete");
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(0));
  }, 20000);

  test("renders a group as one outlined unit with every child inside", async () => {
    const doc = await opened([rectAt(100, 100), ellipseAt(200, 100), rectAt(600, 400)]);
    await press("g", { ctrlKey: true });
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(1));
    const groups = document.querySelectorAll("[data-group]");
    expect(groups.length).toBe(1);
    expect(groups[0].querySelectorAll('ellipse[fill="#22c55e"]').length).toBe(1);
    expect(groups[0].querySelectorAll('rect[fill="#3b82f6"]').length).toBe(2);
    expect(getCanvas().querySelectorAll('rect[fill="#3b82f6"]').length).toBe(2);
  }, 20000);

  test("runs group and ungroup from the command palette", async () => {
    const doc = await opened([rectAt(100, 100), ellipseAt(200, 100), rectAt(300, 100)]);
    await press("k", { ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    const box = screen.getByRole("combobox") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(box, { target: { value: en["command.group"] } });
    });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", bubbles: true });
    });
    await flush();
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(1));
    expect(shapes(doc.id)[0].kind).toBe("Group");
    expect(screen.queryByRole("dialog")).toBeNull();
    await press("k", { ctrlKey: true });
    const again = screen.getByRole("combobox") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(again, { target: { value: en["command.ungroup"] } });
    });
    await act(async () => {
      fireEvent.keyDown(again, { key: "Enter", bubbles: true });
    });
    await flush();
    await waitFor(() => expect(shapes(doc.id)).toHaveLength(3));
    expect(shapes(doc.id)[0].kind).toBe("Rect");
  }, 20000);
});
