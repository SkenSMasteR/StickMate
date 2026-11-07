import { describe, expect, it } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { flattenPath } from "@/lib/document";
import type { Shape } from "@/lib/document";
import { store } from "./backend";
import { click, drag, flush, getCanvas, press, renderEditor } from "./utils";

function shapes(id: string): Shape[] {
  const state = store.get(id);
  if (!state) {
    throw new Error("document is not in the store");
  }
  return state.doc.scenes[0].layers[0].keys[0].shapes;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label)
  );
  if (!found) {
    throw new Error(`button not found: ${label}`);
  }
  return found as HTMLButtonElement;
}

function anchor(index: number): Element {
  const found = getCanvas().querySelector(`[data-anchor="${index}"]`);
  if (!found) {
    throw new Error(`anchor not found: ${index}`);
  }
  return found;
}

function handle(side: "in" | "out"): Element {
  const found = getCanvas().querySelector(`[data-handle="${side}"]`);
  if (!found) {
    throw new Error(`handle not found: ${side}`);
  }
  return found;
}

function firstPath(): Element {
  const found = getCanvas().querySelector("path");
  if (!found) {
    throw new Error("path is not rendered");
  }
  return found;
}

async function penClicks(points: Array<[number, number]>): Promise<void> {
  await press("n");
  for (const point of points) {
    await click(getCanvas(), point);
  }
}

const base = { pointerId: 1, button: 0, buttons: 1, bubbles: true };

describe("pen tool", () => {
  it("places nodes and commits one path with one undo entry on Enter", async () => {
    const { doc } = await renderEditor();
    await penClicks([
      [100, 100],
      [200, 100],
      [200, 200]
    ]);
    expect(shapes(doc.id)).toHaveLength(0);
    await press("Enter");
    const drawn = shapes(doc.id);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].kind).toBe("Path");
    if (drawn[0].kind === "Path") {
      expect(drawn[0].closed).toBe(false);
      expect(drawn[0].nodes).toHaveLength(3);
      expect(drawn[0].nodes[0]).toEqual({
        point: { x: 100, y: 100 },
        handle_in: null,
        handle_out: null
      });
      expect(drawn[0].nodes[2].point).toEqual({ x: 200, y: 200 });
    }
    expect(store.get(doc.id)?.undo).toHaveLength(1);
    const d = firstPath().getAttribute("d");
    expect(d).toContain("M 100 100");
    expect(d).toContain(" C ");
    expect(d).not.toContain("Z");
    expect(firstPath().getAttribute("fill")).toBe("none");
    await press("z", { ctrlKey: true });
    expect(shapes(doc.id)).toHaveLength(0);
  }, 15000);

  it("pulls mirrored handles when dragging while placing a node", async () => {
    const { doc } = await renderEditor();
    await press("n");
    await drag(getCanvas(), [
      [100, 100],
      [130, 140]
    ]);
    expect(shapes(doc.id)).toHaveLength(0);
    await click(getCanvas(), [200, 100]);
    expect(firstPath().getAttribute("d")).toContain("C 130 140");
    await press("Enter");
    const drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Path");
    if (drawn.kind === "Path") {
      expect(drawn.nodes[0]).toEqual({
        point: { x: 100, y: 100 },
        handle_in: { x: 70, y: 60 },
        handle_out: { x: 130, y: 140 }
      });
      expect(drawn.nodes[1].handle_in).toBeNull();
      expect(drawn.nodes[1].handle_out).toBeNull();
    }
    expect(store.get(doc.id)?.undo).toHaveLength(1);
  });

  it("closes and commits when clicking the first node", async () => {
    const { doc } = await renderEditor();
    await penClicks([
      [100, 100],
      [200, 100],
      [200, 200]
    ]);
    await click(getCanvas(), [102, 101]);
    const drawn = shapes(doc.id);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].kind).toBe("Path");
    if (drawn[0].kind === "Path") {
      expect(drawn[0].closed).toBe(true);
      expect(drawn[0].nodes).toHaveLength(3);
    }
    expect(store.get(doc.id)?.undo).toHaveLength(1);
    expect(firstPath().getAttribute("d")).toContain("Z");
    expect(firstPath().getAttribute("fill")).toBe("#3b82f6");
  });

  it("discards a single node draft on Escape", async () => {
    const { doc } = await renderEditor();
    await penClicks([[100, 100]]);
    expect(getCanvas().querySelectorAll("path")).toHaveLength(1);
    await press("Escape");
    expect(shapes(doc.id)).toHaveLength(0);
    expect(store.get(doc.id)?.undo).toHaveLength(0);
    expect(getCanvas().querySelectorAll("path")).toHaveLength(0);
  });

  it("commits an open path on Escape and on double click", async () => {
    const { doc } = await renderEditor();
    await penClicks([
      [100, 100],
      [200, 100]
    ]);
    await press("Escape");
    expect(shapes(doc.id)).toHaveLength(1);
    await penClicks([
      [300, 300],
      [400, 300]
    ]);
    await act(async () => {
      fireEvent.doubleClick(getCanvas());
    });
    await flush();
    const drawn = shapes(doc.id);
    expect(drawn).toHaveLength(2);
    expect(drawn[1].kind).toBe("Path");
    if (drawn[1].kind === "Path") {
      expect(drawn[1].closed).toBe(false);
      expect(drawn[1].nodes).toHaveLength(2);
    }
    expect(store.get(doc.id)?.undo).toHaveLength(2);
  });

  it("commits the draft when switching tool", async () => {
    const { doc } = await renderEditor();
    await penClicks([
      [100, 100],
      [200, 100]
    ]);
    await press("p");
    const drawn = shapes(doc.id);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].kind).toBe("Path");
    expect(getCanvas().querySelectorAll("path")).toHaveLength(1);
  });

  it("deletes a crossed closed path with the eraser", async () => {
    const { doc } = await renderEditor();
    await penClicks([
      [100, 100],
      [200, 100],
      [200, 200]
    ]);
    await click(getCanvas(), [100, 100]);
    expect(shapes(doc.id)).toHaveLength(1);
    await press("e");
    await drag(getCanvas(), [
      [150, 110],
      [150, 150]
    ]);
    expect(shapes(doc.id)).toHaveLength(0);
  });

  it("rejects placement and commit on a locked layer", async () => {
    const { doc } = await renderEditor();
    await penClicks([
      [100, 100],
      [200, 100]
    ]);
    const state = store.get(doc.id);
    if (!state) {
      throw new Error("document is not in the store");
    }
    state.doc.scenes[0].layers[0].locked = true;
    const candidates = document.querySelectorAll('button[title="Layer 1"]');
    const layerButton = candidates[candidates.length - 1];
    if (!layerButton) {
      throw new Error("layer button not found");
    }
    await act(async () => {
      fireEvent.doubleClick(layerButton);
    });
    const input = document.querySelector('input[aria-label="Layer name"]');
    if (!input) {
      throw new Error("rename input not found");
    }
    await act(async () => {
      fireEvent.change(input, { target: { value: "Ink" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await flush();
    await click(getCanvas(), [300, 300]);
    await press("Enter");
    expect(shapes(doc.id)).toHaveLength(0);
    expect(store.get(doc.id)?.undo).toHaveLength(1);
    expect(getCanvas().querySelectorAll("path")).toHaveLength(0);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Layer is locked")
    );
  });
});

describe("node tool", () => {
  it("selects a path, reveals anchors and drags point plus handles", async () => {
    const { doc } = await renderEditor();
    await press("n");
    await drag(getCanvas(), [
      [100, 100],
      [130, 140]
    ]);
    await click(getCanvas(), [200, 100]);
    await press("Enter");
    await press("a");
    await click(firstPath(), [161, 115]);
    expect(getCanvas().querySelectorAll("[data-anchor]")).toHaveLength(2);
    await click(anchor(0), [100, 100]);
    expect(getCanvas().querySelectorAll("[data-handle]")).toHaveLength(2);
    expect(store.get(doc.id)?.undo).toHaveLength(1);
    await act(async () => {
      fireEvent.pointerDown(anchor(0), { ...base, clientX: 100, clientY: 100 });
    });
    await act(async () => {
      fireEvent.pointerMove(getCanvas(), { ...base, clientX: 110, clientY: 120 });
    });
    expect(firstPath().getAttribute("d")).toContain("M 110 120");
    const before = shapes(doc.id)[0];
    if (before.kind === "Path") {
      expect(before.nodes[0].point).toEqual({ x: 100, y: 100 });
    }
    await act(async () => {
      fireEvent.pointerUp(getCanvas(), { ...base, buttons: 0, clientX: 110, clientY: 120 });
    });
    await flush();
    const drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Path");
    if (drawn.kind === "Path") {
      expect(drawn.nodes[0]).toEqual({
        point: { x: 110, y: 120 },
        handle_in: { x: 80, y: 80 },
        handle_out: { x: 140, y: 160 }
      });
      expect(drawn.nodes[1].point).toEqual({ x: 200, y: 100 });
    }
    expect(store.get(doc.id)?.undo).toHaveLength(2);
  });

  it("mirrors the opposite handle on drag and breaks symmetry with Alt", async () => {
    const { doc } = await renderEditor();
    await press("n");
    await drag(getCanvas(), [
      [100, 100],
      [130, 140]
    ]);
    await click(getCanvas(), [200, 100]);
    await press("Enter");
    await press("a");
    await click(firstPath(), [161, 115]);
    await click(anchor(0), [100, 100]);
    await drag(handle("out"), [
      [130, 140],
      [150, 100]
    ]);
    let drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Path");
    if (drawn.kind === "Path") {
      expect(drawn.nodes[0].handle_out).toEqual({ x: 150, y: 100 });
      expect(drawn.nodes[0].handle_in).toEqual({ x: 50, y: 100 });
      expect(drawn.nodes[0].point).toEqual({ x: 100, y: 100 });
    }
    expect(store.get(doc.id)?.undo).toHaveLength(2);
    await act(async () => {
      fireEvent.pointerDown(handle("out"), { ...base, clientX: 150, clientY: 100 });
    });
    await act(async () => {
      fireEvent.pointerMove(getCanvas(), {
        ...base,
        altKey: true,
        clientX: 160,
        clientY: 120
      });
    });
    await act(async () => {
      fireEvent.pointerUp(getCanvas(), {
        ...base,
        buttons: 0,
        altKey: true,
        clientX: 160,
        clientY: 120
      });
    });
    await flush();
    drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Path");
    if (drawn.kind === "Path") {
      expect(drawn.nodes[0].handle_out).toEqual({ x: 160, y: 120 });
      expect(drawn.nodes[0].handle_in).toEqual({ x: 50, y: 100 });
    }
    expect(store.get(doc.id)?.undo).toHaveLength(3);
  });

  it("removes a node and refuses to drop below the minimum", async () => {
    const { doc } = await renderEditor();
    await penClicks([
      [100, 100],
      [200, 100],
      [200, 200]
    ]);
    await press("Enter");
    await press("a");
    await click(firstPath(), [150, 100]);
    await click(anchor(1), [200, 100]);
    await act(async () => {
      fireEvent.click(button("Remove node"));
    });
    await flush();
    let drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Path");
    if (drawn.kind === "Path") {
      expect(drawn.nodes).toHaveLength(2);
      expect(drawn.nodes[1].point).toEqual({ x: 200, y: 200 });
    }
    expect(store.get(doc.id)?.undo).toHaveLength(2);
    await click(anchor(0), [100, 100]);
    await act(async () => {
      fireEvent.click(button("Remove node"));
    });
    await flush();
    drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Path");
    if (drawn.kind === "Path") {
      expect(drawn.nodes).toHaveLength(2);
    }
    expect(store.get(doc.id)?.undo).toHaveLength(2);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Path is too short")
    );
  });

  it("refuses to remove a node from a closed triangle", async () => {
    const { doc } = await renderEditor();
    await penClicks([
      [100, 100],
      [200, 100],
      [200, 200]
    ]);
    await click(getCanvas(), [100, 100]);
    await press("a");
    await click(firstPath(), [150, 100]);
    await click(anchor(0), [100, 100]);
    await act(async () => {
      fireEvent.click(button("Remove node"));
    });
    await flush();
    const drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Path");
    if (drawn.kind === "Path") {
      expect(drawn.closed).toBe(true);
      expect(drawn.nodes).toHaveLength(3);
    }
    expect(store.get(doc.id)?.undo).toHaveLength(1);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Path is too short")
    );
  });

  it("edits node coordinates from the side panel", async () => {
    const { doc } = await renderEditor();
    await penClicks([
      [100, 100],
      [200, 100],
      [200, 200]
    ]);
    await press("Enter");
    await press("a");
    await click(firstPath(), [150, 100]);
    await click(anchor(0), [100, 100]);
    const input = [...document.querySelectorAll("label")]
      .find((item) => item.textContent?.includes("Node X"))
      ?.querySelector("input");
    if (!input) {
      throw new Error("node X field not found");
    }
    await act(async () => {
      fireEvent.change(input, { target: { value: "120" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await flush();
    const drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Path");
    if (drawn.kind === "Path") {
      expect(drawn.nodes[0].point).toEqual({ x: 120, y: 100 });
    }
    expect(store.get(doc.id)?.undo).toHaveLength(2);
  });

  it("toggles closed from the side panel", async () => {
    const { doc } = await renderEditor();
    await penClicks([
      [100, 100],
      [200, 100],
      [200, 200]
    ]);
    await press("Enter");
    await press("a");
    await click(firstPath(), [150, 100]);
    const toggle = button("Closed");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      fireEvent.click(toggle);
    });
    await flush();
    const drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Path");
    if (drawn.kind === "Path") {
      expect(drawn.closed).toBe(true);
    }
    expect(firstPath().getAttribute("d")).toContain("Z");
    expect(store.get(doc.id)?.undo).toHaveLength(2);
  });

  it("bounds the selection outline by the flattened curve", async () => {
    const { doc } = await renderEditor();
    await press("n");
    await drag(getCanvas(), [
      [100, 100],
      [130, 140]
    ]);
    await click(getCanvas(), [200, 100]);
    await press("Enter");
    const drawn = shapes(doc.id)[0];
    expect(drawn.kind).toBe("Path");
    if (drawn.kind !== "Path") {
      return;
    }
    await press("v");
    await click(firstPath(), [161, 115]);
    const outline = getCanvas().querySelector('rect[stroke-dasharray="4 3"]');
    if (!outline) {
      throw new Error("selection outline not found");
    }
    const flat = flattenPath(drawn.nodes, drawn.closed);
    const pad = drawn.width / 2;
    const minX = Math.min(...flat.map((point) => point.x)) - pad;
    const minY = Math.min(...flat.map((point) => point.y)) - pad;
    const maxX = Math.max(...flat.map((point) => point.x)) + pad;
    const maxY = Math.max(...flat.map((point) => point.y)) + pad;
    expect(Number(outline.getAttribute("x"))).toBeCloseTo(minX, 6);
    expect(Number(outline.getAttribute("y"))).toBeCloseTo(minY, 6);
    expect(Number(outline.getAttribute("width"))).toBeCloseTo(maxX - minX, 6);
    expect(Number(outline.getAttribute("height"))).toBeCloseTo(maxY - minY, 6);
    expect(maxY).toBeGreaterThan(110);
  });
});