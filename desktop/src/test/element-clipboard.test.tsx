import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import en from "@/i18n/en.json";
import { docAddLayer, docNew, docSetTransform } from "@/lib/document";
import type { Document, Shape } from "@/lib/document";
import { emit } from "@tauri-apps/api/event";
import { store } from "./backend";
import { click, drag, flush, getCanvas, press, renderEditor } from "./utils";

function shapesOf(id: string, layer: number): Shape[] {
  return store.get(id)!.doc.scenes[0].layers[layer].keys[0].shapes;
}

function layersPanel(): HTMLElement {
  const section = screen
    .getByRole("heading", { name: en["editor.layers"] })
    .closest("section");
  if (!section) {
    throw new Error("layers panel is not mounted");
  }
  return section as HTMLElement;
}

async function selectRect(): Promise<Document> {
  const { doc } = await renderEditor();
  await press("r");
  await drag(getCanvas(), [
    [100, 100],
    [200, 200]
  ]);
  await press("v");
  await click(getCanvas().querySelector('rect[fill="#3b82f6"]')!, [150, 150]);
  return doc;
}

async function pickLayer(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(within(layersPanel()).getByRole("button", { name }));
  });
  await flush();
}

async function lockLayer(): Promise<void> {
  await act(async () => {
    const [button] = screen.getAllByRole("button", { name: en["editor.lockLayer"] });
    fireEvent.click(button);
  });
  await flush();
}

describe("element clipboard", () => {
  test("pastes the copy in place and selects only the new shapes", async () => {
    const doc = await selectRect();
    await press("c", { ctrlKey: true });
    await press("v", { ctrlKey: true });
    expect(shapesOf(doc.id, 0)).toHaveLength(2);
    expect(shapesOf(doc.id, 0)[1]).toMatchObject({ x: 100, y: 100, w: 100, h: 100 });
    await press("ArrowRight");
    expect(shapesOf(doc.id, 0)[1]).toMatchObject({ x: 101 });
    expect(shapesOf(doc.id, 0)[0]).toMatchObject({ x: 100 });
    await press("z", { ctrlKey: true });
    expect(shapesOf(doc.id, 0)).toHaveLength(2);
    expect(shapesOf(doc.id, 0)[1]).toMatchObject({ x: 100 });
    await press("z", { ctrlKey: true });
    expect(shapesOf(doc.id, 0)).toHaveLength(1);
  });

  test("copies every shape of a marquee selection", async () => {
    const doc = await selectRect();
    await press("r");
    await drag(getCanvas(), [
      [300, 100],
      [400, 200]
    ]);
    await press("v");
    await drag(getCanvas(), [
      [50, 50],
      [500, 300]
    ]);
    await press("c", { ctrlKey: true });
    await press("v", { ctrlKey: true });
    expect(shapesOf(doc.id, 0)).toHaveLength(4);
    expect(shapesOf(doc.id, 0)[3]).toMatchObject({ x: 300, y: 100 });
  });

  test("pastes onto another layer at the same canvas place", async () => {
    const doc = await selectRect();
    await press("c", { ctrlKey: true });
    const withBackdrop = await docAddLayer(doc.id, doc.scenes[0].id, "Backdrop");
    const backdrop = withBackdrop.scenes[0].layers[0];
    await docSetTransform(doc.id, doc.scenes[0].id, backdrop.id, 0, {
      x: 120,
      y: 60,
      rotation: 0,
      scale: 1,
      opacity: 1
    });
    await act(async () => {
      await emit("editor-open", doc.id);
    });
    await flush();
    await pickLayer("Backdrop");
    await press("v", { ctrlKey: true });
    expect(shapesOf(doc.id, 0)[0]).toMatchObject({ x: -20, y: 40 });
    expect(shapesOf(doc.id, 1)).toHaveLength(1);
  });

  test("keeps the clipboard across project tabs", async () => {
    const first = await selectRect();
    await press("c", { ctrlKey: true });
    const second = await docNew("Other", 800, 600, 24, "#ffffff");
    await act(async () => {
      await emit("editor-open", second.id);
    });
    await flush();
    await press("v", { ctrlKey: true });
    expect(shapesOf(second.id, 0)).toHaveLength(1);
    expect(shapesOf(second.id, 0)[0]).toMatchObject({ x: 100, y: 100 });
    expect(shapesOf(first.id, 0)).toHaveLength(1);
    await act(async () => {
      await emit("editor-open", first.id);
    });
    await flush();
    await press("v", { ctrlKey: true });
    expect(shapesOf(first.id, 0)).toHaveLength(2);
  });

  test("refuses to paste into a locked layer", async () => {
    const doc = await selectRect();
    await press("c", { ctrlKey: true });
    await lockLayer();
    await press("v", { ctrlKey: true });
    expect(shapesOf(doc.id, 0)).toHaveLength(1);
  });

  test("ignores copy without a selection and paste with an empty clipboard", async () => {
    const { doc } = await renderEditor();
    await press("c", { ctrlKey: true });
    await press("v", { ctrlKey: true });
    expect(shapesOf(doc.id, 0)).toHaveLength(0);
    await press("r");
    await drag(getCanvas(), [
      [100, 100],
      [200, 200]
    ]);
    await press("v");
    await press("Escape");
    await press("c", { ctrlKey: true });
    await press("v", { ctrlKey: true });
    expect(shapesOf(doc.id, 0)).toHaveLength(1);
  });
});
