import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import en from "@/i18n/en.json";
import type { Shape } from "@/lib/document";
import { store } from "./backend";
import { drag, flush, getCanvas, press, renderEditor } from "./utils";

function sceneNames(id: string): string[] {
  const state = store.get(id);
  if (!state) {
    throw new Error("document is not in the store");
  }
  return state.doc.scenes.map((item) => item.name);
}

function sceneShapes(id: string, name: string): Shape[] {
  const state = store.get(id);
  const scene = state?.doc.scenes.find((item) => item.name === name);
  if (!scene) {
    throw new Error("scene is not in the store");
  }
  return scene.layers[0].keys[0].shapes;
}

function frameValue(): string {
  return (screen.getByLabelText(en["editor.frame"]) as HTMLInputElement).value;
}

async function clickButton(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  await flush();
}

async function openMenu(): Promise<void> {
  await clickButton(en["editor.sceneActions"]);
}

async function startEditing(tabName: string): Promise<HTMLInputElement> {
  await act(async () => {
    fireEvent.doubleClick(screen.getByRole("button", { name: tabName }));
  });
  await flush();
  return screen.getByLabelText(en["editor.sceneName"]) as HTMLInputElement;
}

async function typeDraft(
  input: HTMLInputElement,
  value: string
): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

async function pressKey(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(input, { key });
  });
  await flush();
}

describe("scenes bar", () => {
  test("adds a scene and makes it selectable", async () => {
    const { doc } = await renderEditor();
    await clickButton(en["command.addScene"]);
    await waitFor(() =>
      expect(store.get(doc.id)?.doc.scenes).toHaveLength(2)
    );
    await clickButton("Scene 2 (1)");
    expect(
      screen.getByRole("button", { name: "Scene 2 (1)" }).className
    ).toContain("bg-background");
    expect(
      screen.getByRole("button", { name: "Scene 1 (1)" }).className
    ).not.toContain("bg-background");
    expect(
      screen.getAllByRole("button", { name: en["editor.sceneActions"] })
    ).toHaveLength(1);
  });

  test("switching scenes updates the timeline and canvas", async () => {
    await renderEditor();
    await press("p");
    await drag(getCanvas(), [
      [10, 10],
      [40, 40]
    ]);
    await clickButton(en["command.insertFrame"]);
    expect(frameValue()).toBe("2");
    await clickButton(en["command.addScene"]);
    await clickButton("Scene 2 (1)");
    expect(frameValue()).toBe("1");
    expect(screen.getByText("/ 1")).toBeTruthy();
    await waitFor(() =>
      expect(getCanvas().querySelectorAll("polyline")).toHaveLength(0)
    );
    await clickButton("Scene 1 (2)");
    expect(frameValue()).toBe("1");
    expect(screen.getByText("/ 2")).toBeTruthy();
    await waitFor(() =>
      expect(getCanvas().querySelectorAll("polyline").length).toBeGreaterThan(0)
    );
  });

  test("the scene tab shows its frame length", async () => {
    await renderEditor();
    expect(screen.getByRole("button", { name: "Scene 1 (1)" })).toBeTruthy();
    await clickButton(en["command.insertFrame"]);
    expect(screen.getByRole("button", { name: "Scene 1 (2)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Scene 1 (1)" })).toBeNull();
  });

  test("double click then enter renames the scene", async () => {
    const { doc } = await renderEditor();
    const input = await startEditing("Scene 1 (1)");
    expect(input.value).toBe("Scene 1");
    await typeDraft(input, "Intro");
    await pressKey(input, "Enter");
    await waitFor(() =>
      expect(store.get(doc.id)?.doc.scenes[0].name).toBe("Intro")
    );
    expect(screen.getByRole("button", { name: "Intro (1)" })).toBeTruthy();
    expect(screen.queryByLabelText(en["editor.sceneName"])).toBeNull();
  });

  test("escape cancels the scene rename", async () => {
    const { doc } = await renderEditor();
    const input = await startEditing("Scene 1 (1)");
    await typeDraft(input, "Nope");
    await pressKey(input, "Escape");
    expect(screen.queryByLabelText(en["editor.sceneName"])).toBeNull();
    expect(screen.getByRole("button", { name: "Scene 1 (1)" })).toBeTruthy();
    expect(store.get(doc.id)?.doc.scenes[0].name).toBe("Scene 1");
  });

  test("blur commits the scene rename", async () => {
    const { doc } = await renderEditor();
    const input = await startEditing("Scene 1 (1)");
    await typeDraft(input, "Outro");
    await act(async () => {
      fireEvent.blur(input);
    });
    await flush();
    await waitFor(() =>
      expect(store.get(doc.id)?.doc.scenes[0].name).toBe("Outro")
    );
    expect(screen.getByRole("button", { name: "Outro (1)" })).toBeTruthy();
  });

  test("an empty or whitespace draft does not rename the scene", async () => {
    const { doc } = await renderEditor();
    const input = await startEditing("Scene 1 (1)");
    await typeDraft(input, "   ");
    await pressKey(input, "Enter");
    expect(screen.getByRole("button", { name: "Scene 1 (1)" })).toBeTruthy();
    expect(store.get(doc.id)?.doc.scenes[0].name).toBe("Scene 1");
    expect(screen.queryByText("name is empty")).toBeNull();
    expect(store.get(doc.id)?.undo).toHaveLength(0);
  });

  test("renames through the three dot menu", async () => {
    const { doc } = await renderEditor();
    await openMenu();
    await clickButton(en["editor.rename"]);
    const input = screen.getByLabelText(
      en["editor.sceneName"]
    ) as HTMLInputElement;
    expect(input.value).toBe("Scene 1");
    expect(screen.queryByRole("button", { name: en["editor.duplicate"] })).toBeNull();
    await typeDraft(input, "Menu");
    await pressKey(input, "Enter");
    await waitFor(() =>
      expect(store.get(doc.id)?.doc.scenes[0].name).toBe("Menu")
    );
    expect(screen.getByRole("button", { name: "Menu (1)" })).toBeTruthy();
  });

  test("duplicates a scene with independent content", async () => {
    const { doc } = await renderEditor();
    await press("p");
    await drag(getCanvas(), [
      [10, 10],
      [30, 30]
    ]);
    expect(sceneShapes(doc.id, "Scene 1")).toHaveLength(1);
    await openMenu();
    await clickButton(en["editor.duplicate"]);
    await screen.findByRole("button", { name: "Scene 1 copy (1)" });
    const scenes = store.get(doc.id)?.doc.scenes;
    expect(scenes).toHaveLength(2);
    expect(scenes?.[1].name).toBe("Scene 1 copy");
    expect(scenes?.[1].id).not.toBe(scenes?.[0].id);
    expect(scenes?.[1].layers[0].id).not.toBe(scenes?.[0].layers[0].id);
    expect(sceneShapes(doc.id, "Scene 1 copy")).toHaveLength(1);
    await clickButton("Scene 1 copy (1)");
    await press("p");
    await drag(getCanvas(), [
      [60, 60],
      [90, 90]
    ]);
    expect(sceneShapes(doc.id, "Scene 1 copy")).toHaveLength(2);
    expect(sceneShapes(doc.id, "Scene 1")).toHaveLength(1);
  });

  test("moves scenes left and right and disables moves at the ends", async () => {
    const { doc } = await renderEditor();
    await clickButton(en["command.addScene"]);
    await clickButton("Scene 2 (1)");
    await openMenu();
    expect(
      screen.getByRole("button", { name: en["editor.moveLeft"] }).hasAttribute("disabled")
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: en["editor.moveRight"] }).hasAttribute("disabled")
    ).toBe(true);
    await clickButton(en["editor.moveLeft"]);
    await waitFor(() =>
      expect(sceneNames(doc.id)).toEqual(["Scene 2", "Scene 1"])
    );
    expect(
      screen.getByRole("button", { name: "Scene 2 (1)" }).className
    ).toContain("bg-background");
    await openMenu();
    expect(
      screen.getByRole("button", { name: en["editor.moveLeft"] }).hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: en["editor.moveRight"] }).hasAttribute("disabled")
    ).toBe(false);
    await clickButton(en["editor.moveRight"]);
    await waitFor(() =>
      expect(sceneNames(doc.id)).toEqual(["Scene 1", "Scene 2"])
    );
  });

  test("deletes a scene after confirmation and falls back to a remaining scene", async () => {
    const { doc } = await renderEditor();
    await clickButton(en["command.addScene"]);
    await openMenu();
    expect(
      screen.getByRole("button", { name: en["editor.delete"] }).hasAttribute("disabled")
    ).toBe(false);
    await clickButton(en["editor.delete"]);
    await screen.findByText(en["editor.deleteScene"]);
    await clickButton(en["editor.delete"]);
    await waitFor(() =>
      expect(store.get(doc.id)?.doc.scenes).toHaveLength(1)
    );
    expect(sceneNames(doc.id)).toEqual(["Scene 2"]);
    expect(screen.queryByRole("button", { name: "Scene 1 (1)" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Scene 2 (1)" }).className
    ).toContain("bg-background");
    getCanvas(800, 600);
  });

  test("cancelling the delete confirmation keeps the scene", async () => {
    const { doc } = await renderEditor();
    await clickButton(en["command.addScene"]);
    await openMenu();
    await clickButton(en["editor.delete"]);
    await screen.findByText(en["editor.deleteScene"]);
    await clickButton(en["editor.cancel"]);
    await flush();
    expect(store.get(doc.id)?.doc.scenes).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Scene 1 (1)" })).toBeTruthy();
  });

  test("delete is disabled when only one scene remains", async () => {
    await renderEditor();
    await openMenu();
    expect(
      screen.getByRole("button", { name: en["editor.delete"] }).hasAttribute("disabled")
    ).toBe(true);
  });

  test("the menu closes on an outside pointerdown but not inside the bar", async () => {
    await renderEditor();
    await openMenu();
    expect(screen.getByRole("button", { name: en["editor.rename"] })).toBeTruthy();
    await act(async () => {
      fireEvent.pointerDown(
        screen.getByRole("button", { name: en["editor.sceneActions"] })
      );
    });
    await flush();
    expect(screen.getByRole("button", { name: en["editor.rename"] })).toBeTruthy();
    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    await flush();
    expect(screen.queryByRole("button", { name: en["editor.rename"] })).toBeNull();
  });

  test("switching scenes closes the menu and it stays closed", async () => {
    await renderEditor();
    await clickButton(en["command.addScene"]);
    await openMenu();
    await clickButton("Scene 2 (1)");
    expect(screen.queryByRole("button", { name: en["editor.rename"] })).toBeNull();
    await clickButton("Scene 1 (1)");
    expect(screen.queryByRole("button", { name: en["editor.rename"] })).toBeNull();
  });
}, 30000);