import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import en from "@/i18n/en.json";
import {
  cssEffects,
  docDraw,
  docEvaluate,
  docKeyframe,
  docNew,
  docRedo,
  docSetLayer,
  docUndo
} from "@/lib/document";
import { docDuplicateLayer } from "@/lib/tauri";
import type { Effect, Layer, Shape } from "@/lib/document";
import { installBackend, store } from "./backend";
import { flush, getCanvas, press, renderEditor } from "./utils";

function state(id: string) {
  const found = store.get(id);
  if (!found) {
    throw new Error("document is not in the store");
  }
  return found;
}

function layersOf(id: string): Layer[] {
  return state(id).doc.scenes[0].layers;
}

function slots(id: string) {
  const doc = state(id).doc;
  return {
    scene: doc.scenes[0].id,
    layer: doc.scenes[0].layers[0].id
  };
}

function effectsOf(id: string): Effect[] {
  return layersOf(id)[0].effects;
}

function box(x: number): Shape {
  return {
    kind: "Rect",
    x,
    y: 10,
    w: 40,
    h: 40,
    fill: "#ff0000",
    stroke: "none",
    width: 0,
    gradient: null
  };
}

function filterText(): string {
  const group = getCanvas().querySelector(":scope > g > g[transform]")!;
  return /filter:\s*([^;]+)/.exec(group.getAttribute("style") ?? "")?.[1].trim() ?? "";
}

async function change(target: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(target, { target: { value } });
  });
  await flush();
}

async function clickButton(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  await flush();
}

describe("layer effect engine", () => {
  test("effects round-trip and undo restores the previous list", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    const blur: Effect[] = [{ kind: "blur", radius: 12 }];
    const shadow: Effect[] = [{ kind: "shadow", x: 3, y: -4, blur: 6, color: "#1e293b" }];
    await docSetLayer(doc.id, scene, layer, { effects: blur });
    expect(effectsOf(doc.id)).toEqual(blur);
    await docSetLayer(doc.id, scene, layer, { effects: shadow });
    expect(effectsOf(doc.id)).toEqual(shadow);
    await docUndo(doc.id);
    expect(effectsOf(doc.id)).toEqual(blur);
    await docRedo(doc.id);
    expect(effectsOf(doc.id)).toEqual(shadow);
    await docSetLayer(doc.id, scene, layer, { effects: [] });
    expect(effectsOf(doc.id)).toEqual([]);
  });

  test("out-of-range values are clamped", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    await docSetLayer(doc.id, scene, layer, {
      effects: [
        { kind: "blur", radius: 4000 },
        { kind: "shadow", x: -900, y: 20, blur: Number.NaN, color: "#000000" }
      ]
    });
    expect(effectsOf(doc.id)).toEqual([
      { kind: "blur", radius: 500 },
      { kind: "shadow", x: -500, y: 20, blur: 0, color: "#000000" }
    ]);
  });

  test("evaluation carries effects to every rendered frame", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    await docDraw(doc.id, scene, layer, 0, box(0));
    await docKeyframe(doc.id, scene, layer, 4, true);
    const effects: Effect[] = [
      { kind: "blur", radius: 5 },
      { kind: "shadow", x: 0, y: 0, blur: 10, color: "#22c55e" }
    ];
    await docSetLayer(doc.id, scene, layer, { effects });
    const frames = await docEvaluate(doc.id, scene, 0, 4);
    for (const frame of frames) {
      expect(frame.layers[0].effects).toEqual(effects);
    }
    expect(cssEffects(effects)).toBe("blur(5px) drop-shadow(0px 0px 10px #22c55e)");
  });

  test("duplicating a layer copies its effects", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    const effects: Effect[] = [{ kind: "blur", radius: 7 }];
    await docSetLayer(doc.id, scene, layer, { effects });
    const next = await docDuplicateLayer(doc.id, scene, layer);
    const copies = next.scenes[0].layers.filter((item) => item.effects.length === 1);
    expect(copies.length).toBe(2);
    expect(copies[1].effects).toEqual(effects);
  });
});

describe("layer effect controls", () => {
  test("adding a blur writes the filter and paints the canvas", async () => {
    const { doc } = await renderEditor();
    await docDraw(doc.id, slots(doc.id).scene, slots(doc.id).layer, 0, box(0));
    await flush();
    expect(effectsOf(doc.id)).toEqual([]);
    expect(filterText()).toBe("");
    await clickButton(en["editor.addEffect"]);
    expect(effectsOf(doc.id)).toEqual([{ kind: "blur", radius: 8 }]);
    expect(filterText()).toBe("blur(8px)");
    const radius = screen.getByLabelText(en["editor.effectRadius"]) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(radius, { target: { value: "24" } });
    });
    await act(async () => {
      fireEvent.blur(radius);
    });
    await flush();
    expect(effectsOf(doc.id)).toEqual([{ kind: "blur", radius: 24 }]);
    expect(filterText()).toBe("blur(24px)");
    await clickButton(en["editor.removeEffect"]);
    expect(effectsOf(doc.id)).toEqual([]);
    expect(filterText()).toBe("");
  });

  test("switching to shadow exposes offsets, blur and color", async () => {
    const { doc } = await renderEditor();
    await clickButton(en["editor.addEffect"]);
    const kind = screen.getByLabelText(en["editor.effectKind"]) as HTMLSelectElement;
    expect(kind.value).toBe("blur");
    await change(kind, "shadow");
    expect(effectsOf(doc.id)).toEqual([
      { kind: "shadow", x: 4, y: 4, blur: 6, color: "#000000" }
    ]);
    expect(filterText()).toBe("drop-shadow(4px 4px 6px #000000)");
    expect(screen.getByLabelText(en["editor.effectOffsetX"])).toBeTruthy();
    expect(screen.getByLabelText(en["editor.effectOffsetY"])).toBeTruthy();
    expect(screen.getByLabelText(en["editor.effectBlur"])).toBeTruthy();
    expect(screen.getByLabelText(en["editor.effectColor"])).toBeTruthy();
    const offset = screen.getByLabelText(en["editor.effectOffsetX"]) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(offset, { target: { value: "-9" } });
    });
    await act(async () => {
      fireEvent.blur(offset);
    });
    await flush();
    expect(filterText()).toBe("drop-shadow(-9px 4px 6px #000000)");
  });

  test("stacked effects list in order", async () => {
    const { doc } = await renderEditor();
    await clickButton(en["editor.addEffect"]);
    const kind = screen.getByLabelText(en["editor.effectKind"]) as HTMLSelectElement;
    await change(kind, "shadow");
    await clickButton(en["editor.addEffect"]);
    expect(effectsOf(doc.id).map((effect) => effect.kind)).toEqual(["shadow", "blur"]);
    expect(filterText()).toBe("drop-shadow(4px 4px 6px #000000) blur(8px)");
    const removes = screen.getAllByRole("button", { name: en["editor.removeEffect"] });
    await act(async () => {
      fireEvent.click(removes[0]);
    });
    await flush();
    expect(effectsOf(doc.id).map((effect) => effect.kind)).toEqual(["blur"]);
    expect(filterText()).toBe("blur(8px)");
  });

  test("keyboard undo reverts the newest effect change", async () => {
    const { doc } = await renderEditor();
    await clickButton(en["editor.addEffect"]);
    await press("z", { ctrlKey: true });
    expect(effectsOf(doc.id)).toEqual([]);
    expect(filterText()).toBe("");
  });

  test("the history panel names the effects step", async () => {
    const { doc } = await renderEditor();
    await clickButton(en["editor.addEffect"]);
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole("button", { name: en["workspace.title"] }), {
        button: 0
      });
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: en["panel.history"] }));
    });
    await flush();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: en["panel.history"] }));
    });
    await flush();
    expect(await screen.findByRole("button", { name: en["history.step.layer_effects"] })).toBeTruthy();
    expect(effectsOf(doc.id)).toEqual([{ kind: "blur", radius: 8 }]);
  });
});

describe("effect entry points", () => {
  test("the layers panel marks layers that carry effects", async () => {
    await renderEditor();
    const section = screen.getByRole("heading", { name: en["editor.layers"] }).closest("section");
    expect(within(section as HTMLElement).queryByText("fx")).toBeNull();
    await clickButton(en["editor.addEffect"]);
    expect(within(section as HTMLElement).getByText("fx")).toBeTruthy();
    await clickButton(en["editor.removeEffect"]);
    expect(within(section as HTMLElement).queryByText("fx")).toBeNull();
  });
});
