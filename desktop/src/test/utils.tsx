import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import App from "@/App";
import { docNew } from "@/lib/document";
import type { Document } from "@/lib/document";
import { installBackend } from "./backend";

export function getCanvas(width = 800, height = 600): SVGSVGElement {
  const found = document.querySelector<SVGSVGElement>(
    `svg[viewBox="0 0 ${width} ${height}"]`
  );
  if (!found) {
    throw new Error("canvas is not mounted");
  }
  return found;
}

export async function renderEditor(
  width = 800,
  height = 600,
  fps = 24
): Promise<RenderResult & { doc: Document }> {
  installBackend("editor");
  const doc = await docNew("Test", width, height, fps, "#ffffff");
  const view = render(<App />);
  await act(async () => {
    await emit("editor-open", doc.id);
  });
  await waitFor(() => getCanvas(width, height));
  await flush();
  return { ...view, doc };
}

export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

export async function press(key: string, modifiers: Partial<KeyboardEvent> = {}) {
  await act(async () => {
    fireEvent.keyDown(window, { key, ...modifiers });
  });
  await flush();
}

export async function drag(
  target: Element,
  points: Array<[number, number]>,
  button = 0
): Promise<void> {
  const base = { pointerId: 1, button, buttons: 1, bubbles: true };
  const first = points[0];
  await act(async () => {
    fireEvent.pointerDown(target, {
      ...base,
      clientX: first[0],
      clientY: first[1]
    });
  });
  for (const point of points.slice(1, -1)) {
    await act(async () => {
      fireEvent.pointerMove(target, {
        ...base,
        clientX: point[0],
        clientY: point[1]
      });
    });
  }
  const last = points[points.length - 1];
  await act(async () => {
    fireEvent.pointerMove(target, {
      ...base,
      clientX: last[0],
      clientY: last[1]
    });
  });
  await act(async () => {
    fireEvent.pointerUp(target, {
      ...base,
      buttons: 0,
      clientX: last[0],
      clientY: last[1]
    });
  });
  await flush();
}

export async function click(
  target: Element,
  point: [number, number] = [0, 0]
): Promise<void> {
  await drag(target, [point, point]);
}