import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import en from "@/i18n/en.json";
import { docSetLayer } from "@/lib/document";
import type { Keyframe, Shape } from "@/lib/document";
import { store } from "./backend";
import { nextOpenPath } from "./backend/dialog";
import { nextFrames } from "./backend/media";
import { flush, press, renderEditor } from "./utils";

const GIF = "C:/Users/Test/Animations/walk.gif";
const BOX = [388, 294, 24, 12];

function keys(id: string): Keyframe[] {
  const found = store.get(id);
  if (!found) {
    throw new Error("document is not in the store");
  }
  return found.doc.scenes[0].layers[0].keys;
}

function steps(id: string): number {
  return store.get(id)?.undo.length ?? 0;
}

function length(id: string): number {
  const found = store.get(id);
  if (!found) {
    throw new Error("document is not in the store");
  }
  return found.doc.scenes[0].layers[0].length;
}

function source(shape: Shape): string {
  if (shape.kind !== "Bitmap") {
    throw new Error("bitmap expected");
  }
  return shape.source;
}

function sources(id: string): string[] {
  return keys(id).flatMap((key) => key.shapes.map(source));
}

function box(id: string): number[] {
  const [shape] = keys(id)[1].shapes;
  if (!shape || shape.kind !== "Bitmap") {
    throw new Error("bitmap expected");
  }
  return [
    Math.round(shape.x),
    Math.round(shape.y),
    Math.round(shape.w),
    Math.round(shape.h)
  ];
}

async function pickGif(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Import animated GIF/ }));
  });
  await flush();
}

describe("import animated gif", () => {
  test("holds every frame for the delay it was drawn with", async () => {
    const { doc } = await renderEditor();
    nextFrames(3, 125);
    nextOpenPath(GIF);
    await pickGif();
    await waitFor(() => expect(keys(doc.id)).toHaveLength(3));
    expect(keys(doc.id).map((key) => key.frame)).toEqual([0, 3, 6]);
    expect(length(doc.id)).toBe(9);
    expect(sources(doc.id)).toEqual([
      "data:image/png;base64,iVBORw0KGgo=0",
      "data:image/png;base64,iVBORw0KGgo=1",
      "data:image/png;base64,iVBORw0KGgo=2"
    ]);
    expect(box(doc.id)).toEqual(BOX);
    expect(steps(doc.id)).toBe(1);
  });

  test("never holds a frame for less than the frame rate allows", async () => {
    const { doc } = await renderEditor();
    nextFrames(2, 10);
    nextOpenPath(GIF);
    await pickGif();
    await waitFor(() => expect(keys(doc.id)).toHaveLength(2));
    expect(keys(doc.id).map((key) => key.frame)).toEqual([0, 1]);
    expect(length(doc.id)).toBe(2);
  }, 20000);

  test("selects the picture that lands on the current frame", async () => {
    const { doc } = await renderEditor();
    nextFrames(3, 125);
    nextOpenPath(GIF);
    await pickGif();
    await waitFor(() => expect(keys(doc.id)).toHaveLength(3));
    expect(await screen.findByText(`${en["editor.shape.Bitmap"]} 1`)).toBeTruthy();
  }, 20000);

  test("runs from the keyboard", async () => {
    const { doc } = await renderEditor();
    nextFrames(2, 250);
    nextOpenPath(GIF);
    await press("k", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(keys(doc.id)).toHaveLength(2));
    expect(keys(doc.id).map((key) => key.frame)).toEqual([0, 6]);
    expect(steps(doc.id)).toBe(1);
  }, 20000);

  test("undoes the whole animation in one step", async () => {
    const { doc } = await renderEditor();
    nextFrames(3, 125);
    nextOpenPath(GIF);
    await pickGif();
    await waitFor(() => expect(keys(doc.id)).toHaveLength(3));
    await press("z", { ctrlKey: true });
    await waitFor(() => expect(keys(doc.id)).toHaveLength(1));
    expect(keys(doc.id)[0].shapes).toHaveLength(0);
    expect(length(doc.id)).toBe(1);
    expect(steps(doc.id)).toBe(0);
  }, 20000);

  test("does nothing when the picker is cancelled", async () => {
    const { doc } = await renderEditor();
    nextFrames(3, 125);
    nextOpenPath(null);
    await pickGif();
    await flush();
    expect(keys(doc.id)).toHaveLength(1);
    expect(steps(doc.id)).toBe(0);
  }, 20000);

  test("reports a file that is not an animation", async () => {
    const { doc } = await renderEditor();
    nextFrames(3, 125);
    nextOpenPath("C:/Users/Test/Pictures/ball.png");
    await pickGif();
    expect(await screen.findByText(/the file is not a readable GIF animation/)).toBeTruthy();
    expect(keys(doc.id)).toHaveLength(1);
    expect(steps(doc.id)).toBe(0);
  }, 20000);

  test("refuses a locked layer", async () => {
    const { doc } = await renderEditor();
    const scene = doc.scenes[0];
    await docSetLayer(doc.id, scene.id, scene.layers[0].id, { locked: true });
    await flush();
    const before = steps(doc.id);
    nextFrames(3, 125);
    nextOpenPath(GIF);
    await pickGif();
    await flush();
    expect(keys(doc.id)).toHaveLength(1);
    expect(steps(doc.id)).toBe(before);
  }, 20000);
});
