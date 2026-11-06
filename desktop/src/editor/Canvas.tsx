import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Frame, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/i18n";
import { identityTransform } from "@/lib/document";
import type { EvalLayer, Point, Shape, Transform } from "@/lib/document";
import { useWorkspace } from "./workspace";
import type { Tool, TabState } from "./workspace";

interface Drag {
  mode: "draw" | "pan" | "move";
  start: Point;
  clientStart: Point;
  panStart: Point;
  origin: Transform;
}

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
  return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
}

function makeShape(tool: Tool, from: Point, to: Point, tab: TabState): Shape {
  if (tool === "pencil" || tool === "line") {
    return {
      kind: "Stroke",
      points: tool === "pencil" ? [from] : [from, to],
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
  return tool === "rect" ? { kind: "Rect", ...box } : { kind: "Ellipse", ...box };
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
  return shape.w > 0.5 && shape.h > 0.5;
}

function ShapeNode({
  shape,
  selectable,
  selected,
  onSelect
}: {
  shape: Shape;
  selectable: boolean;
  selected: boolean;
  onSelect: (event: ReactPointerEvent) => void;
}) {
  const box = bounds(shape);
  const down = (event: ReactPointerEvent) => {
    if (!selectable) {
      return;
    }
    event.stopPropagation();
    onSelect(event);
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
      <g onPointerDown={down} style={{ cursor: selectable ? "move" : undefined }}>
        {selectable && (
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
    <g onPointerDown={down} style={{ cursor: selectable ? "move" : undefined }}>
      {selectable && (
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
  selectable,
  selected,
  onSelect
}: {
  evaluated: EvalLayer;
  transform: Transform;
  selectable: boolean;
  selected: number | null;
  onSelect: (index: number, event: ReactPointerEvent) => void;
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
          selectable={selectable}
          selected={selectable && selected === index}
          onSelect={(event) => onSelect(index, event)}
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
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [host, setHost] = useState({ width: 0, height: 0 });
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [draft, setDraft] = useState<Shape | null>(null);
  const [preview, setPreview] = useState<Transform | null>(null);

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

  const toDoc = (clientX: number, clientY: number): Point => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: 0, y: 0 };
    }
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  };

  const beginMove = (index: number, event: ReactPointerEvent) => {
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
    if (layer.locked) {
      toast.error(t("editor.layerLocked"));
      return;
    }
    setTab({ playing: false });
    const point = toDoc(event.clientX, event.clientY);
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
    const point = toDoc(event.clientX, event.clientY);
    if (drag.mode === "move") {
      setPreview({
        ...transform,
        x: drag.origin.x + point.x - drag.start.x,
        y: drag.origin.y + point.y - drag.start.y
      });
      return;
    }
    setDraft((prev) => {
      if (tab.tool === "pencil" && prev && prev.kind === "Stroke") {
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
    if (drag.mode === "draw" && draft) {
      let shape = draft;
      if (shape.kind === "Stroke" && shape.points.length === 1) {
        const point = shape.points[0];
        shape = { ...shape, points: [point, { x: point.x + 0.01, y: point.y }] };
      }
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
            selectable={!faded && isActive && tab.tool === "select"}
            selected={tab.selected}
            onSelect={beginMove}
          />
        </g>
      );
    });

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
          style={{ cursor: tab.tool === "select" ? "default" : "crosshair", touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <rect x={0} y={0} width={doc.width} height={doc.height} fill={doc.background} />
          {onion.map((item) => (
            <g key={item.frame}>{renderLayers(item.layers, true)}</g>
          ))}
          {current && renderLayers(current.layers, false)}
          {draft && <ShapeNode shape={draft} selectable={false} selected={false} onSelect={() => undefined} />}
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