import { describe, expect, test } from "vitest";
import { docDraw, docNew, docRedo, docSetLayer, docShapeBool, docUndo } from "@/lib/document";
import type { BoolOp, Document, Point, Shape } from "@/lib/document";
import { installBackend, store } from "./backend";

function rect(x: number, y: number, w: number, h: number): Shape {
  return {
    kind: "Rect",
    x,
    y,
    w,
    h,
    fill: "#ff0000",
    stroke: "#000000",
    width: 2,
    gradient: null
  };
}

function circle(x: number, y: number, w: number, h: number): Shape {
  return {
    kind: "Ellipse",
    x,
    y,
    w,
    h,
    fill: "#00ff00",
    stroke: "#000000",
    width: 2,
    gradient: null
  };
}

function close(value: number, target: number): boolean {
  return Math.abs(value - target) < 1e-6;
}

function doc(id: string): Document {
  const state = store.get(id);
  if (!state) {
    throw new Error("document is not in the store");
  }
  return state.doc;
}

function ringOf(shape: Shape): Point[] {
  if (shape.kind !== "Path") {
    throw new Error("path expected");
  }
  return shape.nodes.map((node) => node.point);
}

function rings(list: Shape[]): Point[][] {
  return list.map(ringOf);
}

function area(ring: Point[]): number {
  let total = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

function bounds(rings: Point[][]): [number, number, number, number] {
  let lowX = Infinity;
  let lowY = Infinity;
  let highX = -Infinity;
  let highY = -Infinity;
  for (const ring of rings) {
    for (const point of ring) {
      lowX = Math.min(lowX, point.x);
      lowY = Math.min(lowY, point.y);
      highX = Math.max(highX, point.x);
      highY = Math.max(highY, point.y);
    }
  }
  return [lowX, lowY, highX, highY];
}

function total(rings: Point[][]): number {
  return rings.reduce((sum, ring) => sum + Math.abs(area(ring)), 0);
}

function boundsAre(rings: Point[][], box: [number, number, number, number]): boolean {
  const found = bounds(rings);
  return found.every((value, index) => close(value, box[index]));
}

async function opened(list: Shape[]): Promise<{ id: string; sceneId: string; layerId: string }> {
  installBackend("boolean");
  const doc = await docNew("Booleans", 800, 600, 24, "#ffffff");
  const sceneId = doc.scenes[0].id;
  const layerId = doc.scenes[0].layers[0].id;
  for (const shape of list) {
    await docDraw(doc.id, sceneId, layerId, 0, shape);
  }
  return { id: doc.id, sceneId, layerId };
}

async function combine(list: Shape[], indices: number[], op: BoolOp): Promise<Point[][]> {
  const { id, sceneId, layerId } = await opened(list);
  const next = await docShapeBool(id, sceneId, layerId, 0, indices, op);
  return rings(next.scenes[0].layers[0].keys[0].shapes);
}

function key(id: string): Shape[] {
  return doc(id).scenes[0].layers[0].keys[0].shapes;
}

describe("boolean engine", () => {
  test("unions rects sharing collinear edges into one closed ring", async () => {
    const merged = await combine(
      [rect(0, 0, 20, 10), rect(10, 0, 20, 10)],
      [0, 1],
      "union"
    );
    expect(merged).toHaveLength(1);
    expect(boundsAre(merged, [0, 0, 30, 10])).toBe(true);
    expect(close(total(merged), 300)).toBe(true);
  });

  test("intersects the same pair down to the overlap", async () => {
    const merged = await combine(
      [rect(0, 0, 20, 10), rect(10, 0, 20, 10)],
      [0, 1],
      "intersect"
    );
    expect(merged).toHaveLength(1);
    expect(boundsAre(merged, [10, 0, 20, 10])).toBe(true);
    expect(close(total(merged), 100)).toBe(true);
  });

  test("subtracts the overlap from the subject", async () => {
    const merged = await combine(
      [rect(0, 0, 20, 10), rect(10, 0, 20, 10)],
      [0, 1],
      "subtract"
    );
    expect(merged).toHaveLength(1);
    expect(boundsAre(merged, [0, 0, 10, 10])).toBe(true);
    expect(close(total(merged), 100)).toBe(true);
  });

  test("excludes the overlap and keeps both arms", async () => {
    const merged = await combine(
      [rect(0, 0, 20, 10), rect(10, 0, 20, 10)],
      [0, 1],
      "exclude"
    );
    expect(merged).toHaveLength(2);
    expect(close(total(merged), 200)).toBe(true);
  });

  test("subtracts a nested rect punching a single ring", async () => {
    const merged = await combine([rect(0, 0, 40, 40), rect(10, 10, 10, 10)], [0, 1], "subtract");
    expect(merged).toHaveLength(1);
    expect(close(total(merged), 1500)).toBe(true);
  });

  test("unions disjoint rings side by side", async () => {
    const merged = await combine([rect(0, 0, 10, 10), rect(30, 30, 10, 10)], [0, 1], "union");
    expect(merged).toHaveLength(2);
    expect(close(total(merged), 200)).toBe(true);
  });

  test("unions stacked rects into the full cover", async () => {
    const merged = await combine([rect(0, 0, 20, 10), rect(0, 10, 20, 10)], [0, 1], "union");
    expect(close(total(merged), 400)).toBe(true);
  });

  test("unions corner-overlapping rects into the L shape", async () => {
    const merged = await combine([rect(0, 0, 20, 20), rect(10, 10, 20, 20)], [0, 1], "union");
    expect(merged).toHaveLength(1);
    expect(close(total(merged), 700)).toBe(true);
  });

  test("unions transversally overlapping rects", async () => {
    const merged = await combine([rect(0, 0, 20, 10), rect(10, -5, 20, 20)], [0, 1], "union");
    expect(merged).toHaveLength(1);
    expect(close(total(merged), 500)).toBe(true);
  });

  test("combines two overlapping ellipses into one closed ring", async () => {
    const merged = await combine([circle(0, 0, 20, 20), circle(10, 0, 20, 20)], [0, 1], "union");
    expect(merged).toHaveLength(1);
    expect(close(bounds(merged)[0], 0)).toBe(true);
    expect(close(bounds(merged)[2], 30)).toBe(true);
    expect(area(merged[0])).toBeGreaterThan(0);
  });

  test("keeps a rect whole when intersecting a circle that contains it", async () => {
    const merged = await combine([rect(10, 10, 10, 10), circle(0, 0, 40, 40)], [0, 1], "intersect");
    expect(merged).toHaveLength(1);
    expect(close(total(merged), 100)).toBe(true);
  });

  test("keeps the first shape style on every merged ring", async () => {
    const { id, sceneId, layerId } = await opened([rect(0, 0, 20, 10), circle(10, 0, 20, 10)]);
    const next = await docShapeBool(id, sceneId, layerId, 0, [0, 1], "union");
    const list = next.scenes[0].layers[0].keys[0].shapes;
    expect(list).toHaveLength(1);
    const shape = list[0];
    if (shape.kind !== "Path") {
      throw new Error("path expected");
    }
    expect(shape.nodes.length).toBeGreaterThan(4);
    expect(shape.closed).toBe(true);
    expect(shape.fill).toBe("#ff0000");
    expect(shape.stroke).toBe("#000000");
    expect(shape.width).toBe(2);
  });

  test("folds a chain of three rects in index order", async () => {
    const merged = await combine(
      [rect(0, 0, 20, 10), rect(10, 0, 20, 10), rect(25, 0, 20, 10)],
      [0, 1, 2],
      "union"
    );
    expect(close(total(merged), 450)).toBe(true);
  });

  test("refuses strokes and text", async () => {
    const stroke: Shape = {
      kind: "Stroke",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 }
      ],
      color: "#000000",
      width: 2
    };
    const text: Shape = {
      kind: "Text",
      x: 40,
      y: 40,
      text: "hi",
      size: 12,
      family: "sans-serif",
      color: "#000000"
    };
    const first = await opened([stroke, rect(0, 0, 10, 10)]);
    await expect(
      docShapeBool(first.id, first.sceneId, first.layerId, 0, [0, 1], "union")
    ).rejects.toThrow("boolean needs closed filled shapes");
    const second = await opened([text, rect(0, 0, 10, 10)]);
    await expect(
      docShapeBool(second.id, second.sceneId, second.layerId, 0, [0, 1], "union")
    ).rejects.toThrow("boolean needs closed filled shapes");
  });

  test("refuses open paths", async () => {
    const open: Shape = {
      kind: "Path",
      nodes: [
        { point: { x: 0, y: 0 }, handle_in: null, handle_out: null },
        { point: { x: 10, y: 0 }, handle_in: null, handle_out: null },
        { point: { x: 10, y: 10 }, handle_in: null, handle_out: null }
      ],
      closed: false,
      fill: "#ff0000",
      stroke: "#000000",
      width: 2
    };
    const { id, sceneId, layerId } = await opened([open, rect(5, 5, 20, 20)]);
    await expect(docShapeBool(id, sceneId, layerId, 0, [0, 1], "union")).rejects.toThrow(
      "boolean needs closed filled shapes"
    );
  });

  test("refuses selections below two shapes", async () => {
    const { id, sceneId, layerId } = await opened([rect(0, 0, 20, 10), rect(10, 0, 20, 10)]);
    const before = JSON.stringify(key(id));
    await expect(docShapeBool(id, sceneId, layerId, 0, [1], "union")).rejects.toThrow(
      "select at least two shapes"
    );
    await expect(docShapeBool(id, sceneId, layerId, 0, [], "union")).rejects.toThrow(
      "select at least two shapes"
    );
    await expect(docShapeBool(id, sceneId, layerId, 0, [0, 7], "union")).rejects.toThrow(
      "unknown shape"
    );
    expect(JSON.stringify(key(id))).toBe(before);
  });

  test("refuses an empty intersection between separated shapes", async () => {
    const { id, sceneId, layerId } = await opened([rect(0, 0, 10, 10), rect(30, 30, 10, 10)]);
    const before = JSON.stringify(key(id));
    await expect(docShapeBool(id, sceneId, layerId, 0, [0, 1], "intersect")).rejects.toThrow(
      "the boolean result is empty"
    );
    expect(JSON.stringify(key(id))).toBe(before);
  });

  test("replaces the picked slots with the merged rings", async () => {
    const { id, sceneId, layerId } = await opened([
      rect(60, 60, 20, 10),
      rect(0, 0, 20, 10),
      rect(10, 0, 20, 10),
      rect(90, 90, 10, 10)
    ]);
    const next = await docShapeBool(id, sceneId, layerId, 0, [1, 2], "union");
    const list = next.scenes[0].layers[0].keys[0].shapes;
    expect(list.map((shape) => shape.kind)).toEqual(["Rect", "Path", "Rect"]);
    expect(close(Math.abs(area(ringOf(list[1]))), 300)).toBe(true);
  });

  test("refuses a locked layer without adding history", async () => {
    const { id, sceneId, layerId } = await opened([rect(0, 0, 20, 10), rect(10, 0, 20, 10)]);
    await docSetLayer(id, sceneId, layerId, { locked: true });
    const before = JSON.stringify(key(id));
    const steps = store.get(id)?.undo.length ?? 0;
    await expect(docShapeBool(id, sceneId, layerId, 0, [0, 1], "union")).rejects.toThrow(
      "layer is locked"
    );
    expect(JSON.stringify(key(id))).toBe(before);
    expect(store.get(id)?.undo.length ?? 0).toBe(steps);
  });

  test("undoes and redoes a boolean as one step", async () => {
    const { id, sceneId, layerId } = await opened([rect(0, 0, 20, 10), rect(10, 0, 20, 10)]);
    const before = JSON.stringify(key(id));
    const merged = await docShapeBool(id, sceneId, layerId, 0, [0, 1], "union");
    const result = JSON.stringify(merged.scenes[0].layers[0].keys[0].shapes);
    expect(result).not.toBe(before);
    await docUndo(id);
    expect(JSON.stringify(key(id))).toBe(before);
    await docRedo(id);
    expect(JSON.stringify(key(id))).toBe(result);
  });
});
