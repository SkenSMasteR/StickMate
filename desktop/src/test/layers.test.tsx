import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import en from "@/i18n/en.json";
import { docKeyframe } from "@/lib/document";
import type { Layer } from "@/lib/document";
import { docDuplicateLayer } from "@/lib/tauri";
import { store } from "./backend";
import { drag, flush, getCanvas, press, renderEditor } from "./utils";

function layersOf(id: string): Layer[] {
  const state = store.get(id);
  if (!state) {
    throw new Error("document is not in the store");
  }
  return state.doc.scenes[0].layers;
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

async function clickButton(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  await flush();
}

async function clickDuplicate(row: number): Promise<void> {
  await act(async () => {
    fireEvent.click(
      within(panel()).getAllByRole("button", {
        name: en["editor.duplicateLayer"]
      })[row]
    );
  });
  await flush();
}

describe("duplicate layer", () => {
  test("duplicates the layer with all keyframes and a fresh id", async () => {
    const { doc } = await renderEditor();
    const sceneId = doc.scenes[0].id;
    const layerId = doc.scenes[0].layers[0].id;
    await press("p");
    await drag(getCanvas(), [
      [10, 10],
      [40, 40]
    ]);
    await docKeyframe(doc.id, sceneId, layerId, 4, false);
    const before = JSON.stringify(layersOf(doc.id)[0]);
    await clickDuplicate(0);
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    const [source, copy] = layersOf(doc.id);
    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe("Layer 1 copy");
    expect(copy.length).toBe(5);
    expect(copy.keys.map((key) => key.frame)).toEqual([0, 4]);
    expect(copy.keys).toEqual(source.keys);
    expect(copy.keys[1].shapes).toHaveLength(1);
    expect(JSON.stringify(source)).toBe(before);
    expect(
      within(panel()).getByRole("button", { name: "Layer 1" })
    ).toBeTruthy();
    expect(
      within(panel()).getByRole("button", { name: "Layer 1 copy" })
    ).toBeTruthy();
    expect(
      within(panel()).getAllByRole("button", {
        name: en["editor.duplicateLayer"]
      })
    ).toHaveLength(2);
  });

  test("the copy is independent of the original", async () => {
    const { doc } = await renderEditor();
    await press("p");
    await drag(getCanvas(), [
      [10, 10],
      [30, 30]
    ]);
    await clickDuplicate(0);
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    await act(async () => {
      fireEvent.click(
        within(panel()).getByRole("button", { name: "Layer 1 copy" })
      );
    });
    await flush();
    await press("p");
    await drag(getCanvas(), [
      [60, 60],
      [90, 90]
    ]);
    expect(layersOf(doc.id)[0].keys[0].shapes).toHaveLength(1);
    expect(layersOf(doc.id)[1].keys[0].shapes).toHaveLength(2);
  });

  test("adding a layer makes it the active layer", async () => {
    const { doc } = await renderEditor();
    await press("p");
    await drag(getCanvas(), [
      [10, 10],
      [40, 40]
    ]);
    await clickButton(en["command.addLayer"]);
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    await press("p");
    await drag(getCanvas(), [
      [60, 60],
      [90, 90]
    ]);
    expect(layersOf(doc.id)[0].keys[0].shapes).toHaveLength(1);
    expect(layersOf(doc.id)[1].keys[0].shapes).toHaveLength(1);
  });

  test("the copy lands directly after its source", async () => {
    const { doc } = await renderEditor();
    await clickButton(en["command.addLayer"]);
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    expect(layersOf(doc.id).map((item) => item.name)).toEqual(["Layer 2", "Layer 1"]);
    await clickDuplicate(0);
    await waitFor(() =>
      expect(layersOf(doc.id).map((item) => item.name)).toEqual([
        "Layer 2",
        "Layer 2 copy",
        "Layer 1"
      ])
    );
    await clickDuplicate(2);
    await waitFor(() =>
      expect(layersOf(doc.id).map((item) => item.name)).toEqual([
        "Layer 2",
        "Layer 2 copy",
        "Layer 1",
        "Layer 1 copy"
      ])
    );
    expect(
      within(panel()).getAllByRole("button", {
        name: en["editor.duplicateLayer"]
      })
    ).toHaveLength(4);
  });

  test("one undo removes exactly the copy", async () => {
    const { doc } = await renderEditor();
    await press("p");
    await drag(getCanvas(), [
      [10, 10],
      [40, 40]
    ]);
    const before = JSON.stringify(store.get(doc.id)?.doc);
    const depth = store.get(doc.id)?.undo.length ?? 0;
    await clickDuplicate(0);
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    expect(store.get(doc.id)?.undo.length).toBe(depth + 1);
    await press("z", { ctrlKey: true });
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(1));
    expect(JSON.stringify(store.get(doc.id)?.doc)).toBe(before);
    expect(
      within(panel()).queryByRole("button", { name: "Layer 1 copy" })
    ).toBeNull();
    await waitFor(() =>
      expect(getCanvas().querySelectorAll("polyline").length).toBeGreaterThan(0)
    );
    await press("z", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
  });

  test("duplicating a locked layer is allowed and keeps the lock", async () => {
    const { doc } = await renderEditor();
    await press("p");
    await drag(getCanvas(), [
      [10, 10],
      [40, 40]
    ]);
    await clickButton(en["editor.lockLayer"]);
    await waitFor(() => expect(layersOf(doc.id)[0].locked).toBe(true));
    await clickDuplicate(0);
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    const [source, copy] = layersOf(doc.id);
    expect(source.locked).toBe(true);
    expect(copy.locked).toBe(true);
    expect(copy.keys).toEqual(source.keys);
    await press("z", { ctrlKey: true });
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(1));
    expect(layersOf(doc.id)[0].locked).toBe(true);
  });

  test("an unknown layer or scene is rejected without touching the document", async () => {
    const { doc } = await renderEditor();
    const sceneId = doc.scenes[0].id;
    const layerId = doc.scenes[0].layers[0].id;
    const before = JSON.stringify(store.get(doc.id)?.doc);
    await expect(
      docDuplicateLayer(doc.id, sceneId, "missing")
    ).rejects.toThrow("unknown layer");
    await expect(
      docDuplicateLayer(doc.id, "missing", layerId)
    ).rejects.toThrow("unknown scene");
    expect(JSON.stringify(store.get(doc.id)?.doc)).toBe(before);
    expect(store.get(doc.id)?.undo).toHaveLength(0);
    expect(
      within(panel()).getAllByRole("button", {
        name: en["editor.duplicateLayer"]
      })
    ).toHaveLength(1);
  });
}, 30000);