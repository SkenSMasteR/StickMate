import { describe, expect, test } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import {
  affineFrom,
  applyAffine,
  docDeleteShapes,
  docDraw,
  docErase,
  docRedo,
  docReorderShapes,
  docSetLayer,
  docTransformShapes,
  docUndo,
  shapeBounds,
  textCorners,
  unionBounds
} from "@/lib/document";
import type { Point, Shape } from "@/lib/document";
import { store } from "./backend";
import { click, drag, flush, getCanvas, press, renderEditor } from "./utils";

const base = { pointerId: 1, button: 0, buttons: 1, bubbles: true };

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

function docJSON(id: string): string {
  return JSON.stringify(state(id).doc);
}

function undoLen(id: string): number {
  return state(id).undo.length;
}

function ids(id: string): { sceneId: string; layerId: string } {
  const doc = state(id).doc;
  return { sceneId: doc.scenes[0].id, layerId: doc.scenes[0].layers[0].id };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label)
  );
  if (!found) {
    throw new Error(`button not found: ${label}`);
  }
  return found as HTMLButtonElement;
}

function field(label: string): HTMLInputElement {
  const found = [...document.querySelectorAll("label")]
    .find((item) => item.textContent?.includes(label))
    ?.querySelector("input");
  if (!found) {
    throw new Error(`field not found: ${label}`);
  }
  return found as HTMLInputElement;
}

function selBox(): Element {
  const found = getCanvas().querySelector("[data-selection-box]");
  if (!found) {
    throw new Error("selection box not found");
  }
  return found;
}

function corner(name: string): Element {
  const found = getCanvas().querySelector(`[data-corner="${name}"]`);
  if (!found) {
    throw new Error(`corner not found: ${name}`);
  }
  return found;
}

function edge(name: string): Element {
  const found = getCanvas().querySelector(`[data-edge="${name}"]`);
  if (!found) {
    throw new Error(`edge not found: ${name}`);
  }
  return found;
}

function rotateHandle(): Element {
  const found = getCanvas().querySelector("[data-rotate-handle]");
  if (!found) {
    throw new Error("rotate handle not found");
  }
  return found;
}

function outlines(): number {
  return getCanvas().querySelectorAll('rect[stroke-dasharray="4 3"]').length;
}

function visibleRects(): Element[] {
  return [...getCanvas().querySelectorAll('rect[fill="#3b82f6"]')];
}

function attr(element: Element, name: string): number {
  return Number(element.getAttribute(name));
}

async function down(target: Element, x: number, y: number, shiftKey = false): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(target, { ...base, clientX: x, clientY: y, shiftKey });
  });
}

async function move(x: number, y: number, shiftKey = false): Promise<void> {
  await act(async () => {
    fireEvent.pointerMove(getCanvas(), { ...base, clientX: x, clientY: y, shiftKey });
  });
}

async function up(x: number, y: number, shiftKey = false): Promise<void> {
  await act(async () => {
    fireEvent.pointerUp(getCanvas(), {
      ...base,
      buttons: 0,
      clientX: x,
      clientY: y,
      shiftKey
    });
  });
  await flush();
}

async function selectShape(target: Element, x: number, y: number): Promise<void> {
  await down(target, x, y);
  await up(x, y);
}

async function setField(label: string, value: string): Promise<void> {
  const input = field(label);
  await act(async () => {
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
  });
  await flush();
}

async function drawRect(x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await press("r");
  await drag(getCanvas(), [
    [x1, y1],
    [x2, y2]
  ]);
}

async function marquee(x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await down(getCanvas(), x1, y1);
  await move(x2, y2);
  await up(x2, y2);
}

describe("selection and transforms", () => {
  test("marquee selects exactly the shapes whose bounds intersect", async () => {
    const { doc } = await renderEditor();
    await drawRect(10, 10, 30, 30);
    await drawRect(100, 100, 120, 120);
    await drawRect(200, 200, 220, 220);
    const before = docJSON(doc.id);
    await press("v");
    await marquee(5, 5, 125, 125);
    expect(outlines()).toBe(2);
    const box = selBox();
    expect(attr(box, "x")).toBe(10);
    expect(attr(box, "y")).toBe(10);
    expect(attr(box, "width")).toBe(110);
    expect(attr(box, "height")).toBe(110);
    await marquee(400, 400, 400, 400);
    expect(outlines()).toBe(0);
    expect(getCanvas().querySelector("[data-selection-box]")).toBeNull();
    expect(docJSON(doc.id)).toBe(before);
  }, 20000);

  test("shift-click adds and removes shapes from the selection", async () => {
    const { doc } = await renderEditor();
    await drawRect(10, 10, 30, 30);
    await drawRect(100, 100, 120, 120);
    const before = docJSON(doc.id);
    await press("v");
    await click(visibleRects()[0], [20, 20]);
    expect(outlines()).toBe(1);
    await down(visibleRects()[1], 110, 110, true);
    await flush();
    expect(outlines()).toBe(2);
    expect(attr(selBox(), "width")).toBe(110);
    await down(visibleRects()[0], 20, 20, true);
    await flush();
    expect(outlines()).toBe(1);
    expect(attr(selBox(), "x")).toBe(100);
    expect(docJSON(doc.id)).toBe(before);
  }, 20000);

  test("dragging the selection moves every shape as one undo step and undo restores the document", async () => {
    const { doc } = await renderEditor();
    await drawRect(10, 10, 30, 30);
    await drawRect(100, 100, 120, 120);
    await press("v");
    await marquee(5, 5, 125, 125);
    const before = docJSON(doc.id);
    const undoBefore = undoLen(doc.id);
    await down(selBox(), 20, 20);
    await move(27, 16);
    await up(27, 16);
    const moved = shapes(doc.id);
    expect(moved[0]).toMatchObject({ kind: "Rect", x: 17, y: 6, w: 20, h: 20 });
    expect(moved[1]).toMatchObject({ kind: "Rect", x: 107, y: 96, w: 20, h: 20 });
    expect(undoLen(doc.id)).toBe(undoBefore + 1);
    await press("z", { ctrlKey: true });
    expect(docJSON(doc.id)).toBe(before);
  }, 20000);

  test("scaling about a custom pivot set from the side panel matches hand computation", async () => {
    const { doc } = await renderEditor();
    await drawRect(10, 10, 30, 30);
    await press("v");
    await selectShape(visibleRects()[0], 20, 20);
    await setField("Pivot X", "10");
    await setField("Pivot Y", "10");
    await down(corner("se"), 30, 30);
    await move(50, 50);
    await up(50, 50);
    expect(shapes(doc.id)[0]).toMatchObject({ kind: "Rect", x: 10, y: 10, w: 40, h: 40, width: 3 });
    expect(undoLen(doc.id)).toBe(2);
  }, 20000);

  test("edge handles stretch only the axis they sit on", async () => {
    const { doc } = await renderEditor();
    await drawRect(100, 100, 200, 200);
    await press("v");
    await selectShape(visibleRects()[0], 150, 150);
    const undoBefore = undoLen(doc.id);
    await down(edge("e"), 200, 150);
    await move(250, 175);
    await up(250, 175);
    expect(shapes(doc.id)[0]).toMatchObject({ kind: "Rect", x: 100, y: 100, w: 150, h: 100 });
    await down(edge("n"), 175, 100);
    await move(175, 50);
    await up(175, 50);
    expect(shapes(doc.id)[0]).toMatchObject({ kind: "Rect", x: 100, y: 50, w: 150, h: 150 });
    expect(undoLen(doc.id)).toBe(undoBefore + 2);
    await press("z", { ctrlKey: true });
    await press("z", { ctrlKey: true });
    expect(shapes(doc.id)[0]).toMatchObject({ kind: "Rect", x: 100, y: 100, w: 100, h: 100 });
  }, 20000);

  test("shift on a corner keeps the aspect ratio and free drag deforms it", async () => {
    const { doc } = await renderEditor();
    await drawRect(100, 100, 300, 200);
    await press("v");
    await selectShape(visibleRects()[0], 200, 150);
    await down(corner("se"), 300, 200);
    await move(350, 200);
    await up(350, 200);
    expect(shapes(doc.id)[0]).toMatchObject({ kind: "Rect", x: 50, y: 100, w: 300, h: 100 });
    await press("z", { ctrlKey: true });
    await down(corner("se"), 300, 200, true);
    await move(350, 200, true);
    await up(350, 200, true);
    expect(shapes(doc.id)[0]).toMatchObject({ kind: "Rect", x: 50, y: 75, w: 300, h: 150 });
  }, 20000);

  test("rotating a rectangle produces a faithful closed four node path", async () => {
    const { doc } = await renderEditor();
    await drawRect(0, 0, 20, 20);
    await press("v");
    await selectShape(visibleRects()[0], 10, 10);
    await down(rotateHandle(), 10, -24);
    await move(44, 10);
    await up(44, 10);
    const shape = shapes(doc.id)[0];
    expect(shape.kind).toBe("Path");
    if (shape.kind === "Path") {
      expect(shape.closed).toBe(true);
      expect(shape.fill).toBe("#3b82f6");
      expect(shape.width).toBe(3);
      expect(shape.nodes).toHaveLength(4);
      const expected = [
        [20, 0],
        [20, 20],
        [0, 20],
        [0, 0]
      ];
      shape.nodes.forEach((node, index) => {
        expect(node.point.x).toBeCloseTo(expected[index][0], 6);
        expect(node.point.y).toBeCloseTo(expected[index][1], 6);
        expect(node.handle_in).toBeNull();
        expect(node.handle_out).toBeNull();
      });
    }
  }, 20000);

  test("rotating text preserves editable content and undo restores it", async () => {
    const { doc } = await renderEditor();
    await press("t");
    await click(getCanvas(), [300, 10]);
    const before = docJSON(doc.id);
    const undoBefore = undoLen(doc.id);
    await press("v");
    const textEl = getCanvas().querySelector("text");
    if (!textEl) {
      throw new Error("text is not rendered");
    }
    await selectShape(textEl, 320, 20);
    await down(rotateHandle(), 338.4, -14);
    await move(378.4, 26);
    await up(378.4, 26);
    const transformed = shapes(doc.id)[0];
    expect(transformed).toMatchObject({ kind: "Text", x: 300, y: 10 });
    if (transformed.kind !== "Text" || !transformed.matrix) {
      throw new Error("text matrix is missing");
    }
    expect(transformed.matrix.a).toBeCloseTo(0);
    expect(transformed.matrix.b).toBeCloseTo(1);
    expect(transformed.matrix.c).toBeCloseTo(-1);
    expect(transformed.matrix.d).toBeCloseTo(0);
    const rendered = getCanvas().querySelector("text")!;
    const hit = rendered.parentElement?.querySelector('rect[fill="transparent"]');
    expect(hit?.getAttribute("transform")).toBe(rendered.getAttribute("transform"));
    expect(hit?.getAttribute("x")).toBe("300");
    expect(undoLen(doc.id)).toBe(undoBefore + 1);
    await press("z", { ctrlKey: true });
    expect(docJSON(doc.id)).toBe(before);
  }, 20000);

  test("a locked layer rejects every shape transform command", async () => {
    const { doc } = await renderEditor();
    await drawRect(10, 10, 30, 30);
    const { sceneId, layerId } = ids(doc.id);
    await docSetLayer(doc.id, sceneId, layerId, { locked: true });
    const pivot: Point = { x: 0, y: 0 };
    await expect(
      docTransformShapes(doc.id, sceneId, layerId, 0, [0], pivot, 5, 5, 1, 1, 0)
    ).rejects.toThrow("layer is locked");
    await expect(
      docReorderShapes(doc.id, sceneId, layerId, 0, [0], true)
    ).rejects.toThrow("layer is locked");
    await expect(docDeleteShapes(doc.id, sceneId, layerId, 0, [0])).rejects.toThrow(
      "layer is locked"
    );
    expect(shapes(doc.id)[0]).toMatchObject({ kind: "Rect", x: 10, y: 10 });
  }, 20000);

  test("the canvas guards and stacking controls refuse a locked layer", async () => {
    const { doc } = await renderEditor();
    await drawRect(10, 10, 30, 30);
    const lockButton = document.querySelector('button[aria-label="Lock layer"]');
    if (!lockButton) {
      throw new Error("lock button not found");
    }
    await act(async () => {
      fireEvent.click(lockButton);
    });
    await flush();
    await press("v");
    await click(visibleRects()[0], [20, 20]);
    expect(document.body.textContent).toContain("Layer is locked");
    const before = docJSON(doc.id);
    await down(selBox(), 20, 20);
    await move(40, 40);
    await up(40, 40);
    expect(docJSON(doc.id)).toBe(before);
    await act(async () => {
      fireEvent.click(button("Bring to front"));
    });
    await flush();
    expect(shapes(doc.id)[0]).toMatchObject({ kind: "Rect", x: 10, y: 10 });
    await waitFor(() => expect(document.body.textContent).toContain("layer is locked"));
  }, 20000);

  test("transforming a held frame materializes a keyframe", async () => {
    const { doc } = await renderEditor();
    await drawRect(10, 10, 30, 30);
    for (let index = 0; index < 5; index += 1) {
      await press("f5");
    }
    await press("v");
    await selectShape(visibleRects()[0], 20, 20);
    await down(selBox(), 20, 20);
    await move(23, 24);
    await up(23, 24);
    const keys = state(doc.id).doc.scenes[0].layers[0].keys;
    expect(keys).toHaveLength(2);
    expect(keys[0].frame).toBe(0);
    expect(keys[1].frame).toBe(5);
    expect(keys[0].shapes[0]).toMatchObject({ kind: "Rect", x: 10, y: 10 });
    expect(keys[1].shapes[0]).toMatchObject({ kind: "Rect", x: 13, y: 14 });
  }, 20000);

  test("stacking controls change the render order", async () => {
    const { doc } = await renderEditor();
    await drawRect(0, 0, 20, 20);
    await drawRect(100, 0, 120, 20);
    await drawRect(200, 0, 220, 20);
    await press("v");
    await click(visibleRects()[0], [10, 10]);
    await act(async () => {
      fireEvent.click(button("Bring to front"));
    });
    await flush();
    expect(shapes(doc.id).map((shape) => (shape.kind === "Rect" ? shape.x : -1))).toEqual([
      100, 200, 0
    ]);
    expect(visibleRects().map((rect) => attr(rect, "x"))).toEqual([100, 200, 0]);
    await act(async () => {
      fireEvent.click(button("Send to back"));
    });
    await flush();
    expect(shapes(doc.id).map((shape) => (shape.kind === "Rect" ? shape.x : -1))).toEqual([
      0, 100, 200
    ]);
    expect(visibleRects().map((rect) => attr(rect, "x"))).toEqual([0, 100, 200]);
  }, 20000);

  test("selection numeric fields move and scale the document", async () => {
    const { doc } = await renderEditor();
    await drawRect(10, 10, 30, 30);
    await press("v");
    await click(visibleRects()[0], [20, 20]);
    await setField("Selection X", "50");
    expect(shapes(doc.id)[0]).toMatchObject({ kind: "Rect", x: 50, y: 10 });
    await setField("Selection width", "40");
    expect(shapes(doc.id)[0]).toMatchObject({ kind: "Rect", w: 40 });
  }, 20000);

  test("ellipse quarter turns swap axes and other angles are rejected", async () => {
    const { doc } = await renderEditor();
    await press("o");
    await drag(getCanvas(), [
      [0, 0],
      [20, 10]
    ]);
    const { sceneId, layerId } = ids(doc.id);
    const pivot: Point = { x: 0, y: 0 };
    await expect(
      docTransformShapes(doc.id, sceneId, layerId, 0, [0], pivot, 0, 0, 1, 1, 30)
    ).rejects.toThrow("ellipse cannot be rotated");
    const turned = await docTransformShapes(
      doc.id,
      sceneId,
      layerId,
      0,
      [0],
      pivot,
      0,
      0,
      1,
      1,
      90
    );
    expect(turned.scenes[0].layers[0].keys[0].shapes[0]).toMatchObject({
      kind: "Ellipse",
      w: 10,
      h: 20,
      x: -10,
      y: 0
    });
  }, 20000);

  test("unrepresentable transforms are rejected without changing the document", async () => {
    const { doc } = await renderEditor();
    await press("t");
    await click(getCanvas(), [300, 10]);
    const { sceneId, layerId } = ids(doc.id);
    const pivot: Point = { x: 0, y: 0 };
    const before = docJSON(doc.id);
    await expect(
      docTransformShapes(doc.id, sceneId, layerId, 0, [0], pivot, 0, 0, -1, 1, 0)
    ).rejects.toThrow("scale must be positive");
    await expect(
      docTransformShapes(doc.id, sceneId, layerId, 0, [], pivot, 0, 0, 1, 1, 0)
    ).rejects.toThrow("no shapes selected");
    await expect(
      docTransformShapes(doc.id, sceneId, layerId, 0, [9], pivot, 0, 0, 1, 1, 0)
    ).rejects.toThrow("unknown shape");
    expect(docJSON(doc.id)).toBe(before);
  }, 20000);

  test("text rotation and nonuniform scales compose in selection order", async () => {
    const { doc } = await renderEditor();
    const { sceneId, layerId } = ids(doc.id);
    const original: Shape = { kind: "Text", x: 10, y: 20, text: "A𐐀", size: 10, family: "Segoe UI", color: "#000000" };
    await docDraw(doc.id, sceneId, layerId, 0, original);
    const before = docJSON(doc.id);
    const pivot = { x: 15, y: -4 };
    const steps = [[7, -9, 2, 3, 35], [-2, 8, 4, 0.5, -70], [5, 6, 2, 2, 0]];
    let expected = textCorners(original);
    for (const [dx, dy, sx, sy, rotation] of steps) {
      await docTransformShapes(doc.id, sceneId, layerId, 0, [0], pivot, dx, dy, sx, sy, rotation);
      const m = affineFrom(pivot, dx, dy, sx, sy, rotation);
      expected = expected.map((point) => applyAffine(m, point));
      const shape = shapes(doc.id)[0];
      expect(shape).toMatchObject(original);
      if (shape.kind !== "Text") throw new Error("expected text");
      textCorners(shape).forEach((point, index) => {
        expect(point.x).toBeCloseTo(expected[index].x, 9);
        expect(point.y).toBeCloseTo(expected[index].y, 9);
      });
    }
    const after = docJSON(doc.id);
    for (const _ of steps) await docUndo(doc.id);
    expect(docJSON(doc.id)).toBe(before);
    for (const _ of steps) await docRedo(doc.id);
    expect(docJSON(doc.id)).toBe(after);
  });

  test("text bounds and eraser radius follow the transformed rectangle", async () => {
    const { doc } = await renderEditor();
    const { sceneId, layerId } = ids(doc.id);
    const shape: Shape = {
      kind: "Text", x: 0, y: 0, text: "AB", size: 10, family: "Segoe UI", color: "#000000",
      matrix: { a: 2, b: 2, c: -1, d: 1, e: 10, f: 20 }
    };
    expect(shapeBounds(shape)).toEqual({ x: 0, y: 20, w: 34, h: 34 });
    await docDraw(doc.id, sceneId, layerId, 0, shape);
    for (const [x, y, radius, hit] of [[1, 21, 1, false], [23, 31, 1, false], [23, 31, 1.5, true], [10, 18, 1.5, false], [10, 18, 2, true], [17, 37, 1, true]] as const) {
      await docErase(doc.id, sceneId, layerId, 0, [{ x, y }], radius);
      expect(shapes(doc.id)).toHaveLength(hit ? 0 : 1);
      if (hit) await docUndo(doc.id);
    }
  });

  test("text validates all affine entries and finite positive font sizes", async () => {
    const { doc } = await renderEditor();
    const { sceneId, layerId } = ids(doc.id);
    const shape: Extract<Shape, { kind: "Text" }> = {
      kind: "Text", x: 0, y: 0, text: "AB", size: 10, family: "Segoe UI", color: "#000000"
    };
    const before = docJSON(doc.id);
    for (const size of [0, -1, NaN, Infinity]) {
      await expect(docDraw(doc.id, sceneId, layerId, 0, { ...shape, size })).rejects.toThrow("text size must be positive");
    }
    for (const field of ["a", "b", "c", "d", "e", "f"]) {
      for (const value of [NaN, Infinity, -Infinity]) {
        const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, [field]: value };
        await expect(docDraw(doc.id, sceneId, layerId, 0, { ...shape, matrix })).rejects.toThrow("text matrix must be finite");
      }
    }
    expect(docJSON(doc.id)).toBe(before);
  });

  test("shared affine and bounds helpers match the Rust contract", async () => {
    const pivot: Point = { x: 10, y: 10 };
    const matrix = affineFrom(pivot, 5, -3, 2, 3, 90);
    const moved = applyAffine(matrix, { x: 20, y: 30 });
    expect(moved.x).toBeCloseTo(-45, 9);
    expect(moved.y).toBeCloseTo(27, 9);
    const identity = affineFrom(pivot, 0, 0, 1, 1, 0);
    const same = applyAffine(identity, { x: 7, y: -2 });
    expect(same.x).toBeCloseTo(7, 9);
    expect(same.y).toBeCloseTo(-2, 9);
    const box: Shape = {
      kind: "Rect",
      x: 10,
      y: 20,
      w: 20,
      h: 20,
      fill: "#ff0000",
      stroke: "#000000",
      width: 1
    };
    expect(shapeBounds(box)).toEqual({ x: 10, y: 20, w: 20, h: 20 });
    const stroke: Shape = {
      kind: "Stroke",
      points: [
        { x: 4, y: 0 },
        { x: 4, y: 10 }
      ],
      color: "#000000",
      width: 2
    };
    expect(shapeBounds(stroke)).toEqual({ x: 3, y: -1, w: 2, h: 12 });
    const text: Shape = {
      kind: "Text",
      x: 300,
      y: 10,
      text: "AB",
      size: 10,
      family: "Segoe UI",
      color: "#000000"
    };
    expect(shapeBounds(text)).toEqual({ x: 300, y: 10, w: 12, h: 10 });
    const curve: Shape = {
      kind: "Path",
      nodes: [
        { point: { x: 0, y: 0 }, handle_in: null, handle_out: { x: 0, y: 100 } },
        { point: { x: 100, y: 0 }, handle_in: { x: 100, y: 100 }, handle_out: null }
      ],
      closed: false,
      fill: "#ff0000",
      stroke: "#000000",
      width: 1
    };
    const curveBounds = shapeBounds(curve);
    expect(curveBounds.x).toBeCloseTo(-0.5, 9);
    expect(curveBounds.y).toBeCloseTo(-0.5, 9);
    expect(curveBounds.w).toBeCloseTo(101, 9);
    expect(curveBounds.h).toBeCloseTo(76, 9);
    expect(unionBounds([box, stroke], [0, 1])).toEqual({ x: 3, y: -1, w: 27, h: 41 });
  }, 20000);
});