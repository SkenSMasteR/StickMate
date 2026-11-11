import { describe, expect, test } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { docSetLayer, figureBounds, figurePlaces, shapeBounds } from "@/lib/document";
import type { Document, Figure, Place, Shape } from "@/lib/document";
import { store } from "./backend";
import { click, drag, flush, getCanvas, press, renderEditor } from "./utils";

const size = 600 * 0.6;

function near(value: number, target: number, tolerance = 0.01): boolean {
  return Math.abs(value - target) < tolerance;
}

function span(place: Place): number {
  return Math.hypot(place.tip.x - place.base.x, place.tip.y - place.base.y);
}

function listed(id: string): Shape[] {
  const found = store.get(id);
  if (!found) {
    throw new Error("document is not in the store");
  }
  return found.doc.scenes[0].layers[0].keys[0].shapes;
}

function steps(id: string): number {
  return store.get(id)?.undo.length ?? 0;
}

function rigOf(shape: Shape): Figure {
  if (shape.kind !== "Figure") {
    throw new Error("figure expected");
  }
  return shape.figure;
}

function rig(id: string): Figure {
  return rigOf(listed(id)[0]);
}

function joint(bone: number): Element {
  const found = getCanvas().querySelector(`[data-figure-joint="${bone}"]`);
  if (!found) {
    throw new Error(`joint is not mounted: ${bone}`);
  }
  return found;
}

function figureBody(): Element {
  const found = getCanvas().querySelector("[data-figure]");
  if (!found) {
    throw new Error("figure is not mounted");
  }
  return found;
}

function button(selector: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(selector);
  if (!found) {
    throw new Error(`button is not mounted: ${selector}`);
  }
  return found;
}

async function pressButton(selector: string): Promise<void> {
  await act(async () => {
    fireEvent.click(button(selector));
  });
  await flush();
}

async function planted(): Promise<Document> {
  const { doc } = await renderEditor();
  await press("f");
  await click(getCanvas(), [300, 300]);
  await waitFor(() => expect(listed(doc.id)).toHaveLength(1));
  await flush();
  return doc;
}

describe("stick figure tool", () => {
  test("plants a humanoid on the clicked point", async () => {
    const doc = await planted();
    expect(listed(doc.id).map((shape) => shape.kind)).toEqual(["Figure"]);
    const figure = rig(doc.id);
    expect(figure.bones).toHaveLength(12);
    expect({ x: figure.x, y: figure.y, rotation: figure.rotation }).toEqual({
      x: 300,
      y: 300,
      rotation: 0
    });
    const places = figurePlaces(figure);
    expect(near(places[1].tip.y, 300 - size * 0.26)).toBe(true);
    const box = figureBounds(figure);
    expect(box === null).toBe(false);
    if (box) {
      expect(near(box.y, 300 - size / 2)).toBe(true);
    }
  });

  test("rings every joint of the selected figure", async () => {
    await planted();
    expect(getCanvas().querySelectorAll("[data-figure-joint]").length).toBe(12);
    expect(document.querySelectorAll("[data-bone-pick]").length).toBe(12);
  });

  test("dragging an elbow turns only that bone and keeps every length", async () => {
    const doc = await planted();
    const figure = rig(doc.id);
    const before = figurePlaces(figure);
    const target = { x: before[4].base.x + 60, y: before[4].base.y - 70 };
    await drag(joint(4), [
      [before[4].tip.x, before[4].tip.y],
      [target.x, target.y]
    ]);
    await waitFor(() => expect(rig(doc.id).bones[4].twist).not.toBe(figure.bones[4].twist));
    const after = figurePlaces(rig(doc.id));
    expect(rig(doc.id).bones.map((bone) => bone.length)).toEqual(
      figure.bones.map((bone) => bone.length)
    );
    expect(after.every((place, index) => near(span(place), span(before[index]), 1e-9))).toBe(true);
    expect(
      figure.bones.every(
        (bone, index) => index === 4 || bone.twist === rig(doc.id).bones[index].twist
      )
    ).toBe(true);
    const dx = target.x - after[4].base.x;
    const dy = target.y - after[4].base.y;
    const cross = (after[4].tip.x - after[4].base.x) * dy - (after[4].tip.y - after[4].base.y) * dx;
    expect(Math.abs(cross)).toBeLessThan(1e-6);
    expect((after[4].tip.x - after[4].base.x) * dx + (after[4].tip.y - after[4].base.y) * dy).toBeGreaterThan(0);
    expect(joint(4).getAttribute("fill")).toBe("#3b82f6");
  });

  test("dragging a wrist reaches the whole arm to the pointer", async () => {
    const doc = await planted();
    const figure = rig(doc.id);
    const before = figurePlaces(figure);
    const stepsBefore = steps(doc.id);
    const target = { x: before[4].base.x + 40, y: before[4].base.y + 40 };
    await drag(joint(5), [
      [before[5].tip.x, before[5].tip.y],
      [target.x, target.y]
    ]);
    await waitFor(() => expect(rig(doc.id).bones[4].twist).not.toBe(figure.bones[4].twist));
    const after = figurePlaces(rig(doc.id));
    expect(Math.hypot(after[5].tip.x - target.x, after[5].tip.y - target.y)).toBeLessThan(0.01);
    expect(after.every((place, index) => near(span(place), span(before[index]), 1e-9))).toBe(true);
    expect(
      figure.bones.every(
        (bone, index) => index === 5 || index === 4 || bone.twist === rig(doc.id).bones[index].twist
      )
    ).toBe(true);
    expect(near(after[4].base.x, before[4].base.x, 1e-9)).toBe(true);
    expect(steps(doc.id)).toBe(stepsBefore + 1);
  });

  test("poses one drag as a single undo step", async () => {
    const doc = await planted();
    const figure = rig(doc.id);
    const before = figurePlaces(figure);
    const stepsBefore = steps(doc.id);
    await drag(joint(6), [
      [before[6].tip.x, before[6].tip.y],
      [before[6].base.x - 40, before[6].base.y + 80]
    ]);
    await waitFor(() => expect(steps(doc.id)).toBe(stepsBefore + 1));
    await press("z", { ctrlKey: true });
    await waitFor(() => expect(JSON.stringify(rig(doc.id))).toBe(JSON.stringify(figure)));
  });

  test("arms the bone picked in the side panel and the joint clicked on canvas", async () => {
    const doc = await planted();
    await pressButton('[data-bone-pick="9"]');
    await waitFor(() => expect(joint(9).getAttribute("fill")).toBe("#3b82f6"));
    expect(joint(0).getAttribute("fill")).toBe("#ffffff");
    const places = figurePlaces(rig(doc.id));
    await click(figureBody(), [places[5].tip.x, places[5].tip.y]);
    await waitFor(() => expect(joint(5).getAttribute("fill")).toBe("#3b82f6"));
    expect(listed(doc.id)).toHaveLength(1);
  });

  test("attaches the selection to the armed bone and detaches it back", async () => {
    const doc = await planted();
    expect(button("[data-attach-art]").disabled).toBe(true);
    await pressButton('[data-bone-pick="0"]');
    await press("r");
    await drag(getCanvas(), [
      [500, 480],
      [560, 520]
    ]);
    await waitFor(() => expect(listed(doc.id)).toHaveLength(2));
    await press("v");
    await drag(getCanvas(), [
      [5, 5],
      [780, 580]
    ]);
    await waitFor(() => expect(button("[data-attach-art]").disabled).toBe(false));
    await pressButton("[data-attach-art]");
    await waitFor(() => expect(listed(doc.id)).toHaveLength(1));
    const art = rig(doc.id).bones[0].art;
    expect(art).toHaveLength(1);
    expect(art[0].kind).toBe("Rect");
    await pressButton("[data-detach-art]");
    await waitFor(() => expect(listed(doc.id)).toHaveLength(2));
    expect(rig(doc.id).bones[0].art).toEqual([]);
    const back = shapeBounds(listed(doc.id)[1]);
    expect(near(back.x, 500) && near(back.y, 480)).toBe(true);
    expect(near(back.w, 60) && near(back.h, 40)).toBe(true);
  });

  test("refuses to draw on a locked layer", async () => {
    const { doc } = await renderEditor();
    const scene = doc.scenes[0];
    await docSetLayer(doc.id, scene.id, scene.layers[0].id, { locked: true });
    await flush();
    const stepsBefore = steps(doc.id);
    await press("f");
    await click(getCanvas(), [300, 300]);
    await flush();
    expect(listed(doc.id)).toHaveLength(0);
    expect(steps(doc.id)).toBe(stepsBefore);
  });
});
