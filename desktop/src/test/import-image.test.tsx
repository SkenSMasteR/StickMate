import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import en from "@/i18n/en.json";
import { docSetLayer } from "@/lib/document";
import type { Shape } from "@/lib/document";
import { store } from "./backend";
import { nextOpenPath } from "./backend/dialog";
import { nextSize } from "./backend/media";
import { flush, getCanvas, press, renderEditor } from "./utils";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const SVG = "data:image/svg+xml;base64,PHN2Zy8+";

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

function box(shape: Shape): number[] {
  if (shape.kind !== "Bitmap") {
    throw new Error("bitmap expected");
  }
  return [
    Math.round(shape.x),
    Math.round(shape.y),
    Math.round(shape.w),
    Math.round(shape.h)
  ];
}

async function pickImport(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Import image \(/ }));
  });
  await flush();
}

describe("import image", () => {
  test("places the chosen picture centred on the stage", async () => {
    const { doc } = await renderEditor();
    nextOpenPath("C:/Users/Test/Pictures/ball.png");
    await pickImport();
    await waitFor(() => expect(listed(doc.id)).toHaveLength(1));
    expect(box(listed(doc.id)[0])).toEqual([388, 294, 24, 12]);
    expect(getCanvas().querySelector("image")?.getAttribute("href")).toBe(PNG);
  }, 20000);

  test("selects the placed picture", async () => {
    const { doc } = await renderEditor();
    nextOpenPath("C:/Users/Test/Pictures/ball.png");
    await pickImport();
    await waitFor(() => expect(listed(doc.id)).toHaveLength(1));
    expect(await screen.findByText(`${en["editor.shape.Bitmap"]} 1`)).toBeTruthy();
  }, 20000);

  test("shrinks a picture larger than the stage to fit", async () => {
    const { doc } = await renderEditor();
    nextOpenPath("C:/Users/Test/Pictures/poster.jpg");
    nextSize(1600, 1200);
    await pickImport();
    await waitFor(() => expect(listed(doc.id)).toHaveLength(1));
    expect(box(listed(doc.id)[0])).toEqual([0, 0, 800, 600]);
  }, 20000);

  test("runs from the keyboard", async () => {
    const { doc } = await renderEditor();
    nextOpenPath("C:/Users/Test/Pictures/ball.gif");
    await press("i", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(listed(doc.id)).toHaveLength(1));
    expect(steps(doc.id)).toBe(1);
  }, 20000);

  test("undoes the placed picture", async () => {
    const { doc } = await renderEditor();
    nextOpenPath("C:/Users/Test/Pictures/ball.png");
    await pickImport();
    await waitFor(() => expect(listed(doc.id)).toHaveLength(1));
    await press("z", { ctrlKey: true });
    await waitFor(() => expect(listed(doc.id)).toHaveLength(0));
  }, 20000);

  test("does nothing when the picker is cancelled", async () => {
    const { doc } = await renderEditor();
    nextOpenPath(null);
    await pickImport();
    await flush();
    expect(listed(doc.id)).toHaveLength(0);
    expect(steps(doc.id)).toBe(0);
  }, 20000);

  test("places a chosen svg drawing as vector artwork", async () => {
    const { doc } = await renderEditor();
    nextOpenPath("C:/Users/Test/Pictures/balloon.svg");
    await pickImport();
    await waitFor(() => expect(listed(doc.id)).toHaveLength(1));
    expect(box(listed(doc.id)[0])).toEqual([388, 294, 24, 12]);
    expect(getCanvas().querySelector("image")?.getAttribute("href")).toBe(SVG);
  }, 20000);

  test("reports a file the reader refuses", async () => {
    const { doc } = await renderEditor();
    nextOpenPath("C:/Users/Test/Notes/plan.txt");
    await pickImport();
    expect(await screen.findByText(/the file is not a PNG, JPEG, GIF or SVG image/)).toBeTruthy();
    expect(listed(doc.id)).toHaveLength(0);
    expect(steps(doc.id)).toBe(0);
  }, 20000);

  test("refuses a locked layer", async () => {
    const { doc } = await renderEditor();
    const scene = doc.scenes[0];
    await docSetLayer(doc.id, scene.id, scene.layers[0].id, { locked: true });
    await flush();
    const before = steps(doc.id);
    nextOpenPath("C:/Users/Test/Pictures/ball.png");
    await pickImport();
    await flush();
    expect(listed(doc.id)).toHaveLength(0);
    expect(steps(doc.id)).toBe(before);
  }, 20000);
});
