import { describe, expect, test, vi } from "vitest";
import { buildCommands } from "@/editor/commands";
import type { CommandContext } from "@/editor/commands";
import type { Actions, TabState } from "@/editor/workspace";
import type { Document, Layer, Scene } from "@/lib/document";
import { humanoidFigure } from "@/lib/document";
import { validateProfile } from "@/lib/shortcuts";

const t = (key: string) => key;

function makeLayer(id: string, name: string, length: number): Layer {
  return {
    id,
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    effects: [],
    masked: false,
    folder: false,
    children: [],
    length,
    keys: [
      {
        frame: 0,
        shapes: [],
        transform: { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 },
        tween: false,
        label: null
      }
    ]
  };
}

function makeScene(id: string, name: string, layers: Layer[]): Scene {
  return { id, name, layers };
}

function fixtureDoc(scenes?: Scene[]): Document {
  return {
    id: "d1",
    name: "Test",
    width: 800,
    height: 600,
    fps: 24,
    background: "#ffffff",
    scenes:
      scenes ??
      [
        makeScene("s1", "Scene 1", [
          makeLayer("l1", "Layer 1", 4),
          makeLayer("l2", "Layer 2", 2)
        ]),
        makeScene("s2", "Scene 2", [makeLayer("l3", "Layer 1", 1)])
      ]
  };
}

function fixtureTab(): TabState {
  return {
    sceneId: "s1",
    layerId: "l1",
    collapsedFolders: [],
    frame: 1,
    selectedFrames: [],
    loopStart: null,
    loopEnd: null,
    tool: "pencil",
    playing: false,
    loop: true,
    onion: false,
    onionRange: 2,
    selected: [],
    pivot: null,
    selectedNode: null,
    selectedBone: null,
    alignReference: "selection",
    stroke: "#000000",
    fill: "#3b82f6",
    strokeWidth: 3,
    smoothing: 30,
    sides: 5,
    eraserWidth: 20,
    fontSize: 32,
    fontFamily: "Segoe UI",
    zoom: 1
  };
}

function stubActions(): Actions {
  const cache = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({} as Actions, {
    get(_target, prop) {
      const key = String(prop);
      if (!cache.has(key)) {
        cache.set(key, vi.fn());
      }
      return cache.get(key);
    }
  });
}

function makeContext(doc: Document): CommandContext {
  return {
    state: {
      doc,
      scene: doc.scenes[0],
      layer: doc.scenes[0].layers[0],
      tab: fixtureTab(),
      frame: 1,
      total: 4,
      ids: [doc.id],
      docs: { [doc.id]: doc },
      activeId: doc.id
    },
    openPalette: vi.fn(),
    confirm: vi.fn(() => Promise.resolve(true)),
    activate: vi.fn(),
    close: vi.fn()
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("command model", () => {
  test("the five argument call keeps only zero argument commands", () => {
    const commands = buildCommands(stubActions(), t, {}, vi.fn(), vi.fn());
    expect(commands.length).toBe(71);
    expect(commands.every((item) => item.args === undefined)).toBe(true);
    expect(commands.find((item) => item.id === "view.palette")?.disabled).toBe(true);
    expect(commands.some((item) => item.id === "layer.rename")).toBe(false);
    expect(commands.some((item) => item.id === "align.left")).toBe(true);
    expect(commands.find((item) => item.id === "edit.group")?.defaultKeys).toBe("ctrl+g");
    expect(commands.find((item) => item.id === "edit.ungroup")?.defaultKeys).toBe(
      "ctrl+shift+g"
    );
    expect(commands.find((item) => item.id === "edit.combine")?.defaultKeys).toBe("ctrl+alt+u");
    expect(commands.find((item) => item.id === "edit.cut")?.defaultKeys).toBe("ctrl+alt+x");
  });

  test("the context call registers every parameterized action", () => {
    const commands = buildCommands(
      stubActions(),
      t,
      {},
      vi.fn(),
      vi.fn(),
      makeContext(fixtureDoc())
    );
    const ids = commands.map((item) => item.id);
    for (const id of [
      "align.left",
      "align.centerH",
      "align.right",
      "align.top",
      "align.centerV",
      "align.bottom",
      "align.distributeH",
      "align.distributeV",
      "view.palette",
      "playback.loopClear",
      "edit.bringToFront",
      "edit.sendToBack",
      "tool.pick",
      "frame.seek",
      "frame.insertCount",
      "frame.removeCount",
      "frame.move",
      "frame.setLabel",
      "frame.loopRange",
      "view.zoom",
      "view.onionRange",
      "layer.select",
      "layer.rename",
      "layer.move",
      "layer.addIn",
      "folder.addIn",
      "folder.unwrap",
      "folder.collapse",
      "layer.duplicate",
      "layer.remove",
      "layer.visibility",
      "layer.lock",
      "layer.opacity",
      "layer.blend",
      "layer.mask",
      "scene.select",
      "scene.rename",
      "scene.move",
      "scene.duplicate",
      "scene.remove",
      "project.rename",
      "project.activate",
      "project.close"
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(commands.length).toBe(105);
    for (const command of commands) {
      if (command.args) {
        expect(typeof command.runArgs, command.id).toBe("function");
        expect(command.args.length, command.id).toBeGreaterThan(0);
      }
    }
  });

  test("default bindings across the whole catalogue are conflict free", () => {
    const commands = buildCommands(
      stubActions(),
      t,
      {},
      vi.fn(),
      vi.fn(),
      makeContext(fixtureDoc())
    );
    const result = validateProfile(
      JSON.stringify({ version: 1, overrides: {} }),
      commands.map((item) => ({ id: item.id, keys: item.defaultKeys }))
    );
    expect(result.ok).toBe(true);
    expect(commands.find((item) => item.id === "view.palette")?.defaultKeys).toBe("ctrl+k");
    expect(commands.find((item) => item.id === "frame.seek")?.defaultKeys).toBeNull();
    expect(commands.find((item) => item.id === "edit.group")?.defaultKeys).toBe("ctrl+g");
    expect(commands.find((item) => item.id === "edit.ungroup")?.defaultKeys).toBe(
      "ctrl+shift+g"
    );
    expect(commands.find((item) => item.id === "layer.rename")?.defaultKeys).toBeNull();
  });

  test("overrides and explicit unbinds apply to parameterized ids", () => {
    const commands = buildCommands(
      stubActions(),
      t,
      { "layer.rename": "ctrl+alt+r", "frame.seek": null, "view.palette": "ctrl+shift+p" },
      vi.fn(),
      vi.fn(),
      makeContext(fixtureDoc())
    );
    const rename = commands.find((item) => item.id === "layer.rename");
    expect(rename?.keys).toBe("ctrl+alt+r");
    expect(rename?.defaultKeys).toBeNull();
    const seek = commands.find((item) => item.id === "frame.seek");
    expect(seek?.keys).toBeNull();
    expect(seek?.defaultKeys).toBeNull();
    expect(commands.find((item) => item.id === "view.palette")?.keys).toBe("ctrl+shift+p");
  });

  test("argument bounds come from the live document state", () => {
    const commands = buildCommands(
      stubActions(),
      t,
      {},
      vi.fn(),
      vi.fn(),
      makeContext(fixtureDoc())
    );
    const seek = commands.find((item) => item.id === "frame.seek");
    expect(seek?.args?.[0]).toMatchObject({ kind: "int", min: 1, max: 4, initial: 2 });
    const remove = commands.find((item) => item.id === "frame.removeCount");
    expect(remove?.args?.[0]).toMatchObject({ min: 1, max: 4 });
    const onion = commands.find((item) => item.id === "view.onionRange");
    expect(onion?.args?.[0]).toMatchObject({ min: 1, max: 5, initial: 2 });
    const move = commands.find((item) => item.id === "layer.move");
    expect(move?.args?.[1]).toMatchObject({ kind: "choice", initial: "" });
    expect(move?.args?.[1].options).toEqual([{ value: "", label: "palette.topLevel" }]);
    expect(move?.args?.[2]).toMatchObject({ min: 1, max: 2, initial: 1 });
    expect(commands.find((item) => item.id === "folder.unwrap")?.disabled).toBe(true);
    const zoom = commands.find((item) => item.id === "view.zoom");
    expect(zoom?.args?.[0]).toMatchObject({ min: 10, max: 800, initial: 100 });
    const rename = commands.find((item) => item.id === "layer.rename");
    expect(rename?.args?.[0].options).toEqual([
      { value: "l1", label: "Layer 1" },
      { value: "l2", label: "Layer 2" }
    ]);
    expect(rename?.args?.[0].initial).toBe("l1");
  });

  test("a shortcut on a parameterized command opens its palette form", () => {
    const context = makeContext(fixtureDoc());
    const commands = buildCommands(stubActions(), t, {}, vi.fn(), vi.fn(), context);
    commands.find((item) => item.id === "layer.rename")?.run();
    expect(context.openPalette).toHaveBeenCalledWith("layer.rename");
    commands.find((item) => item.id === "view.palette")?.run();
    expect(context.openPalette).toHaveBeenCalledWith();
  });

  test("remove commands are disabled when they would empty the scene or document", () => {
    const single = fixtureDoc([makeScene("s1", "Scene 1", [makeLayer("l1", "Layer 1", 4)])]);
    const context = makeContext(single);
    const commands = buildCommands(stubActions(), t, {}, vi.fn(), vi.fn(), context);
    const removeLayer = commands.find((item) => item.id === "layer.remove");
    expect(removeLayer?.disabled).toBe(true);
    removeLayer?.run();
    expect(context.openPalette).not.toHaveBeenCalled();
    const removeScene = commands.find((item) => item.id === "scene.remove");
    expect(removeScene?.disabled).toBe(true);
    const full = buildCommands(
      stubActions(),
      t,
      {},
      vi.fn(),
      vi.fn(),
      makeContext(fixtureDoc())
    );
    expect(full.find((item) => item.id === "layer.remove")?.disabled).toBe(false);
    expect(full.find((item) => item.id === "scene.remove")?.disabled).toBe(false);
  });

  test("runArgs routes to the same workspace actions with converted values", () => {
    const actions = stubActions();
    const context = makeContext(fixtureDoc());
    const commands = buildCommands(actions, t, {}, vi.fn(), vi.fn(), context);
    const byId = (id: string) => commands.find((item) => item.id === id);
    byId("layer.rename")?.runArgs?.({ layer: "l2", name: "Hero" });
    expect(actions.renameLayer).toHaveBeenCalledWith("l2", "Hero");
    byId("frame.seek")?.runArgs?.({ frame: 3 });
    expect(actions.seek).toHaveBeenCalledWith(2);
    byId("frame.move")?.runArgs?.({ target: 3 });
    expect(actions.moveFrames).toHaveBeenCalledWith(2);
    byId("frame.loopRange")?.runArgs?.({ start: 2, end: 4 });
    expect(actions.setLoopRange).toHaveBeenCalledWith(1, 3);
    byId("view.zoom")?.runArgs?.({ zoom: 200 });
    expect(actions.zoomBy).toHaveBeenCalledWith(2);
    byId("view.onionRange")?.runArgs?.({ range: 4 });
    expect(actions.setOnionRange).toHaveBeenCalledWith(4);
    byId("tool.pick")?.runArgs?.({ tool: "brush" });
    expect(actions.setTool).toHaveBeenCalledWith("brush");
    byId("layer.move")?.runArgs?.({ layer: "l2", index: 1 });
    expect(actions.moveLayer).toHaveBeenCalledWith("l2", 0, null);
    byId("layer.addIn")?.runArgs?.({ parent: "l1" });
    expect(actions.addLayer).toHaveBeenCalledWith("l1");
    byId("folder.unwrap")?.runArgs?.({ folder: "l1" });
    expect(actions.unwrapFolder).toHaveBeenCalledWith("l1");
    byId("folder.collapse")?.runArgs?.({ folder: "l1" });
    expect(actions.toggleFolder).toHaveBeenCalledWith("l1");
    byId("layer.opacity")?.runArgs?.({ layer: "l1", opacity: 50 });
    expect(actions.setLayerFlags).toHaveBeenCalledWith("l1", { opacity: 0.5 });
    byId("scene.move")?.runArgs?.({ scene: "s2", index: 1 });
    expect(actions.moveScene).toHaveBeenCalledWith("s2", 0);
    byId("project.rename")?.runArgs?.({ name: "Renamed" });
    expect(actions.renameDoc).toHaveBeenCalledWith("Renamed");
    byId("project.activate")?.runArgs?.({ project: "d1" });
    expect(context.activate).toHaveBeenCalledWith("d1");
    byId("project.close")?.runArgs?.({ project: "d1" });
    expect(context.close).toHaveBeenCalledWith("d1");
    byId("playback.loopClear")?.run();
    expect(actions.setLoopRange).toHaveBeenCalledWith(null, null);
    byId("align.left")?.run();
    expect(actions.alignSelected).toHaveBeenCalledWith("left");
    byId("align.centerV")?.run();
    expect(actions.alignSelected).toHaveBeenCalledWith("center_v");
    byId("align.distributeH")?.run();
    expect(actions.alignSelected).toHaveBeenCalledWith("distribute_h");
    byId("align.distributeV")?.run();
    expect(actions.alignSelected).toHaveBeenCalledWith("distribute_v");
    byId("edit.group")?.run();
    expect(actions.groupSelected).toHaveBeenCalledWith();
    byId("edit.ungroup")?.run();
    expect(actions.ungroupSelected).toHaveBeenCalledWith();
    byId("edit.combine")?.run();
    expect(actions.shapeBool).toHaveBeenCalledWith("union");
    byId("edit.subtract")?.run();
    expect(actions.shapeBool).toHaveBeenCalledWith("subtract");
    byId("edit.intersect")?.run();
    expect(actions.shapeBool).toHaveBeenCalledWith("intersect");
    byId("edit.cut")?.run();
    expect(actions.shapeBool).toHaveBeenCalledWith("exclude");
  });

  test("group and ungroup availability follows the selection", () => {
    const context = makeContext(fixtureDoc());
    const build = () =>
      buildCommands(stubActions(), t, {}, vi.fn(), vi.fn(), context);
    const state = (id: string) =>
      build().find((item) => item.id === id)?.disabled;
    expect(state("edit.group")).toBe(true);
    expect(state("edit.ungroup")).toBe(true);
    const tab = context.state.tab;
    if (!tab) {
      throw new Error("tab is missing");
    }
    tab.selected = [0, 1];
    expect(state("edit.group")).toBe(false);
    expect(state("edit.combine")).toBe(false);
    expect(state("edit.ungroup")).toBe(true);
    tab.selected = [0];
    context.state.layer?.keys[0].shapes.push({
      kind: "Group",
      children: [
        { kind: "Rect", x: 0, y: 0, w: 10, h: 10, fill: "#000000", stroke: "#000000", width: 1 }
      ]
    });
    expect(state("edit.group")).toBe(true);
    expect(state("edit.ungroup")).toBe(false);
    tab.selected = [];
    expect(state("edit.group")).toBe(true);
    expect(state("edit.ungroup")).toBe(true);
    expect(state("edit.combine")).toBe(true);
  });

  test("artwork attachment follows the figure in the selection", () => {
    const context = makeContext(fixtureDoc());
    const build = () => buildCommands(stubActions(), t, {}, vi.fn(), vi.fn(), context);
    const state = (id: string) => build().find((item) => item.id === id)?.disabled;
    const tab = context.state.tab;
    if (!tab) {
      throw new Error("tab is missing");
    }
    context.state.layer?.keys[0].shapes.push(
      { kind: "Rect", x: 0, y: 0, w: 10, h: 10, fill: "#000000", stroke: "#000000", width: 1 },
      { kind: "Figure", figure: humanoidFigure(10, 10, 100) }
    );
    tab.selected = [0];
    expect(state("figure.attach")).toBe(true);
    expect(state("figure.detach")).toBe(true);
    tab.selected = [0, 1];
    expect(state("figure.attach")).toBe(false);
    expect(state("figure.detach")).toBe(false);
    tab.selected = [1];
    expect(state("figure.attach")).toBe(true);
    expect(state("figure.detach")).toBe(false);
  });

  test("removing frames by count asks for confirmation first", async () => {
    const actions = stubActions();
    const context = makeContext(fixtureDoc());
    const commands = buildCommands(actions, t, {}, vi.fn(), vi.fn(), context);
    commands.find((item) => item.id === "frame.removeCount")?.runArgs?.({ count: 2 });
    expect(context.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true })
    );
    expect(actions.removeFrames).not.toHaveBeenCalled();
    await tick();
    expect(actions.removeFrames).toHaveBeenCalledWith(2);
    const denied = makeContext(fixtureDoc());
    denied.confirm = vi.fn(() => Promise.resolve(false));
    const deniedActions = stubActions();
    const deniedCommands = buildCommands(deniedActions, t, {}, vi.fn(), vi.fn(), denied);
    deniedCommands.find((item) => item.id === "frame.removeCount")?.runArgs?.({ count: 2 });
    await tick();
    expect(deniedActions.removeFrames).not.toHaveBeenCalled();
  });
});