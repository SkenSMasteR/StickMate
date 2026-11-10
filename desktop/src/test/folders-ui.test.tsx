import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import en from "@/i18n/en.json";
import { findLayer } from "@/lib/document";
import type { Layer } from "@/lib/document";
import { store } from "./backend";
import { flush, press, renderEditor } from "./utils";

function layersOf(id: string): Layer[] {
  const state = store.get(id);
  if (!state) {
    throw new Error("document is not in the store");
  }
  return state.doc.scenes[0].layers;
}

function byName(layers: Layer[], name: string): Layer | null {
  for (const layer of layers) {
    if (layer.name === name) {
      return layer;
    }
    const nestedIn = byName(layer.children, name);
    if (nestedIn) {
      return nestedIn;
    }
  }
  return null;
}

function nested(id: string, name: string): Layer {
  const layer = byName(layersOf(id), name);
  if (!layer) {
    throw new Error(`${name} is missing`);
  }
  return layer;
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

function rows(): HTMLElement[] {
  return Array.from(panel().querySelectorAll<HTMLElement>("[data-folder]"));
}

function rowNames(): string[] {
  return rows().map((row) => (row.textContent ?? "").trim());
}

function indent(index: number): string {
  const row = rows()[index];
  if (!row) {
    throw new Error("row is missing");
  }
  return (row.firstElementChild as HTMLElement).style.paddingLeft;
}

function grid(): HTMLElement {
  return screen.getByTestId("timeline-grid");
}

function gridRows(): HTMLElement[] {
  return Array.from(grid().children).filter((item) =>
    item.hasAttribute("data-folder")
  ) as HTMLElement[];
}

function nameRows(): HTMLElement[] {
  const column = grid().parentElement?.children[0];
  if (!column) {
    throw new Error("timeline names are not mounted");
  }
  return Array.from(column.children).filter((item) =>
    item.hasAttribute("data-folder")
  ) as HTMLElement[];
}

async function click(element: Element | null): Promise<void> {
  if (!element) {
    throw new Error("control is missing");
  }
  await act(async () => {
    fireEvent.click(element);
  });
  await flush();
}

async function clickNamed(name: string): Promise<void> {
  await click(screen.getByRole("button", { name }));
}

async function clickIn(index: number, name: string): Promise<void> {
  const row = rows()[index];
  if (!row) {
    throw new Error("row is missing");
  }
  await click(within(row).getByRole("button", { name }));
}

async function buildFolder(id: string): Promise<void> {
  await clickNamed(en["command.addFolder"]);
  await waitFor(() => expect(layersOf(id)[0].folder).toBe(true));
  await clickNamed(en["command.addLayer"]);
  await waitFor(() => expect(nested(id, "Folder 2").children).toHaveLength(1));
}

async function runPalette(command: string, changes: Array<[string, string]>): Promise<void> {
  await press("k", { ctrlKey: true });
  await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
  const search = screen.getByRole("combobox");
  await act(async () => {
    fireEvent.change(search, { target: { value: command } });
  });
  await act(async () => {
    fireEvent.keyDown(search, { key: "Enter", bubbles: true });
  });
  await waitFor(() =>
    expect(screen.getByRole("dialog").querySelector("form")).toBeTruthy()
  );
  const form = screen.getByRole("dialog");
  for (const [label, value] of changes) {
    await act(async () => {
      fireEvent.change(within(form).getByLabelText(label) as HTMLSelectElement, {
        target: { value }
      });
    });
  }
  await act(async () => {
    fireEvent.click(within(form).getByRole("button", { name: en["palette.run"] }));
  });
  await flush();
}

describe("folder ui", () => {
  test("the panel nests a new layer inside the selected folder", async () => {
    const { doc } = await renderEditor();
    await clickNamed(en["command.addFolder"]);
    await waitFor(() => expect(layersOf(doc.id)).toHaveLength(2));
    expect(layersOf(doc.id)[0].name).toBe("Folder 2");
    expect(nested(doc.id, "Folder 2").children).toHaveLength(0);

    await clickNamed(en["command.addLayer"]);
    await waitFor(() => expect(rowNames()).toEqual(["Folder 2", "Layer 2", "Layer 1"]));
    expect(nested(doc.id, "Folder 2").children.map((item) => item.name)).toEqual(["Layer 2"]);
    expect(layersOf(doc.id).map((item) => item.name)).toEqual(["Folder 2", "Layer 1"]);
    expect(rows()[0].getAttribute("data-folder")).toBe("true");
    expect(rows()[1].getAttribute("data-folder")).toBe("false");
    expect(indent(0)).toBe("0px");
    expect(indent(1)).toBe("12px");
    expect(indent(2)).toBe("0px");
  }, 30000);

  test("collapsing a folder hides its layers in the panel and the timeline", async () => {
    const { doc } = await renderEditor();
    await buildFolder(doc.id);
    expect(rowNames()).toEqual(["Folder 2", "Layer 2", "Layer 1"]);
    expect(nameRows()).toHaveLength(3);
    expect(gridRows()).toHaveLength(3);

    await clickIn(0, en["editor.collapseFolder"]);
    await waitFor(() => expect(rowNames()).toEqual(["Folder 2", "Layer 1"]));
    expect(
      within(rows()[0]).getByRole("button", { name: en["editor.expandFolder"] }).getAttribute(
        "aria-expanded"
      )
    ).toBe("false");
    expect(nameRows()).toHaveLength(2);
    expect(gridRows()).toHaveLength(2);
    expect(byName(layersOf(doc.id), "Layer 2")).not.toBeNull();

    await clickIn(0, en["editor.expandFolder"]);
    await waitFor(() => expect(rowNames()).toEqual(["Folder 2", "Layer 2", "Layer 1"]));
    expect(nameRows()).toHaveLength(3);
  }, 30000);

  test("folder rows have no frame cells and grid clicks select the matching row", async () => {
    const { doc } = await renderEditor();
    await buildFolder(doc.id);
    expect(gridRows()[0].querySelectorAll("[data-frame]")).toHaveLength(0);
    expect(gridRows()[1].querySelectorAll("[data-frame]").length).toBeGreaterThan(0);

    const y = 20 + 22 * 2 + 11;
    await act(async () => {
      fireEvent.pointerDown(grid(), {
        clientX: 8,
        clientY: y,
        button: 0,
        buttons: 1,
        pointerId: 1,
        bubbles: true
      });
      fireEvent.pointerUp(grid(), {
        clientX: 8,
        clientY: y,
        button: 0,
        buttons: 0,
        pointerId: 1,
        bubbles: true
      });
    });
    await flush();
    await waitFor(() => expect(rows()[2].className).toContain("bg-accent"));
    expect(rows()[1].className).not.toContain("bg-accent");
    expect(nested(doc.id, "Layer 1").folder).toBe(false);
  }, 30000);

  test("moving a layer stays inside its folder", async () => {
    const { doc } = await renderEditor();
    await clickNamed(en["command.addFolder"]);
    await clickNamed(en["command.addLayer"]);
    await clickNamed(en["command.addLayer"]);
    await waitFor(() => expect(rowNames()).toEqual(["Folder 2", "Layer 3", "Layer 2", "Layer 1"]));
    expect(
      within(rows()[1]).getByRole("button", { name: en["editor.moveUp"] }).hasAttribute("disabled")
    ).toBe(true);

    await clickIn(1, en["editor.moveDown"]);
    await waitFor(() =>
      expect(nested(doc.id, "Folder 2").children.map((item) => item.name)).toEqual([
        "Layer 2",
        "Layer 3"
      ])
    );
    expect(layersOf(doc.id).map((item) => item.name)).toEqual(["Folder 2", "Layer 1"]);
    expect(rowNames()).toEqual(["Folder 2", "Layer 2", "Layer 3", "Layer 1"]);
  }, 30000);

  test("unwrapping a folder lifts its layers to the top level", async () => {
    const { doc } = await renderEditor();
    await buildFolder(doc.id);
    await clickIn(0, en["editor.unwrapFolder"]);
    await waitFor(() =>
      expect(layersOf(doc.id).map((item) => item.name)).toEqual(["Layer 2", "Layer 1"])
    );
    expect(rows().some((row) => row.getAttribute("data-folder") === "true")).toBe(false);
  }, 30000);

  test("deleting a folder asks for a folder confirmation and drops the subtree", async () => {
    const { doc } = await renderEditor();
    await buildFolder(doc.id);

    await clickIn(0, en["editor.deleteFolder"]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(en["editor.deleteFolder"])).toBeTruthy();
    await click(within(dialog).getByRole("button", { name: en["editor.cancel"] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(layersOf(doc.id)).toHaveLength(2);
    expect(byName(layersOf(doc.id), "Layer 2")).not.toBeNull();

    await clickIn(0, en["editor.deleteFolder"]);
    const accepted = await screen.findByRole("dialog");
    await click(within(accepted).getByRole("button", { name: en["editor.delete"] }));
    await waitFor(() => expect(rowNames()).toEqual(["Layer 1"]));
    expect(layersOf(doc.id).map((item) => item.name)).toEqual(["Layer 1"]);
  }, 30000);

  test("the palette adds a layer into the chosen folder", async () => {
    const { doc } = await renderEditor();
    await buildFolder(doc.id);
    await runPalette(en["command.addLayerIn"], [
      [en["palette.arg.parent"], nested(doc.id, "Folder 2").id]
    ]);
    await waitFor(() =>
      expect(nested(doc.id, "Folder 2").children.map((item) => item.name)).toEqual([
        "Layer 3",
        "Layer 2"
      ])
    );
    expect(rowNames()).toEqual(["Folder 2", "Layer 3", "Layer 2", "Layer 1"]);
  }, 30000);

  test("the palette unwraps the chosen folder", async () => {
    const { doc } = await renderEditor();
    await buildFolder(doc.id);
    const folderId = nested(doc.id, "Folder 2").id;
    await runPalette(en["command.unwrapFolder"], []);
    await waitFor(() => expect(layersOf(doc.id)[0].name).toBe("Layer 2"));
    expect(findLayer(layersOf(doc.id), folderId)).toBeNull();
  }, 30000);
});
