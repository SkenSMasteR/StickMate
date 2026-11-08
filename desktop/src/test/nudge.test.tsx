import { describe, expect, test } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import en from "@/i18n/en.json";
import { docSetTransform } from "@/lib/document";
import { emit } from "@tauri-apps/api/event";
import { store } from "./backend";
import { click, drag, flush, getCanvas, press, renderEditor } from "./utils";

async function selectedRect() {
  const { doc } = await renderEditor();
  await press("r");
  await drag(getCanvas(), [[100, 100], [200, 200]]);
  await press("v");
  await click(getCanvas().querySelector('rect[fill="#3b82f6"]')!, [150, 150]);
  return doc;
}

function shape(id: string) {
  return store.get(id)!.doc.scenes[0].layers[0].keys[0].shapes[0];
}

describe("selection arrow keys", () => {
  test("nudges in all directions and uses a ten-pixel shift step", async () => {
    const doc = await selectedRect();
    await press("ArrowRight");
    await press("ArrowDown", { shiftKey: true });
    expect(shape(doc.id)).toMatchObject({ x: 101, y: 110 });
    await press("ArrowLeft", { shiftKey: true });
    await press("ArrowUp");
    expect(shape(doc.id)).toMatchObject({ x: 91, y: 109 });
    await press("z", { ctrlKey: true });
    expect(shape(doc.id)).toMatchObject({ x: 91, y: 110 });
    await press("z", { ctrlKey: true, shiftKey: true });
    expect(shape(doc.id)).toMatchObject({ x: 91, y: 109 });
  });

  test("leaves unselected shapes and text-entry fields alone", async () => {
    const doc = await selectedRect();
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText(en["editor.selectionX"]), { key: "ArrowRight" });
    });
    expect(shape(doc.id)).toMatchObject({ x: 100, y: 100 });
    await press("Escape");
    await press("ArrowDown");
    expect(shape(doc.id)).toMatchObject({ x: 100, y: 100 });
    await press("p");
    await press("ArrowRight");
    expect(shape(doc.id)).toMatchObject({ x: 100, y: 100 });
  });

  test("moves in canvas coordinates on a rotated and scaled layer", async () => {
    const doc = await selectedRect();
    await docSetTransform(doc.id, doc.scenes[0].id, doc.scenes[0].layers[0].id, 0, {
      x: 0, y: 0, rotation: 90, scale: 2, opacity: 1
    });
    await act(async () => { await emit("editor-open", doc.id); });
    await flush();
    await press("ArrowRight", { shiftKey: true });
    expect(shape(doc.id)).toMatchObject({ x: 100, y: 95 });
  });
});
