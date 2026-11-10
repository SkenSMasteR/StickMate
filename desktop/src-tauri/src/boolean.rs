use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::document::{polygon_vertices, Gradient, Point, Shape};
use crate::path::{flatten_path, PathNode};

pub const ELLIPSE_SEGMENTS: usize = 72;

const EPS: f64 = 1e-9;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoolOp {
    Union,
    Subtract,
    Intersect,
    Exclude,
}

pub fn bool_history_name(op: BoolOp) -> &'static str {
    match op {
        BoolOp::Union => "bool_union",
        BoolOp::Subtract => "bool_subtract",
        BoolOp::Intersect => "bool_intersect",
        BoolOp::Exclude => "bool_exclude",
    }
}

fn spot(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn clone_point(value: &Point) -> Point {
    Point {
        x: value.x,
        y: value.y,
    }
}

pub fn ring_of(shape: &Shape) -> Result<Vec<Point>, String> {
    let ring = match shape {
        Shape::Rect { x, y, w, h, .. } => vec![
            spot(*x, *y),
            spot(*x + *w, *y),
            spot(*x + *w, *y + *h),
            spot(*x, *y + *h),
        ],
        Shape::Ellipse { x, y, w, h, .. } => {
            let cx = x + w / 2.0;
            let cy = y + h / 2.0;
            let rx = w / 2.0;
            let ry = h / 2.0;
            let step = std::f64::consts::TAU / ELLIPSE_SEGMENTS as f64;
            (0..ELLIPSE_SEGMENTS)
                .map(|index| {
                    let angle = -std::f64::consts::FRAC_PI_2 + index as f64 * step;
                    spot(cx + angle.cos() * rx, cy + angle.sin() * ry)
                })
                .collect()
        }
        Shape::Polygon {
            x, y, w, h, sides, ..
        } => polygon_vertices(*x, *y, *w, *h, *sides),
        Shape::Path { nodes, closed, .. } => {
            if !*closed {
                return Err("boolean needs closed filled shapes".to_string());
            }
            flatten_path(nodes, true)
        }
        _ => return Err("boolean needs closed filled shapes".to_string()),
    };
    let clean = close_ring(ring);
    if clean.len() < 3 || area(&clean).abs() <= EPS {
        return Err("boolean needs closed filled shapes".to_string());
    }
    Ok(clean)
}

fn close_ring(ring: Vec<Point>) -> Vec<Point> {
    let mut out: Vec<Point> = Vec::with_capacity(ring.len());
    for item in ring {
        if !item.x.is_finite() || !item.y.is_finite() {
            continue;
        }
        match out.last() {
            Some(last)
                if (last.x - item.x).abs() <= EPS && (last.y - item.y).abs() <= EPS => continue,
            _ => out.push(item),
        }
    }
    while out.len() > 1 {
        let first = clone_point(&out[0]);
        let last = clone_point(&out[out.len() - 1]);
        if (first.x - last.x).abs() <= EPS && (first.y - last.y).abs() <= EPS {
            out.pop();
        } else {
            break;
        }
    }
    out
}

fn area(ring: &[Point]) -> f64 {
    let mut total = 0.0;
    for index in 0..ring.len() {
        let a = &ring[index];
        let b = &ring[(index + 1) % ring.len()];
        total += a.x * b.y - b.x * a.y;
    }
    total / 2.0
}

fn wound(ring: &[Point], clockwise: bool) -> Vec<Point> {
    let positive = area(ring) >= 0.0;
    let want_positive = clockwise;
    if positive == want_positive {
        return ring.to_vec();
    }
    reversed(ring)
}

fn reversed(ring: &[Point]) -> Vec<Point> {
    let mut out = ring.to_vec();
    out.reverse();
    out
}

fn inside(ring: &[Point], target: &Point) -> bool {
    let mut hit = false;
    for index in 0..ring.len() {
        let a = &ring[index];
        let b = &ring[(index + 1) % ring.len()];
        if (a.y <= target.y) == (b.y <= target.y) {
            continue;
        }
        let t = (target.y - a.y) / (b.y - a.y);
        let edge_x = a.x + t * (b.x - a.x);
        if target.x < edge_x {
            hit = !hit;
        }
    }
    hit
}

fn near(a: &Point, b: &Point, tol: f64) -> bool {
    (a.x - b.x).abs() <= tol && (a.y - b.y).abs() <= tol
}

fn clearance(target: &Point, ring: &[Point]) -> f64 {
    let mut best = f64::INFINITY;
    for index in 0..ring.len() {
        let a = &ring[index];
        let b = &ring[(index + 1) % ring.len()];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let len = dx * dx + dy * dy;
        if len <= EPS {
            continue;
        }
        let t = (((target.x - a.x) * dx + (target.y - a.y) * dy) / len).clamp(0.0, 1.0);
        let fx = a.x + t * dx - target.x;
        let fy = a.y + t * dy - target.y;
        best = best.min((fx * fx + fy * fy).sqrt());
    }
    best
}

fn interior_normal(positive: bool, from: &Point, to: &Point) -> Point {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let len = (dx * dx + dy * dy).sqrt().max(EPS);
    let normal = spot(-dy / len, dx / len);
    if positive {
        normal
    } else {
        spot(-normal.x, -normal.y)
    }
}

struct Marks {
    scale: f64,
    spots: Vec<Point>,
    keys: HashMap<(i64, i64), usize>,
}

impl Marks {
    fn new(scale: f64) -> Self {
        Marks {
            scale,
            spots: Vec::new(),
            keys: HashMap::new(),
        }
    }

    fn register(&mut self, value: &Point, tol: f64) -> usize {
        let row = (value.x / self.scale).round() as i64;
        let column = (value.y / self.scale).round() as i64;
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(&found) = self.keys.get(&(row + dx, column + dy)) {
                    if near(&self.spots[found], value, tol) {
                        return found;
                    }
                }
            }
        }
        let id = self.spots.len();
        self.spots.push(clone_point(value));
        self.keys.insert((row, column), id);
        id
    }

    fn at(&self, id: usize) -> Point {
        clone_point(&self.spots[id])
    }
}

#[derive(Clone, Copy, Debug)]
struct Event {
    edge: usize,
    at: f64,
    id: usize,
}

fn push_event(list: &mut Vec<Event>, edge: usize, raw: f64, id: usize) {
    if raw <= EPS || raw >= 1.0 - EPS {
        return;
    }
    list.push(Event { edge, at: raw, id });
}

fn along(from: &Point, to: &Point, target: &Point) -> Option<f64> {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if dx.abs() >= dy.abs() {
        if dx.abs() <= EPS {
            return None;
        }
        Some((target.x - from.x) / dx)
    } else {
        if dy.abs() <= EPS {
            return None;
        }
        Some((target.y - from.y) / dy)
    }
}

fn edge_pair(
    a0: &Point,
    a1: &Point,
    b0: &Point,
    b1: &Point,
    marks: &mut Marks,
    tol: f64,
    left: &mut Vec<Event>,
    right: &mut Vec<Event>,
) -> bool {
    let rx = a1.x - a0.x;
    let ry = a1.y - a0.y;
    let sx = b1.x - b0.x;
    let sy = b1.y - b0.y;
    let len_a = (rx * rx + ry * ry).sqrt();
    let len_b = (sx * sx + sy * sy).sqrt();
    let den = rx * sy - ry * sx;
    let qx = b0.x - a0.x;
    let qy = b0.y - a0.y;
    if den.abs() > len_a * len_b * 1e-12 {
        let t = (qx * sy - qy * sx) / den;
        let u = (qx * ry - qy * rx) / den;
        if t < -EPS || t > 1.0 + EPS || u < -EPS || u > 1.0 + EPS {
            return false;
        }
        let place = spot(a0.x + t * rx, a0.y + t * ry);
        let id = marks.register(&place, tol);
        push_event(left, 0, t, id);
        push_event(right, 0, u, id);
        return true;
    }
    if len_a <= EPS || len_b <= EPS {
        return false;
    }
    if (qx * ry - qy * rx).abs() > tol * len_a {
        return false;
    }
    let mut touched = false;
    for value in [b0, b1] {
        match along(a0, a1, value) {
            Some(t) if (-EPS..=1.0 + EPS).contains(&t) => {
                let id = marks.register(value, tol);
                push_event(left, 0, t, id);
                touched = true;
            }
            _ => {}
        }
    }
    for value in [a0, a1] {
        match along(b0, b1, value) {
            Some(u) if (-EPS..=1.0 + EPS).contains(&u) => {
                let id = marks.register(value, tol);
                push_event(right, 0, u, id);
                touched = true;
            }
            _ => {}
        }
    }
    touched
}

fn pair_events(
    a: &[Point],
    b: &[Point],
    marks: &mut Marks,
    tol: f64,
    left: &mut Vec<Event>,
    right: &mut Vec<Event>,
) -> bool {
    let mut touched = false;
    for i in 0..a.len() {
        let a0 = &a[i];
        let a1 = &a[(i + 1) % a.len()];
        for j in 0..b.len() {
            let b0 = &b[j];
            let b1 = &b[(j + 1) % b.len()];
            let mut on_a: Vec<Event> = Vec::new();
            let mut on_b: Vec<Event> = Vec::new();
            if edge_pair(a0, a1, b0, b1, marks, tol, &mut on_a, &mut on_b) {
                touched = true;
            }
            for item in on_a {
                left.push(Event { edge: i, ..item });
            }
            for item in on_b {
                right.push(Event { edge: j, ..item });
            }
        }
    }
    touched
}

fn split(ring: &[Point], events: &[Event], marks: &mut Marks, tol: f64) -> Vec<(usize, Point)> {
    let mut per_edge: Vec<Vec<Event>> = vec![Vec::new(); ring.len()];
    for item in events {
        per_edge[item.edge].push(*item);
    }
    let mut out: Vec<(usize, Point)> = Vec::new();
    for index in 0..ring.len() {
        let id = marks.register(&ring[index], tol);
        out.push((id, marks.at(id)));
        let list = &mut per_edge[index];
        list.sort_by(|a, b| a.at.partial_cmp(&b.at).unwrap_or(std::cmp::Ordering::Equal));
        let mut previous = usize::MAX;
        for item in list {
            if item.id == previous {
                continue;
            }
            previous = item.id;
            let place = marks.at(item.id);
            out.push((item.id, place));
        }
    }
    while out.len() > 1 {
        let (first, _) = out[0];
        let (last, _) = out[out.len() - 1];
        if first == last {
            out.pop();
        } else {
            break;
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Inside,
    Outside,
    Overlap,
}

#[derive(Clone, Debug)]
struct Arc {
    from: usize,
    to: usize,
    points: Vec<Point>,
    kind: Kind,
    shared: bool,
}

fn values(ring: &[(usize, Point)]) -> Vec<Point> {
    ring.iter().map(|item| clone_point(&item.1)).collect()
}

fn arcs_of(ring: &[(usize, Point)], other: &[(usize, Point)]) -> Vec<Arc> {
    let points = values(ring);
    let bounds = values(other);
    let touch = extent(&points).min(extent(&bounds)) * 1e-9;
    let nudge = extent(&points) * 1e-6;
    let positive = area(&points) >= 0.0;
    let count = ring.len();
    let mut out: Vec<Arc> = Vec::with_capacity(count);
    for index in 0..count {
        let start = &ring[index];
        let stop = &ring[(index + 1) % count];
        if start.0 == stop.0 {
            continue;
        }
        let mid = spot((start.1.x + stop.1.x) / 2.0, (start.1.y + stop.1.y) / 2.0);
        let mut arc = Arc {
            from: start.0,
            to: stop.0,
            points: vec![clone_point(&start.1), clone_point(&stop.1)],
            kind: Kind::Outside,
            shared: false,
        };
        if clearance(&mid, &bounds) <= touch {
            let normal = interior_normal(positive, &start.1, &stop.1);
            let probe = spot(mid.x + normal.x * nudge, mid.y + normal.y * nudge);
            arc.kind = Kind::Overlap;
            arc.shared = inside(&bounds, &probe);
        } else if inside(&bounds, &mid) {
            arc.kind = Kind::Inside;
        }
        out.push(arc);
    }
    out
}

fn plan(op: BoolOp, subject: bool, arc: &Arc) -> Option<bool> {
    match (op, arc.kind) {
        (BoolOp::Union, Kind::Outside) => Some(false),
        (BoolOp::Union, Kind::Inside) => None,
        (BoolOp::Union, Kind::Overlap) => Some(false).filter(|_| subject && arc.shared),
        (BoolOp::Intersect, Kind::Inside) => Some(false),
        (BoolOp::Intersect, Kind::Outside) => None,
        (BoolOp::Intersect, Kind::Overlap) => Some(false).filter(|_| subject && arc.shared),
        (BoolOp::Subtract, Kind::Outside) => Some(false),
        (BoolOp::Subtract, Kind::Inside) => {
            if subject {
                None
            } else {
                Some(true)
            }
        }
        (BoolOp::Subtract, Kind::Overlap) => Some(false).filter(|_| subject && !arc.shared),
        (BoolOp::Exclude, Kind::Outside) => Some(false),
        (BoolOp::Exclude, Kind::Inside) => Some(true),
        (BoolOp::Exclude, Kind::Overlap) => None,
    }
}

fn chosen(left: Vec<Arc>, right: Vec<Arc>, op: BoolOp) -> Vec<Arc> {
    let flip = |piece: &Arc| Arc {
        from: piece.to,
        to: piece.from,
        points: piece.points.iter().rev().cloned().collect(),
        kind: piece.kind,
        shared: piece.shared,
    };
    let mut out: Vec<Arc> = Vec::new();
    for piece in left.iter() {
        match plan(op, true, piece) {
            Some(false) => out.push(piece.clone()),
            Some(true) => out.push(flip(piece)),
            None => {}
        }
    }
    for piece in right.iter() {
        match plan(op, false, piece) {
            Some(false) => out.push(piece.clone()),
            Some(true) => out.push(flip(piece)),
            None => {}
        }
    }
    out
}

fn tail_direction(points: &[Point]) -> Point {
    if points.len() < 2 {
        return spot(1.0, 0.0);
    }
    let a = &points[points.len() - 2];
    let b = &points[points.len() - 1];
    spot(b.x - a.x, b.y - a.y)
}

fn head_direction(points: &[Point]) -> Point {
    if points.len() < 2 {
        return spot(1.0, 0.0);
    }
    let a = &points[0];
    let b = &points[1];
    spot(b.x - a.x, b.y - a.y)
}

fn chain(arcs: Vec<Arc>) -> Vec<Vec<Point>> {
    let mut used = vec![false; arcs.len()];
    let mut out: Vec<Vec<Point>> = Vec::new();
    for seed in 0..arcs.len() {
        if used[seed] {
            continue;
        }
        used[seed] = true;
        let head = arcs[seed].clone();
        let head_from = head.from;
        let mut ring = head.points.clone();
        let mut at = head.to;
        let mut guard = 0usize;
        while at != head_from && guard <= arcs.len() {
            guard += 1;
            let tail = tail_direction(&ring);
            let mut best: Option<usize> = None;
            let mut best_score = f64::NEG_INFINITY;
            for index in 0..arcs.len() {
                if used[index] || arcs[index].from != at {
                    continue;
                }
                let next = head_direction(&arcs[index].points);
                let score = tail.x * next.x + tail.y * next.y;
                if score > best_score {
                    best_score = score;
                    best = Some(index);
                }
            }
            let Some(index) = best else { break };
            used[index] = true;
            let piece = arcs[index].clone();
            for item in piece.points.iter().skip(1) {
                ring.push(clone_point(item));
            }
            at = piece.to;
        }
        if at == head_from {
            let closed = close_ring(ring);
            if closed.len() > 2 && area(&closed).abs() > EPS {
                out.push(closed);
            }
        }
    }
    out
}

fn bridge(outer: &mut Vec<Point>, hole: &[Point]) {
    let mut hi = 0usize;
    for index in 1..hole.len() {
        if hole[index].x > hole[hi].x {
            hi = index;
        }
    }
    let anchor = clone_point(&hole[hi]);
    let mut joint: Option<(usize, f64)> = None;
    for index in 0..outer.len() {
        let a = clone_point(&outer[index]);
        let b = clone_point(&outer[(index + 1) % outer.len()]);
        if (a.y - b.y).abs() <= EPS {
            continue;
        }
        if (a.y <= anchor.y) == (b.y <= anchor.y) {
            continue;
        }
        let t = (anchor.y - a.y) / (b.y - a.y);
        let edge_x = a.x + t * (b.x - a.x);
        if edge_x >= anchor.x - EPS {
            continue;
        }
        if joint.map_or(true, |(_, best)| edge_x > best) {
            joint = Some((index, edge_x));
        }
    }
    let (split, joint_point) = match joint {
        Some((index, x)) => (index, spot(x, anchor.y)),
        None => {
            let mut nearest = 0usize;
            for index in 1..outer.len() {
                let a = &outer[index];
                let b = &outer[nearest];
                let da = (a.x - anchor.x).abs() + (a.y - anchor.y).abs();
                let db = (b.x - anchor.x).abs() + (b.y - anchor.y).abs();
                if da < db {
                    nearest = index;
                }
            }
            let place = clone_point(&outer[nearest]);
            (nearest, place)
        }
    };
    let mut result: Vec<Point> = Vec::with_capacity(outer.len() + hole.len() + 3);
    result.push(clone_point(&joint_point));
    for index in 0..=hole.len() {
        result.push(clone_point(&hole[(hi + index) % hole.len()]));
    }
    result.push(clone_point(&joint_point));
    for index in 1..=outer.len() {
        result.push(clone_point(&outer[(split + index) % outer.len()]));
    }
    *outer = close_ring(result);
}

fn with_holes(rings: Vec<Vec<Point>>) -> Vec<Vec<Point>> {
    let mut outers: Vec<Vec<Point>> = Vec::new();
    let mut holes: Vec<Vec<Point>> = Vec::new();
    for ring in rings {
        if area(&ring) < 0.0 {
            holes.push(wound(&ring, false));
        } else {
            outers.push(wound(&ring, true));
        }
    }
    for hole in holes {
        let mut host: Option<usize> = None;
        for (index, outer) in outers.iter().enumerate() {
            if !inside(outer, &hole[0]) {
                continue;
            }
            match host {
                None => host = Some(index),
                Some(current) => {
                    if area(outer).abs() < area(&outers[current]).abs() {
                        host = Some(index);
                    }
                }
            }
        }
        if let Some(index) = host {
            bridge(&mut outers[index], &hole);
        }
    }
    outers
}

fn finish(rings: Vec<Vec<Point>>) -> Vec<Vec<Point>> {
    let cleaned: Vec<Vec<Point>> = rings
        .into_iter()
        .map(close_ring)
        .filter(|ring| {
            let width = extent(ring);
            ring.len() > 2 && area(ring).abs() >= width * width * 1e-10
        })
        .collect();
    if cleaned.iter().any(|ring| area(ring) < 0.0) {
        return with_holes(cleaned);
    }
    cleaned.into_iter().map(|ring| wound(&ring, true)).collect()
}

fn extent(ring: &[Point]) -> f64 {
    let mut low_x = f64::INFINITY;
    let mut low_y = f64::INFINITY;
    let mut high_x = f64::NEG_INFINITY;
    let mut high_y = f64::NEG_INFINITY;
    for item in ring {
        low_x = low_x.min(item.x);
        low_y = low_y.min(item.y);
        high_x = high_x.max(item.x);
        high_y = high_y.max(item.y);
    }
    (high_x - low_x).max(high_y - low_y).max(1.0)
}

fn disjoint_rings(s: &[Point], c: &[Point], op: BoolOp) -> Vec<Vec<Point>> {
    let subject_inside = inside(c, &s[0]);
    let clip_inside = inside(s, &c[0]);
    let rings = match op {
        BoolOp::Union => {
            if subject_inside {
                vec![c.to_vec()]
            } else if clip_inside {
                vec![s.to_vec()]
            } else {
                vec![s.to_vec(), c.to_vec()]
            }
        }
        BoolOp::Intersect => {
            if subject_inside {
                vec![s.to_vec()]
            } else if clip_inside {
                vec![c.to_vec()]
            } else {
                Vec::new()
            }
        }
        BoolOp::Subtract => {
            if subject_inside {
                Vec::new()
            } else if clip_inside {
                vec![s.to_vec(), reversed(c)]
            } else {
                vec![s.to_vec()]
            }
        }
        BoolOp::Exclude => {
            if subject_inside {
                vec![c.to_vec(), reversed(s)]
            } else if clip_inside {
                vec![s.to_vec(), reversed(c)]
            } else {
                vec![s.to_vec(), c.to_vec()]
            }
        }
    };
    finish(rings)
}

fn boolean_rings(subject: &[Point], clip: &[Point], op: BoolOp) -> Vec<Vec<Point>> {
    let s = wound(subject, true);
    let c = wound(clip, true);
    let tol = extent(&s).max(extent(&c)) * 1e-9;
    let mut marks = Marks::new(tol);
    let mut left_events: Vec<Event> = Vec::new();
    let mut right_events: Vec<Event> = Vec::new();
    let touched = pair_events(&s, &c, &mut marks, tol, &mut left_events, &mut right_events);
    if !touched {
        return disjoint_rings(&s, &c, op);
    }
    let left_marks = split(&s, &left_events, &mut marks, tol);
    let right_marks = split(&c, &right_events, &mut marks, tol);
    let left = arcs_of(&left_marks, &right_marks);
    let right = arcs_of(&right_marks, &left_marks);
    finish(chain(chosen(left, right, op)))
}

fn path_from(ring: &[Point], template: &Shape) -> Shape {
    let nodes: Vec<PathNode> = ring
        .iter()
        .map(|item| PathNode {
            point: clone_point(item),
            handle_in: None,
            handle_out: None,
        })
        .collect();
    let (fill, stroke, width, gradient) = match template {
        Shape::Rect {
            fill,
            stroke,
            width,
            gradient,
            ..
        }
        | Shape::Ellipse {
            fill,
            stroke,
            width,
            gradient,
            ..
        }
        | Shape::Polygon {
            fill,
            stroke,
            width,
            gradient,
            ..
        }
        | Shape::Path {
            fill,
            stroke,
            width,
            gradient,
            ..
        } => (
            fill.clone(),
            stroke.clone(),
            *width,
            gradient.as_ref().map(|value| value.clone()),
        ),
        _ => (String::new(), String::new(), 1.0, None::<Gradient>),
    };
    Shape::Path {
        nodes,
        closed: true,
        fill,
        stroke,
        width,
        gradient,
    }
}

pub fn combine(shapes: &[Shape], indices: &[usize], op: BoolOp) -> Result<Vec<Shape>, String> {
    let mut picked: Vec<usize> = indices.to_vec();
    picked.sort_unstable();
    picked.dedup();
    if picked.len() < 2 {
        return Err("select at least two shapes".to_string());
    }
    let template = shapes
        .get(picked[0])
        .ok_or_else(|| "unknown shape".to_string())?;
    let mut current: Vec<Vec<Point>> = vec![ring_of(template)?];
    for &index in picked.iter().skip(1) {
        let shape = shapes
            .get(index)
            .ok_or_else(|| "unknown shape".to_string())?;
        let ring = ring_of(shape)?;
        let mut merged: Vec<Vec<Point>> = Vec::new();
        for layer in &current {
            merged.extend(boolean_rings(layer, &ring, op));
        }
        if merged.is_empty() {
            return Err("the boolean result is empty".to_string());
        }
        current = merged;
    }
    if current.is_empty() {
        return Err("the boolean result is empty".to_string());
    }
    Ok(current.iter().map(|ring| path_from(ring, template)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Shape {
        Shape::Rect {
            x,
            y,
            w,
            h,
            fill: "#ff0000".to_string(),
            stroke: "#000000".to_string(),
            width: 2.0,
            gradient: None,
        }
    }

    fn circle(x: f64, y: f64, w: f64, h: f64) -> Shape {
        Shape::Ellipse {
            x,
            y,
            w,
            h,
            fill: "#00ff00".to_string(),
            stroke: "#000000".to_string(),
            width: 2.0,
            gradient: None,
        }
    }

    fn close(value: f64, target: f64) -> bool {
        (value - target).abs() < 1e-6
    }

    fn bounds(rings: &[Vec<Point>]) -> (f64, f64, f64, f64) {
        let mut low_x = f64::INFINITY;
        let mut low_y = f64::INFINITY;
        let mut high_x = f64::NEG_INFINITY;
        let mut high_y = f64::NEG_INFINITY;
        for ring in rings {
            for point in ring {
                low_x = low_x.min(point.x);
                low_y = low_y.min(point.y);
                high_x = high_x.max(point.x);
                high_y = high_y.max(point.y);
            }
        }
        (low_x, low_y, high_x, high_y)
    }

    fn total(rings: &[Vec<Point>]) -> f64 {
        rings.iter().map(|ring| area(ring).abs()).sum()
    }

    fn rings(op: BoolOp, a: &Shape, b: &Shape) -> Vec<Vec<Point>> {
        let shapes = combine(&[a.clone(), b.clone()], &[0, 1], op).expect("combine");
        shapes
            .iter()
            .map(|item| match item {
                Shape::Path { nodes, .. } => {
                    nodes.iter().map(|node| clone_point(&node.point)).collect()
                }
                _ => panic!("paths expected"),
            })
            .collect()
    }

    #[test]
    fn union_of_rects_sharing_edges_covers_both() {
        let left = rect(0.0, 0.0, 20.0, 10.0);
        let right = rect(10.0, 0.0, 20.0, 10.0);
        let merged = rings(BoolOp::Union, &left, &right);
        assert_eq!(merged.len(), 1);
        let outer = bounds(&merged);
        assert!(close(outer.0, 0.0) && close(outer.1, 0.0));
        assert!(close(outer.2, 30.0) && close(outer.3, 10.0));
        assert!(close(total(&merged), 300.0));
    }

    #[test]
    fn intersect_keeps_the_overlap_only() {
        let left = rect(0.0, 0.0, 20.0, 10.0);
        let right = rect(10.0, 0.0, 20.0, 10.0);
        let merged = rings(BoolOp::Intersect, &left, &right);
        assert_eq!(merged.len(), 1);
        let outer = bounds(&merged);
        assert!(close(outer.0, 10.0) && close(outer.1, 0.0));
        assert!(close(outer.2, 20.0) && close(outer.3, 10.0));
        assert!(close(total(&merged), 100.0));
    }

    #[test]
    fn subtract_removes_the_overlap() {
        let left = rect(0.0, 0.0, 20.0, 10.0);
        let right = rect(10.0, 0.0, 20.0, 10.0);
        let merged = rings(BoolOp::Subtract, &left, &right);
        assert_eq!(merged.len(), 1);
        let outer = bounds(&merged);
        assert!(close(outer.0, 0.0) && close(outer.1, 0.0));
        assert!(close(outer.2, 10.0) && close(outer.3, 10.0));
        assert!(close(total(&merged), 100.0));
    }

    #[test]
    fn subtract_a_nested_shape_punches_a_hole() {
        let outer = rect(0.0, 0.0, 40.0, 40.0);
        let inner = rect(10.0, 10.0, 10.0, 10.0);
        let merged = rings(BoolOp::Subtract, &outer, &inner);
        assert_eq!(merged.len(), 1);
        assert!(close(total(&merged), 1500.0));
    }

    #[test]
    fn exclude_of_overlapping_rects_keeps_both_arms() {
        let left = rect(0.0, 0.0, 20.0, 10.0);
        let right = rect(10.0, 0.0, 20.0, 10.0);
        let merged = rings(BoolOp::Exclude, &left, &right);
        assert_eq!(merged.len(), 2);
        assert!(close(total(&merged), 200.0));
    }

    #[test]
    fn disjoint_union_returns_both_rings() {
        let left = rect(0.0, 0.0, 10.0, 10.0);
        let right = rect(30.0, 30.0, 10.0, 10.0);
        let merged = rings(BoolOp::Union, &left, &right);
        assert_eq!(merged.len(), 2);
        assert!(close(total(&merged), 200.0));
    }

    #[test]
    fn stacked_rects_union_covers_both() {
        let lower = rect(0.0, 0.0, 20.0, 10.0);
        let upper = rect(0.0, 10.0, 20.0, 10.0);
        let merged = rings(BoolOp::Union, &lower, &upper);
        assert!(close(total(&merged), 400.0));
    }

    #[test]
    fn corner_overlap_union_covers_the_l_shape() {
        let first = rect(0.0, 0.0, 20.0, 20.0);
        let second = rect(10.0, 10.0, 20.0, 20.0);
        let merged = rings(BoolOp::Union, &first, &second);
        assert_eq!(merged.len(), 1);
        assert!(close(total(&merged), 700.0));
    }

    #[test]
    fn transverse_overlap_union_covers_both() {
        let flat = rect(0.0, 0.0, 20.0, 10.0);
        let tall = rect(10.0, -5.0, 20.0, 20.0);
        let merged = rings(BoolOp::Union, &flat, &tall);
        assert_eq!(merged.len(), 1);
        assert!(close(total(&merged), 500.0));
    }

    #[test]
    fn ellipses_combine_into_one_closed_ring() {
        let a = circle(0.0, 0.0, 20.0, 20.0);
        let b = circle(10.0, 0.0, 20.0, 20.0);
        let merged = rings(BoolOp::Union, &a, &b);
        assert_eq!(merged.len(), 1);
        assert!(close(bounds(&merged).0, 0.0));
        assert!(close(bounds(&merged).2, 30.0));
        assert!(area(&merged[0]) > 0.0);
    }

    #[test]
    fn square_inside_a_circle_survives_intersect() {
        let block = rect(10.0, 10.0, 10.0, 10.0);
        let disc = circle(0.0, 0.0, 40.0, 40.0);
        let merged = rings(BoolOp::Intersect, &block, &disc);
        assert_eq!(merged.len(), 1);
        assert!(close(total(&merged), 100.0));
    }

    #[test]
    fn three_shapes_combine_in_order() {
        let shapes = vec![
            rect(0.0, 0.0, 20.0, 10.0),
            rect(10.0, 0.0, 20.0, 10.0),
            rect(25.0, 0.0, 20.0, 10.0),
        ];
        let merged = combine(&shapes, &[0, 1, 2], BoolOp::Union).expect("union");
        let rings_of = merged
            .iter()
            .map(|item| match item {
                Shape::Path { nodes, .. } => nodes.iter().map(|node| node.point.clone()).collect(),
                _ => panic!("paths expected"),
            })
            .collect::<Vec<Vec<Point>>>();
        assert!(close(total(&rings_of), 450.0));
    }

    #[test]
    fn intersect_of_separated_shapes_is_refused() {
        let left = rect(0.0, 0.0, 10.0, 10.0);
        let right = rect(30.0, 30.0, 10.0, 10.0);
        assert_eq!(
            combine(&[left, right], &[0, 1], BoolOp::Intersect).expect_err("no overlap"),
            "the boolean result is empty"
        );
    }

    #[test]
    fn strokes_and_text_are_refused() {
        let line = Shape::Stroke {
            points: vec![spot(0.0, 0.0), spot(10.0, 10.0)],
            color: "#000000".to_string(),
            width: 2.0,
        };
        let block = rect(0.0, 0.0, 10.0, 10.0);
        assert_eq!(
            combine(&[block.clone(), block.clone()], &[0], BoolOp::Union)
                .expect_err("one shape"),
            "select at least two shapes"
        );
        assert_eq!(
            combine(&[line, block], &[0, 1], BoolOp::Union).expect_err("unsupported"),
            "boolean needs closed filled shapes"
        );
    }

    #[test]
    fn results_keep_the_first_shape_style() {
        let a = rect(0.0, 0.0, 20.0, 10.0);
        let b = circle(10.0, 0.0, 20.0, 10.0);
        let shapes = combine(&[a, b], &[0, 1], BoolOp::Union).expect("union");
        let Shape::Path {
            nodes,
            closed,
            fill,
            stroke,
            width,
            ..
        } = &shapes[0]
        else {
            panic!("path expected");
        };
        assert!(nodes.len() > 4);
        assert!(closed);
        assert_eq!(fill, "#ff0000");
        assert_eq!(stroke, "#000000");
        assert_eq!(*width, 2.0);
    }
}
