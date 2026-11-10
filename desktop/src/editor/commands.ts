import { useEffect, useRef } from "react";
import { comboFromEvent } from "@/lib/shortcuts";
import type { ShortcutOverrides } from "@/lib/shortcuts";
import type { ConfirmOptions } from "@/lib/confirm";
import { heldKey } from "@/lib/document";
import type { Document, Layer, Scene } from "@/lib/document";
import type { Actions, TabState, Tool } from "./workspace";

export interface CommandArgOption {
  value: string;
  label: string;
}

export interface CommandArg {
  name: string;
  label: string;
  kind: "text" | "int" | "choice";
  initial: string | number;
  min?: number;
  max?: number;
  step?: number;
  options?: CommandArgOption[];
  allowEmpty?: boolean;
}

export type CommandArgs = Record<string, string | number>;

export interface Command {
  id: string;
  label: string;
  keys: string | null;
  defaultKeys: string | null;
  run: () => void;
  args?: CommandArg[];
  runArgs?: (values: CommandArgs) => void;
  disabled?: boolean;
}

export interface CommandState {
  doc: Document | null;
  scene: Scene | null;
  layer: Layer | null;
  tab: TabState | null;
  frame: number;
  total: number;
  ids: string[];
  docs: Record<string, Document>;
  activeId: string | null;
}

export interface CommandContext {
  state: CommandState;
  openPalette: (commandId?: string) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  activate: (id: string) => void;
  close: (id: string) => void;
}

type CommandDef = Omit<Command, "defaultKeys">;

const toolIds: Tool[] = [
  "select",
  "pencil",
  "brush",
  "eraser",
  "line",
  "rect",
  "ellipse",
  "polygon",
  "fill",
  "eyedropper",
  "text",
  "pen",
  "node"
];

function parameterCommands(
  actions: Actions,
  t: (key: string) => string,
  context: CommandContext
): CommandDef[] {
  const { state, openPalette, confirm, activate, close } = context;
  const { doc, scene, layer, tab, frame, total, ids, docs, activeId } = state;
  const ready = Boolean(doc && scene && layer && tab);
  const layers = scene?.layers ?? [];
  const scenes = doc?.scenes ?? [];
  const layerOptions = layers.map((item) => ({ value: item.id, label: item.name }));
  const sceneOptions = scenes.map((item) => ({ value: item.id, label: item.name }));
  const projectOptions = ids.map((id) => ({ value: id, label: docs[id]?.name ?? id }));
  const layerArg = (): CommandArg => ({
    name: "layer",
    label: t("palette.arg.layer"),
    kind: "choice",
    options: layerOptions,
    initial: layer?.id ?? layers[0]?.id ?? ""
  });
  const sceneArg = (): CommandArg => ({
    name: "scene",
    label: t("palette.arg.scene"),
    kind: "choice",
    options: sceneOptions,
    initial: scene?.id ?? scenes[0]?.id ?? ""
  });
  const projectArg = (): CommandArg => ({
    name: "project",
    label: t("palette.arg.project"),
    kind: "choice",
    options: projectOptions,
    initial: activeId ?? ids[0] ?? ""
  });
  const nameArg = (initial: string): CommandArg => ({
    name: "name",
    label: t("palette.arg.name"),
    kind: "text",
    initial
  });
  const intArg = (
    name: string,
    label: string,
    min: number,
    max: number,
    initial: number,
    step = 1
  ): CommandArg => ({ name, label, kind: "int", min, max, step, initial });
  const prompt = (
    id: string,
    label: string,
    keys: string | null,
    args: CommandArg[],
    runArgs: (values: CommandArgs) => void,
    disabled = false
  ): CommandDef => ({
    id,
    label,
    keys,
    args,
    runArgs,
    disabled,
    run: () => {
      if (!disabled) {
        openPalette(id);
      }
    }
  });
  const layerIndex = Math.max(
    1,
    layers.findIndex((item) => item.id === layer?.id) + 1
  );
  const sceneIndex = Math.max(
    1,
    scenes.findIndex((item) => item.id === scene?.id) + 1
  );
  return [
    {
      id: "playback.loopClear",
      label: t("command.loopClear"),
      keys: null,
      run: () => actions.setLoopRange(null, null)
    },
    {
      id: "edit.bringToFront",
      label: t("command.bringToFront"),
      keys: "ctrl+shift+arrowup",
      run: () => actions.reorderSelected(true)
    },
    {
      id: "edit.sendToBack",
      label: t("command.sendToBack"),
      keys: "ctrl+shift+arrowdown",
      run: () => actions.reorderSelected(false)
    },
    prompt(
      "tool.pick",
      t("command.pickTool"),
      null,
      [
        {
          name: "tool",
          label: t("palette.arg.tool"),
          kind: "choice",
          initial: tab?.tool ?? "select",
          options: toolIds.map((id) => ({ value: id, label: t(`command.${id}`) }))
        }
      ],
      (values) => actions.setTool(String(values.tool) as Tool),
      !tab
    ),
    prompt(
      "frame.seek",
      t("command.seek"),
      null,
      [intArg("frame", t("palette.arg.frame"), 1, total, frame + 1)],
      (values) => actions.seek(Number(values.frame) - 1),
      !ready
    ),
    prompt(
      "frame.insertCount",
      t("command.insertFramesCount"),
      null,
      [intArg("count", t("palette.arg.count"), 1, 1000, 1)],
      (values) => actions.insertFrames(Number(values.count)),
      !ready
    ),
    prompt(
      "frame.removeCount",
      t("command.removeFramesCount"),
      null,
      [
        intArg(
          "count",
          t("palette.arg.count"),
          1,
          Math.min(1000, Math.max(1, layer?.length ?? 1)),
          1
        )
      ],
      (values) => {
        const count = Number(values.count);
        void confirm({
          title: t("palette.removeFramesTitle"),
          description: String(count),
          confirmLabel: t("editor.delete"),
          cancelLabel: t("editor.cancel"),
          destructive: true
        }).then((accepted) => {
          if (accepted) {
            actions.removeFrames(count);
          }
        });
      },
      !ready
    ),
    prompt(
      "frame.move",
      t("command.moveFrames"),
      null,
      [
        intArg(
          "target",
          t("palette.arg.target"),
          1,
          total,
          Math.min(total, frame + 2)
        )
      ],
      (values) => actions.moveFrames(Number(values.target) - 1),
      !ready
    ),
    prompt(
      "frame.setLabel",
      t("command.setLabel"),
      null,
      [
        {
          name: "label",
          label: t("palette.arg.label"),
          kind: "text",
          initial: "",
          allowEmpty: true
        }
      ],
      (values) => actions.setLabel(String(values.label)),
      !ready
    ),
    prompt(
      "frame.loopRange",
      t("command.loopRange"),
      null,
      [
        intArg("start", t("palette.arg.start"), 1, total, (tab?.loopStart ?? 0) + 1),
        intArg(
          "end",
          t("palette.arg.end"),
          1,
          total,
          tab?.loopEnd === null || tab?.loopEnd === undefined ? total : tab.loopEnd + 1
        )
      ],
      (values) => actions.setLoopRange(Number(values.start) - 1, Number(values.end) - 1),
      !ready
    ),
    prompt(
      "view.zoom",
      t("command.zoom"),
      null,
      [
        intArg(
          "zoom",
          t("palette.arg.zoom"),
          10,
          800,
          Math.round((tab?.zoom ?? 1) * 100),
          5
        )
      ],
      (values) => actions.zoomBy(Number(values.zoom) / 100 / (tab?.zoom ?? 1)),
      !tab
    ),
    prompt(
      "view.onionRange",
      t("command.onionRange"),
      null,
      [intArg("range", t("palette.arg.range"), 1, 5, tab?.onionRange ?? 2)],
      (values) => actions.setOnionRange(Number(values.range)),
      !tab
    ),
    prompt(
      "layer.select",
      t("command.selectLayer"),
      null,
      [layerArg()],
      (values) => actions.selectLayer(String(values.layer)),
      !scene
    ),
    prompt(
      "layer.rename",
      t("command.renameLayer"),
      null,
      [layerArg(), nameArg("")],
      (values) => actions.renameLayer(String(values.layer), String(values.name)),
      !scene
    ),
    prompt(
      "layer.move",
      t("command.moveLayer"),
      null,
      [
        layerArg(),
        intArg("index", t("palette.arg.position"), 1, Math.max(1, layers.length), layerIndex)
      ],
      (values) => actions.moveLayer(String(values.layer), Number(values.index) - 1),
      !scene
    ),
    prompt(
      "layer.duplicate",
      t("command.duplicateLayer"),
      null,
      [layerArg()],
      (values) => actions.duplicateLayer(String(values.layer)),
      !scene
    ),
    prompt(
      "layer.remove",
      t("command.removeLayer"),
      null,
      [layerArg()],
      (values) => actions.removeLayer(String(values.layer)),
      !scene || layers.length < 2
    ),
    prompt(
      "layer.visibility",
      t("command.layerVisibility"),
      null,
      [
        layerArg(),
        {
          name: "state",
          label: t("palette.arg.state"),
          kind: "choice",
          initial: "visible",
          options: [
            { value: "visible", label: t("editor.showLayer") },
            { value: "hidden", label: t("editor.hideLayer") }
          ]
        }
      ],
      (values) =>
        actions.setLayerFlags(String(values.layer), {
          visible: String(values.state) === "visible"
        }),
      !scene
    ),
    prompt(
      "layer.lock",
      t("command.layerLock"),
      null,
      [
        layerArg(),
        {
          name: "state",
          label: t("palette.arg.state"),
          kind: "choice",
          initial: "unlocked",
          options: [
            { value: "unlocked", label: t("editor.unlockLayer") },
            { value: "locked", label: t("editor.lockLayer") }
          ]
        }
      ],
      (values) =>
        actions.setLayerFlags(String(values.layer), {
          locked: String(values.state) === "locked"
        }),
      !scene
    ),
    prompt(
      "layer.opacity",
      t("command.layerOpacity"),
      null,
      [
        layerArg(),
        intArg(
          "opacity",
          t("palette.arg.opacity"),
          0,
          100,
          Math.round((layer?.opacity ?? 1) * 100)
        )
      ],
      (values) =>
        actions.setLayerFlags(String(values.layer), {
          opacity: Number(values.opacity) / 100
        }),
      !scene
    ),
    prompt(
      "scene.select",
      t("command.selectScene"),
      null,
      [sceneArg()],
      (values) => actions.selectScene(String(values.scene)),
      !doc
    ),
    prompt(
      "scene.rename",
      t("command.renameScene"),
      null,
      [sceneArg(), nameArg("")],
      (values) => actions.renameScene(String(values.scene), String(values.name)),
      !doc
    ),
    prompt(
      "scene.move",
      t("command.moveScene"),
      null,
      [
        sceneArg(),
        intArg("index", t("palette.arg.position"), 1, Math.max(1, scenes.length), sceneIndex)
      ],
      (values) => actions.moveScene(String(values.scene), Number(values.index) - 1),
      !doc
    ),
    prompt(
      "scene.duplicate",
      t("command.duplicateScene"),
      null,
      [sceneArg()],
      (values) => actions.duplicateScene(String(values.scene)),
      !doc
    ),
    prompt(
      "scene.remove",
      t("command.removeScene"),
      null,
      [sceneArg()],
      (values) => actions.removeScene(String(values.scene)),
      !doc || scenes.length < 2
    ),
    prompt(
      "project.rename",
      t("command.renameProject"),
      null,
      [nameArg(doc?.name ?? "")],
      (values) => actions.renameDoc(String(values.name)),
      !doc
    ),
    prompt(
      "project.activate",
      t("command.activateProject"),
      null,
      [projectArg()],
      (values) => activate(String(values.project)),
      ids.length === 0
    ),
    prompt(
      "project.close",
      t("command.closeProject"),
      null,
      [projectArg()],
      (values) => close(String(values.project)),
      ids.length === 0
    )
  ];
}

export function buildCommands(
  actions: Actions,
  t: (key: string) => string,
  overrides: ShortcutOverrides,
  openShortcuts: () => void,
  openExport: () => void,
  context?: CommandContext
): Command[] {
  const selected = context?.state.tab?.selected ?? [];
  const heldShapes = context?.state.layer
    ? heldKey(context.state.layer, context.state.frame)?.shapes ?? []
    : [];
  const singleShape = selected.length === 1 ? heldShapes[selected[0]] : undefined;
  const defaults: CommandDef[] = [
    { id: "tool.select", label: t("command.select"), keys: "v", run: () => actions.setTool("select") },
    { id: "tool.pencil", label: t("command.pencil"), keys: "p", run: () => actions.setTool("pencil") },
    { id: "tool.brush", label: t("command.brush"), keys: "b", run: () => actions.setTool("brush") },
    { id: "tool.eraser", label: t("command.eraser"), keys: "e", run: () => actions.setTool("eraser") },
    { id: "tool.line", label: t("command.line"), keys: "l", run: () => actions.setTool("line") },
    { id: "tool.rect", label: t("command.rect"), keys: "r", run: () => actions.setTool("rect") },
    { id: "tool.ellipse", label: t("command.ellipse"), keys: "o", run: () => actions.setTool("ellipse") },
    { id: "tool.polygon", label: t("command.polygon"), keys: "g", run: () => actions.setTool("polygon") },
    { id: "tool.fill", label: t("command.fill"), keys: "k", run: () => actions.setTool("fill") },
    { id: "tool.eyedropper", label: t("command.eyedropper"), keys: "i", run: () => actions.setTool("eyedropper") },
    { id: "tool.text", label: t("command.text"), keys: "t", run: () => actions.setTool("text") },
    { id: "tool.pen", label: t("command.pen"), keys: "n", run: () => actions.setTool("pen") },
    { id: "tool.node", label: t("command.node"), keys: "a", run: () => actions.setTool("node") },
    { id: "playback.toggle", label: t("command.play"), keys: "space", run: actions.togglePlay },
    { id: "playback.back", label: t("command.stepBack"), keys: ",", run: () => actions.step(-1) },
    { id: "playback.forward", label: t("command.stepForward"), keys: ".", run: () => actions.step(1) },
    { id: "playback.loop", label: t("command.loop"), keys: "ctrl+l", run: actions.toggleLoop },
    { id: "edit.undo", label: t("command.undo"), keys: "ctrl+z", run: actions.undo },
    { id: "edit.redo", label: t("command.redo"), keys: "ctrl+shift+z", run: actions.redo },
    { id: "edit.redo.again", label: t("command.redo"), keys: "ctrl+y", run: actions.redo },
    { id: "edit.delete", label: t("command.deleteShape"), keys: "delete", run: actions.deleteSelected },
    { id: "edit.deselect", label: t("command.deselect"), keys: "escape", run: () => actions.select(null) },
    { id: "edit.copy", label: t("command.copyShape"), keys: "ctrl+c", run: actions.copySelected },
    { id: "edit.paste", label: t("command.pasteShape"), keys: "ctrl+v", run: actions.pasteSelected },
    { id: "edit.group", label: t("command.group"), keys: "ctrl+g", run: actions.groupSelected, disabled: selected.length < 2 },
    { id: "edit.ungroup", label: t("command.ungroup"), keys: "ctrl+shift+g", run: actions.ungroupSelected, disabled: singleShape?.kind !== "Group" },
    { id: "frame.insert", label: t("command.insertFrame"), keys: "f5", run: actions.insertFrame },
    { id: "frame.keyframe", label: t("command.keyframe"), keys: "f6", run: () => actions.keyframe(false) },
    { id: "frame.blank", label: t("command.blankKeyframe"), keys: "shift+f6", run: () => actions.keyframe(true) },
    { id: "frame.remove", label: t("command.removeFrame"), keys: "shift+f5", run: actions.removeFrame },
    { id: "frame.tween", label: t("command.tween"), keys: "alt+t", run: actions.toggleTween },
    { id: "frame.insertFrames", label: t("command.insertFrames"), keys: "ctrl+f5", run: () => actions.insertFrames(1) },
    { id: "frame.removeFrames", label: t("command.removeFrames"), keys: "ctrl+shift+f5", run: () => actions.removeFrames(1) },
    { id: "frame.copyFrames", label: t("command.copyFrames"), keys: "ctrl+alt+c", run: actions.copyFrames },
    { id: "frame.pasteFrames", label: t("command.pasteFrames"), keys: "ctrl+alt+v", run: actions.pasteFrames },
    { id: "frame.duplicateFrames", label: t("command.duplicateFrames"), keys: "ctrl+alt+d", run: actions.duplicateFrames },
    { id: "view.onion", label: t("command.onion"), keys: "alt+o", run: actions.toggleOnion },
    { id: "view.zoomIn", label: t("command.zoomIn"), keys: "ctrl+=", run: () => actions.zoomBy(1.25) },
    { id: "view.zoomOut", label: t("command.zoomOut"), keys: "ctrl+-", run: () => actions.zoomBy(0.8) },
    { id: "view.zoomFit", label: t("command.zoomFit"), keys: "ctrl+0", run: actions.zoomFit },
    { id: "view.shortcuts", label: t("command.shortcuts"), keys: "ctrl+alt+k", run: openShortcuts },
    { id: "view.export", label: t("command.export"), keys: "ctrl+e", run: openExport },
    { id: "view.palette", label: t("command.palette"), keys: "ctrl+k", run: () => context?.openPalette(), disabled: !context },
    { id: "layer.add", label: t("command.addLayer"), keys: "ctrl+alt+n", run: actions.addLayer },
    { id: "scene.add", label: t("command.addScene"), keys: "ctrl+shift+n", run: actions.addScene }
  ];
  for (const [direction, dx, dy] of [
    ["left", -1, 0], ["right", 1, 0], ["up", 0, -1], ["down", 0, 1]
  ] as const) {
    for (const step of [1, 10]) {
      defaults.push({
        id: `edit.nudge.${direction}.${step}`,
        label: `${t(`command.nudge.${direction}`)} (${step} px)`,
        keys: `${step === 10 ? "shift+" : ""}arrow${direction}`,
        run: () => actions.nudgeSelected(dx * step, dy * step)
      });
    }
  }
  for (const [commandId, labelKey, mode] of [
    ["align.left", "command.alignLeft", "left"],
    ["align.centerH", "command.alignCenterH", "center_h"],
    ["align.right", "command.alignRight", "right"],
    ["align.top", "command.alignTop", "top"],
    ["align.centerV", "command.alignCenterV", "center_v"],
    ["align.bottom", "command.alignBottom", "bottom"],
    ["align.distributeH", "command.distributeH", "distribute_h"],
    ["align.distributeV", "command.distributeV", "distribute_v"]
  ] as const) {
    defaults.push({
      id: commandId,
      label: t(labelKey),
      keys: null,
      run: () => actions.alignSelected(mode)
    });
  }
  const all = context
    ? [...defaults, ...parameterCommands(actions, t, context)]
    : defaults;
  return all.map((command) => ({
    ...command,
    defaultKeys: command.keys,
    keys: overrides[command.id] === undefined ? command.keys : overrides[command.id]
  }));
}

export function useCommandKeys(commands: Command[], enabled: boolean): void {
  const latest = useRef(commands);
  latest.current = commands;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const combo = comboFromEvent(event);
      if (combo === null) {
        return;
      }
      const command = latest.current.find((item) => item.keys === combo);
      if (!command) {
        return;
      }
      event.preventDefault();
      command.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}