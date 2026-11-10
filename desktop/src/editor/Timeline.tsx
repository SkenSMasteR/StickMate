import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Diamond,
  Eye,
  EyeOff,
  Layers,
  ListMinus,
  ListPlus,
  Lock,
  LockOpen,
  Minus,
  MoveHorizontal,
  Pause,
  Play,
  Plus,
  Redo2,
  Repeat,
  SkipBack,
  SkipForward,
  Square,
  Undo2,
  X
} from "lucide-react";
import { useI18n } from "@/i18n";
import type { Layer } from "@/lib/document";
import { visibleRows } from "@/lib/document";
import { cn } from "@/lib/utils";
import ToolButton from "./ToolButton";
import { useWorkspace } from "./workspace";

const CELL = 16;
const ROW = 22;
const HEADER = 20;
const NAME_WIDTH = 160;

type CellState = "none" | "held" | "key" | "blank" | "tween" | "past";

interface Cell {
  frame: number;
  state: CellState;
  label: string | null;
  arrow: boolean;
}

function cellsOf(layer: Layer, from: number, to: number): Cell[] {
  let index = -1;
  for (let i = 0; i < layer.keys.length; i += 1) {
    if (layer.keys[i].frame <= from) {
      index = i;
    }
  }
  const cells: Cell[] = [];
  for (let frame = from; frame <= to; frame += 1) {
    while (index + 1 < layer.keys.length && layer.keys[index + 1].frame <= frame) {
      index += 1;
    }
    if (frame >= layer.length) {
      cells.push({ frame, state: "past", label: null, arrow: false });
      continue;
    }
    const key = index >= 0 ? layer.keys[index] : null;
    const next = index >= 0 ? layer.keys[index + 1] ?? null : null;
    const isKey = key !== null && key.frame === frame;
    const tween = key !== null && key.tween && next !== null && frame < next.frame;
    cells.push({
      frame,
      state: isKey
        ? key.shapes.length > 0
          ? "key"
          : "blank"
        : tween
          ? "tween"
          : key
            ? "held"
            : "none",
      label: isKey ? key.label : null,
      arrow: tween && next !== null && frame === next.frame - 1
    });
  }
  return cells;
}

export default function Timeline() {
  const { doc, scene, layer, tab, frame, total, actions } = useWorkspace();
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const scrubbing = useRef(false);
  const anchor = useRef(0);
  const [view, setView] = useState({ left: 0, width: 0 });
  const [frameCount, setFrameCount] = useState(1);
  const [moveTarget, setMoveTarget] = useState(1);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setView({ left: element.scrollLeft, width: element.clientWidth });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (!doc || !scene || !layer || !tab) {
    return null;
  }

  const from = Math.max(0, Math.floor(view.left / CELL) - 2);
  const to = Math.min(
    total - 1,
    Math.ceil((view.left + Math.max(view.width, NAME_WIDTH)) / CELL) + 2
  );
  const frames: number[] = [];
  for (let index = from; index <= to; index += 1) {
    frames.push(index);
  }
  const rows = visibleRows(scene.layers, tab.collapsedFolders);
  const contentHeight = HEADER + rows.length * ROW;
  const selected = new Set(tab.selectedFrames);

  const rangeTo = (frame: number): number[] => {
    const low = Math.min(anchor.current, frame);
    const high = Math.max(anchor.current, frame);
    const frames: number[] = [];
    for (let index = low; index <= high; index += 1) {
      frames.push(index);
    }
    return frames;
  };

  const cellAt = (event: ReactPointerEvent) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return {
      frame: Math.min(Math.max(Math.floor(x / CELL), 0), total - 1),
      row: Math.floor((y - HEADER) / ROW)
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const cell = cellAt(event);
    if (!cell) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (cell.row >= 0 && cell.row < rows.length) {
      actions.selectLayer(rows[cell.row].layer.id);
    }
    if (event.ctrlKey || event.metaKey) {
      scrubbing.current = false;
      const next = new Set(tab.selectedFrames);
      if (next.has(cell.frame)) {
        next.delete(cell.frame);
      } else {
        next.add(cell.frame);
      }
      actions.setSelectedFrames([...next]);
      return;
    }
    scrubbing.current = true;
    if (!event.shiftKey) {
      anchor.current = cell.frame;
      actions.setSelectedFrames([cell.frame]);
    } else {
      actions.setSelectedFrames(rangeTo(cell.frame));
    }
    actions.seek(cell.frame);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubbing.current) {
      return;
    }
    const cell = cellAt(event);
    if (!cell) {
      return;
    }
    actions.setSelectedFrames(rangeTo(cell.frame));
    actions.seek(cell.frame);
  };

  const stopScrubbing = () => {
    scrubbing.current = false;
  };

  const tweenOn = (() => {
    let found = null;
    for (const key of layer.keys) {
      if (key.frame <= frame) {
        found = key;
      }
    }
    return found?.tween ?? false;
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1">
        <ToolButton
          icon={tab.playing ? Pause : Play}
          label={t("command.play")}
          active={tab.playing}
          onClick={actions.togglePlay}
        />
        <ToolButton icon={SkipBack} label={t("command.stepBack")} onClick={() => actions.step(-1)} />
        <ToolButton icon={SkipForward} label={t("command.stepForward")} onClick={() => actions.step(1)} />
        <ToolButton icon={Repeat} label={t("command.loop")} active={tab.loop} onClick={actions.toggleLoop} />
        <ToolButton icon={Layers} label={t("command.onion")} active={tab.onion} onClick={actions.toggleOnion} />
        {tab.onion && (
          <input
            type="number"
            min={1}
            max={5}
            value={tab.onionRange}
            aria-label={t("editor.onionRange")}
            onChange={(event) => actions.setOnionRange(Number(event.target.value))}
            className="h-7 w-12 border border-border bg-transparent px-1 text-xs outline-none focus:border-ring"
          />
        )}
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolButton icon={Plus} label={t("command.insertFrame")} onClick={actions.insertFrame} />
        <ToolButton icon={Diamond} label={t("command.keyframe")} onClick={() => actions.keyframe(false)} />
        <ToolButton icon={Square} label={t("command.blankKeyframe")} onClick={() => actions.keyframe(true)} />
        <ToolButton icon={Minus} label={t("command.removeFrame")} onClick={actions.removeFrame} />
        <ToolButton icon={ArrowRight} label={t("command.tween")} active={tweenOn} onClick={actions.toggleTween} />
        <span className="mx-1 h-5 w-px bg-border" />
        <ToolButton icon={Undo2} label={t("command.undo")} onClick={actions.undo} />
        <ToolButton icon={Redo2} label={t("command.redo")} onClick={actions.redo} />
        <div className="flex-1" />
        <input
          type="number"
          min={1}
          max={total}
          value={frame + 1}
          aria-label={t("editor.frame")}
          onChange={(event) => actions.seek(Number(event.target.value) - 1)}
          className="h-7 w-16 border border-border bg-transparent px-1 text-right text-xs outline-none focus:border-ring"
        />
        <span className="px-1 text-xs text-muted-foreground">/ {total}</span>
        <span className="px-1 text-xs text-muted-foreground">{doc.fps} fps</span>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1">
        <input
          type="number"
          min={1}
          max={1000}
          value={frameCount}
          aria-label={t("editor.frameCount")}
          onChange={(event) => setFrameCount(Number(event.target.value))}
          className="h-7 w-12 border border-border bg-transparent px-1 text-xs outline-none focus:border-ring"
        />
        <ToolButton icon={ListPlus} label={t("command.insertFrames")} onClick={() => actions.insertFrames(frameCount)} />
        <ToolButton icon={ListMinus} label={t("command.removeFrames")} onClick={() => actions.removeFrames(frameCount)} />
        <ToolButton icon={Copy} label={t("command.copyFrames")} onClick={actions.copyFrames} />
        <ToolButton icon={ClipboardPaste} label={t("command.pasteFrames")} onClick={actions.pasteFrames} />
        <ToolButton icon={CopyPlus} label={t("command.duplicateFrames")} onClick={actions.duplicateFrames} />
        <span className="mx-1 h-5 w-px bg-border" />
        <input
          type="number"
          min={1}
          max={total}
          value={moveTarget}
          aria-label={t("editor.moveTarget")}
          onChange={(event) => setMoveTarget(Number(event.target.value))}
          className="h-7 w-12 border border-border bg-transparent px-1 text-xs outline-none focus:border-ring"
        />
        <ToolButton icon={MoveHorizontal} label={t("command.moveFrames")} onClick={() => actions.moveFrames(moveTarget - 1)} />
        <span className="mx-1 h-5 w-px bg-border" />
        <input
          type="number"
          min={1}
          max={total}
          value={tab.loopStart === null ? 1 : tab.loopStart + 1}
          aria-label={t("editor.loopStart")}
          onChange={(event) => actions.setLoopRange(Number(event.target.value) - 1, tab.loopEnd ?? total - 1)}
          className="h-7 w-12 border border-border bg-transparent px-1 text-xs outline-none focus:border-ring"
        />
        <input
          type="number"
          min={1}
          max={total}
          value={tab.loopEnd === null ? total : tab.loopEnd + 1}
          aria-label={t("editor.loopEnd")}
          onChange={(event) => actions.setLoopRange(tab.loopStart ?? 0, Number(event.target.value) - 1)}
          className="h-7 w-12 border border-border bg-transparent px-1 text-xs outline-none focus:border-ring"
        />
        {tab.loopStart !== null && tab.loopEnd !== null && (
          <ToolButton icon={X} label={t("editor.loopClear")} onClick={() => actions.setLoopRange(null, null)} />
        )}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(event) =>
          setView({
            left: event.currentTarget.scrollLeft,
            width: event.currentTarget.clientWidth
          })
        }
      >
        <div className="flex" style={{ width: NAME_WIDTH + total * CELL, height: contentHeight }}>
          <div
            className="sticky left-0 z-30 shrink-0 border-r border-border bg-background"
            style={{ width: NAME_WIDTH }}
          >
            <div
              className="sticky top-0 z-10 flex items-center border-b border-border bg-background px-2 text-[10px] uppercase tracking-wide text-muted-foreground"
              style={{ height: HEADER }}
            >
              {t("editor.layers")}
            </div>
            {rows.map((row) => {
              const item = row.layer;
              const folded = row.layer.folder && tab.collapsedFolders.includes(item.id);
              return (
              <div
                key={item.id}
                data-folder={item.folder}
                className={cn(
                  "flex items-center gap-1 border-b border-border/60 px-1",
                  item.id === layer.id && "bg-accent"
                )}
                style={{ height: ROW }}
              >
                <div
                  className="flex min-w-0 flex-1 items-center gap-1"
                  style={{ paddingLeft: row.depth * 12 }}
                >
                  {item.folder ? (
                    <button
                      type="button"
                      aria-expanded={!folded}
                      title={folded ? t("editor.expandFolder") : t("editor.collapseFolder")}
                      aria-label={folded ? t("editor.expandFolder") : t("editor.collapseFolder")}
                      onClick={() => actions.toggleFolder(item.id)}
                      className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                    >
                      {folded ? (
                        <ChevronRight className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : (
                    <span className="h-5 w-4 shrink-0" />
                  )}
                  <button
                    type="button"
                    title={item.visible ? t("editor.hideLayer") : t("editor.showLayer")}
                    aria-label={item.visible ? t("editor.hideLayer") : t("editor.showLayer")}
                    onClick={() => actions.setLayerFlags(item.id, { visible: !item.visible })}
                    className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                  >
                    {item.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    title={item.locked ? t("editor.unlockLayer") : t("editor.lockLayer")}
                    aria-label={item.locked ? t("editor.unlockLayer") : t("editor.lockLayer")}
                    onClick={() => actions.setLayerFlags(item.id, { locked: !item.locked })}
                    className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                  >
                    {item.locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => actions.selectLayer(item.id)}
                    className="min-w-0 flex-1 truncate text-left text-xs"
                  >
                    {item.name}
                  </button>
                </div>
              </div>
              );
            })}
          </div>

          <div
            ref={gridRef}
            data-testid="timeline-grid"
            className="relative"
            style={{ width: total * CELL, height: contentHeight }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={stopScrubbing}
            onPointerCancel={stopScrubbing}
          >
            <div
              className="sticky top-0 z-10 border-b border-border bg-background"
              style={{ height: HEADER }}
            >
              {frames.map((item) => (
                <div
                  key={item}
                  className="absolute top-0 flex h-full items-center justify-center border-r border-border/40 text-[9px] text-muted-foreground"
                  style={{ left: item * CELL, width: CELL }}
                >
                  {item % 5 === 0 ? item + 1 : ""}
                </div>
              ))}
            </div>

            {tab.loopStart !== null && tab.loopEnd !== null && (
              <div
                data-testid="loop-range"
                className="pointer-events-none absolute top-0 z-20 border-x-2 border-primary bg-primary/20"
                style={{
                  left: tab.loopStart * CELL,
                  width: (tab.loopEnd - tab.loopStart + 1) * CELL,
                  height: HEADER
                }}
              />
            )}

            {rows.map((row, rowIndex) => (
              <div
                key={row.layer.id}
                data-folder={row.layer.folder}
                className={cn(
                  "absolute left-0 right-0 border-b border-border/60",
                  row.layer.id === layer.id && "bg-accent/30"
                )}
                style={{ top: HEADER + rowIndex * ROW, height: ROW }}
              >
                {(row.layer.folder ? [] : cellsOf(row.layer, from, to)).map((cell) => (
                  <div
                    key={cell.frame}
                    data-frame={cell.frame}
                    data-selected={row.layer.id === layer.id && selected.has(cell.frame)}
                    className={cn(
                      "absolute top-0 h-full border-r border-border/40",
                      cell.state === "held" && "bg-muted/60",
                      cell.state === "tween" && "bg-primary/15",
                      cell.state === "past" && "border-r-transparent",
                      row.layer.id === layer.id && selected.has(cell.frame) && "bg-primary/40"
                    )}
                    style={{ left: cell.frame * CELL, width: CELL }}
                  >
                    {cell.state === "tween" && (
                      <span className="absolute left-0 right-0 top-1/2 border-t border-primary/50" />
                    )}
                    {cell.arrow && (
                      <span className="absolute right-0 top-1/2 h-0 w-0 -translate-y-1/2 border-y-[3px] border-l-[5px] border-y-transparent border-l-primary" />
                    )}
                    {(cell.state === "key" || cell.state === "blank") && (
                      <span
                        className={cn(
                          "absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2",
                          cell.state === "key" ? "bg-foreground" : "border border-foreground"
                        )}
                      />
                    )}
                    {cell.label && (
                      <span className="pointer-events-none absolute left-0 top-0 z-10 max-w-24 truncate bg-background/80 px-0.5 text-[9px] leading-3 text-muted-foreground">
                        {cell.label}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}

            <div
              className="pointer-events-none absolute top-0 z-20 border-x border-red-500 bg-red-500/20"
              style={{ left: frame * CELL, width: CELL, height: contentHeight }}
            >
              <span className="absolute -top-0 left-0 h-2 w-full bg-red-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}