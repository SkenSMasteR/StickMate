import type { Bounds, Point, Transform } from "./document";

export interface SnapTargets {
  xs: number[];
  ys: number[];
}

export interface SnapLines {
  x: number | null;
  y: number | null;
}

export interface PointSnap extends SnapLines {
  point: Point;
}

export interface DeltaSnap extends SnapLines {
  dx: number;
  dy: number;
}

export interface StageSize {
  width: number;
  height: number;
}

export interface GridSetting {
  enabled: boolean;
  size: number;
}

export function mapBounds(box: Bounds, transform: Transform): Bounds {
  const angle = (transform.rotation * Math.PI) / 180;
  const cos = Math.cos(angle) * transform.scale;
  const sin = Math.sin(angle) * transform.scale;
  const points = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h]
  ].map(([x, y]) => ({
    x: transform.x + x * cos - y * sin,
    y: transform.y + x * sin + y * cos
  }));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, w: Math.max(...xs) - left, h: Math.max(...ys) - top };
}

export function boxAxes(box: Bounds): SnapTargets {
  return {
    xs: [box.x, box.x + box.w / 2, box.x + box.w],
    ys: [box.y, box.y + box.h / 2, box.y + box.h]
  };
}

export function collectTargets(
  stage: StageSize,
  grid: GridSetting,
  boxes: Bounds[]
): SnapTargets {
  const xs = [0, stage.width / 2, stage.width];
  const ys = [0, stage.height / 2, stage.height];
  if (grid.enabled && grid.size > 0) {
    for (let value = grid.size; value < stage.width; value += grid.size) {
      xs.push(value);
    }
    for (let value = grid.size; value < stage.height; value += grid.size) {
      ys.push(value);
    }
  }
  for (const box of boxes) {
    const axes = boxAxes(box);
    xs.push(...axes.xs);
    ys.push(...axes.ys);
  }
  return { xs, ys };
}

function nearest(value: number, targets: number[], tolerance: number): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const target of targets) {
    const distance = Math.abs(value - target);
    if (distance <= tolerance && distance < bestDistance) {
      bestDistance = distance;
      best = target;
    }
  }
  return best;
}

function nearestOffset(value: number, targets: number[], tolerance: number): number | null {
  const target = nearest(value, targets, tolerance);
  return target === null ? null : target - value;
}

export function snapPoint(point: Point, targets: SnapTargets, tolerance: number): PointSnap {
  const offsetX = nearestOffset(point.x, targets.xs, tolerance);
  const offsetY = nearestOffset(point.y, targets.ys, tolerance);
  return {
    point: {
      x: point.x + (offsetX ?? 0),
      y: point.y + (offsetY ?? 0)
    },
    x: offsetX === null ? null : point.x + offsetX,
    y: offsetY === null ? null : point.y + offsetY
  };
}

export function snapDelta(
  box: Bounds,
  offset: Point,
  targets: SnapTargets,
  tolerance: number
): DeltaSnap {
  const axes = boxAxes(box);
  let offsetX: number | null = null;
  let atX: number | null = null;
  let offsetY: number | null = null;
  let atY: number | null = null;
  for (const edge of axes.xs) {
    const correction = nearestOffset(edge + offset.x, targets.xs, tolerance);
    if (correction !== null && (offsetX === null || Math.abs(correction) < Math.abs(offsetX))) {
      offsetX = correction;
      atX = edge + offset.x + correction;
    }
  }
  for (const edge of axes.ys) {
    const correction = nearestOffset(edge + offset.y, targets.ys, tolerance);
    if (correction !== null && (offsetY === null || Math.abs(correction) < Math.abs(offsetY))) {
      offsetY = correction;
      atY = edge + offset.y + correction;
    }
  }
  return {
    dx: offset.x + (offsetX ?? 0),
    dy: offset.y + (offsetY ?? 0),
    x: atX,
    y: atY
  };
}
