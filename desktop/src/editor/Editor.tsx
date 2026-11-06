import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "@/i18n";
import Canvas from "./Canvas";
import ScenesBar from "./ScenesBar";
import SidePanel from "./SidePanel";
import Timeline from "./Timeline";
import ToolsPanel from "./ToolsPanel";
import { buildCommands, useCommandKeys } from "./commands";
import { useWorkspace } from "./workspace";

interface Resize {
  axis: "x" | "y";
  start: number;
  size: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export default function Editor() {
  const { doc, tab, actions } = useWorkspace();
  const { t } = useI18n();
  const resizeRef = useRef<Resize | null>(null);
  const [rightWidth, setRightWidth] = useState(264);
  const [bottomHeight, setBottomHeight] = useState(220);

  useCommandKeys(buildCommands(actions, t), Boolean(doc && tab));

  const beginResize = (axis: "x" | "y", event: ReactPointerEvent<HTMLDivElement>) => {
    resizeRef.current = {
      axis,
      start: axis === "x" ? event.clientX : event.clientY,
      size: axis === "x" ? rightWidth : bottomHeight
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize) {
      return;
    }
    const delta = (resize.axis === "x" ? event.clientX : event.clientY) - resize.start;
    if (resize.axis === "x") {
      setRightWidth(clamp(resize.size - delta, 220, 480));
    } else {
      setBottomHeight(clamp(resize.size - delta, 120, 520));
    }
  };

  const endResize = () => {
    resizeRef.current = null;
  };

  if (!doc || !tab) {
    return null;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <ScenesBar />
      <div className="flex min-h-0 flex-1">
        <ToolsPanel />
        <div className="flex min-w-0 flex-1 flex-col">
          <Canvas />
          <div
            onPointerDown={(event) => beginResize("y", event)}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            className="h-1 shrink-0 cursor-row-resize bg-border hover:bg-ring"
          />
          <div className="flex shrink-0 flex-col" style={{ height: bottomHeight }}>
            <Timeline />
          </div>
        </div>
        <div
          onPointerDown={(event) => beginResize("x", event)}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-ring"
        />
        <div
          className="shrink-0 overflow-y-auto border-l border-border bg-background"
          style={{ width: rightWidth }}
        >
          <SidePanel />
        </div>
      </div>
    </div>
  );
}