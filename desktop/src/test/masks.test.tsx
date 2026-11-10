import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import en from "@/i18n/en.json";
import {
  docAddLayer,
  docDraw,
  docEvaluate,
  docKeyframe,
  docMoveLayer,
  docNew,
  docRedo,
  docRemoveLayer,
  docSetLayer,
  docUndo
} from "@/lib/document";
import { docDuplicateLayer } from "@/lib/tauri";
import { docHistory } from "@/lib/history";
import type { Layer, Shape } from "@/lib/document";
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

function sceneOf(id: string): string {
  return state(id).doc.scenes[0].id;
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

function toggles(): HTMLElement[] {
  return within(panel()).getAllByRole("button", {
    name: en["editor.layerMask"]
  }) as HTMLElement[];
}

function flags(id: string): boolean[] {
  return layersOf(id).map((item) => item.masked);
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

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(target);
  });
  await flush();
}

async function addLayer(): Promise<void> {
  await click(screen.getByRole("button", { name: en["command.addLayer"] }));
  await flush();
}

async function showHistory(): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(screen.getByRole("button", { name: en["workspace.title"] }), {
      button: 0
    });
  });
  await flush();
  await click(screen.getByRole("menuitemcheckbox", { name: en["panel.history"] }));
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  });
  await flush();
  await click(screen.getByRole("tab", { name: en["panel.history"] }));
}

describe("layer mask engine", () => {
  test("clipping round-trips and undo restores the previous state", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const scene = sceneOf(doc.id);
    await docAddLayer(doc.id, scene, "Mask");
    const [top, bottom] = layersOf(doc.id);
    expect(flags(doc.id)).toEqual([false, false]);
    await docSetLayer(doc.id, scene, bottom!.id, { masked: true });
    expect(flags(doc.id)).toEqual([false, true]);
    await docSetLayer(doc.id, scene, bottom!.id, { masked: false });
    expect(flags(doc.id)).toEqual([false, false]);
    await docSetLayer(doc.id, scene, bottom!.id, { masked: true });
    await docUndo(doc.id);
    expect(flags(doc.id)).toEqual([false, false]);
    await docRedo(doc.id);
    expect(flags(doc.id)).toEqual([false, true]);
    expect(top!.masked).toBe(false);
  });

  test("the top layer cannot be clipped", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const scene = sceneOf(doc.id);
    const [top] = layersOf(doc.id);
    await expect(
      docSetLayer(doc.id, scene, top!.id, { masked: true })
    ).rejects.toThrow("the top layer cannot be clipped");
    expect(flags(doc.id)).toEqual([false]);
    expect(state(doc.id).undo).toHaveLength(0);
  });

  test("a clip provider cannot itself be clipped", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const scene = sceneOf(doc.id);
    await docAddLayer(doc.id, scene, "Middle");
    await docAddLayer(doc.id, scene, "Top");
    const [top, middle, bottom] = layersOf(doc.id);
    await docSetLayer(doc.id, scene, middle!.id, { masked: true });
    expect(flags(doc.id)).toEqual([false, true, false]);
    await expect(
      docSetLayer(doc.id, scene, bottom!.id, { masked: true })
    ).rejects.toThrow("a mask layer cannot itself be clipped");
    expect(flags(doc.id)).toEqual([false, true, false]);
    await docSetLayer(doc.id, scene, top!.id, { visible: false });
    expect(flags(doc.id)).toEqual([false, true, false]);
  });

  test("evaluation clips to the layer directly above while it lasts", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const scene = sceneOf(doc.id);
    const content = layersOf(doc.id)[0]!;
    await docDraw(doc.id, scene, content.id, 0, box(100));
    await docKeyframe(doc.id, scene, content.id, 4, true);
    await docAddLayer(doc.id, scene, "Mask");
    const provider = layersOf(doc.id)[0]!;
    await docDraw(doc.id, scene, provider.id, 0, box(0));
    await docSetLayer(doc.id, scene, provider.id, {
      opacity: 0.4,
      blend: "multiply",
      effects: [{ kind: "blur", radius: 6 }]
    });
    await docSetLayer(doc.id, scene, content.id, { masked: true });
    const frames = await docEvaluate(doc.id, scene, 0, 4);
    expect(frames).toHaveLength(5);
    const first = frames[0]!.layers;
    expect(first).toHaveLength(2);
    expect(first[1]!.mask!.shapes).toEqual(first[0]!.shapes);
    expect(first[1]!.mask!.transform).toEqual(first[0]!.transform);
    for (const frame of frames.slice(1)) {
      expect(frame.layers).toHaveLength(1);
      expect(frame.layers[0]!.id).toBe(content.id);
      expect(frame.layers[0]!.mask).toBeNull();
    }
    await docSetLayer(doc.id, scene, provider.id, { visible: true });
    await docSetLayer(doc.id, scene, provider.id, { visible: false });
    const hidden = await docEvaluate(doc.id, scene, 0, 0);
    expect(hidden[0]!.layers).toHaveLength(1);
    expect(hidden[0]!.layers[0]!.mask).toBeNull();
  });

  test("the clip follows the layer above after the stack moves", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const scene = sceneOf(doc.id);
    const content = layersOf(doc.id)[0]!;
    await docDraw(doc.id, scene, content.id, 0, box(100));
    await docAddLayer(doc.id, scene, "First");
    await docAddLayer(doc.id, scene, "Second");
    const [second, first] = layersOf(doc.id);
    await docDraw(doc.id, scene, first!.id, 0, box(0));
    await docDraw(doc.id, scene, second!.id, 0, box(200));
    await docSetLayer(doc.id, scene, content.id, { masked: true });
    expect(flags(doc.id)).toEqual([false, false, true]);
    let layers = (await docEvaluate(doc.id, scene, 0, 0))[0]!.layers;
    expect(layers[2]!.mask!.shapes).toEqual([box(0)]);
    await docMoveLayer(doc.id, scene, first!.id, 0);
    expect(flags(doc.id)).toEqual([false, false, true]);
    layers = (await docEvaluate(doc.id, scene, 0, 0))[0]!.layers;
    expect(layers[2]!.mask!.shapes).toEqual([box(200)]);
    await docMoveLayer(doc.id, scene, content.id, 0);
    expect(flags(doc.id)).toEqual([false, false, false]);
    layers = (await docEvaluate(doc.id, scene, 0, 0))[0]!.layers;
    expect(layers[0]!.mask).toBeNull();
  });

  test("duplicating or removing a clip keeps the stack valid", async () => {
    installBackend("editor");
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const scene = sceneOf(doc.id);
    const content = layersOf(doc.id)[0]!;
    await docDraw(doc.id, scene, content.id, 0, box(100));
    await docAddLayer(doc.id, scene, "Mask");
    const provider = layersOf(doc.id)[0]!;
    await docDraw(doc.id, scene, provider.id, 0, box(0));
    await docSetLayer(doc.id, scene, content.id, { masked: true });
    const next = await docDuplicateLayer(doc.id, scene, content.id);
    expect(next.scenes[0].layers.map((item) => item.masked)).toEqual([
      false,
      true,
      false
    ]);
    await docRemoveLayer(doc.id, scene, provider.id);
    expect(flags(doc.id)).toEqual([false, false]);
    const steps = await docHistory(doc.id);
    expect(steps.map((step) => step.name)).toEqual([
      "new_document",
      "draw_rect",
      "add_layer",
      "draw_rect",
      "layer_mask",
      "duplicate_layer",
      "remove_layer"
    ]);
  });
});

describe("layer mask controls", () => {
  test("the panel toggle clips the layer and the canvas carries the clip path", async () => {
    const { doc } = await renderEditor();
    await docDraw(doc.id, sceneOf(doc.id), layersOf(doc.id)[0]!.id, 0, box(100));
    await flush();
    await addLayer();
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    await docDraw(doc.id, sceneOf(doc.id), layersOf(doc.id)[0]!.id, 0, box(0));
    await flush();
    expect(getCanvas().querySelector("[clip-path]")).toBeNull();
    expect(toggles()[0]!.hasAttribute("disabled")).toBe(true);
    expect(toggles()[1]!.getAttribute("aria-pressed")).toBe("false");
    await click(toggles()[1]!);
    expect(flags(doc.id)).toEqual([false, true]);
    expect(toggles()[1]!.getAttribute("aria-pressed")).toBe("true");
    const clipped = getCanvas().querySelector("[clip-path]") as HTMLElement;
    expect(clipped.getAttribute("clip-path")).toBe(
      `url(#clip-${layersOf(doc.id)[1]!.id})`
    );
    const clipPath = getCanvas().querySelector("clipPath")!;
    expect(clipPath.getAttribute("clipPathUnits")).toBe("userSpaceOnUse");
    expect(clipPath.querySelectorAll("rect")).toHaveLength(1);
    await click(toggles()[1]!);
    expect(flags(doc.id)).toEqual([false, false]);
    expect(getCanvas().querySelector("[clip-path]")).toBeNull();
    expect(getCanvas().querySelector("clipPath")).toBeNull();
  });

  test("keyboard undo releases the clip", async () => {
    const { doc } = await renderEditor();
    await addLayer();
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    await click(toggles()[1]!);
    expect(flags(doc.id)).toEqual([false, true]);
    await press("z", { ctrlKey: true });
    expect(flags(doc.id)).toEqual([false, false]);
    expect(toggles()[1]!.getAttribute("aria-pressed")).toBe("false");
    expect(getCanvas().querySelector("clipPath")).toBeNull();
    await press("z", { ctrlKey: true, shiftKey: true });
    expect(flags(doc.id)).toEqual([false, true]);
    expect(getCanvas().querySelector("clipPath")).toBeTruthy();
  });

  test("the palette command clips the chosen layer", async () => {
    const { doc } = await renderEditor();
    await addLayer();
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    await press("k", { ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    const search = screen.getByRole("combobox");
    await act(async () => {
      fireEvent.change(search, { target: { value: en["command.layerMask"] } });
    });
    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter", bubbles: true });
    });
    await waitFor(() =>
      expect(screen.getByRole("dialog").querySelector("form")).toBeTruthy()
    );
    const form = screen.getByRole("dialog");
    const [layerChoice, maskChoice] = [
      within(form).getByLabelText(en["palette.arg.layer"]) as HTMLSelectElement,
      within(form).getByLabelText(en["palette.arg.mask"]) as HTMLSelectElement
    ];
    expect(maskChoice.value).toBe("off");
    await act(async () => {
      fireEvent.change(layerChoice, { target: { value: layersOf(doc.id)[1]!.id } });
      fireEvent.change(maskChoice, { target: { value: "on" } });
    });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: en["palette.run"] }));
    });
    await waitFor(() => expect(flags(doc.id)).toEqual([false, true]));
    expect(getCanvas().querySelector("clipPath")).toBeTruthy();
  });

  test("the history panel names the mask step", async () => {
    const { doc } = await renderEditor();
    await addLayer();
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    await click(toggles()[1]!);
    await showHistory();
    expect(
      await screen.findByRole("button", { name: en["history.step.layer_mask"] })
    ).toBeTruthy();
    expect(flags(doc.id)).toEqual([false, true]);
  });
});
