import { describe, expect, test } from "vitest";
import {
  docAddFigure,
  docAttachArt,
  docDetachArt,
  docDraw,
  docKeyframe,
  docNew,
  docPoseFigure,
  docReachFigure,
  docRedo,
  docSetLayer,
  docSetTween,
  docUndo,
  figureBounds,
  figurePlaces,
  humanoidFigure,
  ikChain,
  isLeafBone,
  shapeBounds
} from "@/lib/document";
import type { Bounds, Document, Figure, Place, Point, Shape } from "@/lib/document";
import { installBackend, store } from "./backend";

function near(value: number, target: number, tolerance = 0.01): boolean {
  return Math.abs(value - target) < tolerance;
}

function span(place: Place): number {
  return Math.hypot(place.tip.x - place.base.x, place.tip.y - place.base.y);
}

function boxIs(box: Bounds, target: [number, number, number, number]): boolean {
  return (
    near(box.x, target[0], 1e-6) &&
    near(box.y, target[1], 1e-6) &&
    near(box.w, target[2], 1e-6) &&
    near(box.h, target[3], 1e-6)
  );
}

function ringOf(shape: Shape): Point[] {
  if (shape.kind !== "Path") {
    throw new Error("path expected");
  }
  return shape.nodes.map((node) => node.point);
}

function ringIs(shape: Shape, want: Array<[number, number]>): boolean {
  const ring = ringOf(shape);
  return (
    ring.length === want.length &&
    ring.every(
      (point, index) =>
        near(point.x, want[index][0], 1e-6) && near(point.y, want[index][1], 1e-6)
    )
  );
}

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

function current(id: string): Document {
  const found = store.get(id);
  if (!found) {
    throw new Error("document is not in the store");
  }
  return found.doc;
}

function listed(id: string, frame = 0): Shape[] {
  const key = current(id).scenes[0].layers[0].keys.find((item) => item.frame === frame);
  if (!key) {
    throw new Error("keyframe is missing");
  }
  return key.shapes;
}

function rigOf(shape: Shape): Figure {
  if (shape.kind !== "Figure") {
    throw new Error("figure expected");
  }
  return shape.figure;
}

function rigAt(id: string, frame = 0): Figure {
  return rigOf(listed(id, frame)[0]);
}

async function opened(extra: Shape[] = []): Promise<{ id: string; sceneId: string; layerId: string }> {
  installBackend("figure");
  const fresh = await docNew("Figures", 800, 600, 24, "#ffffff");
  const sceneId = fresh.scenes[0].id;
  const layerId = fresh.scenes[0].layers[0].id;
  await docAddFigure(fresh.id, sceneId, layerId, 0, 200, 320, 200);
  for (const shape of extra) {
    await docDraw(fresh.id, sceneId, layerId, 0, shape);
  }
  return { id: fresh.id, sceneId, layerId };
}

describe("figure backend commands", () => {
  test("adds a twelve bone humanoid standing on the given hip", async () => {
    const { id } = await opened();
    expect(listed(id).map((shape) => shape.kind)).toEqual(["Figure"]);
    const figure = rigAt(id);
    expect(figure.bones).toHaveLength(12);
    expect({ x: figure.x, y: figure.y, rotation: figure.rotation }).toEqual({
      x: 200,
      y: 320,
      rotation: 0
    });
    const places = figurePlaces(figure);
    expect(span(places[0])).toBe(0);
    expect(places[1].tip.x).toBeCloseTo(200, 6);
    expect(places[1].tip.y).toBeCloseTo(268, 6);
    for (const [left, right] of [
      [4, 8],
      [5, 9],
      [6, 10],
      [7, 11]
    ]) {
      expect(near(places[left].tip.x + places[right].tip.x, 400, 1e-6)).toBe(true);
      expect(near(places[left].tip.y, places[right].tip.y, 1e-6)).toBe(true);
    }
    expect(places[5].tip.y > places[4].base.y).toBe(true);
    expect(places[7].tip.y > places[0].base.y).toBe(true);
    const box = figureBounds(figure);
    expect(box === null).toBe(false);
    if (box) {
      expect(near(box.y, 220)).toBe(true);
      expect(near(box.h, 205.34, 0.5)).toBe(true);
      expect(near(box.w, 50.96, 0.5)).toBe(true);
    }
    expect(figure.bones[3].art).toHaveLength(1);
    expect(figure.bones[3].art[0].kind).toBe("Ellipse");
    expect(figure.bones[3].art.map((shape) => shapeBounds(shape).w)).toEqual([40]);
    expect(figure.bones.every((bone) => bone.color === "#27272a")).toBe(true);
  });

  test("poses a bone that keeps its length and aims at the pointer", async () => {
    const { id, sceneId, layerId } = await opened();
    const figure = rigAt(id);
    const places = figurePlaces(figure);
    const target = { x: places[5].base.x + 60, y: places[5].base.y - 60 };
    await docPoseFigure(id, sceneId, layerId, 0, 0, 5, target);
    const posed = figurePlaces(rigAt(id));
    expect(posed.every((place, index) => near(span(place), span(places[index]), 1e-9))).toBe(true);
    expect(near(posed[5].base.x, places[5].base.x, 1e-9)).toBe(true);
    const dx = target.x - posed[5].base.x;
    const dy = target.y - posed[5].base.y;
    const cross = (posed[5].tip.x - posed[5].base.x) * dy - (posed[5].tip.y - posed[5].base.y) * dx;
    expect(Math.abs(cross)).toBeLessThan(1e-6);
    expect(posed[5].angle).toBeLessThan(0);
    expect(rigAt(id).bones[5].twist).not.toBe(figure.bones[5].twist);
    expect(rigAt(id).bones[4].twist).toBe(figure.bones[4].twist);
  });

  test("a chain stops where the bones split", () => {
    const figure = humanoidFigure(200, 320, 200);
    expect(ikChain(figure, 5)).toEqual([4, 5]);
    expect(ikChain(figure, 7)).toEqual([6, 7]);
    expect(ikChain(figure, 3)).toEqual([2, 3]);
    expect(ikChain(figure, 1)).toEqual([1]);
    expect(ikChain(figure, 0)).toEqual([0]);
    expect(ikChain(figure, 30)).toBeNull();
    expect([3, 5, 7, 9, 11].every((index) => isLeafBone(figure, index))).toBe(true);
    expect([0, 1, 2, 4, 6].every((index) => !isLeafBone(figure, index))).toBe(true);
  });

  test("reaching a wrist pulls the whole arm onto the pointer", async () => {
    const { id, sceneId, layerId } = await opened();
    const figure = rigAt(id);
    const places = figurePlaces(figure);
    const target = { x: places[5].base.x + 45, y: places[5].base.y - 45 };
    await docReachFigure(id, sceneId, layerId, 0, 0, 5, target);
    const reached = figurePlaces(rigAt(id));
    const turned = rigAt(id).bones;
    expect(Math.hypot(reached[5].tip.x - target.x, reached[5].tip.y - target.y)).toBeLessThan(0.01);
    expect(reached.every((place, index) => near(span(place), span(places[index]), 1e-9))).toBe(true);
    expect(near(reached[4].base.x, places[4].base.x, 1e-9)).toBe(true);
    expect(near(reached[4].base.y, places[4].base.y, 1e-9)).toBe(true);
    expect([4, 5].every((index) => turned[index].twist !== figure.bones[index].twist)).toBe(true);
    expect([0, 1, 2, 3, 6, 7, 8, 9, 10, 11].every((index) => turned[index].twist === figure.bones[index].twist)).toBe(true);
  });

  test("a far pointer stretches the limb straight at it", async () => {
    const { id, sceneId, layerId } = await opened();
    const places = figurePlaces(rigAt(id));
    const shoulder = places[4].base;
    const target = { x: -100, y: -100 };
    await docReachFigure(id, sceneId, layerId, 0, 0, 5, target);
    const place = figurePlaces(rigAt(id))[5];
    const reach = span(places[4]) + span(places[5]);
    const dx = target.x - shoulder.x;
    const dy = target.y - shoulder.y;
    expect(Math.hypot(place.tip.x - shoulder.x, place.tip.y - shoulder.y)).toBeCloseTo(reach, 6);
    const drift = Math.abs(Math.atan2(dy, dx) - Math.atan2(place.tip.y - shoulder.y, place.tip.x - shoulder.x));
    expect(drift).toBeLessThan(0.002);
    expect([4, 5].every((index) => Math.abs(rigAt(id).bones[index].twist) <= 180)).toBe(true);
  });

  test("a joint with no length follows the bone that carries it", async () => {
    const { id, sceneId, layerId } = await opened();
    const before = rigAt(id);
    await docReachFigure(id, sceneId, layerId, 0, 0, 3, { x: 260, y: 268 });
    const after = rigAt(id);
    const place = figurePlaces(after)[3];
    expect(after.bones[3].twist).toBe(before.bones[3].twist);
    expect(after.bones[2].twist).not.toBe(before.bones[2].twist);
    expect(near(place.base.x, 208, 0.01)).toBe(true);
    expect(near(place.base.y, 268, 0.01)).toBe(true);
    expect(span(figurePlaces(after)[2])).toBeCloseTo(span(figurePlaces(before)[2]), 9);
  });

  test("reaching a leg turns the hip too and undoes as one step", async () => {
    const { id, sceneId, layerId } = await opened();
    const before = JSON.stringify(rigAt(id).bones);
    const start = rigAt(id);
    const places = figurePlaces(rigAt(id));
    await docReachFigure(id, sceneId, layerId, 0, 0, 7, {
      x: places[6].base.x - 50,
      y: places[6].base.y + 70
    });
    const reached = figurePlaces(rigAt(id));
    const goal = { x: places[6].base.x - 50, y: places[6].base.y + 70 };
    expect(Math.hypot(reached[7].tip.x - goal.x, reached[7].tip.y - goal.y)).toBeLessThan(0.01);
    expect(reached.every((place, index) => near(span(place), span(places[index]), 1e-9))).toBe(true);
    expect(rigAt(id).bones[6].twist).not.toBe(start.bones[6].twist);
    expect(rigAt(id).bones[7].twist).not.toBe(start.bones[7].twist);
    expect(rigAt(id).bones[0].twist).toBe(start.bones[0].twist);
    await docUndo(id);
    expect(JSON.stringify(rigAt(id).bones)).toBe(before);
    await docRedo(id);
    expect(JSON.stringify(rigAt(id).bones)).not.toBe(before);
  });

  test("posing on a tweened frame materializes the held key", async () => {
    const { id, sceneId, layerId } = await opened();
    await docKeyframe(id, sceneId, layerId, 4, false);
    await docSetTween(id, sceneId, layerId, 0, true);
    const layer = current(id).scenes[0].layers[0];
    expect(layer.keys.map((key) => key.frame)).toEqual([0, 4]);
    expect(listed(id, 4)).toHaveLength(1);
    const places = figurePlaces(rigAt(id));
    await docPoseFigure(id, sceneId, layerId, 2, 0, 1, {
      x: places[1].base.x + 30,
      y: places[1].base.y - 30
    });
    const keys = current(id).scenes[0].layers[0].keys;
    expect(keys.map((key) => key.frame)).toEqual([0, 2, 4]);
    expect(current(id).scenes[0].layers[0].length).toBe(5);
    expect(rigOf(keys[0].shapes[0]).bones[1].twist).toBe(-90);
    expect(keys[0].tween).toBe(true);
    expect(keys[1].tween).toBe(false);
    expect(rigOf(keys[1].shapes[0]).bones[1].twist).not.toBe(-90);
    expect(rigOf(keys[2].shapes[0]).bones[1].twist).toBe(-90);
    expect(span(figurePlaces(rigOf(keys[1].shapes[0]))[1])).toBeCloseTo(52, 6);
  });

  test("attaches artwork into a turned bone and detaches it back on the stage", async () => {
    const { id, sceneId, layerId } = await opened([rect(300, 100, 20, 10), rect(340, 200, 12, 12)]);
    const places = figurePlaces(rigAt(id));
    await docPoseFigure(id, sceneId, layerId, 0, 0, 4, {
      x: places[4].base.x + 40,
      y: places[4].base.y - 40
    });
    await docAttachArt(id, sceneId, layerId, 0, 0, 4, [2, 1, 1]);
    const art = rigAt(id).bones[4].art;
    expect(listed(id)).toHaveLength(1);
    expect(art).toHaveLength(2);
    expect(art[0].kind).toBe("Path");
    expect(boxIs(shapeBounds(art[0]), [300, 100, 20, 10])).toBe(false);
    await docDetachArt(id, sceneId, layerId, 0, 0, 4);
    const back = listed(id);
    expect(back).toHaveLength(3);
    expect(rigAt(id).bones[4].art).toEqual([]);
    const first: Array<[number, number]> = [
      [300, 100],
      [320, 100],
      [320, 110],
      [300, 110]
    ];
    const second: Array<[number, number]> = [
      [340, 200],
      [352, 200],
      [352, 212],
      [340, 212]
    ];
    expect(ringIs(back[1], first)).toBe(true);
    expect(ringIs(back[2], second)).toBe(true);
  });

  test("shifts the figure index when the attached shapes sit before it", async () => {
    installBackend("figure");
    const fresh = await docNew("Figures", 800, 600, 24, "#ffffff");
    const sceneId = fresh.scenes[0].id;
    const layerId = fresh.scenes[0].layers[0].id;
    await docDraw(fresh.id, sceneId, layerId, 0, rect(40, 50, 10, 10));
    await docAddFigure(fresh.id, sceneId, layerId, 0, 200, 320, 200);
    await docAttachArt(fresh.id, sceneId, layerId, 0, 1, 0, [0]);
    expect(listed(fresh.id).map((shape) => shape.kind)).toEqual(["Figure"]);
    const art = rigAt(fresh.id).bones[0].art;
    expect(art).toHaveLength(1);
    expect(art[0].kind).toBe("Rect");
    expect(boxIs(shapeBounds(art[0]), [-160, -270, 10, 10])).toBe(true);
    await docDetachArt(fresh.id, sceneId, layerId, 0, 0, 0);
    expect(listed(fresh.id).map((shape) => shape.kind)).toEqual(["Figure", "Rect"]);
    expect(boxIs(shapeBounds(listed(fresh.id)[1]), [40, 50, 10, 10])).toBe(true);
  });

  test("refuses a locked layer for every figure operation", async () => {
    const { id, sceneId, layerId } = await opened([rect(0, 0, 10, 10)]);
    await docSetLayer(id, sceneId, layerId, { locked: true });
    const before = JSON.stringify(listed(id));
    const steps = store.get(id)?.undo.length ?? 0;
    const places = figurePlaces(rigAt(id));
    await expect(docAddFigure(id, sceneId, layerId, 0, 100, 100, 100)).rejects.toThrow(
      "layer is locked"
    );
    await expect(
      docPoseFigure(id, sceneId, layerId, 0, 0, 1, { x: places[1].base.x + 10, y: places[1].base.y })
    ).rejects.toThrow("layer is locked");
    await expect(docAttachArt(id, sceneId, layerId, 0, 0, 1, [1])).rejects.toThrow(
      "layer is locked"
    );
    await expect(docDetachArt(id, sceneId, layerId, 0, 0, 3)).rejects.toThrow("layer is locked");
    await expect(
      docReachFigure(id, sceneId, layerId, 0, 0, 5, { x: places[5].base.x + 10, y: places[5].base.y })
    ).rejects.toThrow("layer is locked");
    expect(JSON.stringify(listed(id))).toBe(before);
    expect(store.get(id)?.undo.length ?? 0).toBe(steps);
  });

  test("refuses bad figure operations with the engine messages", async () => {
    const { id, sceneId, layerId } = await opened([rect(0, 0, 10, 10)]);
    const places = figurePlaces(rigAt(id));
    await expect(docAttachArt(id, sceneId, layerId, 0, 0, 4, [])).rejects.toThrow(
      "no shapes selected"
    );
    await expect(docAttachArt(id, sceneId, layerId, 0, 0, 4, [0])).rejects.toThrow("unknown shape");
    await expect(docAttachArt(id, sceneId, layerId, 0, 0, 4, [7])).rejects.toThrow("unknown shape");
    await expect(docAttachArt(id, sceneId, layerId, 0, 9, 4, [1])).rejects.toThrow("unknown shape");
    await expect(docAttachArt(id, sceneId, layerId, 0, 1, 4, [0])).rejects.toThrow(
      "shape is not a figure"
    );
    await expect(docAttachArt(id, sceneId, layerId, 0, 0, 30, [1])).rejects.toThrow("no such bone");
    await expect(docPoseFigure(id, sceneId, layerId, 0, 1, 0, { x: 1, y: 1 })).rejects.toThrow(
      "shape is not a figure"
    );
    await expect(docPoseFigure(id, sceneId, layerId, 0, 9, 0, { x: 1, y: 1 })).rejects.toThrow(
      "unknown shape"
    );
    await expect(docPoseFigure(id, sceneId, layerId, 0, 0, 30, { x: 1, y: 1 })).rejects.toThrow(
      "no such bone"
    );
    await expect(docPoseFigure(id, sceneId, layerId, 0, 0, 4, places[4].base)).rejects.toThrow(
      "the pointer is on the joint"
    );
    await expect(docReachFigure(id, sceneId, layerId, 0, 9, 0, { x: 1, y: 1 })).rejects.toThrow(
      "unknown shape"
    );
    await expect(docReachFigure(id, sceneId, layerId, 0, 1, 0, { x: 1, y: 1 })).rejects.toThrow(
      "shape is not a figure"
    );
    await expect(docReachFigure(id, sceneId, layerId, 0, 0, 30, { x: 1, y: 1 })).rejects.toThrow(
      "no such bone"
    );
    await expect(docDetachArt(id, sceneId, layerId, 0, 0, 5)).rejects.toThrow(
      "that bone carries no artwork"
    );
    await expect(docDetachArt(id, sceneId, layerId, 0, 0, 30)).rejects.toThrow("no such bone");
    await expect(docDetachArt(id, sceneId, layerId, 0, 1, 0)).rejects.toThrow(
      "shape is not a figure"
    );
    expect(listed(id)).toHaveLength(2);
  });

  test("undoes a pose back to the previous one and redoes it", async () => {
    const { id, sceneId, layerId } = await opened();
    const before = JSON.stringify(rigAt(id).bones);
    const places = figurePlaces(rigAt(id));
    await docPoseFigure(id, sceneId, layerId, 0, 0, 6, {
      x: places[6].base.x - 40,
      y: places[6].base.y + 40
    });
    const posed = JSON.stringify(rigAt(id).bones);
    expect(posed).not.toBe(before);
    await docUndo(id);
    expect(JSON.stringify(rigAt(id).bones)).toBe(before);
    await docRedo(id);
    expect(JSON.stringify(rigAt(id).bones)).toBe(posed);
  });
});
