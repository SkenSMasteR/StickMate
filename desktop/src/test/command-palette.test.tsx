import { describe, expect, test } from "vitest";
import { useEffect, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster } from "@/components/ui/sonner";
import CommandPalette from "@/editor/CommandPalette";
import ShortcutsDialog from "@/editor/ShortcutsDialog";
import SidePanel from "@/editor/SidePanel";
import Timeline from "@/editor/Timeline";
import ToolsPanel from "@/editor/ToolsPanel";
import { buildCommands, useCommandKeys } from "@/editor/commands";
import { WorkspaceProvider, useWorkspace } from "@/editor/workspace";
import { I18nProvider, useI18n } from "@/i18n";
import { ConfirmProvider, useConfirm } from "@/lib/confirm";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import { docNew } from "@/lib/document";
import type { Document } from "@/lib/document";
import { installBackend, store } from "./backend";
import { server } from "./backend/prefs";
import { flush, press } from "./utils";

function Host({ docId }: { docId: string }) {
  const {
    doc,
    scene,
    layer,
    tab,
    frame,
    total,
    ids,
    docs,
    activeId,
    actions,
    activate,
    close,
    open
  } = useWorkspace();
  const { t } = useI18n();
  const { prefs, update, loaded } = usePrefs();
  const confirm = useConfirm();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteCommand, setPaletteCommand] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    void open(docId);
  }, [open, docId]);

  const openPalette = (commandId?: string) => {
    setPaletteCommand(commandId ?? null);
    setPaletteOpen(true);
  };

  const commands = buildCommands(
    actions,
    t,
    prefs.shortcuts,
    () => setShortcutsOpen(true),
    () => {},
    {
      state: { doc, scene, layer, tab, frame, total, ids, docs, activeId },
      openPalette,
      confirm,
      activate,
      close
    }
  );

  useCommandKeys(
    commands,
    Boolean(doc && tab) && loaded && !paletteOpen && !shortcutsOpen
  );

  if (!loaded || !doc || !tab) {
    return null;
  }

  return (
    <div>
      <button
        type="button"
        aria-label={t("command.palette")}
        onClick={() => openPalette()}
      >
        {t("command.palette")}
      </button>
      <div
        data-testid="probe"
        data-tool={tab.tool}
        data-zoom={tab.zoom}
        data-frame={frame}
        data-onion-range={tab.onionRange}
        data-loop-start={tab.loopStart === null ? "" : String(tab.loopStart)}
        data-loop-end={tab.loopEnd === null ? "" : String(tab.loopEnd)}
        data-layer={layer?.id ?? ""}
        data-scene={scene?.id ?? ""}
      />
      <ToolsPanel onShortcuts={() => setShortcutsOpen(true)} onExport={() => {}} />
      <Timeline />
      <SidePanel />
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        initialCommand={paletteCommand}
        onClose={() => {
          setPaletteOpen(false);
          setPaletteCommand(null);
        }}
      />
      <ShortcutsDialog
        open={shortcutsOpen}
        commands={commands}
        overrides={prefs.shortcuts}
        onChange={(next) => void update({ shortcuts: next })}
        onClose={() => setShortcutsOpen(false)}
      />
    </div>
  );
}

async function renderHost(): Promise<Document> {
  installBackend("palette");
  const doc = await docNew("Test", 800, 600, 24, "#ffffff");
  render(
    <PrefsProvider>
      <I18nProvider language="en" onLanguageChange={() => {}}>
        <ConfirmProvider>
          <WorkspaceProvider>
            <Host docId={doc.id} />
          </WorkspaceProvider>
        </ConfirmProvider>
      </I18nProvider>
      <Toaster />
    </PrefsProvider>
  );
  await waitFor(() => expect(screen.getByTestId("probe")).toBeTruthy());
  await flush();
  return doc;
}

function currentDoc(doc: Document): Document {
  const state = store.get(doc.id);
  if (!state) {
    throw new Error("document missing from store");
  }
  return state.doc;
}

function layerOf(doc: Document) {
  return currentDoc(doc).scenes[0].layers[0];
}

function probe(): DOMStringMap {
  return screen.getByTestId("probe").dataset;
}

function combobox(): HTMLInputElement {
  return screen.getByRole("combobox") as HTMLInputElement;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function field(label: string): HTMLInputElement {
  return within(dialog()).getByLabelText(label) as HTMLInputElement;
}

function selectField(label: string): HTMLSelectElement {
  return within(dialog()).getByLabelText(label) as HTMLSelectElement;
}

async function openPalette(): Promise<void> {
  await press("k", { ctrlKey: true });
  await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
}

async function closePalette(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(combobox(), { key: "Escape", bubbles: true });
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

async function filter(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(combobox(), { target: { value: text } });
  });
}

async function keyOn(
  target: Element,
  key: string,
  modifiers: Partial<KeyboardEvent> = {}
): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, { key, bubbles: true, ...modifiers });
  });
  await flush();
}

async function setValue(
  target: HTMLInputElement | HTMLSelectElement,
  value: string
): Promise<void> {
  await act(async () => {
    fireEvent.change(target, { target: { value } });
  });
}

async function runForm(): Promise<void> {
  await act(async () => {
    fireEvent.click(within(dialog()).getByRole("button", { name: "Run" }));
  });
  await flush();
}

async function openForm(query: string): Promise<void> {
  await openPalette();
  await filter(query);
  await keyOn(combobox(), "Enter");
  await waitFor(() =>
    expect(within(dialog()).getByRole("button", { name: "Run" })).toBeTruthy()
  );
}

async function clickButton(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  await flush();
}

async function insertOneFrame(): Promise<void> {
  await press("f5");
}

describe("command palette", () => {
  test("opens from its binding and from a button and lists bindings", async () => {
    await renderHost();
    await openPalette();
    const rows = screen.getAllByRole("option");
    expect(rows.length).toBeGreaterThan(40);
    const seek = rows.find((row) => row.textContent?.startsWith("Go to frame"));
    expect(seek?.textContent).toContain("Ctrl+G");
    const rename = rows.find((row) => row.textContent?.startsWith("Rename layer"));
    expect(rename?.textContent).toContain("Not set");
    await closePalette();
    await clickButton("Command palette");
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    await closePalette();
  }, 60000);

  test("search filters rows and typing in the field runs no command", async () => {
    await renderHost();
    await press("v");
    await openPalette();
    await filter("rename");
    expect(screen.getByRole("option", { name: /^Rename layer/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^Rename scene/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^Rename project/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^Pencil/ })).toBeNull();
    await keyOn(combobox(), "p");
    expect(probe().tool).toBe("select");
    await filter("zzz");
    expect(screen.getByText("No commands match")).toBeTruthy();
    await closePalette();
  }, 60000);

  test("global commands are suppressed while the palette is open", async () => {
    await renderHost();
    await press("v");
    await openPalette();
    await act(async () => {
      fireEvent.keyDown(window, { key: "p" });
    });
    await flush();
    expect(probe().tool).toBe("select");
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    await flush();
    expect(screen.getByRole("combobox")).toBeTruthy();
    await closePalette();
    await press("p");
    expect(probe().tool).toBe("pencil");
  }, 60000);

  test("arrow keys move the highlight and Enter runs the command", async () => {
    await renderHost();
    await press("v");
    await openPalette();
    expect(combobox().getAttribute("aria-activedescendant")).toBe(
      "command-palette-list-option-0"
    );
    await keyOn(combobox(), "ArrowDown");
    await keyOn(combobox(), "ArrowDown");
    expect(combobox().getAttribute("aria-activedescendant")).toBe(
      "command-palette-list-option-2"
    );
    await keyOn(combobox(), "ArrowUp");
    expect(combobox().getAttribute("aria-activedescendant")).toBe(
      "command-palette-list-option-1"
    );
    await keyOn(combobox(), "ArrowUp");
    await keyOn(combobox(), "ArrowDown");
    await keyOn(combobox(), "ArrowDown");
    await keyOn(combobox(), "Enter");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(probe().tool).toBe("brush");
  }, 60000);

  test("Enter on a parameterized row opens its form and Escape steps back", async () => {
    await renderHost();
    await openPalette();
    await filter("go to frame");
    await keyOn(combobox(), "Enter");
    await waitFor(() => expect(field("Frame number")).toBeTruthy());
    await keyOn(field("Frame number"), "Escape");
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    await closePalette();
  }, 60000);

  test("the seek binding opens a prefilled form and rejects out of range frames", async () => {
    const doc = await renderHost();
    await insertOneFrame();
    await waitFor(() => expect(layerOf(doc).length).toBe(2));
    await insertOneFrame();
    await waitFor(() => expect(layerOf(doc).length).toBe(3));
    await press("g", { ctrlKey: true });
    await waitFor(() => expect(field("Frame number")).toBeTruthy());
    expect(field("Frame number").value).toBe("3");
    expect(field("Frame number").min).toBe("1");
    expect(field("Frame number").max).toBe("3");
    await setValue(field("Frame number"), "99");
    await runForm();
    expect(screen.getByRole("alert").textContent).toBe(
      "Frame number: Value is out of range"
    );
    expect(layerOf(doc).length).toBe(3);
    expect(probe().frame).toBe("2");
    await setValue(field("Frame number"), "0");
    await runForm();
    expect(screen.getByRole("alert")).toBeTruthy();
    await setValue(field("Frame number"), "2");
    await runForm();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(probe().frame).toBe("1"));
    expect((screen.getByLabelText("Frame") as HTMLInputElement).value).toBe("2");
  }, 60000);

  test("rename layer collects the layer and name and mutates the document", async () => {
    const doc = await renderHost();
    await press("n", { ctrlKey: true, altKey: true });
    await waitFor(() => expect(currentDoc(doc).scenes[0].layers.length).toBe(2));
    const second = currentDoc(doc).scenes[0].layers[1];
    await openForm("rename layer");
    await runForm();
    expect(screen.getByRole("alert").textContent).toBe("Name: Value is required");
    await setValue(selectField("Layer"), second.id);
    await setValue(field("Name"), "Hero");
    await runForm();
    await waitFor(() =>
      expect(currentDoc(doc).scenes[0].layers[1].name).toBe("Hero")
    );
    expect(currentDoc(doc).scenes[0].layers[0].name).toBe("Layer 2");
    expect(screen.getAllByText("Hero").length).toBeGreaterThan(0);
  }, 60000);

  test("insert and remove frames by count, removal asks for confirmation", async () => {
    const doc = await renderHost();
    await openForm("insert frames by count");
    await setValue(field("Count"), "4");
    await runForm();
    await waitFor(() => expect(layerOf(doc).length).toBe(5));
    await openForm("select layer");
    await runForm();
    await flush();
    await openForm("remove frames by count");
    await setValue(field("Count"), "2");
    await runForm();
    await waitFor(() => expect(screen.getByText("Remove frames?")).toBeTruthy());
    await clickButton("Cancel");
    await flush();
    expect(layerOf(doc).length).toBe(5);
    await openForm("remove frames by count");
    await setValue(field("Count"), "2");
    await runForm();
    await waitFor(() => expect(screen.getByText("Remove frames?")).toBeTruthy());
    await clickButton("Delete");
    await waitFor(() => expect(layerOf(doc).length).toBe(3));
  }, 60000);

  test("remove layer is disabled for the last layer and confirms otherwise", async () => {
    const doc = await renderHost();
    await openPalette();
    await filter("remove layer");
    const row = screen.getByRole("option", { name: /^Remove layer/ });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    await keyOn(combobox(), "Enter");
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.queryByText("Delete layer?")).toBeNull();
    await closePalette();
    await press("n", { ctrlKey: true, altKey: true });
    await waitFor(() => expect(currentDoc(doc).scenes[0].layers.length).toBe(2));
    const second = currentDoc(doc).scenes[0].layers[1];
    await openForm("remove layer");
    await setValue(selectField("Layer"), second.id);
    await runForm();
    await waitFor(() => expect(screen.getByText("Delete layer?")).toBeTruthy());
    await clickButton("Delete");
    await waitFor(() => expect(currentDoc(doc).scenes[0].layers.length).toBe(1));
  }, 60000);

  test("scene rename, duplicate and remove work from the palette", async () => {
    const doc = await renderHost();
    await openForm("duplicate scene");
    await runForm();
    await waitFor(() => expect(currentDoc(doc).scenes.length).toBe(2));
    expect(currentDoc(doc).scenes[1].name).toBe("Scene 1 copy");
    const second = currentDoc(doc).scenes[1];
    await openForm("rename scene");
    await setValue(selectField("Scene"), second.id);
    await setValue(field("Name"), "Intro");
    await runForm();
    await waitFor(() => expect(currentDoc(doc).scenes[1].name).toBe("Intro"));
    await openForm("remove scene");
    await setValue(selectField("Scene"), second.id);
    await runForm();
    await waitFor(() => expect(screen.getByText("Delete scene?")).toBeTruthy());
    await clickButton("Delete");
    await waitFor(() => expect(currentDoc(doc).scenes.length).toBe(1));
  }, 60000);

  test("project rename and frame label mutate the document", async () => {
    const doc = await renderHost();
    await openForm("rename project");
    expect(field("Name").value).toBe("Test");
    await setValue(field("Name"), "Renamed");
    await runForm();
    await waitFor(() => expect(currentDoc(doc).name).toBe("Renamed"));
    await openForm("set frame label");
    await setValue(field("Frame label"), "intro");
    await runForm();
    await waitFor(() => expect(layerOf(doc).keys[0].label).toBe("intro"));
  }, 60000);

  test("zoom, onion range, tool choice and loop range apply their arguments", async () => {
    await renderHost();
    await press("v");
    await openForm("set zoom");
    await setValue(field("Zoom percent"), "200");
    await runForm();
    await waitFor(() => expect(probe().zoom).toBe("2"));
    await openForm("onion skin range");
    await setValue(field("Onion frames"), "4");
    await runForm();
    await waitFor(() => expect(probe().onionRange).toBe("4"));
    await openForm("choose tool");
    await setValue(selectField("Tool"), "brush");
    await runForm();
    await waitFor(() => expect(probe().tool).toBe("brush"));
    await insertOneFrame();
    await waitFor(() => expect(probe().frame).toBe("1"));
    await openForm("set loop range");
    await setValue(field("End frame"), "2");
    await runForm();
    await waitFor(() => expect(probe().loopStart).toBe("0"));
    expect(probe().loopEnd).toBe("1");
    expect(screen.getByTestId("loop-range")).toBeTruthy();
    await openPalette();
    await filter("clear loop range");
    await keyOn(combobox(), "Enter");
    await waitFor(() => expect(probe().loopStart).toBe(""));
    expect(probe().loopEnd).toBe("");
  }, 60000);

  test("move frames relocates the held key to the target frame", async () => {
    const doc = await renderHost();
    await insertOneFrame();
    await waitFor(() => expect(layerOf(doc).length).toBe(2));
    await insertOneFrame();
    await waitFor(() => expect(probe().frame).toBe("2"));
    await press("g", { ctrlKey: true });
    await waitFor(() => expect(field("Frame number")).toBeTruthy());
    await setValue(field("Frame number"), "1");
    await runForm();
    await waitFor(() => expect(probe().frame).toBe("0"));
    await openForm("move frames");
    expect(field("Target frame").value).toBe("2");
    await setValue(field("Target frame"), "3");
    await runForm();
    await waitFor(() =>
      expect(layerOf(doc).keys.some((key) => key.frame === 1)).toBe(true)
    );
    expect(layerOf(doc).length).toBe(3);
  }, 60000);

  test("new ids are bindable in the shortcuts dialog with conflict detection", async () => {
    await renderHost();
    const binding = (label: string): HTMLButtonElement => {
      const found = document.querySelector<HTMLButtonElement>(
        `[role="dialog"] button[aria-label="${label}"]`
      );
      if (!found) {
        throw new Error(`binding control not found: ${label}`);
      }
      return found;
    };
    const record = async (label: string) => {
      await act(async () => {
        fireEvent.click(binding(label));
      });
      await act(async () => {
        fireEvent.keyDown(binding(label), {
          key: "g",
          ctrlKey: true,
          bubbles: true
        });
      });
      await flush();
    };
    await press("k", { ctrlKey: true, altKey: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(binding("Rename layer").textContent).toBe("Not set");
    expect(binding("Go to frame").textContent).toBe("Ctrl+G");
    expect(binding("Command palette").textContent).toBe("Ctrl+K");
    expect(screen.getByText("Project")).toBeTruthy();
    await record("Rename layer");
    expect(screen.getByText("Ctrl+G is already used by Go to frame")).toBeTruthy();
    await clickButton("Cancel");
    expect(binding("Rename layer").textContent).toBe("Not set");
    await record("Rename layer");
    await clickButton("Reassign");
    expect(binding("Rename layer").textContent).toBe("Ctrl+G");
    expect(binding("Go to frame").textContent).toBe("Not set");
    await clickButton("Done");
    await waitFor(() =>
      expect(server.data.shortcuts).toEqual({
        "layer.rename": "ctrl+g",
        "frame.seek": null
      })
    );
    await press("g", { ctrlKey: true });
    await waitFor(() => expect(field("Name")).toBeTruthy());
    await keyOn(field("Name"), "Escape");
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    await closePalette();
  }, 60000);

  test("text entry inside the palette and in panel inputs never fires canvas commands", async () => {
    await renderHost();
    await press("v");
    await press("g", { ctrlKey: true });
    await waitFor(() => expect(field("Frame number")).toBeTruthy());
    await keyOn(field("Frame number"), "p");
    expect(probe().tool).toBe("select");
    await act(async () => {
      fireEvent.keyDown(window, { key: "p" });
    });
    await flush();
    expect(probe().tool).toBe("select");
    await keyOn(field("Frame number"), "Escape");
    await closePalette();
    const label = screen.getByLabelText("Label");
    await keyOn(label, "p");
    expect(probe().tool).toBe("select");
    await press("p");
    expect(probe().tool).toBe("pencil");
  }, 60000);
});