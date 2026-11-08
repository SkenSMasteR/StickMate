import { describe, expect, test } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import en from "@/i18n/en.json";
import { docDraw, identityTransform } from "@/lib/document";
import type { Shape } from "@/lib/document";
import {
  boxAxes,
  collectTargets,
  mapBounds,
  snapDelta,
  snapPoint
} from "@/lib/snapping";
import { store } from "./backend";
import { flush, getCanvas, press, renderEditor } from "./utils";

const base = { pointerId: 1, button: 0, buttons: 1, bubbles: true };
const stage = { width: 800, height: 600 };

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

function ids(id: string): { sceneId: string; layerId: string } {
  const doc = state(id).doc;
  return { sceneId: doc.scenes[0].id, layerId: doc.scenes[0].layers[0].id };
}

function rect(x: number, y: number, w: number, h: number): Shape {
  return {
    kind: "Rect",
    x,
    y,
    w,
    h,
    fill: "#3b82f6",
    stroke: "#000000",
    width: 3
  };
}

function selBox(): Element {
  const found = getCanvas().querySelector("[data-selection-box]");
  if (!found) {
    throw new Error("selection box not found");
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

function corner(name: string): Element {
  const found = getCanvas().querySelector(`[data-corner="${name}"]`);
  if (!found) {
    throw new Error(`corner not found: ${name}`);
  }
  return found;
}

function visibleRects(): Element[] {
  return [...getCanvas().querySelectorAll('rect[fill="#3b82f6"]')];
}

function attr(element: Element, name: string): number {
  return Number(element.getAttribute(name));
}

function snapLines(): Element[] {
  return [...getCanvas().querySelectorAll("[data-snap-line]")];
}

async function openView(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: en["panel.view"] }));
  });
  await flush();
}

async function clickToggle(id: string): Promise<void> {
  const found = document.querySelector<HTMLElement>(`[data-view-toggle="${id}"]`);
  if (!found) {
    throw new Error(`view toggle ${id} is not mounted`);
  }
  await act(async () => {
    fireEvent.click(found);
  });
  await flush();
}

async function enableSnap(grid: boolean): Promise<void> {
  await openView();
  if (grid) {
    await clickToggle("grid");
  }
  await clickToggle("snap");
  await press("v");
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

async function tap(x: number, y: number): Promise<void> {
  await down(getCanvas(), x, y);
  await up(x, y);
}

async function pick(target: Element, x: number, y: number): Promise<void> {
  await down(target, x, y);
  await up(x, y);
}

async function marquee(x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await down(getCanvas(), x1, y1);
  await move(x2, y2);
  await up(x2, y2);
}

async function addRect(id: string, shape: Shape): Promise<void> {
  const { sceneId, layerId } = ids(id);
  await docDraw(id, sceneId, layerId, 0, shape);
  await flush();
}

describe("snapping math", () => {
  test("collectTargets covers the stage, the centre, the grid and shape boxes", () => {
    const plain = collectTargets(stage, { enabled: false, size: 50 }, []);
    expect(plain.xs).toEqual([0, 400, 800]);
    expect(plain.ys).toEqual([0, 300, 600]);
    const withGrid = collectTargets(stage, { enabled: true, size: 300 }, [
      { x: 10, y: 20, w: 40, h: 60 }
    ]);
    expect(withGrid.xs).toEqual([0, 400, 800, 300, 600, 10, 30, 50]);
    expect(withGrid.ys).toEqual([0, 300, 600, 300, 20, 50, 80]);
    expect(boxAxes({ x: 10, y: 20, w: 40, h: 60 })).toEqual({ xs: [10, 30, 50], ys: [20, 50, 80] });
  });

  test("snapPoint resolves each axis on its own to the nearest target", () => {
    const targets = collectTargets(stage, { enabled: false, size: 50 }, [
      { x: 100, y: 100, w: 200, h: 100 }
    ]);
    expect(snapPoint({ x: 199, y: 101 }, targets, 6)).toEqual({
      point: { x: 200, y: 100 },
      x: 200,
      y: 100
    });
    expect(snapPoint({ x: 150, y: 149 }, targets, 6)).toEqual({
      point: { x: 150, y: 150 },
      x: null,
      y: 150
    });
    expect(snapPoint({ x: 40, y: 40 }, targets, 6)).toEqual({
      point: { x: 40, y: 40 },
      x: null,
      y: null
    });
  });

  test("snapPoint follows the grid spacing and the zoom scaled tolerance", () => {
    const grid = collectTargets(stage, { enabled: true, size: 50 }, []);
    expect(snapPoint({ x: 97, y: 98 }, grid, 6).point).toEqual({ x: 100, y: 100 });
    expect(snapPoint({ x: 124, y: 126 }, grid, 6).point).toEqual({ x: 124, y: 126 });
    expect(snapPoint({ x: 402, y: 305 }, grid, 6).point).toEqual({ x: 400, y: 300 });
    expect(snapPoint({ x: 402, y: 305 }, grid, 3).point).toEqual({ x: 400, y: 305 });
  });

  test("snapDelta prefers the nearest edge candidate per axis", () => {
    const targets = collectTargets(stage, { enabled: false, size: 50 }, [
      { x: 100, y: 100, w: 200, h: 200 }
    ]);
    expect(snapDelta({ x: 96, y: 10, w: 20, h: 20 }, { x: 5, y: 0 }, targets, 6)).toEqual({
      dx: 4,
      dy: 0,
      x: 100,
      y: null
    });
    expect(snapDelta({ x: 96, y: 10, w: 20, h: 20 }, { x: 30, y: 191 }, targets, 6)).toEqual({
      dx: 30,
      dy: 190,
      x: null,
      y: 200
    });
  });

  test("mapBounds carries shape boxes into document space", () => {
    const scaled = mapBounds(
      { x: 10, y: 20, w: 20, h: 10 },
      { ...identityTransform, x: 5, y: 7, scale: 2 }
    );
    expect(scaled).toEqual({ x: 25, y: 47, w: 40, h: 20 });
    const turned = mapBounds(
      { x: 0, y: 0, w: 20, h: 10 },
      { ...identityTransform, rotation: 90 }
    );
    expect(turned.x).toBeCloseTo(-10, 9);
    expect(turned.y).toBeCloseTo(0, 9);
    expect(turned.w).toBeCloseTo(10, 9);
    expect(turned.h).toBeCloseTo(20, 9);
    expect(mapBounds({ x: 1, y: 2, w: 3, h: 4 }, identityTransform)).toEqual({
      x: 1,
      y: 2,
      w: 3,
      h: 4
    });
  });
});

describe("snapping in the canvas", () => {
  test("the grid only feeds the targets while it is visible", async () => {
    const { doc } = await renderEditor();
    await addRect(doc.id, rect(100, 100, 200, 200));
    await enableSnap(true);
    await press("r");
    await down(getCanvas(), 97, 98);
    await move(203, 147);
    expect(snapLines()).toHaveLength(2);
    await up(203, 147);
    expect(shapes(doc.id)[1]).toMatchObject({ kind: "Rect", x: 100, y: 100, w: 100, h: 50 });
    expect(snapLines()).toHaveLength(0);

    await clickToggle("grid");
    await press("r");
    await down(getCanvas(), 420, 10);
    await move(470, 60);
    expect(snapLines()).toHaveLength(0);
    await up(470, 60);
    expect(shapes(doc.id)[2]).toMatchObject({ kind: "Rect", x: 420, y: 10, w: 50, h: 50 });
  }, 20000);

  test("a dragged selection snaps its edge to another shape and clears on release", async () => {
    const { doc } = await renderEditor();
    await addRect(doc.id, rect(100, 100, 200, 200));
    await addRect(doc.id, rect(96, 10, 20, 20));
    await enableSnap(false);
    await marquee(90, 5, 120, 35);
    expect(selBox()).toBeTruthy();
    await down(selBox(), 100, 20);
    await move(105, 20);
    const lines = snapLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute("data-snap-line")).toBe("x");
    expect(attr(lines[0], "x1")).toBe(100);
    await up(105, 20);
    expect(shapes(doc.id)[1]).toMatchObject({ kind: "Rect", x: 100, y: 10, w: 20, h: 20 });
    expect(snapLines()).toHaveLength(0);
  }, 20000);

  test("stretch handles snap the dragged edge to the grid", async () => {
    const { doc } = await renderEditor();
    await addRect(doc.id, rect(100, 100, 100, 100));
    await enableSnap(true);
    await pick(visibleRects()[0], 150, 150);
    await down(edge("e"), 200, 150);
    await move(246, 150);
    const vertical = snapLines().find((line) => line.getAttribute("data-snap-line") === "x");
    expect(vertical).toBeDefined();
    expect(attr(vertical as Element, "x1")).toBe(250);
    await up(246, 150);
    expect(shapes(doc.id)[0]).toMatchObject({ kind: "Rect", x: 100, y: 100, w: 150, h: 100 });
  }, 20000);

  test("corner snapping still honours the shift aspect lock", async () => {
    const { doc } = await renderEditor();
    await addRect(doc.id, rect(100, 100, 200, 100));
    await enableSnap(true);
    await pick(visibleRects()[0], 200, 150);
    await down(corner("se"), 300, 200, true);
    await move(303, 225, true);
    await up(303, 225, true);
    expect(shapes(doc.id)[0]).toMatchObject({ kind: "Rect", x: 50, y: 75, w: 300, h: 150 });
  }, 20000);

  test("pen anchors land on the grid", async () => {
    const { doc } = await renderEditor();
    await enableSnap(true);
    await press("n");
    await tap(98, 103);
    await tap(197, 102);
    await tap(201, 298);
    await press("Enter");
    const drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Path");
    if (drawn.kind === "Path") {
      expect(drawn.nodes).toHaveLength(3);
      expect(drawn.nodes[0].point).toEqual({ x: 100, y: 100 });
      expect(drawn.nodes[1].point).toEqual({ x: 200, y: 100 });
      expect(drawn.nodes[2].point).toEqual({ x: 200, y: 300 });
    }
  }, 20000);

  test("freehand strokes keep every sampled point", async () => {
    const { doc } = await renderEditor();
    await enableSnap(true);
    await press("p");
    await down(getCanvas(), 98, 103);
    await move(121, 137);
    expect(snapLines()).toHaveLength(0);
    await up(121, 137);
    expect(shapes(doc.id)[0]).toMatchObject({
      kind: "Stroke",
      points: [
        { x: 98, y: 103 },
        { x: 121, y: 137 }
      ]
    });
  }, 20000);

  test("snapping off leaves the pointer positions untouched", async () => {
    const { doc } = await renderEditor();
    await addRect(doc.id, rect(100, 100, 200, 200));
    await openView();
    await clickToggle("grid");
    await press("r");
    await down(getCanvas(), 97, 98);
    await move(203, 147);
    expect(snapLines()).toHaveLength(0);
    await up(203, 147);
    expect(shapes(doc.id)[1]).toMatchObject({ kind: "Rect", x: 97, y: 98, w: 106, h: 49 });
  }, 20000);
});
