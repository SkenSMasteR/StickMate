import { describe, expect, test } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import App from "@/App";
import en from "@/i18n/en.json";
import {
  docDraw,
  docEvaluate,
  docKeyframe,
  docNew,
  docPaintShape,
  docReplaceShape,
  docSetTween,
  docTransformShapes,
  gradientBox,
  gradientGeometry,
  shapeGradient
} from "@/lib/document";
import type { Document, Gradient, Shape } from "@/lib/document";
import { installBackend, store } from "./backend";
import { drag, flush, getCanvas, press } from "./utils";

function state(id: string) {
  const found = store.get(id);
  if (!found) {
    throw new Error("document is not in the store");
  }
  return found;
}

function slots(id: string) {
  const doc = state(id).doc;
  return {
    scene: doc.scenes[0].id,
    layer: doc.scenes[0].layers[0].id,
    shapes: (frame: number) =>
      state(id).doc.scenes[0].layers[0].keys.find((key) => key.frame === frame)!.shapes
  };
}

function linear(angle: number, stops: Array<[number, string]>): Gradient {
  return { kind: "linear", angle, stops: stops.map(([offset, color]) => ({ offset, color })) };
}

function radial(stops: Array<[number, string]>): Gradient {
  return { kind: "radial", stops: stops.map(([offset, color]) => ({ offset, color })) };
}

function rect(gradient: Gradient | null = null): Extract<Shape, { kind: "Rect" }> {
  return {
    kind: "Rect",
    x: 100,
    y: 120,
    w: 40,
    h: 30,
    fill: "#3b82f6",
    stroke: "#000000",
    width: 2,
    gradient
  };
}

function gradient(shape: Shape): Gradient {
  const found = shapeGradient(shape);
  if (!found) {
    throw new Error("shape has no gradient");
  }
  return found;
}

function angleOf(shape: Shape): number {
  const found = gradient(shape);
  if (found.kind !== "linear") {
    throw new Error("gradient is not linear");
  }
  return found.angle;
}

async function tap(button: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(button);
  });
  await flush();
}

function shapePanel(): HTMLElement {
  const section = screen
    .getByRole("heading", { name: en["editor.shape"] })
    .closest("section");
  if (!section) {
    throw new Error("the shape section is not mounted");
  }
  return section as HTMLElement;
}

function button(label: string): HTMLButtonElement {
  return within(shapePanel()).getByRole("button", { name: label }) as HTMLButtonElement;
}

function inputs(label: string): HTMLInputElement[] {
  return within(shapePanel()).getAllByRole("spinbutton", { name: label }) as HTMLInputElement[];
}

async function write(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
  await act(async () => {
    fireEvent.blur(input);
  });
  await flush();
}

async function openWith(shape: Extract<Shape, { kind: "Rect" }>): Promise<Document> {
  installBackend("editor");
  const doc = await docNew("Test", 800, 600, 24, "#ffffff");
  const { scene, layer } = slots(doc.id);
  await docDraw(doc.id, scene, layer, 0, shape);
  render(<App />);
  await act(async () => {
    await emit("editor-open", doc.id);
  });
  await waitFor(() => getCanvas());
  await flush();
  await press("v");
  await drag(getCanvas(), [
    [5, 5],
    [780, 580]
  ]);
  return doc;
}

describe("gradient engine", () => {
  test("keeps a gradient through draw and replace", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer, shapes } = slots(doc.id);
    await docDraw(doc.id, scene, layer, 0, rect(linear(45, [[0, "#ff0000"], [1, "#000000"]])));
    expect(gradient(shapes(0)[0])).toEqual(linear(45, [[0, "#ff0000"], [1, "#000000"]]));
    await docReplaceShape(doc.id, scene, layer, 0, 0, rect(radial([[0, "#ffffff"], [1, "#111827"]])));
    expect(gradient(shapes(0)[0])).toEqual(radial([[0, "#ffffff"], [1, "#111827"]]));
  });

  test("rejects malformed gradients without changing the document", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    await docDraw(doc.id, scene, layer, 0, rect(linear(0, [[0, "#ff0000"], [1, "#000000"]])));
    const before = JSON.stringify(state(doc.id).doc);
    const replace = (next: Gradient) => docReplaceShape(doc.id, scene, layer, 0, 0, rect(next));
    await expect(replace(linear(0, [[0, "#ff0000"]]))).rejects.toThrow(
      "gradient needs at least 2 stops"
    );
    const many = Array.from({ length: 33 }, (_, index): [number, string] => [
      index / 32,
      "#ff0000"
    ]);
    await expect(replace(linear(0, many))).rejects.toThrow("gradient has too many stops");
    await expect(replace(linear(0, [[0, "#ff0000"], [1.5, "#000000"]]))).rejects.toThrow(
      "gradient stop offset must be between 0 and 1"
    );
    await expect(replace(linear(0, [[0.8, "#ff0000"], [0.2, "#000000"]]))).rejects.toThrow(
      "gradient stops must be in order"
    );
    await expect(
      replace(linear(0, [[0, "#ff0000"], [1, `#${"0".repeat(1025)}`]]))
    ).rejects.toThrow("gradient stop color is too long");
    await expect(replace(linear(Number.POSITIVE_INFINITY, [[0, "#ff0000"], [1, "#000000"]]))).rejects.toThrow(
      "gradient angle must be finite"
    );
    expect(JSON.stringify(state(doc.id).doc)).toBe(before);
  });

  test("painting over a gradient leaves a solid fill", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer, shapes } = slots(doc.id);
    await docDraw(doc.id, scene, layer, 0, rect(linear(0, [[0, "#ff0000"], [1, "#000000"]])));
    await docPaintShape(doc.id, scene, layer, 0, 0, "#22c55e");
    expect(shapes(0)[0]).toMatchObject({ kind: "Rect", fill: "#22c55e", gradient: null });
    expect(shapeGradient(shapes(0)[0])).toBeNull();
  });

  test("tweens blend matching gradients on every frame", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    await docDraw(doc.id, scene, layer, 0, rect(linear(0, [[0, "#ff0000"], [1, "#000000"]])));
    await docKeyframe(doc.id, scene, layer, 2, true);
    await docDraw(
      doc.id,
      scene,
      layer,
      2,
      rect(linear(90, [[0.25, "#0000ff"], [1, "#ffffff"]]))
    );
    await docSetTween(doc.id, scene, layer, 0, true);
    const frames = await docEvaluate(doc.id, scene, 0, 2);
    expect(gradient(frames[0].layers[0].shapes[0])).toEqual(linear(0, [[0, "#ff0000"], [1, "#000000"]]));
    expect(gradient(frames[1].layers[0].shapes[0])).toEqual(
      linear(45, [[0.125, "#800080"], [1, "#808080"]])
    );
    expect(gradient(frames[2].layers[0].shapes[0])).toEqual(
      linear(90, [[0.25, "#0000ff"], [1, "#ffffff"]])
    );
  });

  test("holds the start gradient when the endpoints do not line up", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    const start = linear(0, [[0, "#ff0000"], [1, "#000000"]]);
    await docDraw(doc.id, scene, layer, 0, rect(start));
    await docKeyframe(doc.id, scene, layer, 2, true);
    await docDraw(doc.id, scene, layer, 2, rect(radial([[0, "#ffffff"], [1, "#111827"]])));
    await docSetTween(doc.id, scene, layer, 0, true);
    const frames = await docEvaluate(doc.id, scene, 0, 2);
    expect(gradient(frames[1].layers[0].shapes[0])).toEqual(start);
    await docReplaceShape(
      doc.id,
      scene,
      layer,
      2,
      0,
      rect(linear(0, [[0, "#ff0000"], [0.5, "#ffffff"], [1, "#000000"]]))
    );
    const blended = await docEvaluate(doc.id, scene, 1, 1);
    expect(gradient(blended[0].layers[0].shapes[0])).toEqual(start);
    expect(shapeGradient(frames[2].layers[0].shapes[0])).toEqual(
      radial([[0, "#ffffff"], [1, "#111827"]])
    );
  });

  test("rotation turns the gradient with the shape", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer, shapes } = slots(doc.id);
    const start = linear(45, [[0, "#ff0000"], [1, "#000000"]]);
    await docDraw(doc.id, scene, layer, 0, rect(start));
    await docTransformShapes(
      doc.id,
      scene,
      layer,
      0,
      [0],
      { x: 120, y: 135 },
      0,
      0,
      1,
      1,
      90
    );
    expect(shapes(0)[0].kind).toBe("Path");
    expect(gradient(shapes(0)[0])).toEqual(linear(135, [[0, "#ff0000"], [1, "#000000"]]));
  });
});

describe("gradient UI", () => {
  test("switching to linear seeds the stops and paints through an svg gradient", async () => {
    const doc = await openWith(rect());
    await tap(button(en["editor.linear"]));
    expect(gradient(state(doc.id).doc.scenes[0].layers[0].keys[0].shapes[0])).toEqual(
      linear(0, [[0, "#3b82f6"], [1, "#000000"]])
    );
    const painted = getCanvas().querySelector<Element>('rect[fill^="url("]');
    expect(painted?.getAttribute("fill")).toContain("stickmate-");
    const def = getCanvas().querySelector("linearGradient");
    expect(def?.getAttribute("gradientUnits")).toBe("userSpaceOnUse");
    expect(def?.children).toHaveLength(2);
    await press("z", { ctrlKey: true });
    await waitFor(() => expect(shapeGradient(state(doc.id).doc.scenes[0].layers[0].keys[0].shapes[0])).toBeNull());
  }, 20000);

  test("switching back to solid keeps the first stop as the fill", async () => {
    const start = linear(20, [[0, "#22c55e"], [1, "#000000"]]);
    const doc = await openWith(rect(start));
    expect(getCanvas().querySelector("linearGradient")).toBeTruthy();
    await tap(button(en["editor.solid"]));
    const shape = state(doc.id).doc.scenes[0].layers[0].keys[0].shapes[0];
    expect(shape).toMatchObject({ kind: "Rect", fill: "#22c55e" });
    expect(shapeGradient(shape)).toBeNull();
    expect(getCanvas().querySelector("linearGradient")).toBeNull();
    expect(within(shapePanel()).getByRole("spinbutton", { name: en["editor.x"] })).toBeTruthy();
  }, 20000);

  test("radial keeps the stops and renders a centred radial def", async () => {
    const start = linear(0, [[0, "#ffffff"], [1, "#111827"]]);
    const doc = await openWith(rect(start));
    await tap(button(en["editor.radial"]));
    const shape = state(doc.id).doc.scenes[0].layers[0].keys[0].shapes[0];
    expect(gradient(shape)).toEqual(radial([[0, "#ffffff"], [1, "#111827"]]));
    const def = getCanvas().querySelector("radialGradient");
    const [, , , , r] = gradientGeometry(gradientBox(shape), radial([[0, "#ffffff"], [1, "#111827"]]));
    expect([def?.getAttribute("cx"), def?.getAttribute("cy"), def?.getAttribute("r")]).toEqual([
      "120",
      "135",
      String(r)
    ]);
    expect(getCanvas().querySelector("linearGradient")).toBeNull();
  }, 20000);

  test("stops are added, moved and removed in order", async () => {
    const start = linear(0, [[0, "#ff0000"], [1, "#000000"]]);
    const doc = await openWith(rect(start));
    const stops = () => gradient(state(doc.id).doc.scenes[0].layers[0].keys[0].shapes[0]).stops;
    await tap(button(en["editor.addStop"]));
    expect(stops()).toEqual([
      { offset: 0, color: "#ff0000" },
      { offset: 0.5, color: "#000000" },
      { offset: 1, color: "#000000" }
    ]);
    await write(inputs(en["editor.stopOffset"])[1], "0.9");
    expect(stops().map((stop) => stop.offset)).toEqual([0, 0.9, 1]);
    await write(inputs(en["editor.stopOffset"])[0], "0.95");
    expect(stops().map((stop) => stop.offset)).toEqual([0.9, 0.9, 1]);
    const removes = within(shapePanel()).getAllByRole("button", {
      name: en["editor.removeStop"]
    }) as HTMLButtonElement[];
    await tap(removes[2]);
    expect(stops()).toEqual([
      { offset: 0.9, color: "#ff0000" },
      { offset: 0.9, color: "#000000" }
    ]);
    expect(inputs(en["editor.stopOffset"])).toHaveLength(2);
    const after = within(shapePanel()).getAllByRole("button", {
      name: en["editor.removeStop"]
    }) as HTMLButtonElement[];
    expect(after.every((item) => item.disabled)).toBe(true);
    expect(button(en["editor.addStop"]).disabled).toBe(false);
  }, 20000);

  test("angle and colour edits land on the shape", async () => {
    const start = linear(45, [[0, "#ff0000"], [1, "#00ff00"]]);
    const doc = await openWith(rect(start));
    const shape = () => state(doc.id).doc.scenes[0].layers[0].keys[0].shapes[0];
    await write(inputs(en["editor.gradientAngle"])[0], "120");
    expect(angleOf(shape())).toBe(120);
    const strip = shapePanel().querySelector<HTMLElement>("[style*='linear-gradient']");
    expect(strip?.style.backgroundImage).toBe("linear-gradient(210deg, #ff0000 0%, #00ff00 100%)");
  }, 20000);
});
