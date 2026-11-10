import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import en from "@/i18n/en.json";
import {
  TEXT_LEADING,
  docDraw,
  docEvaluate,
  docKeyframe,
  docNew,
  docRedo,
  docReplaceShape,
  docSetTween,
  docUndo,
  shapeBounds,
  textLayout,
  textLinePositions
} from "@/lib/document";
import type { Shape } from "@/lib/document";
import { docHistory } from "@/lib/history";
import { installBackend, store } from "./backend";
import { click, flush, getCanvas, press, renderEditor } from "./utils";

type TextShape = Extract<Shape, { kind: "Text" }>;

function state(id: string) {
  const found = store.get(id);
  if (!found) {
    throw new Error("document is not in the store");
  }
  return found;
}

function slots(id: string): { scene: string; layer: string } {
  const doc = state(id).doc;
  return { scene: doc.scenes[0].id, layer: doc.scenes[0].layers[0].id };
}

function shapeAt(id: string, frame: number): Shape {
  const layer = state(id).doc.scenes[0].layers[0];
  const key = layer.keys.find((item) => item.frame === frame);
  if (!key || key.shapes.length === 0) {
    throw new Error(`no shape is held at frame ${frame}`);
  }
  return key.shapes[0];
}

function text(value: string, overrides: Partial<TextShape> = {}): TextShape {
  return {
    kind: "Text",
    x: 10,
    y: 20,
    text: value,
    size: 10,
    family: "sans-serif",
    color: "#111827",
    spacing: 0,
    leading: TEXT_LEADING,
    align: "left",
    matrix: null,
    ...overrides
  };
}

const alignLabels: Record<"left" | "center" | "right", string> = {
  left: en["editor.alignLeft"],
  center: en["editor.alignCenter"],
  right: en["editor.alignRight"]
};

function shapeSection(): HTMLElement {
  const section = screen
    .getByRole("heading", { name: en["editor.shape"] })
    .closest("section");
  if (!section) {
    throw new Error("shape section is not mounted");
  }
  return section as HTMLElement;
}

function painted(): Element {
  const node = getCanvas().querySelector("text");
  if (!node) {
    throw new Error("no text is painted");
  }
  return node;
}

function rows(): Array<{ text: string; x: number; y: number }> {
  return [...painted().querySelectorAll("tspan")].map((span) => ({
    text: span.textContent ?? "",
    x: Number(span.getAttribute("x")),
    y: Number(span.getAttribute("y"))
  }));
}

function attr(name: string): string {
  return painted().getAttribute(name) ?? "";
}

function selBox(): Element {
  const found = getCanvas().querySelector("[data-selection-box]");
  if (!found) {
    throw new Error("selection box not found");
  }
  return found;
}

async function setField(label: string, value: string): Promise<void> {
  const input = within(shapeSection()).getByRole("spinbutton", { name: label });
  await act(async () => {
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
  });
  await flush();
}

async function setDraft(value: string): Promise<void> {
  const area = within(shapeSection()).getByRole("textbox", {
    name: en["editor.textContent"]
  });
  await act(async () => {
    fireEvent.change(area, { target: { value } });
  });
  await act(async () => {
    fireEvent.blur(area);
  });
  await flush();
}

async function alignWith(mode: "left" | "center" | "right"): Promise<void> {
  await act(async () => {
    fireEvent.click(within(shapeSection()).getByRole("button", { name: alignLabels[mode] }));
  });
  await flush();
}

function pressed(mode: "left" | "center" | "right"): string | null {
  return within(shapeSection())
    .getByRole("button", { name: alignLabels[mode] })
    .getAttribute("aria-pressed");
}

async function selectedText() {
  const view = await renderEditor();
  await press("t");
  await click(getCanvas(), [100, 100]);
  await press("v");
  await click(painted(), [105, 105]);
  return view;
}

describe("text paragraph model", () => {
  test("a legacy text shape keeps its single-line layout", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    const legacy = {
      kind: "Text",
      x: 10,
      y: 20,
      text: "AB",
      size: 10,
      family: "sans-serif",
      color: "#111827"
    } as Shape;
    await docDraw(doc.id, scene, layer, 0, legacy);
    const stored = shapeAt(doc.id, 0) as TextShape;
    expect(stored).toEqual(legacy);
    expect(textLayout(stored)).toMatchObject({
      spacing: 0,
      leading: 1.2,
      align: "left",
      block: 12,
      height: 10
    });
    expect(shapeBounds(stored)).toEqual({ x: 10, y: 20, w: 12, h: 10 });
    expect(textLinePositions(stored)).toEqual([{ text: "AB", x: 10, y: 20 }]);
  });

  test("extra rows grow the bounds with leading and spacing", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    await docDraw(doc.id, scene, layer, 0, text("A\nBCD", { spacing: 2, leading: 2 }));
    const stored = shapeAt(doc.id, 0) as TextShape;
    expect(stored.text).toBe("A\nBCD");
    expect(textLayout(stored)).toMatchObject({ block: 22, height: 30, lineHeight: 20 });
    expect(shapeBounds(stored)).toEqual({ x: 10, y: 20, w: 22, h: 30 });
  });

  test("line positions follow the paragraph alignment", async () => {
    expect(textLinePositions(text("A\nBCD", { align: "left" })).map((row) => row.x)).toEqual([10, 10]);
    expect(
      textLinePositions(text("A\nBCD", { spacing: 2, align: "center" })).map((row) => row.x)
    ).toEqual([18, 10]);
    expect(
      textLinePositions(text("A\nBCD", { spacing: 2, align: "right" })).map((row) => row.x)
    ).toEqual([26, 10]);
    expect(
      textLinePositions(text("A\nBCD\nE", { leading: 3 })).map((row) => row.y)
    ).toEqual([20, 50, 80]);
  });

  test("the backend rejects paragraph values outside the supported ranges", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    await expect(
      docDraw(doc.id, scene, layer, 0, text("A", { spacing: 600 }))
    ).rejects.toThrow("text spacing must be between -500 and 500");
    await expect(
      docDraw(doc.id, scene, layer, 0, text("A", { leading: 0.1 }))
    ).rejects.toThrow("text line spacing must be between 0.2 and 10");
    await expect(
      docDraw(doc.id, scene, layer, 0, { ...text("A"), align: "justify" } as unknown as Shape)
    ).rejects.toThrow("unknown text alignment");
    expect(state(doc.id).undo).toHaveLength(0);
  });

  test("tweens interpolate spacing and leading while holding the alignment", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    await docDraw(doc.id, scene, layer, 0, text("Hi"));
    await docKeyframe(doc.id, scene, layer, 2, true);
    await docDraw(
      doc.id,
      scene,
      layer,
      2,
      text("Hi", { spacing: 10, leading: 3.2, align: "center", size: 20 })
    );
    await docSetTween(doc.id, scene, layer, 0, true);
    const frames = await docEvaluate(doc.id, scene, 0, 2);
    expect(frames[1].layers[0].shapes[0]).toMatchObject({
      kind: "Text",
      size: 15,
      spacing: 5,
      leading: 2.2,
      align: "left"
    });
    expect(frames[2].layers[0].shapes[0]).toMatchObject({ spacing: 10, align: "center" });
  });

  test("paragraph edits are one named undo step each", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    await docDraw(doc.id, scene, layer, 0, text("A"));
    await docReplaceShape(doc.id, scene, layer, 0, 0, text("A\nB", { x: 10 }));
    expect((shapeAt(doc.id, 0) as TextShape).text).toBe("A\nB");
    await docReplaceShape(doc.id, scene, layer, 0, 0, text("A\nB", { x: 40, spacing: 4 }));
    expect((shapeAt(doc.id, 0) as TextShape).x).toBe(40);
    expect(
      (await docHistory(doc.id)).map((step) => step.name)
    ).toEqual(["new_document", "draw_text", "replace_shape", "replace_shape"]);
    await docUndo(doc.id);
    expect((shapeAt(doc.id, 0) as TextShape)).toMatchObject({ x: 10, spacing: 0 });
    await docUndo(doc.id);
    expect((shapeAt(doc.id, 0) as TextShape).text).toBe("A");
    await docRedo(doc.id);
    await docRedo(doc.id);
    expect((shapeAt(doc.id, 0) as TextShape)).toMatchObject({ x: 40, spacing: 4 });
  });
});

describe("text paragraph controls", () => {
  test("the text tool places a paragraph-ready shape with panel defaults", async () => {
    const { doc } = await selectedText();
    const placed = shapeAt(doc.id, 0) as TextShape;
    expect(placed).toMatchObject({
      kind: "Text",
      x: 100,
      y: 100,
      size: 32,
      family: "Segoe UI",
      spacing: 0,
      leading: 1.2,
      align: "left"
    });
    expect(attr("letter-spacing")).toBe("0");
    expect(rows()).toEqual([{ text: "Text", x: 100, y: 100 }]);
    expect(
      (within(shapeSection()).getByRole("textbox", { name: en["editor.textContent"] }) as HTMLTextAreaElement).value
    ).toBe("Text");
    expect(
      (within(shapeSection()).getByRole("spinbutton", { name: en["editor.letterSpacing"] }) as HTMLInputElement).value
    ).toBe("0");
    expect(
      (within(shapeSection()).getByRole("spinbutton", { name: en["editor.lineSpacing"] }) as HTMLInputElement).value
    ).toBe("1.2");
    expect(pressed("left")).toBe("true");
    expect(pressed("center")).toBe("false");
  });

  test("a newline paints another row and grows the selection box", async () => {
    const { doc } = await selectedText();
    expect(Number(selBox().getAttribute("height"))).toBeCloseTo(32, 6);
    await setDraft("Hi\nThere");
    expect((shapeAt(doc.id, 0) as TextShape).text).toBe("Hi\nThere");
    expect(rows()).toEqual([
      { text: "Hi", x: 100, y: 100 },
      { text: "There", x: 100, y: 138.4 }
    ]);
    expect(Number(selBox().getAttribute("width"))).toBeCloseTo(96, 6);
    expect(Number(selBox().getAttribute("height"))).toBeCloseTo(70.4, 6);
  });

  test("letter spacing and line spacing fields move the rows on the canvas", async () => {
    const { doc } = await selectedText();
    await setDraft("Hi\nThere");
    await setField(en["editor.letterSpacing"], "4");
    await setField(en["editor.lineSpacing"], "3");
    const stored = shapeAt(doc.id, 0) as TextShape;
    expect(stored).toMatchObject({ spacing: 4, leading: 3 });
    expect(attr("letter-spacing")).toBe("4");
    expect(rows()).toEqual([
      { text: "Hi", x: 100, y: 100 },
      { text: "There", x: 100, y: 196 }
    ]);
    expect(Number(selBox().getAttribute("width"))).toBeCloseTo(112, 6);
    expect(Number(selBox().getAttribute("height"))).toBeCloseTo(128, 6);
    await setField(en["editor.letterSpacing"], "-1");
    expect((shapeAt(doc.id, 0) as TextShape).spacing).toBe(-1);
    expect(attr("letter-spacing")).toBe("-1");
  });

  test("the alignment buttons re-anchor every row", async () => {
    const { doc } = await selectedText();
    await setDraft("Hi\nThere");
    await alignWith("center");
    expect((shapeAt(doc.id, 0) as TextShape).align).toBe("center");
    expect(pressed("center")).toBe("true");
    expect(rows().map((row) => row.x)).toEqual([128.8, 100]);
    await alignWith("right");
    expect((shapeAt(doc.id, 0) as TextShape).align).toBe("right");
    expect(pressed("right")).toBe("true");
    expect(pressed("center")).toBe("false");
    expect(rows().map((row) => row.x)).toEqual([157.6, 100]);
    expect(Number(selBox().getAttribute("width"))).toBeCloseTo(96, 6);
    await alignWith("left");
    expect(rows().map((row) => row.x)).toEqual([100, 100]);
  });

  test("carriage returns become line breaks", async () => {
    const { doc } = await selectedText();
    await setDraft("A\r\nB\rC");
    expect((shapeAt(doc.id, 0) as TextShape).text).toBe("A\nB\nC");
    expect(rows().map((row) => row.text)).toEqual(["A", "B", "C"]);
  });

  test("an empty draft never replaces the paragraph", async () => {
    const { doc } = await selectedText();
    await setDraft("Two\nrows");
    await setDraft("   ");
    expect((shapeAt(doc.id, 0) as TextShape).text).toBe("Two\nrows");
    expect(rows()).toHaveLength(2);
  });
  test("undo and redo restore the paragraph as a single step", async () => {
    const { doc } = await selectedText();
    const undoBefore = state(doc.id).undo.length;
    await setDraft("One\nTwo\nThree");
    await setField(en["editor.lineSpacing"], "2.5");
    expect(state(doc.id).undo.length).toBe(undoBefore + 2);
    expect(rows()).toEqual([
      { text: "One", x: 100, y: 100 },
      { text: "Two", x: 100, y: 180 },
      { text: "Three", x: 100, y: 260 }
    ]);
    await press("z", { ctrlKey: true });
    expect((shapeAt(doc.id, 0) as TextShape).leading).toBe(1.2);
    expect(rows()[2].y).toBeCloseTo(100 + 2 * 32 * 1.2, 6);
    await press("z", { ctrlKey: true });
    expect((shapeAt(doc.id, 0) as TextShape).text).toBe("Text");
    expect(rows()).toHaveLength(1);
    await press("z", { ctrlKey: true, shiftKey: true });
    await press("z", { ctrlKey: true, shiftKey: true });
    expect((shapeAt(doc.id, 0) as TextShape)).toMatchObject({
      text: "One\nTwo\nThree",
      leading: 2.5
    });
    expect(rows()).toHaveLength(3);
  });
});
