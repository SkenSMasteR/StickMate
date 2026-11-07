import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Frame, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/i18n";
import {
  affineFrom,
  heldKey,
  identityTransform,
  polygonVertices,
  shapeBounds,
  unionBounds
} from "@/lib/document";
import type { Bounds, EvalLayer, PathNode, Point, Shape, Transform } from "@/lib/document";
import { useWorkspace } from "./workspace";
import type { Tool, TabState } from "./workspace";

type PathShape = Extract<Shape, { kind: "Path" }>;

interface Drag {
  mode:
    | "draw"
    | "pan"
    | "erase"
    | "pen"
    | "anchor"
    | "handle"
    | "marquee"
    | "selmove"
    | "scale"
    | "rotate"
    | "pivot";
  start: Point;
  clientStart: Point;
  panStart: Point;
  origin: Transform;
  nodeIndex?: number;
  handle?: "in" | "out";
  path?: PathShape;
  indices?: number[];
  pivot?: Point;
  angle?: number;
}

interface SelPreview {
  indices: number[];
  pivot: Point;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rotation: number;
}

const PICK_TOOLS: Tool[] = ["select", "node", "fill", "eyedropper", "text"];

function pathData(nodes: PathNode[], closed: boolean): string {
  const first = nodes[0];
  if (!first) {
    return "";
  }
  let d = `M ${first.point.x} ${first.point.y}`;
  const segments = closed ? nodes.length : nodes.length - 1;
  for (let index = 0; index < segments; index += 1) {
    const a = nodes[index];
    const b = nodes[(index + 1) % nodes.length];
    const p1 = a.handle_out ?? a.point;
    const p2 = b.handle_in ?? b.point;
    d += ` C ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${b.point.x} ${b.point.y}`;
  }
  return closed ? `${d} Z` : d;
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
  if (shape.kind === "Path") {
    return shape.nodes.length >= 2;
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
  const box = shapeBounds(shape);
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

  if (shape.kind === "Path") {
    const d = pathData(shape.nodes, shape.closed);
    return (
      <g onPointerDown={down} style={{ cursor: interactive ? cursor : undefined }}>
        {interactive && (
          <path
            d={d}
            fill={shape.closed ? "transparent" : "none"}
            stroke="transparent"
            strokeWidth={Math.max(shape.width, 12)}
          />
        )}
        <path
          d={d}
          fill={shape.closed ? shape.fill : "none"}
          stroke={shape.stroke}
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
  selected: number[];
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
          selected={interactive && selected.includes(index)}
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
  const [marquee, setMarquee] = useState<Bounds | null>(null);
  const [selPreview, setSelPreview] = useState<SelPreview | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [penNodes, setPenNodes] = useState<PathNode[]>([]);
  const [nodePreview, setNodePreview] = useState<PathShape | null>(null);
  const penRef = useRef<PathNode[]>([]);
  const commitRef = useRef<(closed: boolean) => void>(() => undefined);

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

  useEffect(() => {
    penRef.current = [];
    setPenNodes([]);
    setNodePreview(null);
    setMarquee(null);
    setSelPreview(null);
    dragRef.current = null;
  }, [doc?.id, tab?.sceneId, tab?.layerId, tab?.frame]);

  useEffect(() => () => commitRef.current(false), [tab?.tool]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (event.key === "Enter" || event.key === "Escape") {
        commitRef.current(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

  const toShape = (point: Point): Point => {
    const dx = (point.x - transform.x) / transform.scale;
    const dy = (point.y - transform.y) / transform.scale;
    const angle = (-transform.rotation * Math.PI) / 180;
    return {
      x: dx * Math.cos(angle) - dy * Math.sin(angle),
      y: dx * Math.sin(angle) + dy * Math.cos(angle)
    };
  };

  const commitPen = (closed: boolean) => {
    const nodes = penRef.current;
    penRef.current = [];
    setPenNodes([]);
    if (nodes.length >= 2) {
      actions.draw({
        kind: "Path",
        nodes,
        closed,
        fill: tab.fill,
        stroke: tab.stroke,
        width: tab.strokeWidth
      });
    }
  };
  commitRef.current = commitPen;

  const activeShapes =
    current?.layers.find((item) => item.id === layer.id)?.shapes ?? [];
  const selectedShape =
    tab.selected.length === 1 ? activeShapes[tab.selected[0]] : undefined;
  const selectionBounds = unionBounds(activeShapes, tab.selected);
  const pivotPoint: Point =
    tab.pivot ??
    (selectionBounds
      ? { x: selectionBounds.x + selectionBounds.w / 2, y: selectionBounds.y + selectionBounds.h / 2 }
      : { x: 0, y: 0 });
  const nodePath: PathShape | null =
    tab.tool === "node" && selectedShape?.kind === "Path"
      ? nodePreview ?? selectedShape
      : null;
  const activeNode =
    nodePath && tab.selectedNode !== null
      ? nodePath.nodes[tab.selectedNode] ?? null
      : null;

  const onAnchorDown = (index: number, event: ReactPointerEvent) => {
    event.stopPropagation();
    if (!nodePath) {
      return;
    }
    setTab({ selectedNode: index });
    if (layer.locked) {
      toast.error(t("editor.layerLocked"));
      return;
    }
    dragRef.current = {
      mode: "anchor",
      start: toShape(toDoc(event.clientX, event.clientY)),
      clientStart: { x: event.clientX, y: event.clientY },
      panStart: pan,
      origin: transform,
      nodeIndex: index,
      path: nodePath
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const onHandleDown = (side: "in" | "out", event: ReactPointerEvent) => {
    event.stopPropagation();
    if (!nodePath || tab.selectedNode === null) {
      return;
    }
    if (layer.locked) {
      toast.error(t("editor.layerLocked"));
      return;
    }
    dragRef.current = {
      mode: "handle",
      start: toShape(toDoc(event.clientX, event.clientY)),
      clientStart: { x: event.clientX, y: event.clientY },
      panStart: pan,
      origin: transform,
      nodeIndex: tab.selectedNode,
      handle: side,
      path: nodePath
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const startSelMove = (point: Point, indices: number[], event: ReactPointerEvent) => {
    dragRef.current = {
      mode: "selmove",
      start: point,
      clientStart: { x: event.clientX, y: event.clientY },
      panStart: pan,
      origin: transform,
      indices,
      pivot: pivotPoint
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const onShapeDown = (index: number, shape: Shape, event: ReactPointerEvent) => {
    if (tab.tool === "node") {
      actions.select(index);
      if (layer.locked) {
        toast.error(t("editor.layerLocked"));
      }
      return;
    }
    if (tab.tool === "select") {
      if (event.shiftKey) {
        actions.toggleSelect(index);
        return;
      }
      const indices = tab.selected.includes(index) ? tab.selected : [index];
      if (!tab.selected.includes(index)) {
        actions.select(index);
      }
      if (layer.locked) {
        toast.error(t("editor.layerLocked"));
        return;
      }
      startSelMove(toShape(toDoc(event.clientX, event.clientY)), indices, event);
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

  const onBoxDown = (event: ReactPointerEvent) => {
    event.stopPropagation();
    const point = toShape(toDoc(event.clientX, event.clientY));
    if (event.shiftKey) {
      for (let index = activeShapes.length - 1; index >= 0; index -= 1) {
        const shape = activeShapes[index];
        if (!shape) {
          continue;
        }
        const box = shapeBounds(shape);
        if (
          point.x >= box.x &&
          point.x <= box.x + box.w &&
          point.y >= box.y &&
          point.y <= box.y + box.h
        ) {
          actions.toggleSelect(index);
          return;
        }
      }
      return;
    }
    if (layer.locked) {
      toast.error(t("editor.layerLocked"));
      return;
    }
    startSelMove(point, tab.selected, event);
  };

  const onCornerDown = (event: ReactPointerEvent) => {
    event.stopPropagation();
    if (layer.locked) {
      toast.error(t("editor.layerLocked"));
      return;
    }
    dragRef.current = {
      mode: "scale",
      start: toShape(toDoc(event.clientX, event.clientY)),
      clientStart: { x: event.clientX, y: event.clientY },
      panStart: pan,
      origin: transform,
      indices: tab.selected,
      pivot: pivotPoint
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const onRotateDown = (event: ReactPointerEvent) => {
    event.stopPropagation();
    if (layer.locked) {
      toast.error(t("editor.layerLocked"));
      return;
    }
    const point = toShape(toDoc(event.clientX, event.clientY));
    dragRef.current = {
      mode: "rotate",
      start: point,
      clientStart: { x: event.clientX, y: event.clientY },
      panStart: pan,
      origin: transform,
      indices: tab.selected,
      pivot: pivotPoint,
      angle: Math.atan2(point.y - pivotPoint.y, point.x - pivotPoint.x)
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const onPivotDown = (event: ReactPointerEvent) => {
    event.stopPropagation();
    dragRef.current = {
      mode: "pivot",
      start: toShape(toDoc(event.clientX, event.clientY)),
      clientStart: { x: event.clientX, y: event.clientY },
      panStart: pan,
      origin: transform,
      indices: tab.selected,
      pivot: pivotPoint
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
      const point = toShape(toDoc(event.clientX, event.clientY));
      dragRef.current = {
        mode: "marquee",
        start: point,
        clientStart: { x: event.clientX, y: event.clientY },
        panStart: pan,
        origin: identityTransform
      };
      setMarquee({ x: point.x, y: point.y, w: 0, h: 0 });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (tab.tool === "node") {
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
    if (tab.tool === "pen") {
      const nodes = penRef.current;
      const first = nodes[0];
      if (
        nodes.length >= 3 &&
        first &&
        Math.hypot(point.x - first.point.x, point.y - first.point.y) <= 5
      ) {
        commitPen(true);
        return;
      }
      const next = [...nodes, { point, handle_in: null, handle_out: null }];
      penRef.current = next;
      setPenNodes(next);
      dragRef.current = {
        mode: "pen",
        start: point,
        clientStart: point,
        panStart: pan,
        origin: identityTransform
      };
      event.currentTarget.setPointerCapture(event.pointerId);
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
    if (drag.mode === "marquee") {
      const local = toShape(point);
      setMarquee({
        x: Math.min(drag.start.x, local.x),
        y: Math.min(drag.start.y, local.y),
        w: Math.abs(local.x - drag.start.x),
        h: Math.abs(local.y - drag.start.y)
      });
      return;
    }
    if (drag.mode === "pivot") {
      setTab({ pivot: toShape(point) });
      return;
    }
    if (drag.mode === "selmove" || drag.mode === "scale" || drag.mode === "rotate") {
      const local = toShape(point);
      const pivot = drag.pivot ?? pivotPoint;
      const indices = drag.indices ?? tab.selected;
      if (drag.mode === "selmove") {
        const dx = local.x - drag.start.x;
        const dy = local.y - drag.start.y;
        setSelPreview(
          dx === 0 && dy === 0 ? null : { indices, pivot, dx, dy, sx: 1, sy: 1, rotation: 0 }
        );
        return;
      }
      if (drag.mode === "scale") {
        const startX = drag.start.x - pivot.x;
        const startY = drag.start.y - pivot.y;
        const sx = Math.abs(startX) > 0.001 ? Math.max(0.01, (local.x - pivot.x) / startX) : 1;
        const sy = Math.abs(startY) > 0.001 ? Math.max(0.01, (local.y - pivot.y) / startY) : 1;
        setSelPreview({ indices, pivot, dx: 0, dy: 0, sx, sy, rotation: 0 });
        return;
      }
      const angle =
        ((Math.atan2(local.y - pivot.y, local.x - pivot.x) - (drag.angle ?? 0)) * 180) /
        Math.PI;
      setSelPreview({ indices, pivot, dx: 0, dy: 0, sx: 1, sy: 1, rotation: angle });
      return;
    }
    if (drag.mode === "pen") {
      if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 2) {
        const nodes = penRef.current;
        const index = nodes.length - 1;
        const node = nodes[index];
        if (node) {
          const next = nodes.map((item, position) =>
            position === index
              ? {
                  ...item,
                  handle_out: point,
                  handle_in: {
                    x: 2 * item.point.x - point.x,
                    y: 2 * item.point.y - point.y
                  }
                }
              : item
          );
          penRef.current = next;
          setPenNodes(next);
        }
      }
      return;
    }
    const { path, nodeIndex } = drag;
    if ((drag.mode === "anchor" || drag.mode === "handle") && path && nodeIndex !== undefined) {
      const local = toShape(point);
      if (drag.mode === "anchor") {
        const dx = local.x - drag.start.x;
        const dy = local.y - drag.start.y;
        const nodes = path.nodes.map((node, index) =>
          index === nodeIndex
            ? {
                point: { x: node.point.x + dx, y: node.point.y + dy },
                handle_in: node.handle_in
                  ? { x: node.handle_in.x + dx, y: node.handle_in.y + dy }
                  : null,
                handle_out: node.handle_out
                  ? { x: node.handle_out.x + dx, y: node.handle_out.y + dy }
                  : null
              }
            : node
        );
        setNodePreview({ ...path, nodes });
        return;
      }
      const node = path.nodes[nodeIndex];
      const mirror = { x: 2 * node.point.x - local.x, y: 2 * node.point.y - local.y };
      const updated: PathNode =
        drag.handle === "in"
          ? { ...node, handle_in: local, handle_out: event.altKey ? node.handle_out : mirror }
          : { ...node, handle_out: local, handle_in: event.altKey ? node.handle_in : mirror };
      setNodePreview({
        ...path,
        nodes: path.nodes.map((item, index) => (index === nodeIndex ? updated : item))
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
    if (drag.mode === "marquee") {
      const rect = marquee;
      setMarquee(null);
      if (!rect) {
        return;
      }
      if (rect.w === 0 && rect.h === 0) {
        actions.selectMany([]);
        return;
      }
      const hits: number[] = [];
      activeShapes.forEach((shape, index) => {
        const box = shapeBounds(shape);
        if (
          box.x < rect.x + rect.w &&
          box.x + box.w > rect.x &&
          box.y < rect.y + rect.h &&
          box.y + box.h > rect.y
        ) {
          hits.push(index);
        }
      });
      actions.selectMany(hits);
      return;
    }
    if (drag.mode === "pivot") {
      return;
    }
    if (
      (drag.mode === "selmove" || drag.mode === "scale" || drag.mode === "rotate") &&
      selPreview
    ) {
      const next = selPreview;
      setSelPreview(null);
      actions.transformShapes(next.pivot, next.dx, next.dy, next.sx, next.sy, next.rotation);
      return;
    }
    if (
      (drag.mode === "anchor" || drag.mode === "handle") &&
      nodePreview &&
      tab.selected.length === 1
    ) {
      const next = nodePreview;
      setNodePreview(null);
      actions.replaceShape(tab.selected[0], next);
    }
  };

  const renderLayers = (evaluated: EvalLayer[], faded: boolean) =>
    [...evaluated].reverse().map((item) => {
      const isActive = item.id === layer.id;
      const previewing = isActive && !faded && selPreview !== null;
      const content =
        isActive && !faded && nodePreview && tab.selected.length === 1
          ? {
              ...item,
              shapes: item.shapes.map((shape, index) =>
                index === tab.selected[0] ? nodePreview : shape
              )
            }
          : item;
      const shownShapes = previewing
        ? content.shapes.filter((_, index) => !selPreview.indices.includes(index))
        : content.shapes;
      const matrix = selPreview
        ? affineFrom(
            selPreview.pivot,
            selPreview.dx,
            selPreview.dy,
            selPreview.sx,
            selPreview.sy,
            selPreview.rotation
          )
        : null;
      return (
        <g key={item.id} opacity={faded ? 0.2 : 1}>
          <LayerContent
            evaluated={{ ...content, shapes: shownShapes }}
            transform={item.transform}
            interactive={!faded && isActive && PICK_TOOLS.includes(tab.tool) && !previewing}
            cursor={shapeCursor}
            selected={tab.selected}
            onDown={(index, event) =>
              onShapeDown(index, item.shapes[index], event)
            }
          />
          {previewing && matrix && (
            <g
              transform={`translate(${item.transform.x} ${item.transform.y}) rotate(${item.transform.rotation}) scale(${item.transform.scale})`}
            >
              <g
                transform={`matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`}
              >
                {selPreview.indices.map((index) => {
                  const shape = item.shapes[index];
                  return shape ? (
                    <ShapeNode
                      key={index}
                      shape={shape}
                      interactive={false}
                      cursor={shapeCursor}
                      selected={false}
                      onDown={() => undefined}
                    />
                  ) : null;
                })}
              </g>
            </g>
          )}
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
          onDoubleClick={() => {
            if (tab.tool === "pen") {
              commitPen(false);
            }
          }}
        >
          <rect x={0} y={0} width={doc.width} height={doc.height} fill={doc.background} />
          {onion.map((item) => (
            <g key={item.frame}>{renderLayers(item.layers, true)}</g>
          ))}
          {current && renderLayers(current.layers, false)}
          {tab.tool === "select" && selectionBounds && !selPreview && (
            <g
              transform={`translate(${transform.x} ${transform.y}) rotate(${transform.rotation}) scale(${transform.scale})`}
            >
              <rect
                data-selection-box
                x={selectionBounds.x}
                y={selectionBounds.y}
                width={selectionBounds.w}
                height={selectionBounds.h}
                fill="transparent"
                stroke="#3b82f6"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: "move" }}
                onPointerDown={onBoxDown}
              />
              {(["nw", "ne", "sw", "se"] as const).map((corner) => {
                const cx =
                  corner === "nw" || corner === "sw"
                    ? selectionBounds.x
                    : selectionBounds.x + selectionBounds.w;
                const cy =
                  corner === "nw" || corner === "ne"
                    ? selectionBounds.y
                    : selectionBounds.y + selectionBounds.h;
                return (
                  <rect
                    key={corner}
                    data-corner={corner}
                    x={cx - 4}
                    y={cy - 4}
                    width={8}
                    height={8}
                    fill="#ffffff"
                    stroke="#3b82f6"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    style={{
                      cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize"
                    }}
                    onPointerDown={onCornerDown}
                  />
                );
              })}
              <line
                x1={selectionBounds.x + selectionBounds.w / 2}
                y1={selectionBounds.y}
                x2={selectionBounds.x + selectionBounds.w / 2}
                y2={selectionBounds.y - 24}
                stroke="#3b82f6"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
              <circle
                data-rotate-handle
                cx={selectionBounds.x + selectionBounds.w / 2}
                cy={selectionBounds.y - 24}
                r={5}
                fill="#ffffff"
                stroke="#3b82f6"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: "grab" }}
                onPointerDown={onRotateDown}
              />
              <circle
                data-pivot-handle
                cx={pivotPoint.x}
                cy={pivotPoint.y}
                r={5}
                fill="#3b82f6"
                stroke="#ffffff"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: "move" }}
                onPointerDown={onPivotDown}
              />
            </g>
          )}
          {marquee && (
            <g
              transform={`translate(${transform.x} ${transform.y}) rotate(${transform.rotation}) scale(${transform.scale})`}
            >
              <rect
                data-marquee
                x={marquee.x}
                y={marquee.y}
                width={marquee.w}
                height={marquee.h}
                fill="#3b82f6"
                fillOpacity={0.1}
                stroke="#3b82f6"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            </g>
          )}
          {shown && (
            <ShapeNode
              shape={shown}
              interactive={false}
              cursor="crosshair"
              selected={false}
              onDown={() => undefined}
            />
          )}
          {tab.tool === "pen" && penNodes.length > 0 && (
            <g pointerEvents="none">
              <ShapeNode
                shape={{
                  kind: "Path",
                  nodes: penNodes,
                  closed: false,
                  fill: tab.fill,
                  stroke: tab.stroke,
                  width: tab.strokeWidth
                }}
                interactive={false}
                cursor="crosshair"
                selected={false}
                onDown={() => undefined}
              />
              {penNodes.map((node, index) => (
                <rect
                  key={index}
                  x={node.point.x - 3}
                  y={node.point.y - 3}
                  width={6}
                  height={6}
                  fill="#3b82f6"
                />
              ))}
            </g>
          )}
          {nodePath && (
            <g
              transform={`translate(${transform.x} ${transform.y}) rotate(${transform.rotation}) scale(${transform.scale})`}
            >
              {nodePath.nodes.map((node, index) => (
                <rect
                  key={index}
                  data-anchor={index}
                  x={node.point.x - 4}
                  y={node.point.y - 4}
                  width={8}
                  height={8}
                  fill={tab.selectedNode === index ? "#3b82f6" : "#ffffff"}
                  stroke="#3b82f6"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  style={{ cursor: "move" }}
                  onPointerDown={(event) => onAnchorDown(index, event)}
                />
              ))}
              {activeNode &&
                (["in", "out"] as const).map((side) => {
                  const handle = side === "in" ? activeNode.handle_in : activeNode.handle_out;
                  if (!handle) {
                    return null;
                  }
                  return (
                    <g key={side}>
                      <line
                        x1={activeNode.point.x}
                        y1={activeNode.point.y}
                        x2={handle.x}
                        y2={handle.y}
                        stroke="#3b82f6"
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                        pointerEvents="none"
                      />
                      <circle
                        data-handle={side}
                        cx={handle.x}
                        cy={handle.y}
                        r={4}
                        fill="#ffffff"
                        stroke="#3b82f6"
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: "move" }}
                        onPointerDown={(event) => onHandleDown(side, event)}
                      />
                    </g>
                  );
                })}
            </g>
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