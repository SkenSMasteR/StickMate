import { describe, expect, test } from "vitest";
import {
  docAddFigure,
  docAttachArt,
  docDetachArt,
  docDraw,
  docEvaluate,
  docKeyframe,
  docNew,
  docErase,
  docSetKeyframes,
  docSetTransform,
  docSetTween,
  docTransformShapes,
  docUndo,
  shapeBounds
} from "@/lib/document";
import type { Affine, Bounds, Document, Figure, Shape } from "@/lib/document";
import { docHistory } from "@/lib/history";
import { docCopyShapes, docPasteShapes } from "@/lib/shapes";
import { installBackend, store } from "./backend";

const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

function near(value: number, target: number, tolerance = 0.01): boolean {
  return Math.abs(value - target) < tolerance;
}

function boxIs(box: Bounds, target: [number, number, number, number]): boolean {
  return (
    near(box.x, target[0], 1e-6) &&
    near(box.y, target[1], 1e-6) &&
    near(box.w, target[2], 1e-6) &&
    near(box.h, target[3], 1e-6)
  );
}

function picture(
  x: number,
  y: number,
  w = 40,
  h = 20
): Extract<Shape, { kind: "Bitmap" }> {
  return { kind: "Bitmap", x, y, w, h, source: IMAGE };
}

function image(x: number, y: number): Extract<Shape, { kind: "Bitmap" }> {
  return picture(x, y, 40, 20);
}

function tilted(
  shape: Extract<Shape, { kind: "Bitmap" }>,
  matrix: Affine
): Shape {
  return { ...shape, matrix };
}

function bitmapOf(shape: Shape): Extract<Shape, { kind: "Bitmap" }> {
  if (shape.kind !== "Bitmap") {
    throw new Error("bitmap expected");
  }
  return shape;
}

function rigOf(shape: Shape): Figure {
  if (shape.kind !== "Figure") {
    throw new Error("figure expected");
  }
  return shape.figure;
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

async function opened(): Promise<{ id: string; sceneId: string; layerId: string }> {
  installBackend("bitmap");
  const fresh = await docNew("Bitmaps", 800, 600, 24, "#ffffff");
  return {
    id: fresh.id,
    sceneId: fresh.scenes[0].id,
    layerId: fresh.scenes[0].layers[0].id
  };
}

describe("bitmap backend commands", () => {
  test("a placed image is a shape with its own history step", async () => {
    const { id, sceneId, layerId } = await opened();
    await docDraw(id, sceneId, layerId, 0, image(100, 50));
    expect(listed(id)).toHaveLength(1);
    expect(boxIs(shapeBounds(listed(id)[0]), [100, 50, 40, 20])).toBe(true);
    expect(bitmapOf(listed(id)[0]).source).toBe(IMAGE);
    const steps = await docHistory(id);
    expect(steps[steps.length - 1].name).toBe("draw_bitmap");
    await docUndo(id);
    expect(listed(id)).toHaveLength(0);
  });

  test("a numbered run of images lands on its own keyframes", async () => {
    const { id, sceneId, layerId } = await opened();
    await docSetKeyframes(id, sceneId, layerId, 0, [
      [image(0, 0)],
      [image(40, 0)],
      [image(80, 0)]
    ]);
    expect(listed(id, 0)).toHaveLength(1);
    expect(
      current(id).scenes[0].layers[0].keys.map((key) => key.frame)
    ).toEqual([0, 1, 2]);
    expect(boxIs(shapeBounds(listed(id, 2)[0]), [80, 0, 40, 20])).toBe(true);
    const steps = await docHistory(id);
    expect(steps).toHaveLength(2);
    expect(steps[steps.length - 1].name).toBe("place_image_sequence");
    await docUndo(id);
    expect(current(id).scenes[0].layers[0].keys).toHaveLength(1);
  });

  test("draw refuses an image it cannot place", async () => {
    const { id, sceneId, layerId } = await opened();
    const before = (await docHistory(id)).length;
    for (const source of [
      "https://example.com/a.png",
      "data:image/bmp;base64,QQ==",
      "data:image/png;base64,",
      `data:image/png;base64,${"A".repeat(8_388_600)}`
    ]) {
      await expect(
        docDraw(id, sceneId, layerId, 0, { ...picture(0, 0, 40, 20), source })
      ).rejects.toThrow("bitmap must be an embedded png, jpeg, gif or svg");
    }
    for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 20_000]) {
      await expect(
        docDraw(id, sceneId, layerId, 0, picture(0, 0, size, 20))
      ).rejects.toThrow("bitmap size must be between 1 and 16384");
      await expect(
        docDraw(id, sceneId, layerId, 0, picture(0, 0, 40, size))
      ).rejects.toThrow("bitmap size must be between 1 and 16384");
    }
    for (let index = 0; index < 6; index += 1) {
      for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const values = [1, 0, 0, 1, 0, 0];
        values[index] = invalid;
        const matrix: Affine = {
          a: values[0],
          b: values[1],
          c: values[2],
          d: values[3],
          e: values[4],
          f: values[5]
        };
        await expect(
          docDraw(id, sceneId, layerId, 0, tilted(picture(0, 0, 40, 20), matrix))
        ).rejects.toThrow("bitmap matrix must be finite");
      }
    }
    expect(listed(id)).toHaveLength(0);
    expect((await docHistory(id)).length).toBe(before);
  });

  test("an image grows with its box and folds a stretch", async () => {
    const { id, sceneId, layerId } = await opened();
    await docDraw(id, sceneId, layerId, 0, image(100, 50));
    await docTransformShapes(id, sceneId, layerId, 0, [0], { x: 0, y: 0 }, 10, 5, 2, 2, 0);
    const grown = bitmapOf(listed(id)[0]);
    expect(boxIs(shapeBounds(grown), [210, 105, 80, 40])).toBe(true);
    expect("matrix" in grown).toBe(false);
    await docTransformShapes(id, sceneId, layerId, 0, [0], { x: 0, y: 0 }, 0, 0, 3, 1, 0);
    const stretched = bitmapOf(listed(id)[0]);
    expect([stretched.x, stretched.y, stretched.w, stretched.h]).toEqual([210, 105, 80, 40]);
    const matrix = stretched.matrix;
    expect(matrix).not.toBeNull();
    if (matrix) {
      expect(near(matrix.a, 3, 1e-9)).toBe(true);
      expect(near(matrix.d, 1, 1e-9)).toBe(true);
    }
    expect(boxIs(shapeBounds(stretched), [630, 105, 240, 40])).toBe(true);
    await docUndo(id);
    expect(boxIs(shapeBounds(bitmapOf(listed(id)[0])), [210, 105, 80, 40])).toBe(true);
    expect("matrix" in listed(id)[0]).toBe(false);
  });

  test("a turned image keeps its picture and gains a matrix", async () => {
    const { id, sceneId, layerId } = await opened();
    await docDraw(id, sceneId, layerId, 0, image(100, 50));
    await docTransformShapes(id, sceneId, layerId, 0, [0], { x: 120, y: 60 }, 0, 0, 1, 1, 90);
    const turned = bitmapOf(listed(id)[0]);
    expect([turned.x, turned.y, turned.w, turned.h]).toEqual([100, 50, 40, 20]);
    expect(turned.source).toBe(IMAGE);
    const matrix = turned.matrix;
    expect(matrix).not.toBeNull();
    if (matrix) {
      expect(near(matrix.a, 0, 1e-9)).toBe(true);
      expect(near(matrix.b, 1, 1e-9)).toBe(true);
      expect(near(matrix.c, -1, 1e-9)).toBe(true);
      expect(near(matrix.d, 0, 1e-9)).toBe(true);
    }
    expect(boxIs(shapeBounds(turned), [110, 40, 20, 40])).toBe(true);
  });

  test("an image is pickable inside its turned corners", async () => {
    const { id, sceneId, layerId } = await opened();
    await docDraw(id, sceneId, layerId, 0, image(100, 50));
    await docTransformShapes(id, sceneId, layerId, 0, [0], { x: 120, y: 60 }, 0, 0, 1, 1, 90);
    await docErase(id, sceneId, layerId, 0, [{ x: 120, y: 20 }], 1);
    expect(listed(id)).toHaveLength(1);
    await docErase(id, sceneId, layerId, 0, [{ x: 120, y: 60 }], 1);
    expect(listed(id)).toHaveLength(0);
  });

  test("a tweened image moves with the timeline", async () => {
    const { id, sceneId, layerId } = await opened();
    await docDraw(id, sceneId, layerId, 0, image(100, 100));
    await docKeyframe(id, sceneId, layerId, 2, true);
    await docDraw(id, sceneId, layerId, 2, image(300, 100));
    await docSetTween(id, sceneId, layerId, 0, true);
    const frames = await docEvaluate(id, sceneId, 0, 2);
    expect(frames[0].layers[0].shapes[0]).toMatchObject({ x: 100, source: IMAGE });
    expect(frames[1].layers[0].shapes[0]).toMatchObject({ x: 200, source: IMAGE });
    expect(frames[2].layers[0].shapes[0]).toMatchObject({ x: 300, source: IMAGE });
  });

  test("an image rides a bone and returns to the stage", async () => {
    const { id, sceneId, layerId } = await opened();
    await docAddFigure(id, sceneId, layerId, 0, 200, 320, 200);
    await docDraw(id, sceneId, layerId, 0, image(190, 250));
    await docAttachArt(id, sceneId, layerId, 0, 0, 0, [1]);
    const art = rigOf(listed(id)[0]).bones[0].art;
    expect(art).toHaveLength(1);
    expect(boxIs(shapeBounds(art[0]), [-10, -70, 40, 20])).toBe(true);
    await docTransformShapes(id, sceneId, layerId, 0, [0], { x: 200, y: 320 }, 0, 0, 2, 2, 0);
    const grown = rigOf(listed(id)[0]).bones[0].art;
    expect(boxIs(shapeBounds(grown[0]), [-20, -140, 80, 40])).toBe(true);
    await docDetachArt(id, sceneId, layerId, 0, 0, 0);
    const back = listed(id);
    expect(back).toHaveLength(2);
    expect(boxIs(shapeBounds(back[1]), [180, 180, 80, 40])).toBe(true);
  });

  test("an image serializes its matrix only when it has one", () => {
    const flat = JSON.parse(JSON.stringify(picture(0, 0, 40, 20)));
    expect(flat.kind).toBe("Bitmap");
    expect("matrix" in flat).toBe(false);
    const turned = JSON.parse(
      JSON.stringify(tilted(picture(0, 0, 40, 20), { a: 1, b: 0.5, c: -0.5, d: 1, e: 12, f: -3 }))
    );
    expect("matrix" in turned).toBe(true);
    expect(turned.matrix.e).toBe(12);
  });

  test("a pasted image keeps its picture and scales its box", async () => {
    const { id, sceneId, layerId } = await opened();
    await docDraw(id, sceneId, layerId, 0, picture(100, 0, 40, 20));
    const clip = await docCopyShapes(id, sceneId, layerId, 0, [0]);
    const other = await docNew("Other", 800, 600, 24, "#ffffff");
    const otherScene = other.scenes[0].id;
    const otherLayer = other.scenes[0].layers[0].id;
    await docSetTransform(other.id, otherScene, otherLayer, 0, {
      x: 0,
      y: 0,
      rotation: 0,
      scale: 2,
      opacity: 1
    });
    await docPasteShapes(other.id, otherScene, otherLayer, 0, clip);
    const pasted = listed(other.id);
    expect(pasted).toHaveLength(1);
    expect(boxIs(shapeBounds(pasted[0]), [50, 0, 20, 10])).toBe(true);
    expect(bitmapOf(pasted[0]).source).toBe(IMAGE);
  });

  test("paste refuses an image it cannot draw", async () => {
    const { id, sceneId, layerId } = await opened();
    await expect(
      docPasteShapes(id, sceneId, layerId, 0, {
        shapes: [
          { kind: "Bitmap", x: 0, y: 0, w: 40, h: 20, source: "https://example.com/a.png" }
        ],
        transform: { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 }
      })
    ).rejects.toThrow("invalid clipboard shape");
    expect(listed(id)).toHaveLength(0);
  });
});
