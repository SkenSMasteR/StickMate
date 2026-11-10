import { flattenPath, polygonVertices } from "./document";
import type { Gradient, PathNode, Point, Shape } from "./document";

export type BoolOp = "union" | "subtract" | "intersect" | "exclude";

const ELLIPSE_SEGMENTS = 72;

const EPS = 1e-9;

export function boolHistoryName(op: BoolOp): string {
  switch (op) {
    case "union":
      return "bool_union";
    case "subtract":
      return "bool_subtract";
    case "intersect":
      return "bool_intersect";
    case "exclude":
      return "bool_exclude";
  }
}

function spot(x: number, y: number): Point {
  return { x, y };
}

function clonePoint(value: Point): Point {
  return { x: value.x, y: value.y };
}

export function ringOf(shape: Shape): Point[] {
  let ring: Point[];
  if (shape.kind === "Rect") {
    ring = [
      spot(shape.x, shape.y),
      spot(shape.x + shape.w, shape.y),
      spot(shape.x + shape.w, shape.y + shape.h),
      spot(shape.x, shape.y + shape.h)
    ];
  } else if (shape.kind === "Ellipse") {
    const cx = shape.x + shape.w / 2.0;
    const cy = shape.y + shape.h / 2.0;
    const rx = shape.w / 2.0;
    const ry = shape.h / 2.0;
    const step = (Math.PI * 2) / ELLIPSE_SEGMENTS;
    ring = [];
    for (let index = 0; index < ELLIPSE_SEGMENTS; index += 1) {
      const angle = -Math.PI / 2 + index * step;
      ring.push(spot(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry));
    }
  } else if (shape.kind === "Polygon") {
    ring = polygonVertices(shape.x, shape.y, shape.w, shape.h, shape.sides);
  } else if (shape.kind === "Path") {
    if (!shape.closed) {
      throw new Error("boolean needs closed filled shapes");
    }
    ring = flattenPath(shape.nodes, true);
  } else {
    throw new Error("boolean needs closed filled shapes");
  }
  const clean = closeRing(ring);
  if (clean.length < 3 || Math.abs(area(clean)) <= EPS) {
    throw new Error("boolean needs closed filled shapes");
  }
  return clean;
}

function closeRing(ring: Point[]): Point[] {
  const out: Point[] = [];
  for (const item of ring) {
    if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) {
      continue;
    }
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - item.x) <= EPS && Math.abs(last.y - item.y) <= EPS) {
      continue;
    }
    out.push(item);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first.x - last.x) <= EPS && Math.abs(first.y - last.y) <= EPS) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

function area(ring: Point[]): number {
  let total = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2.0;
}

function wound(ring: Point[], clockwise: boolean): Point[] {
  const positive = area(ring) >= 0.0;
  if (positive === clockwise) {
    return ring.map(clonePoint);
  }
  return reversed(ring);
}

function reversed(ring: Point[]): Point[] {
  return ring.map(clonePoint).reverse();
}

function inside(ring: Point[], target: Point): boolean {
  let hit = false;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    if ((a.y <= target.y) === (b.y <= target.y)) {
      continue;
    }
    const t = (target.y - a.y) / (b.y - a.y);
    const edgeX = a.x + t * (b.x - a.x);
    if (target.x < edgeX) {
      hit = !hit;
    }
  }
  return hit;
}

function near(a: Point, b: Point, tol: number): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

function clearance(target: Point, ring: Point[]): number {
  let best = Infinity;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    if (len <= EPS) {
      continue;
    }
    const raw = ((target.x - a.x) * dx + (target.y - a.y) * dy) / len;
    const t = Math.min(1, Math.max(0, raw));
    const fx = a.x + t * dx - target.x;
    const fy = a.y + t * dy - target.y;
    best = Math.min(best, Math.sqrt(fx * fx + fy * fy));
  }
  return best;
}

function interiorNormal(positive: boolean, from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.max(EPS, Math.sqrt(dx * dx + dy * dy));
  const normal = spot(-dy / len, dx / len);
  return positive ? normal : spot(-normal.x, -normal.y);
}

interface Marks {
  scale: number;
  spots: Point[];
  keys: Map<string, number>;
}

function marks(scale: number): Marks {
  return { scale, spots: [], keys: new Map() };
}

function cellKey(row: number, column: number): string {
  return `${row},${column}`;
}

function register(mark: Marks, value: Point, tol: number): number {
  const row = Math.round(value.x / mark.scale);
  const column = Math.round(value.y / mark.scale);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const found = mark.keys.get(cellKey(row + dx, column + dy));
      if (found !== undefined && near(mark.spots[found], value, tol)) {
        return found;
      }
    }
  }
  const id = mark.spots.length;
  mark.spots.push(clonePoint(value));
  mark.keys.set(cellKey(row, column), id);
  return id;
}

function markAt(mark: Marks, id: number): Point {
  return clonePoint(mark.spots[id]);
}

interface Event {
  edge: number;
  at: number;
  id: number;
}

function pushEvent(list: Event[], edge: number, raw: number, id: number): void {
  if (raw <= EPS || raw >= 1.0 - EPS) {
    return;
  }
  list.push({ edge, at: raw, id });
}

function along(from: Point, to: Point, target: Point): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (Math.abs(dx) <= EPS) {
      return null;
    }
    return (target.x - from.x) / dx;
  }
  if (Math.abs(dy) <= EPS) {
    return null;
  }
  return (target.y - from.y) / dy;
}

function edgePair(
  a0: Point,
  a1: Point,
  b0: Point,
  b1: Point,
  mark: Marks,
  tol: number,
  left: Event[],
  right: Event[]
): boolean {
  const rx = a1.x - a0.x;
  const ry = a1.y - a0.y;
  const sx = b1.x - b0.x;
  const sy = b1.y - b0.y;
  const lenA = Math.sqrt(rx * rx + ry * ry);
  const lenB = Math.sqrt(sx * sx + sy * sy);
  const den = rx * sy - ry * sx;
  const qx = b0.x - a0.x;
  const qy = b0.y - a0.y;
  if (Math.abs(den) > lenA * lenB * 1e-12) {
    const t = (qx * sy - qy * sx) / den;
    const u = (qx * ry - qy * rx) / den;
    if (t < -EPS || t > 1.0 + EPS || u < -EPS || u > 1.0 + EPS) {
      return false;
    }
    const place = spot(a0.x + t * rx, a0.y + t * ry);
    const id = register(mark, place, tol);
    pushEvent(left, 0, t, id);
    pushEvent(right, 0, u, id);
    return true;
  }
  if (lenA <= EPS || lenB <= EPS) {
    return false;
  }
  if (Math.abs(qx * ry - qy * rx) > tol * lenA) {
    return false;
  }
  let touched = false;
  for (const value of [b0, b1]) {
    const t = along(a0, a1, value);
    if (t !== null && t >= -EPS && t <= 1.0 + EPS) {
      const id = register(mark, value, tol);
      pushEvent(left, 0, t, id);
      touched = true;
    }
  }
  for (const value of [a0, a1]) {
    const u = along(b0, b1, value);
    if (u !== null && u >= -EPS && u <= 1.0 + EPS) {
      const id = register(mark, value, tol);
      pushEvent(right, 0, u, id);
      touched = true;
    }
  }
  return touched;
}

function pairEvents(
  a: Point[],
  b: Point[],
  mark: Marks,
  tol: number,
  left: Event[],
  right: Event[]
): boolean {
  let touched = false;
  for (let i = 0; i < a.length; i += 1) {
    const a0 = a[i];
    const a1 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j += 1) {
      const b0 = b[j];
      const b1 = b[(j + 1) % b.length];
      const onA: Event[] = [];
      const onB: Event[] = [];
      if (edgePair(a0, a1, b0, b1, mark, tol, onA, onB)) {
        touched = true;
      }
      for (const item of onA) {
        left.push({ edge: i, at: item.at, id: item.id });
      }
      for (const item of onB) {
        right.push({ edge: j, at: item.at, id: item.id });
      }
    }
  }
  return touched;
}

type Marked = [number, Point];

function split(ring: Point[], events: Event[], mark: Marks, tol: number): Marked[] {
  const perEdge: Event[][] = [];
  for (let index = 0; index < ring.length; index += 1) {
    perEdge.push([]);
  }
  for (const item of events) {
    perEdge[item.edge].push(item);
  }
  const out: Marked[] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const id = register(mark, ring[index], tol);
    out.push([id, markAt(mark, id)]);
    const list = perEdge[index];
    list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    let previous = -1;
    for (const item of list) {
      if (item.id === previous) {
        continue;
      }
      previous = item.id;
      out.push([item.id, markAt(mark, item.id)]);
    }
  }
  while (out.length > 1) {
    if (out[0][0] === out[out.length - 1][0]) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

type Kind = "inside" | "outside" | "overlap";

interface Arc {
  from: number;
  to: number;
  points: Point[];
  kind: Kind;
  shared: boolean;
}

function values(ring: Marked[]): Point[] {
  return ring.map((item) => clonePoint(item[1]));
}

function arcsOf(ring: Marked[], other: Marked[]): Arc[] {
  const points = values(ring);
  const bounds = values(other);
  const touch = Math.min(extent(points), extent(bounds)) * 1e-9;
  const nudge = extent(points) * 1e-6;
  const positive = area(points) >= 0.0;
  const count = ring.length;
  const out: Arc[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = ring[index];
    const stop = ring[(index + 1) % count];
    if (start[0] === stop[0]) {
      continue;
    }
    const mid = spot((start[1].x + stop[1].x) / 2.0, (start[1].y + stop[1].y) / 2.0);
    const arc: Arc = {
      from: start[0],
      to: stop[0],
      points: [clonePoint(start[1]), clonePoint(stop[1])],
      kind: "outside",
      shared: false
    };
    if (clearance(mid, bounds) <= touch) {
      const normal = interiorNormal(positive, start[1], stop[1]);
      const probe = spot(mid.x + normal.x * nudge, mid.y + normal.y * nudge);
      arc.kind = "overlap";
      arc.shared = inside(bounds, probe);
    } else if (inside(bounds, mid)) {
      arc.kind = "inside";
    }
    out.push(arc);
  }
  return out;
}

function plan(op: BoolOp, subject: boolean, arc: Arc): boolean | null {
  if (op === "union") {
    if (arc.kind === "outside") {
      return false;
    }
    if (arc.kind === "inside") {
      return null;
    }
    return subject && arc.shared ? false : null;
  }
  if (op === "intersect") {
    if (arc.kind === "inside") {
      return false;
    }
    if (arc.kind === "outside") {
      return null;
    }
    return subject && arc.shared ? false : null;
  }
  if (op === "subtract") {
    if (arc.kind === "outside") {
      return false;
    }
    if (arc.kind === "inside") {
      return subject ? null : true;
    }
    return subject && !arc.shared ? false : null;
  }
  if (arc.kind === "outside") {
    return false;
  }
  if (arc.kind === "inside") {
    return true;
  }
  return null;
}

function chosen(left: Arc[], right: Arc[], op: BoolOp): Arc[] {
  const flip = (piece: Arc): Arc => ({
    from: piece.to,
    to: piece.from,
    points: piece.points.map(clonePoint).reverse(),
    kind: piece.kind,
    shared: piece.shared
  });
  const out: Arc[] = [];
  for (const piece of left) {
    const keep = plan(op, true, piece);
    if (keep === false) {
      out.push(piece);
    } else if (keep === true) {
      out.push(flip(piece));
    }
  }
  for (const piece of right) {
    const keep = plan(op, false, piece);
    if (keep === false) {
      out.push(piece);
    } else if (keep === true) {
      out.push(flip(piece));
    }
  }
  return out;
}

function tailDirection(points: Point[]): Point {
  if (points.length < 2) {
    return spot(1.0, 0.0);
  }
  const a = points[points.length - 2];
  const b = points[points.length - 1];
  return spot(b.x - a.x, b.y - a.y);
}

function headDirection(points: Point[]): Point {
  if (points.length < 2) {
    return spot(1.0, 0.0);
  }
  const a = points[0];
  const b = points[1];
  return spot(b.x - a.x, b.y - a.y);
}

function chain(arcs: Arc[]): Point[][] {
  const used: boolean[] = arcs.map(() => false);
  const out: Point[][] = [];
  for (let seed = 0; seed < arcs.length; seed += 1) {
    if (used[seed]) {
      continue;
    }
    used[seed] = true;
    const headFrom = arcs[seed].from;
    const ring = arcs[seed].points.map(clonePoint);
    let at = arcs[seed].to;
    let guard = 0;
    while (at !== headFrom && guard <= arcs.length) {
      guard += 1;
      const tail = tailDirection(ring);
      let best = -1;
      let bestScore = -Infinity;
      for (let index = 0; index < arcs.length; index += 1) {
        if (used[index] || arcs[index].from !== at) {
          continue;
        }
        const next = headDirection(arcs[index].points);
        const score = tail.x * next.x + tail.y * next.y;
        if (score > bestScore) {
          bestScore = score;
          best = index;
        }
      }
      if (best < 0) {
        break;
      }
      used[best] = true;
      const piece = arcs[best];
      for (let index = 1; index < piece.points.length; index += 1) {
        ring.push(clonePoint(piece.points[index]));
      }
      at = piece.to;
    }
    if (at === headFrom) {
      const closed = closeRing(ring);
      if (closed.length > 2 && Math.abs(area(closed)) > EPS) {
        out.push(closed);
      }
    }
  }
  return out;
}

function bridge(outer: Point[], hole: Point[]): Point[] {
  let hi = 0;
  for (let index = 1; index < hole.length; index += 1) {
    if (hole[index].x > hole[hi].x) {
      hi = index;
    }
  }
  const anchor = clonePoint(hole[hi]);
  let joint: [number, number] | null = null;
  for (let index = 0; index < outer.length; index += 1) {
    const a = clonePoint(outer[index]);
    const b = clonePoint(outer[(index + 1) % outer.length]);
    if (Math.abs(a.y - b.y) <= EPS) {
      continue;
    }
    if ((a.y <= anchor.y) === (b.y <= anchor.y)) {
      continue;
    }
    const t = (anchor.y - a.y) / (b.y - a.y);
    const edgeX = a.x + t * (b.x - a.x);
    if (edgeX >= anchor.x - EPS) {
      continue;
    }
    if (joint === null || edgeX > joint[1]) {
      joint = [index, edgeX];
    }
  }
  let splitAt: number;
  let jointPoint: Point;
  if (joint !== null) {
    splitAt = joint[0];
    jointPoint = spot(joint[1], anchor.y);
  } else {
    let nearest = 0;
    for (let index = 1; index < outer.length; index += 1) {
      const a = outer[index];
      const b = outer[nearest];
      const da = Math.abs(a.x - anchor.x) + Math.abs(a.y - anchor.y);
      const db = Math.abs(b.x - anchor.x) + Math.abs(b.y - anchor.y);
      if (da < db) {
        nearest = index;
      }
    }
    splitAt = nearest;
    jointPoint = clonePoint(outer[nearest]);
  }
  const result: Point[] = [clonePoint(jointPoint)];
  for (let index = 0; index <= hole.length; index += 1) {
    result.push(clonePoint(hole[(hi + index) % hole.length]));
  }
  result.push(clonePoint(jointPoint));
  for (let index = 1; index <= outer.length; index += 1) {
    result.push(clonePoint(outer[(splitAt + index) % outer.length]));
  }
  return closeRing(result);
}

function withHoles(rings: Point[][]): Point[][] {
  const outers: Point[][] = [];
  const holes: Point[][] = [];
  for (const ring of rings) {
    if (area(ring) < 0.0) {
      holes.push(wound(ring, false));
    } else {
      outers.push(wound(ring, true));
    }
  }
  for (const hole of holes) {
    let host = -1;
    for (let index = 0; index < outers.length; index += 1) {
      const outer = outers[index];
      if (!inside(outer, hole[0])) {
        continue;
      }
      if (host < 0 || Math.abs(area(outer)) < Math.abs(area(outers[host]))) {
        host = index;
      }
    }
    if (host >= 0) {
      outers[host] = bridge(outers[host], hole);
    }
  }
  return outers;
}

function finish(rings: Point[][]): Point[][] {
  const cleaned = rings
    .map(closeRing)
    .filter((ring) => {
      const width = extent(ring);
      return ring.length > 2 && Math.abs(area(ring)) >= width * width * 1e-10;
    });
  if (cleaned.some((ring) => area(ring) < 0.0)) {
    return withHoles(cleaned);
  }
  return cleaned.map((ring) => wound(ring, true));
}

function extent(ring: Point[]): number {
  let lowX = Infinity;
  let lowY = Infinity;
  let highX = -Infinity;
  let highY = -Infinity;
  for (const item of ring) {
    lowX = Math.min(lowX, item.x);
    lowY = Math.min(lowY, item.y);
    highX = Math.max(highX, item.x);
    highY = Math.max(highY, item.y);
  }
  return Math.max(highX - lowX, highY - lowY, 1.0);
}

function disjointRings(s: Point[], c: Point[], op: BoolOp): Point[][] {
  const subjectInside = inside(c, s[0]);
  const clipInside = inside(s, c[0]);
  let rings: Point[][];
  if (op === "union") {
    rings = subjectInside
      ? [c.map(clonePoint)]
      : clipInside
        ? [s.map(clonePoint)]
        : [s.map(clonePoint), c.map(clonePoint)];
  } else if (op === "intersect") {
    rings = subjectInside
      ? [s.map(clonePoint)]
      : clipInside
        ? [c.map(clonePoint)]
        : [];
  } else if (op === "subtract") {
    rings = subjectInside
      ? []
      : clipInside
        ? [s.map(clonePoint), reversed(c)]
        : [s.map(clonePoint)];
  } else {
    rings = subjectInside
      ? [c.map(clonePoint), reversed(s)]
      : clipInside
        ? [s.map(clonePoint), reversed(c)]
        : [s.map(clonePoint), c.map(clonePoint)];
  }
  return finish(rings);
}

function booleanRings(subject: Point[], clip: Point[], op: BoolOp): Point[][] {
  const s = wound(subject, true);
  const c = wound(clip, true);
  const tol = Math.max(extent(s), extent(c)) * 1e-9;
  const mark = marks(tol);
  const leftEvents: Event[] = [];
  const rightEvents: Event[] = [];
  const touched = pairEvents(s, c, mark, tol, leftEvents, rightEvents);
  if (!touched) {
    return disjointRings(s, c, op);
  }
  const leftMarks = split(s, leftEvents, mark, tol);
  const rightMarks = split(c, rightEvents, mark, tol);
  const left = arcsOf(leftMarks, rightMarks);
  const right = arcsOf(rightMarks, leftMarks);
  return finish(chain(chosen(left, right, op)));
}

function pathFrom(ring: Point[], template: Shape): Shape {
  const nodes: PathNode[] = ring.map((item) => ({
    point: clonePoint(item),
    handle_in: null,
    handle_out: null
  }));
  let fill = "";
  let stroke = "";
  let width = 1.0;
  let gradient: Gradient | null = null;
  if (
    template.kind === "Rect" ||
    template.kind === "Ellipse" ||
    template.kind === "Polygon" ||
    template.kind === "Path"
  ) {
    fill = template.fill;
    stroke = template.stroke;
    width = template.width;
    gradient = template.gradient ?? null;
  }
  return { kind: "Path", nodes, closed: true, fill, stroke, width, gradient };
}

export function combineShapes(shapes: Shape[], indices: number[], op: BoolOp): Shape[] {
  const picked = [...new Set(indices)].sort((a, b) => a - b);
  if (picked.length < 2) {
    throw new Error("select at least two shapes");
  }
  const template = shapes[picked[0]];
  if (!template) {
    throw new Error("unknown shape");
  }
  let current: Point[][] = [ringOf(template)];
  for (let step = 1; step < picked.length; step += 1) {
    const shape = shapes[picked[step]];
    if (!shape) {
      throw new Error("unknown shape");
    }
    const ring = ringOf(shape);
    const merged: Point[][] = [];
    for (const layer of current) {
      merged.push(...booleanRings(layer, ring, op));
    }
    if (merged.length === 0) {
      throw new Error("the boolean result is empty");
    }
    current = merged;
  }
  if (current.length === 0) {
    throw new Error("the boolean result is empty");
  }
  return current.map((ring) => pathFrom(ring, template));
}
