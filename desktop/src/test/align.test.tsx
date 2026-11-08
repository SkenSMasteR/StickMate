import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import en from "@/i18n/en.json";
import {
  affineFrom,
  docAlignShapes,
  docDraw,
  docNew,
  docSetLayer,
  docUndo,
  shapeBounds
} from "@/lib/document";
import type { AlignMode, AlignReference, Document, Shape } from "@/lib/document";
import { installBackend, store } from "./backend";
import { drag, flush, getCanvas, press, renderEditor } from "./utils";

function state(id: string) {
  const found = store.get(id);
  if (!found) {
    throw new Error("document is not in the store");
  }
  return found;
}

function shapes(id: string): Shape[] {
  return state(id).doc.scenes[0].layers[0].keys[0].shapes;
}

function target(id: string): { sceneId: string; layerId: string } {
  const doc = state(id).doc;
  return { sceneId: doc.scenes[0].id, layerId: doc.scenes[0].layers[0].id };
}

function undoLen(id: string): number {
  return state(id).undo.length;
}

function json(id: string): string {
  return JSON.stringify(state(id).doc);
}

function rectAt(x: number, y: number): Shape {
  return {
    kind: "Rect",
    x,
    y,
    w: 20,
    h: 20,
    fill: "#3b82f6",
    stroke: "#000000",
    width: 2
  };
}

function axis(list: Shape[], horizontal: boolean): number[] {
  return list.map((item) => {
    const box = shapeBounds(item);
    return horizontal ? box.x : box.y;
  });
}

async function seed(id: string, positions: Array<[number, number]>): Promise<void> {
  const { sceneId, layerId } = target(id);
  for (const [x, y] of positions) {
    await docDraw(id, sceneId, layerId, 0, rectAt(x, y));
  }
}

async function create(positions: Array<[number, number]>): Promise<string> {
  const doc = await docNew("Test", 800, 600, 24, "#ffffff");
  await seed(doc.id, positions);
  return doc.id;
}

async function alignTo(
  id: string,
  indices: number[],
  mode: AlignMode,
  reference: AlignReference
): Promise<Shape[]> {
  const { sceneId, layerId } = target(id);
  const next = await docAlignShapes(id, sceneId, layerId, 0, indices, mode, reference);
  return next.scenes[0].layers[0].keys[0].shapes;
}

function alignSection(): HTMLElement {
  const section = screen
    .getByRole("heading", { name: en["align.panel"] })
    .closest("section");
  if (!section) {
    throw new Error("align panel is not mounted");
  }
  return section as HTMLElement;
}

function alignButton(label: string): HTMLButtonElement {
  return within(alignSection()).getByRole("button", {
    name: label
  }) as HTMLButtonElement;
}

function referenceButton(label: string): HTMLButtonElement {
  return within(alignSection()).getByRole("button", {
    name: label
  }) as HTMLButtonElement;
}

function pressed(button: HTMLButtonElement): boolean {
  return button.getAttribute("aria-pressed") === "true";
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    fireEvent.click(button);
  });
  await flush();
}

async function opened(positions: Array<[number, number]>): Promise<Document> {
  const { doc } = await renderEditor();
  await seed(doc.id, positions);
  await act(async () => {
    await emit("editor-open", doc.id);
  });
  await flush();
  await press("v");
  await drag(getCanvas(), [
    [5, 5],
    [780, 580]
  ]);
  return doc;
}

describe("shape alignment engine", () => {
  test("aligns every edge and centre against the stage", async () => {
    installBackend("editor");
    const horizontal: Array<[AlignMode, number]> = [
      ["left", 0],
      ["right", 780],
      ["center_h", 390]
    ];
    const vertical: Array<[AlignMode, number]> = [
      ["top", 0],
      ["bottom", 580],
      ["center_v", 290]
    ];
    for (const [mode, expected] of [...horizontal, ...vertical]) {
      const id = await create([[100, 50]]);
      const moved = await alignTo(id, [0], mode, "stage");
      const box = shapeBounds(moved[0]);
      const value = horizontal.some(([item]) => item === mode) ? box.x : box.y;
      expect(value, mode).toBe(expected);
    }
  });

  test("aligns against the union of the selection", async () => {
    installBackend("editor");
    const spread: Array<[number, number]> = [
      [100, 100],
      [300, 200]
    ];
    const cases: Array<[AlignMode, boolean, number[]]> = [
      ["left", true, [100, 100]],
      ["right", true, [300, 300]],
      ["center_h", true, [200, 200]],
      ["top", false, [100, 100]],
      ["bottom", false, [200, 200]],
      ["center_v", false, [150, 150]]
    ];
    for (const [mode, horizontal, expected] of cases) {
      const id = await create(spread);
      const moved = await alignTo(id, [0, 1], mode, "selection");
      expect(axis(moved, horizontal), mode).toEqual(expected);
    }
  });

  test("distributes across the stage edges in position order", async () => {
    installBackend("editor");
    const id = await create([
      [100, 0],
      [200, 100],
      [300, 50]
    ]);
    const wide = await alignTo(id, [0, 1, 2], "distribute_h", "stage");
    expect(axis(wide, true)).toEqual([0, 390, 780]);
    expect(axis(wide, false)).toEqual([0, 100, 50]);
    await docUndo(id);
    expect(axis(shapes(id), true)).toEqual([100, 200, 300]);
    const tall = await alignTo(id, [0, 1, 2], "distribute_v", "stage");
    expect(axis(tall, true)).toEqual([100, 200, 300]);
    expect(axis(tall, false)).toEqual([0, 580, 290]);
  });

  test("distributes inside the selection box and keeps its extremes", async () => {
    installBackend("editor");
    const id = await create([
      [100, 100],
      [110, 100],
      [300, 100]
    ]);
    const moved = await alignTo(id, [0, 1, 2], "distribute_h", "selection");
    expect(axis(moved, true)).toEqual([100, 200, 300]);
    const steps = undoLen(id);
    const settled = await alignTo(id, [0, 1, 2], "distribute_h", "selection");
    expect(axis(settled, true)).toEqual([100, 200, 300]);
    expect(undoLen(id)).toBe(steps);
  });

  test("treats distribute with fewer than three shapes as a no-op", async () => {
    installBackend("editor");
    const id = await create([
      [100, 100],
      [300, 200]
    ]);
    const before = json(id);
    const steps = undoLen(id);
    await alignTo(id, [0, 1], "distribute_h", "stage");
    expect(json(id)).toBe(before);
    expect(undoLen(id)).toBe(steps);
  });

  test("is one undo step and pushes no history on a no-op", async () => {
    installBackend("editor");
    const id = await create([
      [100, 0],
      [200, 0],
      [300, 0]
    ]);
    const before = json(id);
    const steps = undoLen(id);
    await alignTo(id, [0, 1, 2], "top", "selection");
    expect(json(id)).toBe(before);
    expect(undoLen(id)).toBe(steps);
    await alignTo(id, [0, 1, 2], "left", "stage");
    expect(undoLen(id)).toBe(steps + 1);
    expect(axis(shapes(id), true)).toEqual([0, 0, 0]);
    await docUndo(id);
    expect(json(id)).toBe(before);
  });

  test("moves every shape kind and keeps the text matrix", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const id = doc.id;
    const { sceneId, layerId } = target(id);
    const kinds: Shape[] = [
      {
        kind: "Stroke",
        points: [
          { x: 100, y: 40 },
          { x: 140, y: 80 }
        ],
        color: "#000000",
        width: 4
      },
      {
        kind: "Ellipse",
        x: 200,
        y: 0,
        w: 40,
        h: 20,
        fill: "#3b82f6",
        stroke: "#000000",
        width: 2
      },
      {
        kind: "Polygon",
        x: 300,
        y: 10,
        w: 30,
        h: 30,
        sides: 6,
        fill: "#3b82f6",
        stroke: "#000000",
        width: 2
      },
      {
        kind: "Path",
        nodes: [
          {
            point: { x: 120, y: 120 },
            handle_in: null,
            handle_out: { x: 150, y: 90 }
          },
          {
            point: { x: 220, y: 140 },
            handle_in: { x: 190, y: 110 },
            handle_out: null
          }
        ],
        closed: false,
        fill: "#3b82f6",
        stroke: "#000000",
        width: 2
      },
      {
        kind: "Text",
        x: 400,
        y: 50,
        text: "hi",
        size: 20,
        family: "Segoe UI",
        color: "#000000",
        matrix: affineFrom({ x: 410, y: 60 }, 0, 0, 1, 1, 30)
      }
    ];
    for (const shape of kinds) {
      await docDraw(id, sceneId, layerId, 0, shape);
    }
    const moved = await alignTo(
      id,
      kinds.map((_, index) => index),
      "left",
      "stage"
    );
    expect(moved).toHaveLength(5);
    for (const shape of moved) {
      expect(shapeBounds(shape).x).toBeCloseTo(0, 6);
    }
    const text = moved[4];
    if (text.kind !== "Text") {
      throw new Error("expected text");
    }
    expect(text.matrix).toBeTruthy();
    expect(text.text).toBe("hi");
    expect(text.size).toBe(20);
  });

  test("rejects unknown arguments, empty selections and locked layers", async () => {
    installBackend("editor");
    const id = await create([[100, 100]]);
    const { sceneId, layerId } = target(id);
    const before = json(id);
    await expect(
      docAlignShapes(id, sceneId, layerId, 0, [0], "sideways" as AlignMode, "stage")
    ).rejects.toThrow("unknown align mode");
    await expect(
      docAlignShapes(id, sceneId, layerId, 0, [0], "left", "canvas" as AlignReference)
    ).rejects.toThrow("unknown align reference");
    await expect(
      docAlignShapes(id, sceneId, layerId, 0, [], "left", "stage")
    ).rejects.toThrow("no shapes selected");
    await expect(
      docAlignShapes(id, sceneId, layerId, 0, [7], "left", "stage")
    ).rejects.toThrow("unknown shape");
    expect(json(id)).toBe(before);
    await docSetLayer(id, sceneId, layerId, { locked: true });
    const locked = json(id);
    await expect(
      docAlignShapes(id, sceneId, layerId, 0, [0], "left", "stage")
    ).rejects.toThrow("layer is locked");
    expect(json(id)).toBe(locked);
  });
});

describe("shape alignment UI", () => {
  test("aligns the marquee selection from the side panel", async () => {
    const doc = await opened([
      [100, 100],
      [150, 200],
      [300, 150]
    ]);
    const steps = undoLen(doc.id);
    await clickButton(alignButton(en["command.alignLeft"]));
    expect(axis(shapes(doc.id), true)).toEqual([100, 100, 100]);
    expect(undoLen(doc.id)).toBe(steps + 1);
    await press("z", { ctrlKey: true });
    await clickButton(alignButton(en["command.distributeH"]));
    expect(axis(shapes(doc.id), true)).toEqual([100, 200, 300]);
    expect(undoLen(doc.id)).toBe(steps + 1);
    await press("z", { ctrlKey: true });
    await clickButton(alignButton(en["command.alignTop"]));
    expect(axis(shapes(doc.id), false)).toEqual([100, 100, 100]);
    await press("z", { ctrlKey: true });
    expect(axis(shapes(doc.id), false)).toEqual([100, 200, 150]);
    expect(undoLen(doc.id)).toBe(steps);
  }, 20000);

  test("uses the selection reference by default", async () => {
    const doc = await opened([
      [100, 100],
      [300, 200]
    ]);
    const stage = referenceButton(en["align.stage"]);
    expect(pressed(referenceButton(en["align.selection"]))).toBe(true);
    expect(pressed(stage)).toBe(false);
    await clickButton(alignButton(en["command.alignLeft"]));
    expect(axis(shapes(doc.id), true)).toEqual([100, 100]);
    await press("z", { ctrlKey: true });
    expect(axis(shapes(doc.id), true)).toEqual([100, 300]);
    await clickButton(stage);
    expect(pressed(stage)).toBe(true);
    await clickButton(alignButton(en["command.alignLeft"]));
    expect(axis(shapes(doc.id), true)).toEqual([0, 0]);
  }, 20000);

  test("enables distribution once three shapes are selected", async () => {
    await opened([
      [100, 100],
      [300, 200],
      [200, 300]
    ]);
    for (const label of [
      en["command.alignLeft"],
      en["command.alignCenterH"],
      en["command.alignRight"],
      en["command.alignTop"],
      en["command.alignCenterV"],
      en["command.alignBottom"],
      en["command.distributeH"],
      en["command.distributeV"]
    ]) {
      expect(alignButton(label).disabled).toBe(false);
    }
  }, 20000);

  test("disables distribution below three shapes", async () => {
    await opened([
      [100, 100],
      [300, 200]
    ]);
    expect(alignButton(en["command.alignLeft"]).disabled).toBe(false);
    expect(alignButton(en["command.alignBottom"]).disabled).toBe(false);
    expect(alignButton(en["command.distributeH"]).disabled).toBe(true);
    expect(alignButton(en["command.distributeV"]).disabled).toBe(true);
  }, 20000);

  test("disables every align button without a selection", async () => {
    const { doc } = await renderEditor();
    await seed(doc.id, [[100, 100]]);
    await act(async () => {
      await emit("editor-open", doc.id);
    });
    await flush();
    await press("v");
    expect(alignButton(en["command.alignLeft"]).disabled).toBe(true);
    expect(alignButton(en["command.alignCenterV"]).disabled).toBe(true);
    expect(alignButton(en["command.distributeH"]).disabled).toBe(true);
  }, 20000);

  test("runs an align command from the palette", async () => {
    const doc = await opened([
      [100, 100],
      [150, 200],
      [300, 150]
    ]);
    await press("k", { ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    const box = screen.getByRole("combobox") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(box, { target: { value: en["command.alignLeft"] } });
    });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", bubbles: true });
    });
    await flush();
    await waitFor(() =>
      expect(axis(shapes(doc.id), true)).toEqual([100, 100, 100])
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 20000);
});
