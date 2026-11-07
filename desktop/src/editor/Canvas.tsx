import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Frame, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/i18n";
import {
  heldKey,
  identityTransform,
  polygonVertices,
  textWidth
} from "@/lib/document";
import type { EvalLayer, Point, Shape, Transform } from "@/lib/document";
import { useWorkspace } from "./workspace";
import type { Tool, TabState } from "./workspace";

interface Drag {
  mode: "draw" | "pan" | "move" | "erase";
  start: Point;
  clientStart: Point;
  panStart: Point;
  origin: Transform;
}

const PICK_TOOLS: Tool[] = ["select", "fill", "eyedropper", "text"];

function bounds(shape: Shape): { x: number; y: number; w: number; h: number } {
  if (shape.kind === "Stroke") {
    const xs = shape.points.map((point) => point.x);
    const ys = shape.points.map((point) => point.y);
    const pad = shape.width / 2;
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    return {
      x,
      y,
      w: Math.max(...xs) + pad - x,
      h: Math.max(...ys) + pad - y
    };
  }
  if (shape.kind === "Text") {
    return { x: shape.x, y: shape.y, w: textWidth(shape.text, shape.size), h: shape.size };
  }
  return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
}

function smooth(points: Point[], amount: number): Point[] {
  const passes = Math.round(amount / 25);
  if (passes < 1 || points.length < 3) {
    return points;
  }
  let current = points;
  for (let pass = 0; pass < passes; pass++) {
    const next: Point[] = [current[0]];
    for (let index = 1; index < current.length - 1; index++) {
      const a = current[index - 1];
      const b = current[index];
      const c = current[index + 1];
      next.push({ x: (a.x + b.x * 2 + c.x) / 4, y: (a.y + b.y * 2 + c.y) / 4 });
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

function makeShape(tool: Tool, from: Point, to: Point, tab: TabState): Shape {
  if (tool === "pencil" || tool === "brush" || tool === "line") {
    return {
      kind: "Stroke",
      points: tool === "line" ? [from, to] : [from],
      color: tab.stroke,
      width: tab.strokeWidth
    };
  }
  const box = {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    w: Math.abs(to.x - from.x),
    h: Math.abs(to.y - from.y),
    fill: tab.fill,
    stroke: tab.stroke,
    width: tab.strokeWidth
  };
  if (tool === "polygon") {
    return { kind: "Polygon", ...box, sides: tab.sides };
  }
  return tool === "rect" ? { kind: "Rect", ...box } : { kind: "Ellipse", ...box };
}

function finishDraft(shape: Shape, tab: TabState): Shape {
  if (shape.kind !== "Stroke") {
    return shape;
  }
  let points = shape.points;
  if (points.length === 1) {
    const point = points[0];
    points = [point, { x: point.x + 0.01, y: point.y }];
  }
  if (tab.tool === "brush") {
    points = smooth(points, tab.smoothing);
  }
  return { ...shape, points };
}

function isWorthwhile(shape: Shape): boolean {
  if (shape.kind === "Stroke") {
    if (shape.points.length < 2) {
      return false;
    }
    const first = shape.points[0];
    const last = shape.points[shape.points.length - 1];
    return shape.points.length > 2 || Math.hypot(last.x - first.x, last.y - first.y) > 0.5;
  }
  if (shape.kind === "Text") {
    return true;
  }
  return shape.w > 0.5 && shape.h > 0.5;
}

function sampleColor(shape: Shape): { stroke: string; fill: string } {
  if (shape.kind === "Stroke" || shape.kind === "Text") {
    return { stroke: shape.color, fill: shape.color };
  }
  return { stroke: shape.stroke, fill: shape.fill };
}

function ShapeNode({
  shape,
  interactive,
  cursor,
  selected,
  onDown
}: {
  shape: Shape;
  interactive: boolean;
  cursor: string;
  selected: boolean;
  onDown: (event: ReactPointerEvent) => void;
}) {
  const box = bounds(shape);
  const down = (event: ReactPointerEvent) => {
    if (!interactive) {
      return;
    }
    event.stopPropagation();
    onDown(event);
  };
  const outline = selected ? (
    <rect
      x={box.x}
      y={box.y}
      width={box.w}
      height={box.h}
      fill="none"
      stroke="#3b82f6"
      strokeWidth={1}
      strokeDasharray="4 3"
      vectorEffect="non-scaling-stroke"
      pointerEvents="none"
    />
  ) : null;

  if (shape.kind === "Stroke") {
    const points = shape.points.map((point) => `${point.x},${point.y}`).join(" ");
    return (
      <g onPointerDown={down} style={{ cursor: interactive ? cursor : undefined }}>
        {interactive && (
          <polyline
            points={points}
            fill="none"
            stroke="transparent"
            strokeWidth={Math.max(shape.width, 12)}
          />
        )}
        <polyline
          points={points}
          fill="none"
          stroke={shape.color}
          strokeWidth={shape.width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {outline}
      </g>
    );
  }

  if (shape.kind === "Text") {
    return (
      <g onPointerDown={down} style={{ cursor: interactive ? cursor : undefined }}>
        {interactive && (
          <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="transparent" />
        )}
        <text
          x={shape.x}
          y={shape.y}
          dominantBaseline="hanging"
          fontFamily={shape.family}
          fontSize={shape.size}
          fill={shape.color}
          style={{ whiteSpace: "pre" }}
        >
          {shape.text}
        </text>
        {outline}
      </g>
    );
  }

  if (shape.kind === "Polygon") {
    const points = polygonVertices(shape.x, shape.y, shape.w, shape.h, shape.sides)
      .map((point) => `${point.x},${point.y}`)
      .join(" ");
    return (
      <g onPointerDown={down} style={{ cursor: interactive ? cursor : undefined }}>
        {interactive && (
          <polygon points={points} fill="transparent" stroke="transparent" strokeWidth={12} />
        )}
        <polygon
          points={points}
          fill={shape.fill}
          stroke={shape.stroke}
          strokeWidth={shape.width}
          strokeLinejoin="round"
        />
        {outline}
      </g>
    );
  }

  const geometry =
    shape.kind === "Rect"
      ? {
          element: "rect" as const,
          props: { x: shape.x, y: shape.y, width: shape.w, height: shape.h }
        }
      : {
          element: "ellipse" as const,
          props: {
            cx: shape.x + shape.w / 2,
            cy: shape.y + shape.h / 2,
            rx: shape.w / 2,
            ry: shape.h / 2
          }
        };
  const Element = geometry.element;

  return (
    <g onPointerDown={down} style={{ cursor: interactive ? cursor : undefined }}>
      {interactive && (
        <Element
          {...geometry.props}
          fill="transparent"
          stroke="transparent"
          strokeWidth={12}
        />
      )}
      <Element
        {...geometry.props}
        fill={shape.fill}
        stroke={shape.stroke}
        strokeWidth={shape.width}
      />
      {outline}
    </g>
  );
}

function LayerContent({
  evaluated,
  transform,
  interactive,
  cursor,
  selected,
  onDown
}: {
  evaluated: EvalLayer;
  transform: Transform;
  interactive: boolean;
  cursor: string;
  selected: number | null;
  onDown: (index: number, event: ReactPointerEvent) => void;
}) {
  return (
    <g
      opacity={evaluated.opacity}
      transform={`translate(${transform.x} ${transform.y}) rotate(${transform.rotation}) scale(${transform.scale})`}
    >
      {evaluated.shapes.map((shape, index) => (
        <ShapeNode
          key={index}
          shape={shape}
          interactive={interactive}
          cursor={cursor}
          selected={interactive && selected === index}
          onDown={(event) => onDown(index, event)}
        />
      ))}
    </g>
  );
}

export default function Canvas() {
  const { doc, layer, tab, frames, transform, actions, setTab } = useWorkspace();
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const eraseRef = useRef<Point[]>([]);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [host, setHost] = useState({ width: 0, height: 0 });
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [draft, setDraft] = useState<Shape | null>(null);
  const [preview, setPreview] = useState<Transform | null>(null);
  const [hover, setHover] = useState<Point | null>(null);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setHost({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey) {
        actionsRef.current.zoomBy(event.deltaY < 0 ? 1.1 : 0.9);
        return;
      }
      setPan((prev) => ({ x: prev.x - event.deltaX, y: prev.y - event.deltaY }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  if (!doc || !layer || !tab) {
    return <div ref={hostRef} className="min-h-0 flex-1 bg-muted" />;
  }

  const fit =
    host.width > 0 && host.height > 0
      ? Math.min((host.width - 48) / doc.width, (host.height - 48) / doc.height)
      : 1;
  const scale = Math.max(0.02, fit * tab.zoom);
  const current = frames.length > 0 ? frames[frames.length - 1] : null;
  const onion = tab.onion ? frames.slice(0, -1) : [];
  const erasing = tab.tool === "eraser";
  const cursor = erasing
    ? "none"
    : tab.tool === "select"
      ? "default"
      : "crosshair";
  const shapeCursor =
    tab.tool === "select" ? "move" : tab.tool === "text" ? "text" : "crosshair";

  const toDoc = (clientX: number, clientY: number): Point => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: 0, y: 0 };
    }
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  };

  const onShapeDown = (index: number, shape: Shape, event: ReactPointerEvent) => {
    if (tab.tool === "select") {
      actions.select(index);
      if (layer.locked) {
        toast.error(t("editor.layerLocked"));
        return;
      }
      const point = toDoc(event.clientX, event.clientY);
      dragRef.current = {
        mode: "move",
        start: point,
        clientStart: point,
        panStart: pan,
        origin: transform
      };
      svgRef.current?.setPointerCapture(event.pointerId);
      return;
    }
    if (layer.locked && tab.tool !== "eyedropper") {
      toast.error(t("editor.layerLocked"));
      return;
    }
    if (tab.tool === "fill") {
      actions.paintShape(index, tab.fill);
      return;
    }
    if (tab.tool === "eyedropper") {
      setTab(sampleColor(shape));
      return;
    }
    if (shape.kind === "Text") {
      actions.select(index);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button === 1) {
      dragRef.current = {
        mode: "pan",
        start: { x: 0, y: 0 },
        clientStart: { x: event.clientX, y: event.clientY },
        panStart: pan,
        origin: identityTransform
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (tab.tool === "select") {
      actions.select(null);
      return;
    }
    if (tab.tool === "fill" || tab.tool === "eyedropper") {
      return;
    }
    if (layer.locked) {
      toast.error(t("editor.layerLocked"));
      return;
    }
    setTab({ playing: false });
    const point = toDoc(event.clientX, event.clientY);
    if (tab.tool === "text") {
      const count = heldKey(layer, tab.frame)?.shapes.length ?? 0;
      actions.draw({
        kind: "Text",
        x: point.x,
        y: point.y,
        text: t("editor.textDefault"),
        size: tab.fontSize,
        family: tab.fontFamily,
        color: tab.stroke
      });
      actions.select(count);
      return;
    }
    if (erasing) {
      eraseRef.current = [point];
      dragRef.current = {
        mode: "erase",
        start: point,
        clientStart: point,
        panStart: pan,
        origin: identityTransform
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    dragRef.current = {
      mode: "draw",
      start: point,
      clientStart: point,
      panStart: pan,
      origin: identityTransform
    };
    setDraft(makeShape(tab.tool, point, point, tab));
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const point = toDoc(event.clientX, event.clientY);
    if (erasing) {
      setHover(point);
    }
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    if (drag.mode === "pan") {
      setPan({
        x: drag.panStart.x + event.clientX - drag.clientStart.x,
        y: drag.panStart.y + event.clientY - drag.clientStart.y
      });
      return;
    }
    if (drag.mode === "erase") {
      eraseRef.current = [...eraseRef.current, point];
      return;
    }
    if (drag.mode === "move") {
      setPreview({
        ...transform,
        x: drag.origin.x + point.x - drag.start.x,
        y: drag.origin.y + point.y - drag.start.y
      });
      return;
    }
    setDraft((prev) => {
      if ((tab.tool === "pencil" || tab.tool === "brush") && prev && prev.kind === "Stroke") {
        return { ...prev, points: [...prev.points, point] };
      }
      return makeShape(tab.tool, drag.start, point, tab);
    });
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) {
      return;
    }
    if (drag.mode === "erase") {
      const path = eraseRef.current;
      eraseRef.current = [];
      actions.erase(path);
      return;
    }
    if (drag.mode === "draw" && draft) {
      const shape = finishDraft(draft, tab);
      setDraft(null);
      if (isWorthwhile(shape)) {
        actions.draw(shape);
      }
      return;
    }
    if (drag.mode === "move" && preview) {
      const next = preview;
      setPreview(null);
      actions.setTransform({ x: next.x, y: next.y });
    }
  };

  const renderLayers = (evaluated: EvalLayer[], faded: boolean) =>
    [...evaluated].reverse().map((item) => {
      const isActive = item.id === layer.id;
      const shown = isActive && !faded && preview ? preview : item.transform;
      return (
        <g key={item.id} opacity={faded ? 0.2 : 1}>
          <LayerContent
            evaluated={item}
            transform={shown}
            interactive={!faded && isActive && PICK_TOOLS.includes(tab.tool)}
            cursor={shapeCursor}
            selected={tab.selected}
            onDown={(index, event) =>
              onShapeDown(index, item.shapes[index], event)
            }
          />
        </g>
      );
    });

  const shown = draft ? finishDraft(draft, tab) : null;

  return (
    <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden bg-muted">
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
      >
        <svg
          ref={svgRef}
          width={doc.width * scale}
          height={doc.height * scale}
          viewBox={`0 0 ${doc.width} ${doc.height}`}
          className="border border-border"
          style={{ cursor, touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHover(null)}
        >
          <rect x={0} y={0} width={doc.width} height={doc.height} fill={doc.background} />
          {onion.map((item) => (
            <g key={item.frame}>{renderLayers(item.layers, true)}</g>
          ))}
          {current && renderLayers(current.layers, false)}
          {shown && (
            <ShapeNode
              shape={shown}
              interactive={false}
              cursor="crosshair"
              selected={false}
              onDown={() => undefined}
            />
          )}
          {erasing && hover && (
            <circle
              cx={hover.x}
              cy={hover.y}
              r={tab.eraserWidth / 2}
              fill="none"
              stroke="#3b82f6"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}
        </svg>
      </div>
      <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-2 border border-border bg-background px-2 py-1 text-xs text-muted-foreground">
        <span>
          {doc.width} × {doc.height}
        </span>
        <span>{Math.round(scale * 100)}%</span>
      </div>
      <div className="absolute bottom-2 right-2 flex items-center border border-border bg-background">
        <button
          type="button"
          title={t("command.zoomOut")}
          className="flex h-7 w-7 items-center justify-center hover:bg-accent"
          onClick={() => actions.zoomBy(0.8)}
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t("command.zoomFit")}
          className="flex h-7 w-7 items-center justify-center border-x border-border hover:bg-accent"
          onClick={() => {
            actions.zoomFit();
            setPan({ x: 0, y: 0 });
          }}
        >
          <Frame className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t("command.zoomIn")}
          className="flex h-7 w-7 items-center justify-center hover:bg-accent"
          onClick={() => actions.zoomBy(1.25)}
        >
          <ZoomIn className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}