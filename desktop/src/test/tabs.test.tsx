import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import en from "@/i18n/en.json";
import { docNew } from "@/lib/document";
import type { Document, Shape } from "@/lib/document";
import { store } from "./backend";
import { drag, flush, getCanvas, press, renderEditor } from "./utils";

function shapes(id: string): Shape[] {
  const state = store.get(id);
  if (!state) {
    throw new Error("document is not in the store");
  }
  return state.doc.scenes[0].layers[0].keys[0].shapes;
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

async function openProject(
  name: string,
  width = 800,
  height = 600
): Promise<Document> {
  const doc = await docNew(name, width, height, 24, "#ffffff");
  await act(async () => {
    await emit("editor-open", doc.id);
  });
  await flush();
  await screen.findByRole("button", { name });
  return doc;
}

async function startRename(tabName: string): Promise<HTMLInputElement> {
  await act(async () => {
    fireEvent.doubleClick(screen.getByRole("button", { name: tabName }));
  });
  await flush();
  return screen.getByLabelText(en["editor.projectName"]) as HTMLInputElement;
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

describe("project tabs", () => {
  test("renders one tab per open project and clicking activates that document", async () => {
    const { doc: a } = await renderEditor();
    const b = await openProject("Second", 640, 480);
    expect(screen.getByRole("button", { name: "Test" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Second" })).toBeTruthy();
    await waitFor(() => getCanvas(640, 480));
    expect(
      screen.getByRole("button", { name: "Second" }).parentElement?.className
    ).toContain("border-border");
    await clickButton("Test");
    await waitFor(() => getCanvas(800, 600));
    expect(
      screen.getByRole("button", { name: "Test" }).parentElement?.className
    ).toContain("border-border");
    expect(
      screen.getByRole("button", { name: "Second" }).parentElement?.className
    ).not.toContain("border-border");
    expect(store.has(a.id)).toBe(true);
    expect(store.has(b.id)).toBe(true);
  });

  test("undo and redo history stay independent per project", async () => {
    const { doc: a } = await renderEditor();
    await press("p");
    await drag(getCanvas(), [
      [10, 10],
      [30, 30]
    ]);
    expect(shapes(a.id)).toHaveLength(1);
    const b = await openProject("Second");
    await press("p");
    await drag(getCanvas(), [
      [50, 50],
      [80, 80]
    ]);
    expect(shapes(b.id)).toHaveLength(1);
    await press("z", { ctrlKey: true });
    expect(shapes(b.id)).toHaveLength(0);
    expect(shapes(a.id)).toHaveLength(1);
    expect(store.get(a.id)?.undo).toHaveLength(1);
    await clickButton("Test");
    await waitFor(() =>
      expect(getCanvas().querySelectorAll("polyline").length).toBeGreaterThan(0)
    );
    await press("z", { ctrlKey: true });
    expect(shapes(a.id)).toHaveLength(0);
    expect(shapes(b.id)).toHaveLength(0);
    expect(store.get(b.id)?.redo).toHaveLength(1);
    await press("z", { ctrlKey: true, shiftKey: true });
    expect(shapes(a.id)).toHaveLength(1);
    expect(store.get(b.id)?.redo).toHaveLength(1);
    expect(store.get(b.id)?.undo).toHaveLength(0);
    await clickButton("Second");
    expect(store.get(a.id)?.undo).toHaveLength(1);
    await press("z", { ctrlKey: true, shiftKey: true });
    expect(shapes(b.id)).toHaveLength(1);
    expect(shapes(a.id)).toHaveLength(1);
  });

  test("current frame stays independent per project", async () => {
    await renderEditor();
    await clickButton(en["command.insertFrame"]);
    await waitFor(() => expect(frameValue()).toBe("2"));
    await clickButton(en["command.insertFrame"]);
    await waitFor(() => expect(frameValue()).toBe("3"));
    expect(screen.getByText("/ 3")).toBeTruthy();
    await openProject("Second");
    expect(frameValue()).toBe("1");
    expect(screen.getByText("/ 1")).toBeTruthy();
    await clickButton(en["command.insertFrame"]);
    await waitFor(() => expect(frameValue()).toBe("2"));
    await clickButton("Test");
    await waitFor(() => expect(frameValue()).toBe("3"));
    expect(screen.getByText("/ 3")).toBeTruthy();
    await clickButton("Second");
    await waitFor(() => expect(frameValue()).toBe("2"));
    expect(screen.getByText("/ 2")).toBeTruthy();
  });

  test("selected scene stays independent per project", async () => {
    const { doc: a } = await renderEditor();
    await clickButton(en["command.addScene"]);
    await clickButton("Scene 2 (1)");
    expect(
      screen.getByRole("button", { name: "Scene 2 (1)" }).className
    ).toContain("bg-background");
    const b = await openProject("Second");
    expect(screen.queryByRole("button", { name: "Scene 2 (1)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Scene 1 (1)" })).toBeTruthy();
    expect(store.get(b.id)?.doc.scenes).toHaveLength(1);
    await clickButton("Test");
    expect(store.get(a.id)?.doc.scenes).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Scene 2 (1)" }).className
    ).toContain("bg-background");
    expect(
      screen.getByRole("button", { name: "Scene 1 (1)" }).className
    ).not.toContain("bg-background");
  });

  test("closing a tab removes it and activates a remaining project", async () => {
    const { doc: a } = await renderEditor();
    const b = await openProject("Second");
    const closes = screen.getAllByRole("button", {
      name: en["editor.closeTab"]
    });
    expect(closes).toHaveLength(2);
    await act(async () => {
      fireEvent.click(closes[1]);
    });
    await flush();
    await waitFor(() => expect(store.has(b.id)).toBe(false));
    expect(screen.queryByRole("button", { name: "Second" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Test" }).parentElement?.className
    ).toContain("border-border");
    getCanvas(800, 600);
    expect(store.has(a.id)).toBe(true);
    expect(await getCurrentWindow().isVisible()).toBe(true);
  });

  test("closing the last tab clears the editor and returns to the hub", async () => {
    const { doc } = await renderEditor();
    await clickButton(en["editor.closeTab"]);
    await waitFor(() => expect(store.has(doc.id)).toBe(false));
    expect(
      screen.queryAllByRole("button", { name: en["editor.closeTab"] })
    ).toHaveLength(0);
    expect(
      document.querySelector('svg[viewBox="0 0 800 600"]')
    ).toBeNull();
    expect(screen.queryByLabelText(en["editor.frame"])).toBeNull();
    await waitFor(async () =>
      expect(await getCurrentWindow().isVisible()).toBe(false)
    );
  });

  test("the home button hides the editor window", async () => {
    await renderEditor();
    expect(await getCurrentWindow().isVisible()).toBe(true);
    await clickButton(en["editor.home"]);
    await waitFor(async () =>
      expect(await getCurrentWindow().isVisible()).toBe(false)
    );
    getCanvas(800, 600);
  });

  test("double click then enter renames the project", async () => {
    const { doc } = await renderEditor();
    const input = await startRename("Test");
    expect(input.value).toBe("Test");
    await typeDraft(input, "Alpha");
    await pressKey(input, "Enter");
    await waitFor(() =>
      expect(store.get(doc.id)?.doc.name).toBe("Alpha")
    );
    expect(screen.getByRole("button", { name: "Alpha" })).toBeTruthy();
    expect(screen.queryByLabelText(en["editor.projectName"])).toBeNull();
  });

  test("escape cancels the rename without changing the name", async () => {
    const { doc } = await renderEditor();
    const input = await startRename("Test");
    await typeDraft(input, "Beta");
    await pressKey(input, "Escape");
    expect(screen.queryByLabelText(en["editor.projectName"])).toBeNull();
    expect(screen.getByRole("button", { name: "Test" })).toBeTruthy();
    expect(store.get(doc.id)?.doc.name).toBe("Test");
  });

  test("blur commits the rename", async () => {
    const { doc } = await renderEditor();
    const input = await startRename("Test");
    await typeDraft(input, "Gamma");
    await act(async () => {
      fireEvent.blur(input);
    });
    await flush();
    await waitFor(() =>
      expect(store.get(doc.id)?.doc.name).toBe("Gamma")
    );
    expect(screen.getByRole("button", { name: "Gamma" })).toBeTruthy();
  });

  test("an empty or whitespace draft does not rename", async () => {
    const { doc } = await renderEditor();
    const input = await startRename("Test");
    await typeDraft(input, "   ");
    await pressKey(input, "Enter");
    expect(screen.getByRole("button", { name: "Test" })).toBeTruthy();
    expect(store.get(doc.id)?.doc.name).toBe("Test");
    const again = await startRename("Test");
    await typeDraft(again, "");
    await act(async () => {
      fireEvent.blur(again);
    });
    await flush();
    expect(store.get(doc.id)?.doc.name).toBe("Test");
    expect(screen.queryByText("name is empty")).toBeNull();
    expect(store.get(doc.id)?.undo).toHaveLength(0);
  });
}, 30000);