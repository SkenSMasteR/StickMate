import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import en from "@/i18n/en.json";
import { docDraw } from "@/lib/document";
import { defaultView } from "@/lib/view";
import { server } from "./backend/prefs";
import { flush, press, renderEditor } from "./utils";

function toggle(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-view-toggle="${id}"]`);
  if (!found) {
    throw new Error(`view toggle ${id} is not mounted`);
  }
  return found;
}

async function clickToggle(id: string): Promise<void> {
  await act(async () => {
    fireEvent.click(toggle(id));
  });
  await flush();
}

async function openView(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: en["panel.view"] }));
  });
  await flush();
}

async function writeNumber(label: string, value: string): Promise<void> {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
  await flush();
}

async function seek(frame: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(en["editor.frame"]), { target: { value: frame } });
  });
  await flush();
}

function onionGroup(): Element | null {
  return document.querySelector("[data-onion-mode]");
}

describe("view panel", () => {
  test("guides and canvas backdrop react to the toggles", async () => {
    await renderEditor();
    await openView();
    expect(toggle("grid").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("[data-view-grid]")).toBeNull();

    await clickToggle("grid");
    expect(document.querySelector("[data-view-grid]")).not.toBeNull();
    expect(toggle("grid").getAttribute("aria-pressed")).toBe("true");
    await writeNumber(en["view.gridSize"], "100");
    expect(document.getElementById("stickmate-grid")?.getAttribute("width")).toBe("100");

    await clickToggle("rulers");
    expect(document.querySelectorAll("[data-ruler]")).toHaveLength(2);
    expect(document.querySelector('[data-ruler="top"] line')).not.toBeNull();

    await clickToggle("safeAreas");
    expect(document.querySelectorAll("[data-view-safe] rect")).toHaveLength(2);

    expect(document.querySelector("[data-stage]")?.getAttribute("fill")).toBe("#ffffff");
    await clickToggle("checkerboard");
    expect(document.querySelector("[data-stage]")?.getAttribute("fill")).toBe(
      "url(#stickmate-transparency)"
    );

    await waitFor(() => {
      const stored = server.data.view as Record<string, unknown> | undefined;
      expect(stored?.gridSize).toBe(100);
      expect(stored?.rulers).toBe(true);
      expect(stored?.safeAreas).toBe(true);
      expect(stored?.checkerboard).toBe(true);
    });

    await clickToggle("grid");
    expect(document.querySelector("[data-view-grid]")).toBeNull();
    await clickToggle("rulers");
    expect(document.querySelectorAll("[data-ruler]")).toHaveLength(0);
  });

  test("onion skin follows the view settings", async () => {
    const { doc } = await renderEditor();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en["command.insertFrames"] }));
    });
    await waitFor(() =>
      expect((screen.getByLabelText(en["editor.frame"]) as HTMLInputElement).max).toBe("2")
    );
    await docDraw(doc.id, doc.scenes[0].id, doc.scenes[0].layers[0].id, 0, {
      kind: "Stroke",
      points: [
        { x: 10, y: 10 },
        { x: 40, y: 10 }
      ],
      color: "#000000",
      width: 2
    });
    await press("f6");
    await openView();
    await seek("2");
    expect(onionGroup()).toBeNull();

    await clickToggle("onion");
    await waitFor(() => expect(onionGroup()?.querySelector("g")).not.toBeNull());
    expect(onionGroup()?.getAttribute("data-onion-mode")).toBe("ghost");
    expect(onionGroup()?.querySelector("g")?.getAttribute("opacity")).toBe(
      String(defaultView.onionOpacity)
    );

    await clickToggle("trace");
    expect(onionGroup()?.getAttribute("data-onion-mode")).toBe("trace");

    await writeNumber(en["view.opacity"], "60");
    await waitFor(() =>
      expect(onionGroup()?.querySelector("g")?.getAttribute("opacity")).toBe("0.6")
    );
  });
});
