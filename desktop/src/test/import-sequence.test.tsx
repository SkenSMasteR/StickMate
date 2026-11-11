import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import en from "@/i18n/en.json";
import { docSetLayer } from "@/lib/document";
import type { Keyframe, Shape } from "@/lib/document";
import { store } from "./backend";
import { nextOpenPath } from "./backend/dialog";
import { nextSequence } from "./backend/media";
import { flush, press, renderEditor } from "./utils";

const DIR = "C:/Users/Test/Walk";
const RUN = [`${DIR}/walk_0002.png`, `${DIR}/walk_010.png`, `${DIR}/walk_0001.png`];
const FIRST = `${DIR}/walk_0001.png`;
const BOXES = [
  [386, 292, 28, 16],
  [384, 290, 32, 20],
  [368, 274, 64, 52]
];

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

function boxes(id: string): number[][] {
  return keys(id).flatMap((key) => key.shapes.map(box));
}

async function pickSequence(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Import image sequence/ }));
  });
  await flush();
}

describe("import image sequence", () => {
  test("places every numbered sibling on the frame it lands on", async () => {
    const { doc } = await renderEditor();
    nextSequence(RUN);
    nextOpenPath(FIRST);
    await pickSequence();
    await waitFor(() => expect(keys(doc.id)).toHaveLength(3));
    expect(keys(doc.id).map((key) => key.frame)).toEqual([0, 1, 2]);
    expect(boxes(doc.id)).toEqual(BOXES);
    expect(steps(doc.id)).toBe(1);
  });

  test("selects the picture that lands on the current frame", async () => {
    const { doc } = await renderEditor();
    nextSequence(RUN);
    nextOpenPath(FIRST);
    await pickSequence();
    await waitFor(() => expect(keys(doc.id)).toHaveLength(3));
    expect(await screen.findByText(`${en["editor.shape.Bitmap"]} 1`)).toBeTruthy();
  });

  test("runs from the keyboard", async () => {
    const { doc } = await renderEditor();
    nextSequence(RUN);
    nextOpenPath(FIRST);
    await press("j", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(keys(doc.id)).toHaveLength(3));
    expect(boxes(doc.id)[2]).toEqual(BOXES[2]);
    expect(steps(doc.id)).toBe(1);
  });

  test("undoes the whole run in one step", async () => {
    const { doc } = await renderEditor();
    nextSequence(RUN);
    nextOpenPath(FIRST);
    await pickSequence();
    await waitFor(() => expect(keys(doc.id)).toHaveLength(3));
    await press("z", { ctrlKey: true });
    await waitFor(() => expect(keys(doc.id)).toHaveLength(1));
    expect(boxes(doc.id)).toEqual([]);
    expect(steps(doc.id)).toBe(0);
  });

  test("does nothing when the picker is cancelled", async () => {
    const { doc } = await renderEditor();
    nextSequence(RUN);
    nextOpenPath(null);
    await pickSequence();
    await flush();
    expect(keys(doc.id)).toHaveLength(1);
    expect(steps(doc.id)).toBe(0);
  });

  test("reports a file name it cannot number", async () => {
    const { doc } = await renderEditor();
    nextSequence(RUN);
    nextOpenPath(`${DIR}/walk.png`);
    await pickSequence();
    expect(await screen.findByText(/the file name does not end in a number/)).toBeTruthy();
    expect(keys(doc.id)).toHaveLength(1);
    expect(steps(doc.id)).toBe(0);
  });

  test("refuses a locked layer", async () => {
    const { doc } = await renderEditor();
    const scene = doc.scenes[0];
    await docSetLayer(doc.id, scene.id, scene.layers[0].id, { locked: true });
    await flush();
    const before = steps(doc.id);
    nextSequence(RUN);
    nextOpenPath(FIRST);
    await pickSequence();
    await flush();
    expect(keys(doc.id)).toHaveLength(1);
    expect(steps(doc.id)).toBe(before);
  });
});
