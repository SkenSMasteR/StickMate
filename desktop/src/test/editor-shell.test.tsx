import { describe, expect, test } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import en from "@/i18n/en.json";
import { store } from "./backend";
import { dockingState } from "./backend/docking";
import { flush, press, renderEditor } from "./utils";

function layerLength(id: string): number {
  return store.get(id)!.doc.scenes[0].layers[0].length;
}

function rightZone(): HTMLElement {
  return document.querySelector('[data-zone="right"]') as HTMLElement;
}

async function openWorkspaceMenu(): Promise<void> {
  fireEvent.pointerDown(screen.getByRole("button", { name: en["workspace.title"] }), {
    button: 0
  });
  await flush();
}

async function showHistory(): Promise<void> {
  await openWorkspaceMenu();
  fireEvent.click(
    screen.getByRole("menuitemcheckbox", { name: en["panel.history"] })
  );
  await flush();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await flush();
  fireEvent.click(screen.getByRole("tab", { name: en["panel.history"] }));
  await flush();
}

describe("editor shell", () => {
  test("ctrl+k runs a parameterized command from the palette", async () => {
    const { doc } = await renderEditor();
    await press("k", { ctrlKey: true });
    const search = await screen.findByRole("combobox");
    fireEvent.change(search, {
      target: { value: en["command.insertFramesCount"] }
    });
    await flush();
    fireEvent.click(
      screen.getByRole("option", {
        name: new RegExp(en["command.insertFramesCount"])
      })
    );
    await flush();
    fireEvent.change(screen.getByLabelText(en["palette.arg.count"]), {
      target: { value: "3" }
    });
    fireEvent.click(screen.getByRole("button", { name: en["palette.run"] }));
    await waitFor(() => expect(layerLength(doc.id)).toBe(4));
    expect(screen.queryByRole("combobox")).toBeNull();
  }, 30000);

  test("the tools panel button opens the palette", async () => {
    await renderEditor();
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(en["command.palette"]) })
    );
    await flush();
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.getByRole("listbox")).toBeTruthy();
  }, 30000);

  test("the history panel is reachable from the workspace menu and jumps", async () => {
    const { doc } = await renderEditor();
    await press("F5");
    await waitFor(() => expect(layerLength(doc.id)).toBe(2));
    await showHistory();
    const zone = rightZone();
    await waitFor(() =>
      expect(
        within(zone).getByRole("button", {
          name: en["history.step.insert_frame"]
        })
      ).toBeTruthy()
    );
    const steps = zone.querySelectorAll("ol li button");
    expect(steps.length).toBe(2);
    fireEvent.click(steps[0]);
    await waitFor(() => expect(layerLength(doc.id)).toBe(1));
  }, 30000);

  test("the history panel detaches into its own window", async () => {
    await renderEditor();
    await showHistory();
    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: `${en["panel.history"]} ${en["panel.menu"]}`
      }),
      { button: 0 }
    );
    await flush();
    fireEvent.click(screen.getByRole("menuitem", { name: en["panel.detach"] }));
    await waitFor(() =>
      expect(dockingState.created.map((item) => item.label)).toContain(
        "panel-history"
      )
    );
    expect(
      document.querySelector('[data-zone="right"] [data-panel-tab="history"]')
    ).toBeNull();
  }, 30000);
});