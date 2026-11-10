import { describe, expect, test } from "vitest";
import {
  docAddFolder,
  docAddLayer,
  docDraw,
  docEvaluate,
  docKeyframe,
  docMoveLayer,
  docNew,
  docRemoveFolder,
  docRemoveLayer,
  docSetLayer,
  findLayer,
  leafLayers,
  sceneLength,
  visibleRows
} from "@/lib/document";
import type { Document, Layer, Shape } from "@/lib/document";
import { docDuplicateLayer } from "@/lib/tauri";
import { docHistory } from "@/lib/history";
import { docInsertFrames } from "@/lib/frames";
import { installBackend, store } from "./backend";

const box: Shape = {
  kind: "Rect",
  x: 4,
  y: 4,
  w: 12,
  h: 8,
  fill: "#ff0000",
  stroke: "#000000",
  width: 1,
  gradient: null
};

async function open(): Promise<{ id: string; scene: string }> {
  installBackend("folders");
  const doc = await docNew("Folders", 120, 80, 12, "#ffffff");
  return { id: doc.id, scene: doc.scenes[0].id };
}

function doc(id: string): Document {
  const state = store.get(id);
  if (!state) {
    throw new Error("document is not in the store");
  }
  return state.doc;
}

function top(id: string): Layer[] {
  return doc(id).scenes[0].layers;
}

function rows(layers: Layer[]): Array<[string, boolean, number]> {
  return layers.map((layer) => [layer.name, layer.folder, layer.children.length]);
}

function walk(layers: Layer[], name: string): Layer | null {
  for (const layer of layers) {
    if (layer.name === name) {
      return layer;
    }
    const nested = walk(layer.children, name);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function named(layers: Layer[], name: string): Layer {
  const found = walk(layers, name);
  if (!found) {
    throw new Error(`${name} is missing`);
  }
  return found;
}

describe("layer folders", () => {
  test("a folder holds layers without leaving its own row", async () => {
    const { id, scene } = await open();
    await docAddFolder(id, scene, "Art", null);
    const folder = named(top(id), "Art");
    expect(folder.folder).toBe(true);
    expect(folder.length).toBe(0);
    expect(folder.keys).toEqual([]);
    await docAddLayer(id, scene, "Ink", folder.id);
    expect(rows(top(id))).toEqual([
      ["Art", true, 1],
      ["Layer 1", false, 0]
    ]);
    expect(rows(top(id)[0].children)).toEqual([["Ink", false, 0]]);
  });

  test("new layers and folders land on top with counted defaults", async () => {
    const { id, scene } = await open();
    await docAddFolder(id, scene, "", null);
    await docAddLayer(id, scene, "", null);
    expect(rows(top(id))).toEqual([
      ["Layer 2", false, 0],
      ["Folder 2", true, 0],
      ["Layer 1", false, 0]
    ]);
  });

  test("layers move into and out of folders", async () => {
    const { id, scene } = await open();
    await docAddFolder(id, scene, "Art", null);
    const folder = named(top(id), "Art");
    await docAddLayer(id, scene, "One", null);
    await docAddLayer(id, scene, "Two", null);
    const one = named(top(id), "One");
    const two = named(top(id), "Two");
    await docMoveLayer(id, scene, two.id, 0, folder.id);
    await docMoveLayer(id, scene, one.id, 1, folder.id);
    expect(rows(top(id))).toEqual([
      ["Art", true, 2],
      ["Layer 1", false, 0]
    ]);
    expect(top(id)[0].children.map((layer) => layer.name)).toEqual(["Two", "One"]);
    await docMoveLayer(id, scene, one.id, 0, null);
    expect(top(id).map((layer) => layer.name)).toEqual(["One", "Art", "Layer 1"]);
    await docMoveLayer(id, scene, two.id, 0, folder.id);
    expect(top(id)[1].children.map((layer) => layer.name)).toEqual(["Two"]);
  });

  test("unwrapping a folder splices its layers back in place", async () => {
    const { id, scene } = await open();
    await docAddFolder(id, scene, "Art", null);
    const folder = named(top(id), "Art");
    await docAddLayer(id, scene, "One", folder.id);
    await docAddLayer(id, scene, "Two", folder.id);
    await docAddLayer(id, scene, "Base", null);
    await docRemoveFolder(id, scene, folder.id);
    expect(top(id).map((layer) => [layer.name, layer.folder])).toEqual([
      ["Base", false],
      ["Two", false],
      ["One", false],
      ["Layer 1", false]
    ]);
    await expect(docRemoveFolder(id, scene, folder.id)).rejects.toThrow("unknown folder");
    await expect(docRemoveFolder(id, scene, named(top(id), "Base").id)).rejects.toThrow(
      "target is not a folder"
    );
  });

  test("a folder refuses frames and shapes and only guards the last leaf", async () => {
    const { id, scene } = await open();
    await docAddFolder(id, scene, "Art", null);
    const folder = named(top(id), "Art");
    await expect(docKeyframe(id, scene, folder.id, 0, false)).rejects.toThrow(
      "folders cannot hold frames or shapes"
    );
    await expect(docDraw(id, scene, folder.id, 0, box)).rejects.toThrow(
      "folders cannot hold frames or shapes"
    );
    await docAddLayer(id, scene, "Only", folder.id);
    await docRemoveLayer(id, scene, named(top(id), "Only").id);
    expect(rows(top(id))).toEqual([
      ["Art", true, 0],
      ["Layer 1", false, 0]
    ]);
    await expect(docRemoveLayer(id, scene, folder.id)).rejects.toThrow(
      "a scene needs at least one layer"
    );
    await docAddLayer(id, scene, "Extra", null);
    await docRemoveLayer(id, scene, folder.id);
    expect(top(id).map((layer) => layer.name)).toEqual(["Extra", "Layer 1"]);
  });

  test("nesting stops at sixteen levels and never cycles", async () => {
    const { id, scene } = await open();
    let parent: string | null = null;
    for (let level = 0; level < 16; level += 1) {
      await docAddFolder(id, scene, `F${level}`, parent);
      parent = named(top(id), `F${level}`).id;
    }
    const deepest = named(top(id), "F15");
    await expect(docAddFolder(id, scene, "TooDeep", deepest.id)).rejects.toThrow(
      "folders cannot nest deeper than 16 levels"
    );
    await expect(docMoveLayer(id, scene, named(top(id), "F0").id, 0, deepest.id)).rejects.toThrow(
      "a folder cannot contain itself"
    );
    await expect(docMoveLayer(id, scene, deepest.id, 0, "nope")).rejects.toThrow(
      "unknown folder"
    );
    await docAddLayer(id, scene, "Leaf", null);
    await expect(
      docMoveLayer(id, scene, deepest.id, 0, named(top(id), "Leaf").id)
    ).rejects.toThrow("target is not a folder");
    const moved = await docMoveLayer(id, scene, deepest.id, 0, named(top(id), "F14").id);
    expect(findLayer(moved.scenes[0].layers, deepest.id)).not.toBeNull();
  });

  test("locking or hiding a folder reaches every layer inside", async () => {
    const { id, scene } = await open();
    await docAddFolder(id, scene, "Art", null);
    const folder = named(top(id), "Art");
    await docAddLayer(id, scene, "Ink", folder.id);
    const ink = named(top(id), "Ink");
    await docSetLayer(id, scene, folder.id, { locked: true });
    await expect(docDraw(id, scene, ink.id, 0, box)).rejects.toThrow("layer is locked");
    await docSetLayer(id, scene, folder.id, { locked: false });
    await docDraw(id, scene, ink.id, 0, box);
    const frames = await docEvaluate(id, scene, 0, 0);
    expect(frames[0].layers.map((layer) => [layer.id, layer.folder])).toEqual([
      [folder.id, true],
      [named(top(id), "Layer 1").id, false]
    ]);
    expect(frames[0].layers[0].children[0].shapes).toEqual([box]);
    await docSetLayer(id, scene, folder.id, { visible: false });
    const hidden = await docEvaluate(id, scene, 0, 0);
    expect(hidden[0].layers.map((layer) => layer.folder)).toEqual([false]);
  });

  test("an empty or hidden folder drops out of evaluation", async () => {
    const { id, scene } = await open();
    await docAddFolder(id, scene, "Art", null);
    const empty = await docEvaluate(id, scene, 0, 0);
    expect(empty[0].layers.map((layer) => layer.folder)).toEqual([false]);
    const folder = named(top(id), "Art");
    await docAddLayer(id, scene, "Ink", folder.id);
    await docDraw(id, scene, named(top(id), "Ink").id, 0, box);
    const filled = await docEvaluate(id, scene, 0, 0);
    expect(filled[0].layers[0].children).toHaveLength(1);
    expect(filled[0].layers[0].transform).toEqual({
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1,
      opacity: 1
    });
    expect(filled[0].layers[0].shapes).toEqual([]);
  });

  test("clipping respects folder walls", async () => {
    const { id, scene } = await open();
    await docAddFolder(id, scene, "Art", null);
    const folder = named(top(id), "Art");
    await docAddLayer(id, scene, "Clipped", folder.id);
    await docAddLayer(id, scene, "Provider", folder.id);
    const provider = named(top(id), "Provider");
    const clipped = named(top(id), "Clipped");
    await docDraw(id, scene, provider.id, 0, box);
    await docDraw(id, scene, clipped.id, 0, box);
    await docSetLayer(id, scene, clipped.id, { masked: true });
    expect(named(top(id), "Art").masked).toBe(false);
    const masked = (await docEvaluate(id, scene, 0, 0))[0].layers[0].children;
    expect(masked.map((layer) => layer.id)).toEqual([provider.id, clipped.id]);
    expect(masked[0].mask).toBeNull();
    expect(masked[1].mask?.shapes).toEqual([box]);
    await expect(docSetLayer(id, scene, folder.id, { masked: true })).rejects.toThrow(
      "folders cannot be clipped"
    );
    await expect(docSetLayer(id, scene, provider.id, { masked: true })).rejects.toThrow(
      "the top layer cannot be clipped"
    );
    await expect(
      docSetLayer(id, scene, named(top(id), "Layer 1").id, { masked: true })
    ).rejects.toThrow("clipping needs a layer directly above");
  });

  test("duplicating a folder copies the tree with fresh ids", async () => {
    const { id, scene } = await open();
    await docAddFolder(id, scene, "Art", null);
    const folder = named(top(id), "Art");
    await docAddLayer(id, scene, "Ink", folder.id);
    const ink = named(top(id), "Ink").id;
    await docDuplicateLayer(id, scene, folder.id);
    const layers = top(id);
    expect(layers).toHaveLength(3);
    const copy = layers[1];
    expect(copy.folder).toBe(true);
    expect(copy.name).toBe("Art copy");
    expect(copy.children).toHaveLength(1);
    expect(copy.id).not.toBe(folder.id);
    expect(copy.children[0].id).not.toBe(ink);
    expect(copy.children[0].name).toBe("Ink");
  });

  test("scene length follows layers inside folders", async () => {
    const { id, scene } = await open();
    await docAddFolder(id, scene, "Art", null);
    const folder = named(top(id), "Art");
    await docAddLayer(id, scene, "Short", folder.id);
    expect(sceneLength(doc(id).scenes[0])).toBe(1);
    await docInsertFrames(id, scene, named(top(id), "Short").id, 0, 9);
    expect(sceneLength(doc(id).scenes[0])).toBe(10);
    await docRemoveLayer(id, scene, named(top(id), "Short").id);
    expect(named(top(id), "Art").length).toBe(0);
    expect(sceneLength(doc(id).scenes[0])).toBe(1);
  });

  test("history names folder steps", async () => {
    const { id, scene } = await open();
    await docAddFolder(id, scene, "Art", null);
    const folder = named(top(id), "Art");
    await docAddLayer(id, scene, "Ink", folder.id);
    await docRemoveFolder(id, scene, folder.id);
    await docRemoveLayer(id, scene, named(top(id), "Ink").id);
    const steps = await docHistory(id);
    expect(steps.map((step) => step.name)).toEqual([
      "new_document",
      "add_folder",
      "add_layer",
      "remove_folder",
      "remove_layer"
    ]);
  });

  test("visible rows flatten the tree and honour collapse state", async () => {
    const { id, scene } = await open();
    await docAddFolder(id, scene, "Art", null);
    const folder = named(top(id), "Art");
    await docAddLayer(id, scene, "Ink", folder.id);
    await docAddFolder(id, scene, "Deep", folder.id);
    await docAddLayer(id, scene, "Bone", named(top(id), "Deep").id);
    const layers = top(id);
    const flatten = (collapsed: string[]) =>
      visibleRows(layers, collapsed).map((row) => [row.layer.name, row.depth]);
    expect(flatten([])).toEqual([
      ["Art", 0],
      ["Deep", 1],
      ["Bone", 2],
      ["Ink", 1],
      ["Layer 1", 0]
    ]);
    expect(flatten([named(top(id), "Deep").id])).toEqual([
      ["Art", 0],
      ["Deep", 1],
      ["Ink", 1],
      ["Layer 1", 0]
    ]);
    expect(flatten([folder.id])).toEqual([
      ["Art", 0],
      ["Layer 1", 0]
    ]);
    expect(leafLayers(layers).map((layer) => layer.name)).toEqual(["Bone", "Ink", "Layer 1"]);
  });
});
