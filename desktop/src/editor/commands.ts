import { useEffect, useRef } from "react";
import type { Actions } from "./workspace";

export interface Command {
  id: string;
  label: string;
  keys: string | null;
  run: () => void;
}

export function buildCommands(
  actions: Actions,
  t: (key: string) => string
): Command[] {
  return [
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
    { id: "layer.add", label: t("command.addLayer"), keys: "ctrl+alt+n", run: actions.addLayer },
    { id: "scene.add", label: t("command.addScene"), keys: "ctrl+shift+n", run: actions.addScene }
  ];
}

function comboOf(event: KeyboardEvent): string {
  const key = event.key === " " ? "space" : event.key.toLowerCase();
  const ctrl = event.ctrlKey || event.metaKey ? "ctrl+" : "";
  const alt = event.altKey ? "alt+" : "";
  const shift = event.shiftKey ? "shift+" : "";
  return `${ctrl}${alt}${shift}${key}`;
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
      const combo = comboOf(event);
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