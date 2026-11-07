import { describe, expect, it } from "vitest";
import { store } from "./backend";
import { click, drag, getCanvas, press, renderEditor } from "./utils";
import type { Shape } from "@/lib/document";

function shapes(id: string): Shape[] {
  const state = store.get(id);
  if (!state) {
    throw new Error("document is not in the store");
  }
  return state.doc.scenes[0].layers[0].keys[0].shapes;
}

describe("drawing tools", () => {
  it("stores the points sampled by the pencil", async () => {
    const { doc } = await renderEditor();
    await press("p");
    await drag(getCanvas(), [
      [10, 10],
      [20, 20],
      [30, 10]
    ]);
    const drawn = shapes(doc.id);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].kind).toBe("Stroke");
    if (drawn[0].kind === "Stroke") {
      expect(drawn[0].points).toEqual([
        { x: 10, y: 10 },
        { x: 20, y: 20 },
        { x: 30, y: 10 }
      ]);
    }
  });

  it("undoes and redoes a stroke as one step", async () => {
    const { doc } = await renderEditor();
    await press("p");
    await drag(getCanvas(), [
      [10, 10],
      [40, 40]
    ]);
    expect(shapes(doc.id)).toHaveLength(1);
    await press("z", { ctrlKey: true });
    expect(shapes(doc.id)).toHaveLength(0);
    await press("z", { ctrlKey: true, shiftKey: true });
    expect(shapes(doc.id)).toHaveLength(1);
  });

  it("smooths the brush but not the pencil", async () => {
    const { doc } = await renderEditor();
    const path: Array<[number, number]> = [
      [0, 0],
      [10, 20],
      [20, 0],
      [30, 20],
      [40, 0]
    ];
    await press("b");
    await drag(getCanvas(), path);
    const brushed = shapes(doc.id)[0];
    expect(brushed.kind).toBe("Stroke");
    if (brushed.kind === "Stroke") {
      expect(brushed.points).toHaveLength(5);
      expect(brushed.points[1]).toEqual({ x: 10, y: 10 });
      expect(brushed.points[0]).toEqual({ x: 0, y: 0 });
      expect(brushed.points[4]).toEqual({ x: 40, y: 0 });
    }
  });

  it("creates a polygon with the configured side count", async () => {
    const { doc } = await renderEditor();
    await press("g");
    await drag(getCanvas(), [
      [100, 100],
      [200, 200]
    ]);
    const drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Polygon");
    if (drawn.kind === "Polygon") {
      expect(drawn.sides).toBe(5);
      expect(drawn.w).toBe(100);
      expect(drawn.h).toBe(100);
    }
  });

  it("creates text and selects it for editing", async () => {
    const { doc } = await renderEditor();
    await press("t");
    await click(getCanvas(), [120, 80]);
    const drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Text");
    if (drawn.kind === "Text") {
      expect(drawn.text).toBe("Text");
      expect(drawn.size).toBe(32);
      expect(drawn.x).toBe(120);
      expect(drawn.y).toBe(80);
    }
    expect(document.querySelector("svg text")?.textContent).toBe("Text");
  });

  it("splits a stroke where the eraser crosses it", async () => {
    const { doc } = await renderEditor();
    await press("p");
    const line: Array<[number, number]> = [];
    for (let x = 100; x <= 200; x += 5) {
      line.push([x, 100]);
    }
    await drag(getCanvas(), line);
    expect(shapes(doc.id)).toHaveLength(1);
    await press("e");
    await drag(getCanvas(), [
      [150, 90],
      [150, 110]
    ]);
    const left = shapes(doc.id);
    expect(left).toHaveLength(2);
    for (const shape of left) {
      expect(shape.kind).toBe("Stroke");
      if (shape.kind === "Stroke") {
        expect(shape.points.every((point) => Math.abs(point.x - 150) > 5)).toBe(
          true
        );
      }
    }
    expect(store.get(doc.id)?.undo).toHaveLength(2);
  });
});