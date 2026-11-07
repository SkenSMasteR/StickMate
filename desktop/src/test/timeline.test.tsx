import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { store } from "./backend";
import { flush, press, renderEditor } from "./utils";
import {
  docDraw,
  docInsertFrame,
  docKeyframe,
  docNew,
  docSetLabel,
  docSetLayer,
  docSetTween,
  docUndo
} from "@/lib/document";
import type { Document, Keyframe, Layer, Shape } from "@/lib/document";
import {
  docCopyFrames,
  docDuplicateFrames,
  docInsertFrames,
  docMoveFrames,
  docPasteFrames,
  docRemoveFrames,
  setFrameClipboard
} from "@/lib/frames";
import type { FrameClip } from "@/lib/frames";

const CELL = 16;
const ROW_Y = 31;

interface Modifiers {
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

function layerOf(id: string): Layer {
  const state = store.get(id);
  if (!state) {
    throw new Error("document is not in the store");
  }
  return state.doc.scenes[0].layers[0];
}

function stroke(x: number): Shape {
  return {
    kind: "Stroke",
    points: [
      { x, y: 0 },
      { x, y: 10 }
    ],
    color: "#000000",
    width: 2
  };
}

function clipKey(frame: number, x: number): Keyframe {
  return {
    frame,
    shapes: [stroke(x)],
    transform: { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 },
    tween: false,
    label: null
  };
}

async function extend(
  id: string,
  scene: string,
  layer: string,
  length: number,
  keys: number[]
): Promise<void> {
  for (const frame of keys) {
    await docKeyframe(id, scene, layer, frame, false);
  }
  while (layerOf(id).length < length) {
    await docInsertFrame(id, scene, layer, layerOf(id).length - 1);
  }
}

async function makeDoc(
  length = 1,
  keys: number[] = []
): Promise<{ id: string; scene: string; layer: string }> {
  const doc = await docNew("Test", 800, 600, 24, "#ffffff");
  const scene = doc.scenes[0].id;
  const layer = doc.scenes[0].layers[0].id;
  await extend(doc.id, scene, layer, length, keys);
  return { id: doc.id, scene, layer };
}

async function build(doc: Document, length: number, keys: number[] = []): Promise<void> {
  await extend(doc.id, doc.scenes[0].id, doc.scenes[0].layers[0].id, length, keys);
  await press("f6");
}

async function drawAt(doc: Document, frame: number, x: number): Promise<void> {
  await docDraw(doc.id, doc.scenes[0].id, doc.scenes[0].layers[0].id, frame, stroke(x));
  await press("f6");
}

async function pointer(type: string, frame: number, modifiers: Modifiers = {}): Promise<void> {
  const grid = screen.getByTestId("timeline-grid");
  await act(async () => {
    fireEvent(
      grid,
      new PointerEvent(type, {
        clientX: frame * CELL + CELL / 2,
        clientY: ROW_Y,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        pointerId: 1,
        bubbles: true,
        ...modifiers
      })
    );
  });
}

async function clickCell(frame: number, modifiers: Modifiers = {}): Promise<void> {
  await pointer("pointerdown", frame, modifiers);
  await pointer("pointerup", frame, modifiers);
  await flush();
}

async function dragCells(from: number, to: number): Promise<void> {
  await pointer("pointerdown", from);
  await pointer("pointermove", to);
  await pointer("pointerup", to);
  await flush();
}

function selectedFrames(): number[] {
  return [...screen.getByTestId("timeline-grid").querySelectorAll('[data-selected="true"]')].map(
    (cell) => Number(cell.getAttribute("data-frame"))
  );
}

function frameValue(): string {
  return (screen.getByLabelText("Frame") as HTMLInputElement).value;
}

function button(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

async function clickButton(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(button(name));
  });
  await flush();
}

async function setNumber(label: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  });
  await flush();
}

beforeEach(() => {
  setFrameClipboard(null);
});

describe("frame commands", () => {
  it("insert shifts keys, extends length and is one undo step", async () => {
    const { id, scene, layer } = await makeDoc(10, [4, 7]);
    const before = JSON.stringify(store.get(id)?.doc);
    const depth = store.get(id)?.undo.length ?? 0;
    await docInsertFrames(id, scene, layer, 4, 3);
    expect(layerOf(id).keys.map((key) => key.frame)).toEqual([0, 7, 10]);
    expect(layerOf(id).length).toBe(13);
    expect(store.get(id)?.undo.length).toBe(depth + 1);
    await docUndo(id);
    expect(JSON.stringify(store.get(id)?.doc)).toBe(before);
  });

  it("insert on an existing key keeps that key", async () => {
    const { id, scene, layer } = await makeDoc(8, [4]);
    await docSetTween(id, scene, layer, 4, true);
    await docSetLabel(id, scene, layer, 4, "walk");
    await docInsertFrames(id, scene, layer, 4, 2);
    const key = layerOf(id).keys[1];
    expect(key.frame).toBe(6);
    expect(key.tween).toBe(true);
    expect(key.label).toBe("walk");
  });

  it("remove drops in-range keys, shifts later keys and shrinks length", async () => {
    const { id, scene, layer } = await makeDoc(8, [2, 4, 6]);
    await docRemoveFrames(id, scene, layer, 2, 3);
    expect(layerOf(id).keys.map((key) => key.frame)).toEqual([0, 3]);
    expect(layerOf(id).length).toBe(5);
  });

  it("remove never shrinks below one and keeps content at frame zero", async () => {
    const { id, scene, layer } = await makeDoc(3, [2]);
    await docDraw(id, scene, layer, 0, stroke(1));
    await docRemoveFrames(id, scene, layer, 0, 5);
    const target = layerOf(id);
    expect(target.length).toBe(1);
    expect(target.keys).toHaveLength(1);
    expect(target.keys[0].frame).toBe(0);
    expect(target.keys[0].shapes).toEqual([stroke(1)]);
  });

  it("copy mid-hold synthesizes the offset zero key without an undo entry", async () => {
    const { id, scene, layer } = await makeDoc(10);
    await docDraw(id, scene, layer, 0, stroke(1));
    const depth = store.get(id)?.undo.length ?? 0;
    const clip = await docCopyFrames(id, scene, layer, 3, 4);
    expect(clip.span).toBe(4);
    expect(clip.keys).toHaveLength(1);
    expect(clip.keys[0].frame).toBe(0);
    expect(clip.keys[0].shapes).toEqual([stroke(1)]);
    expect(store.get(id)?.undo.length).toBe(depth);
  });

  it("copy preserves tween and label", async () => {
    const { id, scene, layer } = await makeDoc(8, [4]);
    await docSetTween(id, scene, layer, 0, true);
    await docSetLabel(id, scene, layer, 0, "intro");
    const clip = await docCopyFrames(id, scene, layer, 0, 5);
    expect(clip.keys).toHaveLength(2);
    expect(clip.keys[0].tween).toBe(true);
    expect(clip.keys[0].label).toBe("intro");
    expect(clip.keys[1].frame).toBe(4);
  });

  it("paste shifts existing keys and extends length", async () => {
    const { id, scene, layer } = await makeDoc(8, [5]);
    const clip: FrameClip = { span: 3, keys: [clipKey(0, 9), clipKey(2, 8)] };
    await docPasteFrames(id, scene, layer, 5, clip);
    expect(layerOf(id).keys.map((key) => key.frame)).toEqual([0, 5, 7, 8]);
    expect(layerOf(id).length).toBe(11);
    expect(layerOf(id).keys[1].shapes).toEqual([stroke(9)]);
  });

  it("paste rejects empty and invalid clips", async () => {
    const { id, scene, layer } = await makeDoc(8);
    await expect(
      docPasteFrames(id, scene, layer, 2, { span: 3, keys: [] })
    ).rejects.toThrow("clipboard is empty");
    await expect(
      docPasteFrames(id, scene, layer, 2, { span: 4, keys: [clipKey(2, 1), clipKey(1, 2)] })
    ).rejects.toThrow("clipboard is invalid");
    await expect(
      docPasteFrames(id, scene, layer, 2, { span: 4, keys: [clipKey(1, 1), clipKey(1, 2)] })
    ).rejects.toThrow("clipboard is invalid");
  });

  it("duplicate reproduces content in one undo step", async () => {
    const { id, scene, layer } = await makeDoc(6, [3]);
    await docDraw(id, scene, layer, 0, stroke(1));
    const before = JSON.stringify(store.get(id)?.doc);
    const depth = store.get(id)?.undo.length ?? 0;
    await docDuplicateFrames(id, scene, layer, 0, 3);
    expect(layerOf(id).keys.map((key) => key.frame)).toEqual([0, 3, 6]);
    expect(layerOf(id).length).toBe(9);
    expect(layerOf(id).keys[1].shapes).toEqual([stroke(1)]);
    expect(store.get(id)?.undo.length).toBe(depth + 1);
    await docUndo(id);
    expect(JSON.stringify(store.get(id)?.doc)).toBe(before);
  });

  it("move forward relocates the range and shifts the rest", async () => {
    const { id, scene, layer } = await makeDoc(8, [2, 5]);
    await docDraw(id, scene, layer, 2, stroke(2));
    const moved = layerOf(id).keys[1].shapes;
    await docMoveFrames(id, scene, layer, 2, 2, 6);
    expect(layerOf(id).keys.map((key) => key.frame)).toEqual([0, 3, 4]);
    expect(layerOf(id).length).toBe(8);
    expect(layerOf(id).keys[2].shapes).toEqual(moved);
  });

  it("move backward lands at the target", async () => {
    const { id, scene, layer } = await makeDoc(8, [2, 5]);
    await docMoveFrames(id, scene, layer, 5, 2, 1);
    expect(layerOf(id).keys.map((key) => key.frame)).toEqual([0, 1, 4]);
    expect(layerOf(id).length).toBe(8);
  });

  it("move onto an overlapping range keeps keys unique", async () => {
    const { id, scene, layer } = await makeDoc(10, [2, 4, 6]);
    await docMoveFrames(id, scene, layer, 2, 3, 4);
    expect(layerOf(id).keys.map((key) => key.frame)).toEqual([0, 1, 3, 6]);
    expect(layerOf(id).length).toBe(10);
  });

  it("move rejects the same target without an undo entry", async () => {
    const { id, scene, layer } = await makeDoc(6, [2]);
    const depth = store.get(id)?.undo.length ?? 0;
    await expect(docMoveFrames(id, scene, layer, 2, 2, 2)).rejects.toThrow(
      "target equals source frame"
    );
    expect(store.get(id)?.undo.length).toBe(depth);
  });

  it("locked layers reject every mutation but allow copy", async () => {
    const { id, scene, layer } = await makeDoc(8, [4]);
    await docSetLayer(id, scene, layer, { locked: true });
    await expect(docInsertFrames(id, scene, layer, 1, 2)).rejects.toThrow("layer is locked");
    await expect(docRemoveFrames(id, scene, layer, 1, 2)).rejects.toThrow("layer is locked");
    await expect(
      docPasteFrames(id, scene, layer, 1, { span: 1, keys: [clipKey(0, 9)] })
    ).rejects.toThrow("layer is locked");
    await expect(docDuplicateFrames(id, scene, layer, 1, 2)).rejects.toThrow("layer is locked");
    await expect(docMoveFrames(id, scene, layer, 1, 2, 4)).rejects.toThrow("layer is locked");
    const clip = await docCopyFrames(id, scene, layer, 0, 2);
    expect(clip.span).toBe(2);
  });

  it("rejects counts outside 1 to 1000", async () => {
    const { id, scene, layer } = await makeDoc(8);
    const message = "frame count must be between 1 and 1000";
    await expect(docInsertFrames(id, scene, layer, 0, 0)).rejects.toThrow(message);
    await expect(docInsertFrames(id, scene, layer, 0, 1001)).rejects.toThrow(message);
    await expect(docRemoveFrames(id, scene, layer, 0, 0)).rejects.toThrow(message);
    await expect(docCopyFrames(id, scene, layer, 0, 1001)).rejects.toThrow(message);
    await expect(docDuplicateFrames(id, scene, layer, 0, 0)).rejects.toThrow(message);
    await expect(docMoveFrames(id, scene, layer, 0, 1001, 2)).rejects.toThrow(message);
    await expect(
      docPasteFrames(id, scene, layer, 0, { span: 0, keys: [clipKey(0, 1)] })
    ).rejects.toThrow(message);
  });

  it("rejects unknown scenes, layers and documents", async () => {
    const { id, scene, layer } = await makeDoc(8);
    await expect(docInsertFrames(id, "missing", layer, 0, 1)).rejects.toThrow("unknown scene");
    await expect(docInsertFrames(id, scene, "missing", 0, 1)).rejects.toThrow("unknown layer");
    await expect(docCopyFrames(id, "missing", layer, 0, 1)).rejects.toThrow("unknown scene");
    await expect(docMoveFrames("missing", scene, layer, 0, 1, 2)).rejects.toThrow(
      "unknown document"
    );
  });

  it("rejects frames outside the layer", async () => {
    const { id, scene, layer } = await makeDoc(5);
    await expect(docInsertFrames(id, scene, layer, 5, 1)).rejects.toThrow("frame is out of range");
    await expect(docCopyFrames(id, scene, layer, 5, 1)).rejects.toThrow("frame is out of range");
    await expect(docMoveFrames(id, scene, layer, 0, 1, 5)).rejects.toThrow("frame is out of range");
  });
});

describe("timeline selection", () => {
  it("selects a single frame and seeks on click", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await clickCell(3);
    expect(selectedFrames()).toEqual([3]);
    expect(frameValue()).toBe("4");
  });

  it("extends a contiguous range from the anchor on shift click", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await clickCell(2);
    await clickCell(6, { shiftKey: true });
    expect(selectedFrames()).toEqual([2, 3, 4, 5, 6]);
    expect(frameValue()).toBe("7");
  });

  it("toggles individual frames on ctrl click", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await clickCell(2);
    await clickCell(5, { ctrlKey: true });
    expect(selectedFrames()).toEqual([2, 5]);
    await clickCell(2, { ctrlKey: true });
    expect(selectedFrames()).toEqual([5]);
  });

  it("extends the range while dragging across cells", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await dragCells(2, 5);
    expect(selectedFrames()).toEqual([2, 3, 4, 5]);
    expect(frameValue()).toBe("6");
  });

  it("keeps the selection across an unrelated re-render", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await dragCells(2, 4);
    await press("o", { altKey: true });
    expect(selectedFrames()).toEqual([2, 3, 4]);
  });
}, 20000);

describe("timeline toolbar", () => {
  it("inserts frames at the selection start", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10, [4]);
    await dragCells(2, 3);
    await setNumber("Frame count", "2");
    await clickButton("Insert frames");
    expect(layerOf(doc.id).keys.map((key) => key.frame)).toEqual([0, 6]);
    expect(layerOf(doc.id).length).toBe(12);
    expect(selectedFrames()).toEqual([2, 3]);
    expect(frameValue()).toBe("3");
    expect(
      screen.getByTestId("timeline-grid").querySelector('[data-frame="6"] span.border-foreground')
    ).not.toBeNull();
  });

  it("removes the selected range", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10, [2, 4, 6]);
    await dragCells(2, 4);
    await clickButton("Remove frames");
    expect(layerOf(doc.id).keys.map((key) => key.frame)).toEqual([0, 3]);
    expect(layerOf(doc.id).length).toBe(7);
    expect(selectedFrames()).toEqual([]);
    expect(frameValue()).toBe("3");
  });

  it("copies then pastes at another frame and reproduces the shapes", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await drawAt(doc, 0, 1);
    await dragCells(0, 1);
    await clickButton("Copy frames");
    await clickCell(6);
    await clickButton("Paste frames");
    expect(layerOf(doc.id).keys.map((key) => key.frame)).toEqual([0, 6]);
    expect(layerOf(doc.id).length).toBe(12);
    expect(layerOf(doc.id).keys[1].shapes).toEqual([stroke(1)]);
    expect(selectedFrames()).toEqual([6, 7]);
    expect(frameValue()).toBe("7");
    expect(
      screen.getByTestId("timeline-grid").querySelector('[data-frame="6"] span.bg-foreground')
    ).not.toBeNull();
  });

  it("shows an error and changes nothing when pasting an empty clipboard", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    const before = JSON.stringify(store.get(doc.id)?.doc);
    const depth = store.get(doc.id)?.undo.length ?? 0;
    await clickButton("Paste frames");
    expect(await screen.findByText("Clipboard is empty")).toBeTruthy();
    expect(JSON.stringify(store.get(doc.id)?.doc)).toBe(before);
    expect(store.get(doc.id)?.undo.length).toBe(depth);
  });

  it("duplicates the selection in one undo step", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await drawAt(doc, 0, 1);
    const depth = store.get(doc.id)?.undo.length ?? 0;
    await dragCells(0, 1);
    await clickButton("Duplicate frames");
    expect(layerOf(doc.id).keys.map((key) => key.frame)).toEqual([0, 2]);
    expect(layerOf(doc.id).length).toBe(12);
    expect(layerOf(doc.id).keys[1].shapes).toEqual([stroke(1)]);
    expect(store.get(doc.id)?.undo.length).toBe(depth + 1);
    expect(selectedFrames()).toEqual([2, 3]);
    expect(frameValue()).toBe("3");
  });

  it("moves the selection to the target frame", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10, [2, 5]);
    await dragCells(2, 3);
    const moved = layerOf(doc.id).keys[1].shapes;
    await setNumber("Move to frame", "7");
    await clickButton("Move frames");
    expect(layerOf(doc.id).keys.map((key) => key.frame)).toEqual([0, 3, 4]);
    expect(layerOf(doc.id).length).toBe(10);
    expect(layerOf(doc.id).keys[2].shapes).toEqual(moved);
    expect(selectedFrames()).toEqual([4, 5]);
    expect(frameValue()).toBe("5");
  });
}, 20000);

describe("loop range", () => {
  it("shows the range on the ruler and clears it", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await setNumber("Loop start", "3");
    await setNumber("Loop end", "6");
    await flush();
    const band = screen.getByTestId("loop-range");
    expect(band.style.left).toBe("32px");
    expect(band.style.width).toBe("64px");
    await clickButton("Clear loop range");
    expect(screen.queryByTestId("loop-range")).toBeNull();
    expect((screen.getByLabelText("Loop start") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("Loop end") as HTMLInputElement).value).toBe("10");
  });

  it("clamps the range to the scene and keeps start before end", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await setNumber("Loop start", "50");
    await flush();
    expect(screen.getByTestId("loop-range").style.left).toBe("144px");
    await setNumber("Loop start", "8");
    await setNumber("Loop end", "3");
    await flush();
    const band = screen.getByTestId("loop-range");
    expect(band.style.left).toBe("32px");
    expect(band.style.width).toBe("96px");
  });

  it("wraps playback inside the loop range", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await setNumber("Loop start", "3");
    await setNumber("Loop end", "6");
    await clickCell(2);
    vi.useFakeTimers();
    try {
      await press("space");
      for (const expected of ["4", "5", "6", "3", "4"]) {
        await act(async () => {
          vi.advanceTimersByTime(1000 / 24);
        });
        await flush();
        expect(frameValue()).toBe(expected);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at the loop end when looping is off", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await clickButton("Loop");
    await setNumber("Loop start", "3");
    await setNumber("Loop end", "6");
    await clickCell(4);
    vi.useFakeTimers();
    try {
      await press("space");
      await act(async () => {
        vi.advanceTimersByTime(1000 / 24);
      });
      await flush();
      expect(frameValue()).toBe("6");
      await act(async () => {
        vi.advanceTimersByTime(1000 / 24);
      });
      await flush();
      expect(frameValue()).toBe("6");
      expect(button("Play").getAttribute("aria-pressed")).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still allows seeking outside the loop range", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await setNumber("Loop start", "3");
    await setNumber("Loop end", "6");
    await clickCell(8);
    expect(frameValue()).toBe("9");
  });
}, 20000);

describe("timeline shortcuts", () => {
  it("inserts frames with ctrl+f5", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10, [4]);
    await dragCells(2, 3);
    await press("F5", { ctrlKey: true });
    expect(layerOf(doc.id).keys.map((key) => key.frame)).toEqual([0, 5]);
    expect(layerOf(doc.id).length).toBe(11);
  });

  it("removes frames with ctrl+shift+f5", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10, [2, 4, 6]);
    await dragCells(2, 4);
    await press("F5", { ctrlKey: true, shiftKey: true });
    expect(layerOf(doc.id).keys.map((key) => key.frame)).toEqual([0, 3]);
    expect(layerOf(doc.id).length).toBe(7);
  });

  it("copies and pastes frames with ctrl+alt+c and ctrl+alt+v", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await drawAt(doc, 0, 1);
    await dragCells(0, 1);
    await press("c", { ctrlKey: true, altKey: true });
    await clickCell(6);
    await press("v", { ctrlKey: true, altKey: true });
    expect(layerOf(doc.id).keys.map((key) => key.frame)).toEqual([0, 6]);
    expect(layerOf(doc.id).keys[1].shapes).toEqual([stroke(1)]);
  });

  it("duplicates frames with ctrl+alt+d in one undo step", async () => {
    const { doc } = await renderEditor();
    await build(doc, 10);
    await drawAt(doc, 0, 1);
    await dragCells(0, 1);
    const depth = store.get(doc.id)?.undo.length ?? 0;
    await press("d", { ctrlKey: true, altKey: true });
    expect(layerOf(doc.id).keys.map((key) => key.frame)).toEqual([0, 2]);
    expect(store.get(doc.id)?.undo.length).toBe(depth + 1);
  });
}, 20000);