import { describe, expect, test } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit, listen } from "@tauri-apps/api/event";
import { mockWindows } from "@tauri-apps/api/mocks";
import App from "@/App";
import en from "@/i18n/en.json";
import { docNew } from "@/lib/document";
import type { Document } from "@/lib/document";
import { destroyPanelWindow, openPanelWindow } from "@/lib/windows";
import { store } from "./backend";
import { dockingState, mockMonitor } from "./backend/docking";
import { drag, flush, getCanvas, renderEditor } from "./utils";

function handle(zone: string, panel: string): Element | null {
  return document.querySelector(`[data-zone="${zone}"] [data-panel-handle="${panel}"]`);
}

function zoneEl(zone: string): Element | null {
  return document.querySelector(`[data-zone="${zone}"]`);
}

function resizeHandle(side: string): HTMLElement {
  return document.querySelector(`[data-resize="${side}"]`) as HTMLElement;
}

function sizedWrapper(side: string): HTMLElement {
  const handle = resizeHandle(side);
  return (
    side === "left" ? handle.previousElementSibling : handle.nextElementSibling
  ) as HTMLElement;
}

async function openMenu(name: string): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(screen.getByRole("button", { name }), { button: 0 });
  });
  await flush();
}

async function choose(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name }));
  });
  await flush();
}

async function panelMenu(panel: string): Promise<void> {
  const title = en[`panel.${panel}` as keyof typeof en];
  await openMenu(`${title} ${en["panel.menu"]}`);
}

async function capture<T>(event: string): Promise<{ payloads: T[]; stop: () => void }> {
  const payloads: T[] = [];
  let stop = () => {};
  await act(async () => {
    stop = await listen<T>(event, (message) => payloads.push(message.payload));
  });
  return { payloads, stop };
}

async function mountDetached(doc: Document) {
  mockWindows("panel-timeline");
  const view = render(<App />);
  await flush();
  await act(async () => {
    await emit("panel-doc", { id: doc.id, doc });
  });
  await waitFor(() => screen.getByLabelText(en["editor.frame"]));
  await flush();
  return view;
}

describe("dock resizing", () => {
  test("dragging the right handle resizes the zone and clamps at the limit", async () => {
    await renderEditor();
    expect(sizedWrapper("right").style.width).toBe("264px");
    await drag(resizeHandle("right"), [
      [500, 300],
      [450, 300],
      [400, 300]
    ]);
    expect(sizedWrapper("right").style.width).toBe("364px");
    await drag(resizeHandle("right"), [
      [400, 300],
      [900, 300],
      [1400, 300]
    ]);
    expect(sizedWrapper("right").style.width).toBe("220px");
    expect(dockingState.created).toHaveLength(0);
  }, 30000);

  test("dragging the bottom handle resizes the timeline zone", async () => {
    await renderEditor();
    expect(sizedWrapper("bottom").style.height).toBe("220px");
    await drag(resizeHandle("bottom"), [
      [300, 500],
      [300, 450],
      [300, 400]
    ]);
    expect(sizedWrapper("bottom").style.height).toBe("320px");
  }, 30000);

  test("dragging the left handle resizes the tools zone", async () => {
    await renderEditor();
    expect(sizedWrapper("left").style.width).toBe("40px");
    await drag(resizeHandle("left"), [
      [40, 300],
      [90, 300],
      [140, 300]
    ]);
    expect(sizedWrapper("left").style.width).toBe("140px");
  }, 30000);
});

describe("dock rearranging", () => {
  test("the panel menu moves a panel to another zone", async () => {
    await renderEditor();
    await panelMenu("timeline");
    await choose(en["panel.dock.right"]);
    expect(handle("right", "timeline")).not.toBeNull();
    expect(
      document.querySelector('[data-zone="right"] [data-panel-tab="side"]')
    ).not.toBeNull();
    expect(zoneEl("bottom")).toBeNull();
    expect(screen.getByRole("tab", { name: en["panel.timeline"] }).getAttribute("aria-selected")).toBe("true");
    expect(dockingState.created).toHaveLength(0);
  }, 30000);

  test("dragging a panel header never creates a window", async () => {
    await renderEditor();
    const source = document.querySelector('[data-panel-handle="timeline"]') as Element;
    await act(async () => {
      fireEvent.pointerDown(source, { button: 0, buttons: 1, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerMove(zoneEl("right") as Element, {
        buttons: 1,
        pointerId: 1,
        clientX: 700,
        clientY: 300
      });
    });
    await act(async () => {
      fireEvent.pointerUp(window, { buttons: 0, pointerId: 1 });
    });
    await flush();
    expect(handle("right", "timeline")).not.toBeNull();
    expect(zoneEl("bottom")).toBeNull();
    expect(dockingState.created).toHaveLength(0);
    expect(dockingState.destroyed).toHaveLength(0);
  }, 30000);

  test("dragging a tab reorders panels inside one zone", async () => {
    await renderEditor();
    await panelMenu("side");
    await choose(en["panel.dock.bottom"]);
    const tabs = document.querySelectorAll('[data-zone="bottom"] [data-panel-tab]');
    expect(tabs).toHaveLength(2);
    await act(async () => {
      fireEvent.pointerDown(tabs[1], { button: 0, buttons: 1, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerMove(tabs[0], { buttons: 1, pointerId: 1, clientX: 10, clientY: 10 });
    });
    await act(async () => {
      fireEvent.pointerUp(window, { buttons: 0, pointerId: 1 });
    });
    await flush();
    const order = [...document.querySelectorAll('[data-zone="bottom"] [data-panel-tab]')].map(
      (tab) => tab.getAttribute("data-panel-tab")
    );
    expect(order).toEqual(["side", "timeline"]);
    expect(dockingState.created).toHaveLength(0);
  }, 30000);

  test("several panels share one zone as tabs and only the active one mounts", async () => {
    await renderEditor();
    await panelMenu("tools");
    await choose(en["panel.dock.bottom"]);
    await panelMenu("side");
    await choose(en["panel.dock.bottom"]);
    expect(document.querySelectorAll('[data-zone="bottom"] [data-panel-tab]')).toHaveLength(3);
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: en["panel.timeline"] }));
    });
    await flush();
    expect(screen.getByLabelText(en["editor.frame"])).toBeTruthy();
    expect(screen.queryByLabelText(en["editor.x"])).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: en["panel.side"] }));
    });
    await flush();
    expect(screen.getByLabelText(en["editor.x"])).toBeTruthy();
    expect(screen.queryByLabelText(en["editor.frame"])).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: en["panel.tools"] }));
    });
    await flush();
    expect(handle("bottom", "tools")).not.toBeNull();
    expect(screen.queryByLabelText(en["editor.frame"])).toBeNull();
    expect(screen.queryByLabelText(en["editor.x"])).toBeNull();
    expect(dockingState.created).toHaveLength(0);
  }, 30000);

  test("hiding and restoring a panel from the workspace menu works", async () => {
    await renderEditor();
    await openMenu(en["workspace.title"]);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: en["panel.timeline"] }));
    });
    await flush();
    expect(zoneEl("bottom")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: en["panel.timeline"] }));
    });
    await flush();
    expect(handle("bottom", "timeline")).not.toBeNull();
  }, 30000);
});

describe("detaching", () => {
  test("Detach creates exactly one window and removes the panel from the dock", async () => {
    await renderEditor();
    await panelMenu("timeline");
    await choose(en["panel.detach"]);
    await waitFor(() => expect(dockingState.created).toHaveLength(1));
    await flush();
    expect(dockingState.created[0].label).toBe("panel-timeline");
    expect(dockingState.created[0].options.url).toBe("/");
    expect(dockingState.created[0].options.decorations).toBe(false);
    expect(zoneEl("bottom")).toBeNull();
    expect(handle("right", "side")).not.toBeNull();
    getCanvas();
  }, 30000);

  test("a denied window creation keeps the panel docked and reports the error", async () => {
    await renderEditor();
    dockingState.failCreate = true;
    await panelMenu("timeline");
    await choose(en["panel.detach"]);
    expect(await screen.findByText(en["workspace.detachFailed"])).toBeTruthy();
    expect(handle("bottom", "timeline")).not.toBeNull();
    expect(dockingState.created).toHaveLength(0);
  }, 30000);

  test("closing a detached panel re-docks it and keeps document edits", async () => {
    const { doc } = await renderEditor();
    await panelMenu("timeline");
    await choose(en["panel.detach"]);
    await waitFor(() => expect(dockingState.created).toHaveLength(1));
    await flush();
    const state = store.get(doc.id);
    const edited = structuredClone(state!.doc);
    edited.scenes[0].layers[0].length = 3;
    state!.doc = edited;
    await act(async () => {
      await emit("panel-changed", { id: doc.id, doc: edited });
    });
    await flush();
    expect(zoneEl("bottom")).toBeNull();
    await act(async () => {
      await emit("panel-closed", "timeline");
    });
    await flush();
    expect(handle("bottom", "timeline")).not.toBeNull();
    expect(screen.getByText("/ 3")).toBeTruthy();
    expect(dockingState.created).toHaveLength(1);
    expect(store.get(doc.id)!.doc.scenes[0].layers[0].length).toBe(3);
  }, 30000);

  test("a panel-changed event for an unknown document is ignored", async () => {
    const { doc } = await renderEditor();
    await act(async () => {
      await emit("panel-changed", { id: "missing", doc });
    });
    await flush();
    getCanvas();
    expect(screen.getByText("/ 1")).toBeTruthy();
  }, 30000);

  test("panel windows are clamped onto the monitor containing them", async () => {
    dockingState.monitors = [mockMonitor(0, 0, 1920, 1080), mockMonitor(1920, 0, 1920, 1080)];
    expect(await openPanelWindow("side", { x: 2500, y: 300, width: 420, height: 520 })).toBe(true);
    expect(dockingState.created[0].options.x).toBe(2500);
    expect(dockingState.created[0].options.y).toBe(300);
    expect(await openPanelWindow("tools", { x: 99999, y: 300, width: 420, height: 520 })).toBe(true);
    expect(dockingState.created[1].options.x).toBe(1500);
    expect(dockingState.created[1].options.y).toBe(300);
  }, 30000);

  test("panel window sizes are converted to logical pixels for scaled monitors", async () => {
    dockingState.monitors = [mockMonitor(0, 0, 3840, 2160, 2)];
    expect(await openPanelWindow("side", { x: 100, y: 100, width: 420, height: 520 })).toBe(true);
    expect(dockingState.created[0].options.width).toBe(210);
    expect(dockingState.created[0].options.height).toBe(260);
    expect(dockingState.created[0].options.x).toBe(50);
    expect(dockingState.created[0].options.y).toBe(50);
  }, 30000);
});

describe("detached panel window", () => {
  test("adopts the broadcast document and reports edits back", async () => {
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const changed = await capture<{ id: string; doc: Document }>("panel-changed");
    await mountDetached(doc);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en["command.insertFrame"] }));
    });
    await waitFor(() =>
      expect(store.get(doc.id)!.doc.scenes[0].layers[0].length).toBe(2)
    );
    await waitFor(() =>
      expect(
        changed.payloads.some(
          (payload) =>
            payload.id === doc.id && payload.doc.scenes[0].layers[0].length === 2
        )
      ).toBe(true)
    );
    expect((screen.getByLabelText(en["editor.frame"]) as HTMLInputElement).value).toBe("2");
    changed.stop();
  }, 30000);

  test("Reattach emits panel-closed and destroys the window", async () => {
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const closed = await capture<string>("panel-closed");
    await mountDetached(doc);
    await openMenu(`${en["panel.timeline"]} ${en["panel.menu"]}`);
    await choose(en["panel.reattach"]);
    await waitFor(() => expect(dockingState.destroyed).toContain("panel-timeline"));
    expect(closed.payloads).toContain("timeline");
    closed.stop();
  }, 30000);

  test("a native close request preserves the document and destroys the window", async () => {
    const doc = await docNew("Test", 800, 600, 24, "#ffffff");
    const closed = await capture<string>("panel-closed");
    await mountDetached(doc);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en["command.insertFrame"] }));
    });
    await waitFor(() =>
      expect(store.get(doc.id)!.doc.scenes[0].layers[0].length).toBe(2)
    );
    await act(async () => {
      await emit("tauri://close-requested", null);
    });
    await waitFor(() => expect(dockingState.destroyed).toContain("panel-timeline"));
    expect(closed.payloads).toContain("timeline");
    expect(store.get(doc.id)!.doc.scenes[0].layers[0].length).toBe(2);
    closed.stop();
  }, 30000);

  test("destroying a panel window removes it from the window list", async () => {
    expect(await openPanelWindow("side")).toBe(true);
    expect(dockingState.created).toHaveLength(1);
    await destroyPanelWindow("side");
    expect(dockingState.destroyed).toContain("panel-side");
    expect(dockingState.created).toHaveLength(0);
    expect(await openPanelWindow("side")).toBe(true);
    expect(dockingState.created).toHaveLength(1);
  }, 30000);
});