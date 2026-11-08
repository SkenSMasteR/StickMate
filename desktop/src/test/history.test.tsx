import { describe, expect, test } from "vitest";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import en from "@/i18n/en.json";
import { I18nProvider } from "@/i18n";
import { ConfirmProvider } from "@/lib/confirm";
import { PrefsProvider } from "@/lib/prefs";
import { docNew } from "@/lib/document";
import Editor from "@/editor/Editor";
import HistoryPanel from "@/editor/HistoryPanel";
import { WorkspaceProvider, useWorkspace } from "@/editor/workspace";
import { installBackend, store } from "./backend";
import { drag, flush, getCanvas, press } from "./utils";

function Opener({ id, children }: { id: string; children: ReactNode }) {
  const { open } = useWorkspace();
  useEffect(() => {
    void open(id);
  }, [id, open]);
  return <>{children}</>;
}

function tree(id: string) {
  return (
    <PrefsProvider>
      <I18nProvider language="en" onLanguageChange={() => {}}>
        <ConfirmProvider>
          <WorkspaceProvider>
            <Opener id={id}>
              <Editor />
              <div data-testid="history-panel">
                <HistoryPanel />
              </div>
            </Opener>
          </WorkspaceProvider>
        </ConfirmProvider>
      </I18nProvider>
    </PrefsProvider>
  );
}

async function setup() {
  installBackend("editor");
  const doc = await docNew("Test", 800, 600, 24, "#ffffff");
  const view = render(tree(doc.id));
  await waitFor(() => getCanvas(800, 600));
  await flush();
  return { view, doc };
}

function panel(): HTMLElement {
  return screen.getByTestId("history-panel");
}

function stepButtons(): HTMLButtonElement[] {
  return Array.from(panel().querySelectorAll<HTMLButtonElement>("ol li button"));
}

function stepNames(): string[] {
  return stepButtons().map((button) => button.getAttribute("aria-label") ?? "");
}

function currentName(): string | null {
  const current = panel().querySelector<HTMLButtonElement>(
    'ol li button[aria-current="step"]'
  );
  return current?.getAttribute("aria-label") ?? null;
}

function checkpointRows(): HTMLElement[] {
  return Array.from(panel().querySelectorAll<HTMLElement>("ul li"));
}

async function drawStroke(): Promise<void> {
  await press("p");
  await drag(getCanvas(), [
    [10, 10],
    [40, 40]
  ]);
}

async function clickStep(name: string, occurrence = 0): Promise<void> {
  const matches = stepButtons().filter(
    (button) => button.getAttribute("aria-label") === name
  );
  await act(async () => {
    fireEvent.click(matches[occurrence]);
  });
  await flush();
}

async function typeName(value: string): Promise<void> {
  const input = within(panel()).getByRole("textbox", {
    name: en["history.checkpointName"]
  });
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
  await flush();
}

async function clickPanelButton(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(within(panel()).getByRole("button", { name }));
  });
  await flush();
}

async function settleDialog(label: string): Promise<void> {
  const dialog = await screen.findByRole("dialog");
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: label }));
  });
  await flush();
}

function polylines(): number {
  return getCanvas().querySelectorAll("polyline").length;
}

describe("history panel", () => {
  test("lists named steps and marks the current one", async () => {
    await setup();
    await waitFor(() => expect(stepNames()).toEqual([en["history.step.new_document"]]));
    expect(currentName()).toBe(en["history.step.new_document"]);
    await drawStroke();
    await drawStroke();
    await waitFor(() => expect(stepButtons()).toHaveLength(3));
    expect(stepNames()).toEqual([
      en["history.step.new_document"],
      en["history.step.draw_stroke"],
      en["history.step.draw_stroke"]
    ]);
    expect(currentName()).toBe(en["history.step.draw_stroke"]);
    expect(
      panel().querySelectorAll('ol li button[aria-current="step"]')
    ).toHaveLength(1);
  });

  test("jumps backward then forward and keeps the canvas in sync", async () => {
    const { doc } = await setup();
    await drawStroke();
    await drawStroke();
    await waitFor(() => expect(polylines()).toBe(2));
    await clickStep(en["history.step.new_document"]);
    await waitFor(() => expect(currentName()).toBe(en["history.step.new_document"]));
    await waitFor(() => expect(polylines()).toBe(0));
    expect(store.get(doc.id)?.undo).toHaveLength(0);
    expect(store.get(doc.id)?.redo).toHaveLength(2);
    await clickStep(en["history.step.draw_stroke"], 1);
    await waitFor(() => expect(currentName()).toBe(en["history.step.draw_stroke"]));
    await waitFor(() => expect(polylines()).toBe(2));
    expect(store.get(doc.id)?.undo).toHaveLength(2);
    expect(store.get(doc.id)?.redo).toHaveLength(0);
    expect(stepButtons()).toHaveLength(3);
  });

  test("keeps history separate per document", async () => {
    const { view, doc } = await setup();
    await drawStroke();
    await waitFor(() => expect(stepButtons()).toHaveLength(2));
    const other = await docNew("Other", 800, 600, 24, "#ffffff");
    await act(async () => {
      view.rerender(tree(other.id));
    });
    await flush();
    await waitFor(() => expect(currentName()).toBe(en["history.step.new_document"]));
    expect(stepButtons()).toHaveLength(1);
    expect(store.get(other.id)?.undo).toHaveLength(0);
    await act(async () => {
      view.rerender(tree(doc.id));
    });
    await flush();
    await waitFor(() => expect(stepButtons()).toHaveLength(2));
    expect(currentName()).toBe(en["history.step.draw_stroke"]);
  });

  test("saves, restores and deletes a checkpoint", async () => {
    const { doc } = await setup();
    await drawStroke();
    await waitFor(() => expect(polylines()).toBe(1));
    await typeName("Before");
    await clickPanelButton(en["history.save"]);
    await waitFor(() => expect(checkpointRows()).toHaveLength(1));
    expect(checkpointRows()[0].textContent).toContain("Before");
    await drawStroke();
    await waitFor(() => expect(polylines()).toBe(2));
    await clickPanelButton(en["history.restore"]);
    await settleDialog(en["history.restore"]);
    await waitFor(() => expect(polylines()).toBe(1));
    expect(currentName()).toBe(en["history.step.restore_checkpoint"]);
    expect(store.get(doc.id)?.undo).toHaveLength(3);
    await clickPanelButton(en["history.delete"]);
    await settleDialog(en["history.delete"]);
    await waitFor(() => expect(checkpointRows()).toHaveLength(0));
    expect(within(panel()).getByText(en["history.none"])).toBeTruthy();
  });

  test("cancelling the restore confirmation keeps the document", async () => {
    await setup();
    await drawStroke();
    await typeName("Keep");
    await clickPanelButton(en["history.save"]);
    await waitFor(() => expect(checkpointRows()).toHaveLength(1));
    await drawStroke();
    await waitFor(() => expect(polylines()).toBe(2));
    await clickPanelButton(en["history.restore"]);
    await settleDialog(en["editor.cancel"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(polylines()).toBe(2);
    expect(currentName()).toBe(en["history.step.draw_stroke"]);
    expect(checkpointRows()).toHaveLength(1);
  });

  test("cancelling the delete confirmation keeps the checkpoint", async () => {
    await setup();
    await typeName("Stay");
    await clickPanelButton(en["history.save"]);
    await waitFor(() => expect(checkpointRows()).toHaveLength(1));
    await clickPanelButton(en["history.delete"]);
    await settleDialog(en["editor.cancel"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(checkpointRows()).toHaveLength(1);
    expect(checkpointRows()[0].textContent).toContain("Stay");
  });

  test("rejects an invalid checkpoint name", async () => {
    await setup();
    await typeName("bad/name");
    await clickPanelButton(en["history.save"]);
    await waitFor(() =>
      expect(within(panel()).getByRole("alert").textContent).toBe(
        "checkpoint name is invalid"
      )
    );
    expect(checkpointRows()).toHaveLength(0);
  });

  test("disables save until the name has content", async () => {
    await setup();
    const save = within(panel()).getByRole("button", { name: en["history.save"] });
    expect(save.hasAttribute("disabled")).toBe(true);
    await typeName("   ");
    expect(
      within(panel())
        .getByRole("button", { name: en["history.save"] })
        .hasAttribute("disabled")
    ).toBe(true);
    await typeName("Real");
    expect(
      within(panel())
        .getByRole("button", { name: en["history.save"] })
        .hasAttribute("disabled")
    ).toBe(false);
  });
}, 30000);