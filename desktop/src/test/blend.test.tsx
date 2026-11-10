import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import en from "@/i18n/en.json";
import {
  docDraw,
  docEvaluate,
  docKeyframe,
  docNew,
  docRedo,
  docSetLayer,
  docUndo
} from "@/lib/document";
import { docDuplicateLayer } from "@/lib/tauri";
import type { Blend, Layer, Shape } from "@/lib/document";
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

function panel(): HTMLElement {
  const section = screen
    .getByRole("heading", { name: en["editor.layers"] })
    .closest("section");
  if (!section) {
    throw new Error("layers panel is not mounted");
  }
  return section as HTMLElement;
}

function slots(id: string) {
  const doc = state(id).doc;
  return {
    scene: doc.scenes[0].id,
    layer: doc.scenes[0].layers[0].id
  };
}

function blendOf(id: string, index = 0): Blend {
  return layersOf(id)[index].blend;
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

describe("layer blend engine", () => {
  test("every mode round-trips and undo restores the previous one", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    expect(blendOf(doc.id)).toBe("normal");
    const modes: Blend[] = [
      "multiply",
      "color-dodge",
      "hard-light",
      "luminosity",
      "normal"
    ];
    for (const mode of modes) {
      await docSetLayer(doc.id, scene, layer, { blend: mode });
      expect(blendOf(doc.id)).toBe(mode);
    }
    await docSetLayer(doc.id, scene, layer, { blend: "screen" });
    await docUndo(doc.id);
    expect(blendOf(doc.id)).toBe("normal");
    await docRedo(doc.id);
    expect(blendOf(doc.id)).toBe("screen");
  });

  test("evaluation carries the mode to every rendered frame", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    await docDraw(doc.id, scene, layer, 0, box(0));
    await docKeyframe(doc.id, scene, layer, 4, true);
    await docSetLayer(doc.id, scene, layer, { blend: "multiply" });
    const frames = await docEvaluate(doc.id, scene, 0, 4);
    for (const frame of frames) {
      expect(frame.layers[0].blend).toBe("multiply");
    }
  });

  test("duplicating a layer copies its blend mode", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    await docSetLayer(doc.id, scene, layer, { blend: "overlay" });
    const next = await docDuplicateLayer(doc.id, scene, layer);
    const copies = next.scenes[0].layers.filter((item) => item.blend === "overlay");
    expect(copies.length).toBe(2);
  });

  test("an unknown mode is rejected and leaves the layer alone", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const { scene, layer } = slots(doc.id);
    await docSetLayer(doc.id, scene, layer, { blend: "difference" });
    await expect(
      docSetLayer(doc.id, scene, layer, { blend: "hardlight" as Blend })
    ).rejects.toThrow(/blend/);
    expect(blendOf(doc.id)).toBe("difference");
  });
});

describe("layer blend controls", () => {
  test("the panel writes the mode and the canvas blends the layer", async () => {
    const { doc } = await renderEditor();
    const { scene, layer } = slots(doc.id);
    await docDraw(doc.id, scene, layer, 0, box(0));
    await flush();
    const select = screen.getByLabelText(en["editor.layerBlend"]) as HTMLSelectElement;
    expect(select.value).toBe("normal");
    await act(async () => {
      fireEvent.change(select, { target: { value: "multiply" } });
    });
    await flush();
    expect(blendOf(doc.id)).toBe("multiply");
    expect(select.value).toBe("multiply");
    const group = getCanvas().querySelector(":scope > g > g[transform]")!;
    expect(group.getAttribute("style")).toContain("mix-blend-mode: multiply");
    await act(async () => {
      fireEvent.change(select, { target: { value: "normal" } });
    });
    await flush();
    expect(group.getAttribute("style") ?? "").not.toContain("mix-blend-mode");
  });

  test("undo from the keyboard clears the blend and the style", async () => {
    const { doc } = await renderEditor();
    const { scene, layer } = slots(doc.id);
    await docDraw(doc.id, scene, layer, 0, box(0));
    await flush();
    const select = screen.getByLabelText(en["editor.layerBlend"]) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "screen" } });
    });
    await flush();
    const group = getCanvas().querySelector(":scope > g > g[transform]")!;
    expect(group.getAttribute("style")).toContain("mix-blend-mode: screen");
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });
    await flush();
    expect(blendOf(doc.id)).toBe("normal");
    expect(select.value).toBe("normal");
    expect(group.getAttribute("style") ?? "").not.toContain("mix-blend-mode");
  });

  test("the blend select lists every mode", async () => {
    await renderEditor();
    const select = screen.getByLabelText(en["editor.layerBlend"]) as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option"));
    expect(options.map((option) => option.value)).toEqual([
      "normal",
      "multiply",
      "screen",
      "overlay",
      "darken",
      "lighten",
      "color-dodge",
      "color-burn",
      "hard-light",
      "soft-light",
      "difference",
      "exclusion",
      "hue",
      "saturation",
      "color",
      "luminosity"
    ]);
    const catalog = en as Record<string, string>;
    expect(options.map((option) => option.textContent)).toEqual(
      options.map((option) => catalog[`blend.${option.value}`])
    );
  });

  test("the select follows the active layer", async () => {
    const { doc } = await renderEditor();
    const select = screen.getByLabelText(en["editor.layerBlend"]) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "hard-light" } });
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en["command.addLayer"] }));
    });
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    expect(select.value).toBe("normal");
    await act(async () => {
      fireEvent.change(select, { target: { value: "exclusion" } });
    });
    await flush();
    expect(layersOf(doc.id).map((item) => item.blend)).toEqual(["exclusion", "hard-light"]);
    await act(async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "Layer 1" }));
    });
    await flush();
    expect(select.value).toBe("hard-light");
    const styles = Array.from(
      getCanvas().querySelectorAll(":scope > g > g[transform]")
    ).map((group) => group.getAttribute("style") ?? "");
    expect(styles.some((style) => style.includes("mix-blend-mode: hard-light"))).toBe(true);
    expect(styles.some((style) => style.includes("mix-blend-mode: exclusion"))).toBe(true);
  });

  test("the palette command writes the mode to the chosen layer", async () => {
    const { doc } = await renderEditor();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en["command.addLayer"] }));
    });
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    await press("k", { ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    const search = screen.getByRole("combobox");
    await act(async () => {
      fireEvent.change(search, { target: { value: en["command.layerBlend"] } });
    });
    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter", bubbles: true });
    });
    await waitFor(() =>
      expect(screen.getByRole("dialog").querySelector("form")).toBeTruthy()
    );
    const form = screen.getByRole("dialog");
    const [layerChoice, blendChoice] = [
      within(form).getByLabelText(en["palette.arg.layer"]) as HTMLSelectElement,
      within(form).getByLabelText(en["palette.arg.blend"]) as HTMLSelectElement
    ];
    expect(blendChoice.value).toBe("normal");
    await act(async () => {
      fireEvent.change(layerChoice, { target: { value: layersOf(doc.id)[1].id } });
      fireEvent.change(blendChoice, { target: { value: "luminosity" } });
    });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: en["palette.run"] }));
    });
    await waitFor(() =>
      expect(layersOf(doc.id).map((item) => item.blend)).toEqual(["normal", "luminosity"])
    );
  });

  test("the history panel names the blend step", async () => {
    const { doc } = await renderEditor();
    const select = screen.getByLabelText(en["editor.layerBlend"]) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "overlay" } });
    });
    await flush();
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
    expect(await screen.findByRole("button", { name: en["history.step.layer_blend"] })).toBeTruthy();
    expect(blendOf(doc.id)).toBe("overlay");
  });
});
