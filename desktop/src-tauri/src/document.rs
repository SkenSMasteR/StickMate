use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::path::{flatten_path, PathNode};

const HISTORY_LIMIT: usize = 100;
const CHECKPOINT_NAME_LIMIT: usize = 64;
const CHECKPOINT_COUNT_LIMIT: usize = 20;
const CHECKPOINT_SIZE_LIMIT: usize = 8 * 1024 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn new_id(prefix: &str) -> String {
    format!(
        "{}{:x}{:x}",
        prefix,
        now(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

pub(crate) fn locked<T>(_: T) -> String {
    "document store unavailable".to_string()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Shape {
    Stroke {
        points: Vec<Point>,
        color: String,
        width: f64,
    },
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: String,
        stroke: String,
        width: f64,
    },
    Ellipse {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: String,
        stroke: String,
        width: f64,
    },
    Polygon {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        sides: u32,
        fill: String,
        stroke: String,
        width: f64,
    },
    Text {
        x: f64,
        y: f64,
        text: String,
        size: f64,
        family: String,
        color: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        matrix: Option<Affine>,
    },
    Path {
        nodes: Vec<PathNode>,
        closed: bool,
        fill: String,
        stroke: String,
        width: f64,
    },
}

pub const TEXT_ADVANCE: f64 = 0.6;

pub fn text_width(text: &str, size: f64) -> f64 {
    text.chars().count() as f64 * size * TEXT_ADVANCE
}

pub fn polygon_vertices(x: f64, y: f64, w: f64, h: f64, sides: u32) -> Vec<Point> {
    let cx = x + w / 2.0;
    let cy = y + h / 2.0;
    let step = std::f64::consts::TAU / sides as f64;
    (0..sides)
        .map(|index| {
            let angle = -std::f64::consts::FRAC_PI_2 + index as f64 * step;
            Point {
                x: cx + (w / 2.0) * angle.cos(),
                y: cy + (h / 2.0) * angle.sin(),
            }
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Affine {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

pub fn affine_from(pivot: &Point, dx: f64, dy: f64, sx: f64, sy: f64, rotation: f64) -> Affine {
    let angle = rotation * std::f64::consts::PI / 180.0;
    let cos = angle.cos();
    let sin = angle.sin();
    let a = cos * sx;
    let b = sin * sx;
    let c = -sin * sy;
    let d = cos * sy;
    Affine {
        a,
        b,
        c,
        d,
        e: pivot.x - a * pivot.x - c * pivot.y + dx,
        f: pivot.y - b * pivot.x - d * pivot.y + dy,
    }
}

pub fn apply_affine(matrix: &Affine, point: &Point) -> Point {
    Point {
        x: matrix.a * point.x + matrix.c * point.y + matrix.e,
        y: matrix.b * point.x + matrix.d * point.y + matrix.f,
    }
}

fn compose_affine(outer: &Affine, inner: &Affine) -> Affine {
    Affine {
        a: outer.a * inner.a + outer.c * inner.b,
        b: outer.b * inner.a + outer.d * inner.b,
        c: outer.a * inner.c + outer.c * inner.d,
        d: outer.b * inner.c + outer.d * inner.d,
        e: outer.a * inner.e + outer.c * inner.f + outer.e,
        f: outer.b * inner.e + outer.d * inner.f + outer.f,
    }
}

fn text_corners(x: f64, y: f64, text: &str, size: f64, matrix: &Option<Affine>) -> Vec<Point> {
    let w = text_width(text, size);
    [
        Point { x, y },
        Point { x: x + w, y },
        Point { x: x + w, y: y + size },
        Point { x, y: y + size },
    ]
    .into_iter()
    .map(|point| matrix.as_ref().map_or_else(|| point.clone(), |m| apply_affine(m, &point)))
    .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

fn points_bounds(points: &[Point], width: f64) -> Bounds {
    let pad = width / 2.0;
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for point in points {
        min_x = min_x.min(point.x);
        min_y = min_y.min(point.y);
        max_x = max_x.max(point.x);
        max_y = max_y.max(point.y);
    }
    let x = min_x - pad;
    let y = min_y - pad;
    Bounds {
        x,
        y,
        w: max_x + pad - x,
        h: max_y + pad - y,
    }
}

pub fn shape_bounds(shape: &Shape) -> Bounds {
    match shape {
        Shape::Stroke { points, width, .. } => points_bounds(points, *width),
        Shape::Path {
            nodes,
            closed,
            width,
            ..
        } => points_bounds(&flatten_path(nodes, *closed), *width),
        Shape::Text {
            x, y, text, size, matrix, ..
        } => points_bounds(&text_corners(*x, *y, text, *size, matrix), 0.0),
        Shape::Rect { x, y, w, h, .. }
        | Shape::Ellipse { x, y, w, h, .. }
        | Shape::Polygon { x, y, w, h, .. } => Bounds {
            x: *x,
            y: *y,
            w: *w,
            h: *h,
        },
    }
}

fn corners_path(corners: &[Point], matrix: &Affine, fill: &str, stroke: &str, width: f64) -> Shape {
    Shape::Path {
        nodes: corners
            .iter()
            .map(|point| PathNode {
                point: apply_affine(matrix, point),
                handle_in: None,
                handle_out: None,
            })
            .collect(),
        closed: true,
        fill: fill.to_string(),
        stroke: stroke.to_string(),
        width,
    }
}

pub(crate) fn transform_shape(
    shape: &Shape,
    matrix: &Affine,
    sx: f64,
    sy: f64,
    rotation: f64,
) -> Result<Shape, String> {
    match shape {
        Shape::Stroke {
            points,
            color,
            width,
        } => Ok(Shape::Stroke {
            points: points.iter().map(|p| apply_affine(matrix, p)).collect(),
            color: color.clone(),
            width: *width,
        }),
        Shape::Path {
            nodes,
            closed,
            fill,
            stroke,
            width,
        } => Ok(Shape::Path {
            nodes: nodes
                .iter()
                .map(|node| PathNode {
                    point: apply_affine(matrix, &node.point),
                    handle_in: node.handle_in.as_ref().map(|p| apply_affine(matrix, p)),
                    handle_out: node.handle_out.as_ref().map(|p| apply_affine(matrix, p)),
                })
                .collect(),
            closed: *closed,
            fill: fill.clone(),
            stroke: stroke.clone(),
            width: *width,
        }),
        Shape::Text {
            x,
            y,
            text,
            size,
            family,
            color,
            matrix: local,
        } => {
            let simple = local.is_none() && rotation == 0.0 && sx == sy;
            let q = if simple {
                apply_affine(matrix, &Point { x: *x, y: *y })
            } else {
                Point { x: *x, y: *y }
            };
            Ok(Shape::Text {
                x: q.x,
                y: q.y,
                text: text.clone(),
                size: if simple { size * sx } else { *size },
                family: family.clone(),
                color: color.clone(),
                matrix: if simple {
                    None
                } else {
                    Some(local.as_ref().map_or(*matrix, |inner| compose_affine(matrix, inner)))
                },
            })
        }
        Shape::Ellipse {
            x,
            y,
            w,
            h,
            fill,
            stroke,
            width,
        } if rotation != 0.0 => {
            if rotation % 90.0 != 0.0 {
                return Err("ellipse cannot be rotated".to_string());
            }
            let center = apply_affine(
                matrix,
                &Point {
                    x: x + w / 2.0,
                    y: y + h / 2.0,
                },
            );
            let odd = ((rotation / 90.0) as i64).abs() % 2 == 1;
            let nw = if odd { h * sy } else { w * sx };
            let nh = if odd { w * sx } else { h * sy };
            Ok(Shape::Ellipse {
                x: center.x - nw / 2.0,
                y: center.y - nh / 2.0,
                w: nw,
                h: nh,
                fill: fill.clone(),
                stroke: stroke.clone(),
                width: *width,
            })
        }
        Shape::Rect {
            x,
            y,
            w,
            h,
            fill,
            stroke,
            width,
        } if rotation != 0.0 => {
            let corners = [
                Point { x: *x, y: *y },
                Point { x: x + w, y: *y },
                Point { x: x + w, y: y + h },
                Point { x: *x, y: y + h },
            ];
            Ok(corners_path(&corners, matrix, fill, stroke, *width))
        }
        Shape::Polygon {
            x,
            y,
            w,
            h,
            sides,
            fill,
            stroke,
            width,
        } if rotation != 0.0 => {
            let vertices = polygon_vertices(*x, *y, *w, *h, *sides);
            Ok(corners_path(&vertices, matrix, fill, stroke, *width))
        }
        Shape::Rect {
            x,
            y,
            w,
            h,
            fill,
            stroke,
            width,
        } => {
            let q = apply_affine(matrix, &Point { x: *x, y: *y });
            Ok(Shape::Rect {
                x: q.x,
                y: q.y,
                w: w * sx,
                h: h * sy,
                fill: fill.clone(),
                stroke: stroke.clone(),
                width: *width,
            })
        }
        Shape::Ellipse {
            x,
            y,
            w,
            h,
            fill,
            stroke,
            width,
        } => {
            let q = apply_affine(matrix, &Point { x: *x, y: *y });
            Ok(Shape::Ellipse {
                x: q.x,
                y: q.y,
                w: w * sx,
                h: h * sy,
                fill: fill.clone(),
                stroke: stroke.clone(),
                width: *width,
            })
        }
        Shape::Polygon {
            x,
            y,
            w,
            h,
            sides,
            fill,
            stroke,
            width,
        } => {
            let q = apply_affine(matrix, &Point { x: *x, y: *y });
            Ok(Shape::Polygon {
                x: q.x,
                y: q.y,
                w: w * sx,
                h: h * sy,
                sides: *sides,
                fill: fill.clone(),
                stroke: stroke.clone(),
                width: *width,
            })
        }
    }
}

fn within(a: &Point, b: &Point, radius: f64) -> bool {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    dx * dx + dy * dy <= radius * radius
}

fn near_segment(p: &Point, a: &Point, b: &Point, radius: f64) -> bool {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len2 = dx * dx + dy * dy;
    let t = if len2 <= f64::EPSILON {
        0.0
    } else {
        (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).clamp(0.0, 1.0)
    };
    within(
        p,
        &Point {
            x: a.x + dx * t,
            y: a.y + dy * t,
        },
        radius,
    )
}

fn inside_polygon(p: &Point, vertices: &[Point]) -> bool {
    let mut inside = false;
    for index in 0..vertices.len() {
        let a = &vertices[index];
        let b = &vertices[(index + 1) % vertices.len()];
        if (a.y > p.y) != (b.y > p.y) {
            let cross = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
            if p.x < cross {
                inside = !inside;
            }
        }
    }
    inside
}

fn shape_hit(shape: &Shape, p: &Point, radius: f64) -> bool {
    match shape {
        Shape::Stroke { points, width, .. } => {
            let reach = radius + width / 2.0;
            points
                .windows(2)
                .any(|pair| near_segment(p, &pair[0], &pair[1], reach))
                || points
                    .first()
                    .map_or(false, |first| within(p, first, reach))
        }
        Shape::Rect { x, y, w, h, .. } => {
            p.x >= x - radius && p.x <= x + w + radius && p.y >= y - radius && p.y <= y + h + radius
        }
        Shape::Ellipse { x, y, w, h, .. } => {
            let rx = w / 2.0 + radius;
            let ry = h / 2.0 + radius;
            if rx <= 0.0 || ry <= 0.0 {
                return false;
            }
            let dx = (p.x - (x + w / 2.0)) / rx;
            let dy = (p.y - (y + h / 2.0)) / ry;
            dx * dx + dy * dy <= 1.0
        }
        Shape::Polygon {
            x,
            y,
            w,
            h,
            sides,
            ..
        } => {
            let vertices = polygon_vertices(*x, *y, *w, *h, *sides);
            inside_polygon(p, &vertices)
                || vertices.iter().enumerate().any(|(index, a)| {
                    near_segment(p, a, &vertices[(index + 1) % vertices.len()], radius)
                })
        }
        Shape::Text {
            x, y, text, size, matrix, ..
        } => {
            let vertices = text_corners(*x, *y, text, *size, matrix);
            inside_polygon(p, &vertices)
                || vertices.iter().enumerate().any(|(index, a)| {
                    near_segment(p, a, &vertices[(index + 1) % vertices.len()], radius)
                })
        }
        Shape::Path {
            nodes,
            closed,
            width,
            ..
        } => {
            let reach = radius + width / 2.0;
            let outline = flatten_path(nodes, *closed);
            outline
                .windows(2)
                .any(|pair| near_segment(p, &pair[0], &pair[1], reach))
                || outline
                    .first()
                    .map_or(false, |first| within(p, first, reach))
                || (*closed && inside_polygon(p, &outline))
        }
    }
}

fn densify(path: &[Point], spacing: f64) -> Vec<Point> {
    let mut out = Vec::new();
    for (index, point) in path.iter().enumerate() {
        out.push(point.clone());
        let Some(next) = path.get(index + 1) else {
            continue;
        };
        let distance = ((next.x - point.x).powi(2) + (next.y - point.y).powi(2)).sqrt();
        let steps = (distance / spacing).ceil() as usize;
        for step in 1..steps {
            if out.len() >= 20_000 {
                return out;
            }
            let t = step as f64 / steps as f64;
            out.push(Point {
                x: point.x + (next.x - point.x) * t,
                y: point.y + (next.y - point.y) * t,
            });
        }
    }
    out
}

pub(crate) fn validate(shape: &Shape) -> Result<(), String> {
    match shape {
        Shape::Polygon { sides, .. } if *sides < 3 => {
            Err("polygon needs at least 3 sides".to_string())
        }
        Shape::Text { x, y, text, size, matrix, .. } => {
            if text.trim().is_empty() {
                return Err("text is empty".to_string());
            }
            if !size.is_finite() || *size <= 0.0 {
                return Err("text size must be positive".to_string());
            }
            if !x.is_finite() || !y.is_finite() {
                return Err("text coordinates must be finite".to_string());
            }
            if let Some(m) = matrix {
                if [m.a, m.b, m.c, m.d, m.e, m.f].iter().any(|value| !value.is_finite()) {
                    return Err("text matrix must be finite".to_string());
                }
            }
            Ok(())
        }
        Shape::Path {
            nodes,
            closed,
            width,
            ..
        } => {
            if *closed && nodes.len() < 3 {
                return Err("closed path needs at least 3 nodes".to_string());
            }
            if nodes.len() < 2 {
                return Err("path needs at least 2 nodes".to_string());
            }
            for node in nodes {
                for point in [&node.point]
                    .into_iter()
                    .chain(node.handle_in.as_ref())
                    .chain(node.handle_out.as_ref())
                {
                    if !point.x.is_finite() || !point.y.is_finite() {
                        return Err("path coordinates must be finite".to_string());
                    }
                }
            }
            if !(0.5..=200.0).contains(width) {
                return Err("width must be between 0.5 and 200".to_string());
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
    pub scale: f64,
    pub opacity: f64,
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            opacity: 1.0,
        }
    }
}

impl Transform {
    fn lerp(self, other: Transform, t: f64) -> Transform {
        Transform {
            x: self.x + (other.x - self.x) * t,
            y: self.y + (other.y - self.y) * t,
            rotation: self.rotation + (other.rotation - self.rotation) * t,
            scale: self.scale + (other.scale - self.scale) * t,
            opacity: self.opacity + (other.opacity - self.opacity) * t,
        }
    }

    fn sanitized(self) -> Transform {
        Transform {
            x: self.x,
            y: self.y,
            rotation: self.rotation,
            scale: if self.scale <= 0.0 { 0.01 } else { self.scale },
            opacity: self.opacity.clamp(0.0, 1.0),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Keyframe {
    pub frame: u32,
    pub shapes: Vec<Shape>,
    pub transform: Transform,
    pub tween: bool,
    pub label: Option<String>,
}

impl Keyframe {
    fn empty(frame: u32) -> Self {
        Self {
            frame,
            shapes: Vec::new(),
            transform: Transform::default(),
            tween: false,
            label: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Layer {
    pub id: String,
    pub name: String,
    pub visible: bool,
    pub locked: bool,
    pub opacity: f64,
    pub length: u32,
    pub keys: Vec<Keyframe>,
}

impl Layer {
    fn new(name: String) -> Self {
        Self {
            id: new_id("l"),
            name,
            visible: true,
            locked: false,
            opacity: 1.0,
            length: 1,
            keys: vec![Keyframe::empty(0)],
        }
    }

    pub(crate) fn key_index(&self, frame: u32) -> Option<usize> {
        self.keys.iter().position(|k| k.frame == frame)
    }

    pub(crate) fn held_index(&self, frame: u32) -> Option<usize> {
        self.keys.iter().rposition(|k| k.frame <= frame)
    }

    pub(crate) fn key_at(&mut self, frame: u32) -> usize {
        if let Some(index) = self.key_index(frame) {
            return index;
        }
        let key = match self.held_index(frame) {
            Some(index) => Keyframe {
                frame,
                shapes: self.keys[index].shapes.clone(),
                transform: self.keys[index].transform,
                tween: false,
                label: None,
            },
            None => Keyframe::empty(frame),
        };
        let index = self.keys.iter().filter(|k| k.frame < frame).count();
        self.keys.insert(index, key);
        self.length = self.length.max(frame + 1);
        index
    }

    pub(crate) fn writable(&self) -> Result<(), String> {
        if self.locked {
            Err("layer is locked".to_string())
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub layers: Vec<Layer>,
}

impl Scene {
    fn new(name: String) -> Self {
        Self {
            id: new_id("s"),
            name,
            layers: vec![Layer::new("Layer 1".to_string())],
        }
    }

    #[cfg(test)]
    pub fn length(&self) -> u32 {
        self.layers
            .iter()
            .map(|layer| layer.length)
            .max()
            .unwrap_or(1)
            .max(1)
    }

    pub(crate) fn layer_index(&self, layer_id: &str) -> Result<usize, String> {
        self.layers
            .iter()
            .position(|layer| layer.id == layer_id)
            .ok_or_else(|| "unknown layer".to_string())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub background: String,
    pub scenes: Vec<Scene>,
}

impl Document {
    pub(crate) fn scene_index(&self, scene_id: &str) -> Result<usize, String> {
        self.scenes
            .iter()
            .position(|scene| scene.id == scene_id)
            .ok_or_else(|| "unknown scene".to_string())
    }

    pub(crate) fn layer_mut(
        &mut self,
        scene_id: &str,
        layer_id: &str,
    ) -> Result<&mut Layer, String> {
        let scene = self
            .scenes
            .iter_mut()
            .find(|scene| scene.id == scene_id)
            .ok_or_else(|| "unknown scene".to_string())?;
        let index = scene.layer_index(layer_id)?;
        Ok(&mut scene.layers[index])
    }

    pub fn evaluate(&self, scene_id: &str, frame: u32) -> Result<EvalFrame, String> {
        let index = self.scene_index(scene_id)?;
        Ok(EvalFrame {
            frame,
            layers: self.scenes[index]
                .layers
                .iter()
                .filter_map(|layer| evaluate_layer(layer, frame))
                .collect(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EvalLayer {
    pub id: String,
    pub opacity: f64,
    pub transform: Transform,
    pub shapes: Vec<Shape>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EvalFrame {
    pub frame: u32,
    pub layers: Vec<EvalLayer>,
}

fn mix(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn mix_point(a: &Point, b: &Point, t: f64) -> Point {
    Point {
        x: mix(a.x, b.x, t),
        y: mix(a.y, b.y, t),
    }
}

fn mix_bytes(value: &str) -> Option<[u8; 3]> {
    let hex = value.strip_prefix('#')?;
    let digits: Vec<u8> = hex
        .chars()
        .filter_map(|c| c.to_digit(16).map(|d| d as u8))
        .collect();
    match digits.len() {
        3 if digits.len() == hex.len() => Some([digits[0] * 17, digits[1] * 17, digits[2] * 17]),
        6 if digits.len() == hex.len() => Some([
            digits[0] * 16 + digits[1],
            digits[2] * 16 + digits[3],
            digits[4] * 16 + digits[5],
        ]),
        _ => None,
    }
}

fn mix_color(a: &str, b: &str, t: f64) -> String {
    match (mix_bytes(a), mix_bytes(b)) {
        (Some(x), Some(y)) => {
            let channel = |index: usize| {
                (mix(x[index] as f64, y[index] as f64, t) + 0.5).floor() as u8
            };
            format!("#{:02x}{:02x}{:02x}", channel(0), channel(1), channel(2))
        }
        _ => a.to_string(),
    }
}

fn mix_handle(
    a: &Option<Point>,
    b: &Option<Point>,
    a_point: &Point,
    b_point: &Point,
    t: f64,
) -> Option<Point> {
    if a.is_none() && b.is_none() {
        return None;
    }
    Some(mix_point(
        a.as_ref().unwrap_or(a_point),
        b.as_ref().unwrap_or(b_point),
        t,
    ))
}

fn mix_affine(a: &Affine, b: &Affine, t: f64) -> Affine {
    Affine {
        a: mix(a.a, b.a, t),
        b: mix(a.b, b.b, t),
        c: mix(a.c, b.c, t),
        d: mix(a.d, b.d, t),
        e: mix(a.e, b.e, t),
        f: mix(a.f, b.f, t),
    }
}

fn mix_shape(a: &Shape, b: &Shape, t: f64) -> Shape {
    if t <= 0.0 {
        return a.clone();
    }
    if t >= 1.0 {
        return b.clone();
    }
    match (a, b) {
        (
            Shape::Rect {
                x,
                y,
                w,
                h,
                fill,
                stroke,
                width,
            },
            Shape::Rect {
                x: bx,
                y: by,
                w: bw,
                h: bh,
                fill: bf,
                stroke: bs,
                width: bwidth,
            },
        ) => Shape::Rect {
            x: mix(*x, *bx, t),
            y: mix(*y, *by, t),
            w: mix(*w, *bw, t),
            h: mix(*h, *bh, t),
            fill: mix_color(fill, bf, t),
            stroke: mix_color(stroke, bs, t),
            width: mix(*width, *bwidth, t),
        },
        (
            Shape::Ellipse {
                x,
                y,
                w,
                h,
                fill,
                stroke,
                width,
            },
            Shape::Ellipse {
                x: bx,
                y: by,
                w: bw,
                h: bh,
                fill: bf,
                stroke: bs,
                width: bwidth,
            },
        ) => Shape::Ellipse {
            x: mix(*x, *bx, t),
            y: mix(*y, *by, t),
            w: mix(*w, *bw, t),
            h: mix(*h, *bh, t),
            fill: mix_color(fill, bf, t),
            stroke: mix_color(stroke, bs, t),
            width: mix(*width, *bwidth, t),
        },
        (
            Shape::Polygon {
                sides,
                x,
                y,
                w,
                h,
                fill,
                stroke,
                width,
            },
            Shape::Polygon {
                sides: bsides,
                x: bx,
                y: by,
                w: bw,
                h: bh,
                fill: bf,
                stroke: bs,
                width: bwidth,
            },
        ) if sides == bsides => Shape::Polygon {
            sides: *sides,
            x: mix(*x, *bx, t),
            y: mix(*y, *by, t),
            w: mix(*w, *bw, t),
            h: mix(*h, *bh, t),
            fill: mix_color(fill, bf, t),
            stroke: mix_color(stroke, bs, t),
            width: mix(*width, *bwidth, t),
        },
        (
            Shape::Stroke {
                points,
                color,
                width,
            },
            Shape::Stroke {
                points: bpoints,
                color: bcolor,
                width: bwidth,
            },
        ) if points.len() == bpoints.len() && points.len() > 1 => Shape::Stroke {
            points: points
                .iter()
                .zip(bpoints)
                .map(|(left, right)| mix_point(left, right, t))
                .collect(),
            color: mix_color(color, bcolor, t),
            width: mix(*width, *bwidth, t),
        },
        (
            Shape::Path {
                nodes,
                closed,
                fill,
                stroke,
                width,
            },
            Shape::Path {
                nodes: bnodes,
                closed: bclosed,
                fill: bf,
                stroke: bs,
                width: bwidth,
            },
        ) if closed == bclosed && nodes.len() == bnodes.len() && nodes.len() > 1 => Shape::Path {
            nodes: nodes
                .iter()
                .zip(bnodes)
                .map(|(left, right)| PathNode {
                    point: mix_point(&left.point, &right.point, t),
                    handle_in: mix_handle(
                        &left.handle_in,
                        &right.handle_in,
                        &left.point,
                        &right.point,
                        t,
                    ),
                    handle_out: mix_handle(
                        &left.handle_out,
                        &right.handle_out,
                        &left.point,
                        &right.point,
                        t,
                    ),
                })
                .collect(),
            closed: *closed,
            fill: mix_color(fill, bf, t),
            stroke: mix_color(stroke, bs, t),
            width: mix(*width, *bwidth, t),
        },
        (
            Shape::Text {
                x,
                y,
                text,
                size,
                family,
                color,
                matrix,
            },
            Shape::Text {
                x: bx,
                y: by,
                text: _,
                size: bsize,
                family: _,
                color: bcolor,
                matrix: bmatrix,
            },
        ) => Shape::Text {
            x: mix(*x, *bx, t),
            y: mix(*y, *by, t),
            text: text.clone(),
            size: mix(*size, *bsize, t),
            family: family.clone(),
            color: mix_color(color, bcolor, t),
            matrix: match (matrix, bmatrix) {
                (Some(left), Some(right)) => Some(mix_affine(left, right, t)),
                (Some(left), None) | (None, Some(left)) => Some(left.clone()),
                (None, None) => None,
            },
        },
        _ => a.clone(),
    }
}

pub fn evaluate_layer(layer: &Layer, frame: u32) -> Option<EvalLayer> {
    if !layer.visible || frame >= layer.length {
        return None;
    }
    let index = layer.held_index(frame)?;
    let key = &layer.keys[index];
    let mut transform = key.transform;
    let mut shapes = key.shapes.clone();
    if key.tween {
        if let Some(next) = layer.keys.get(index + 1) {
            let span = next.frame.saturating_sub(key.frame);
            if span > 0 {
                let t = ((frame - key.frame) as f64 / span as f64).clamp(0.0, 1.0);
                transform = transform.lerp(next.transform, t);
                shapes = shapes
                    .iter()
                    .enumerate()
                    .map(|(position, shape)| match next.shapes.get(position) {
                        Some(other) => mix_shape(shape, other, t),
                        None => shape.clone(),
                    })
                    .collect();
            }
        }
    }
    Some(EvalLayer {
        id: layer.id.clone(),
        opacity: (layer.opacity * transform.opacity).clamp(0.0, 1.0),
        transform,
        shapes,
    })
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize)]
struct RecoveryFile {
    document: Document,
    updated_at: u64,
}

#[derive(Clone)]
struct HistoryEntry {
    doc: Document,
    name: String,
    at: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct HistoryStep {
    pub index: usize,
    pub name: String,
    pub at: u64,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CheckpointInfo {
    pub id: String,
    pub name: String,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize)]
struct CheckpointFile {
    id: String,
    name: String,
    created_at: u64,
    document: Document,
}

struct DocState {
    doc: Document,
    undo: Vec<HistoryEntry>,
    redo: Vec<HistoryEntry>,
    current_name: String,
    current_at: u64,
    updated_at: u64,
}

pub struct DocStore {
    dir: PathBuf,
    docs: Mutex<HashMap<String, DocState>>,
    problems: Mutex<Vec<String>>,
}

impl DocStore {
    pub fn load(dir: PathBuf) -> Self {
        let store = Self {
            dir,
            docs: Mutex::new(HashMap::new()),
            problems: Mutex::new(Vec::new()),
        };
        if let Err(error) = fs::create_dir_all(&store.dir) {
            store.report(format!("recovery folder unavailable: {error}"));
            return store;
        }
        let entries = match fs::read_dir(&store.dir) {
            Ok(entries) => entries,
            Err(error) => {
                store.report(format!("recovery folder unreadable: {error}"));
                return store;
            }
        };
        let mut docs = HashMap::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            match read_recovery(&path) {
                Ok(file) => {
                    docs.insert(
                        file.document.id.clone(),
                        DocState {
                            doc: file.document,
                            undo: Vec::new(),
                            redo: Vec::new(),
                            current_name: "recovered_document".to_string(),
                            current_at: file.updated_at,
                            updated_at: file.updated_at,
                        },
                    );
                }
                Err(error) => {
                    let name = path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("recovery file")
                        .to_string();
                    match fs::rename(&path, path.with_extension("invalid")) {
                        Ok(()) => store.report(format!(
                            "{name} could not be read and was kept as {name}.invalid: {error}"
                        )),
                        Err(_) => store.report(format!("{name} could not be read: {error}")),
                    }
                }
            }
        }
        *store.docs.lock().expect("document store") = docs;
        store
    }

    fn report(&self, message: String) {
        self.problems.lock().expect("recovery report").push(message);
    }

    fn write(&self, state: &DocState) -> Result<(), String> {
        let bytes = serde_json::to_vec(&RecoveryFile {
            document: state.doc.clone(),
            updated_at: state.updated_at,
        })
        .map_err(|error| error.to_string())?;
        write_atomic(&self.dir.join(format!("{}.json", state.doc.id)), &bytes)
    }

    pub(crate) fn edit<F>(&self, id: &str, change: F) -> Result<Document, String>
    where
        F: FnOnce(&mut Document) -> Result<(), String>,
    {
        self.edit_named(id, "apply_template", change)
    }

    pub(crate) fn edit_named<F>(&self, id: &str, name: &str, change: F) -> Result<Document, String>
    where
        F: FnOnce(&mut Document) -> Result<(), String>,
    {
        let mut docs = self.docs.lock().map_err(locked)?;
        let state = docs.get_mut(id).ok_or_else(|| "unknown document".to_string())?;
        let before = state.doc.clone();
        let mut next = before.clone();
        change(&mut next)?;
        if next == before {
            return Ok(before);
        }
        let at = now();
        self.write(&DocState {
            doc: next.clone(),
            undo: Vec::new(),
            redo: Vec::new(),
            current_name: name.to_string(),
            current_at: at,
            updated_at: at,
        })?;
        state.doc = next;
        state.undo.push(HistoryEntry {
            doc: before,
            name: state.current_name.clone(),
            at: state.current_at,
        });
        if state.undo.len() > HISTORY_LIMIT {
            state.undo.remove(0);
        }
        state.redo.clear();
        state.current_name = name.to_string();
        state.current_at = at;
        state.updated_at = at;
        Ok(state.doc.clone())
    }

    pub fn create(
        &self,
        name: String,
        width: u32,
        height: u32,
        fps: u32,
        background: String,
    ) -> Result<Document, String> {
        if width == 0 || height == 0 || width > 8192 || height > 8192 {
            return Err("resolution must be between 1 and 8192".to_string());
        }
        if fps == 0 || fps > 60 {
            return Err("frame rate must be between 1 and 60".to_string());
        }
        let doc = Document {
            id: new_id("d"),
            name: clean_name(&name).unwrap_or_else(|| "Untitled".to_string()),
            width,
            height,
            fps,
            background,
            scenes: vec![Scene::new("Scene 1".to_string())],
        };
        let state = DocState {
            doc: doc.clone(),
            undo: Vec::new(),
            redo: Vec::new(),
            current_name: "new_document".to_string(),
            current_at: now(),
            updated_at: now(),
        };
        self.write(&state)?;
        self.docs
            .lock()
            .map_err(locked)?
            .insert(doc.id.clone(), state);
        Ok(doc)
    }

    pub fn list(&self) -> Result<Vec<ProjectSummary>, String> {
        let docs = self.docs.lock().map_err(locked)?;
        let mut list: Vec<ProjectSummary> = docs
            .values()
            .map(|state| ProjectSummary {
                id: state.doc.id.clone(),
                name: state.doc.name.clone(),
                width: state.doc.width,
                height: state.doc.height,
                fps: state.doc.fps,
                updated_at: state.updated_at,
            })
            .collect();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(list)
    }

    pub fn take_problems(&self) -> Result<Vec<String>, String> {
        Ok(self.problems.lock().map_err(locked)?.drain(..).collect())
    }

    pub fn get(&self, id: &str) -> Result<Document, String> {
        let mut docs = self.docs.lock().map_err(locked)?;
        let state = docs.get_mut(id).ok_or_else(|| "unknown document".to_string())?;
        state.updated_at = now();
        self.write(state)?;
        Ok(state.doc.clone())
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        self.docs.lock().map_err(locked)?.remove(id);
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.docs.lock().map_err(locked)?.remove(id);
        let path = self.dir.join(format!("{id}.json"));
        if path.exists() {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        if let Ok(dir) = self.checkpoint_dir(id) {
            if dir.exists() {
                let _ = fs::remove_dir_all(&dir);
            }
        }
        Ok(())
    }

    pub fn rename(&self, id: &str, name: String) -> Result<Document, String> {
        let name = clean_name(&name).ok_or_else(|| "name is empty".to_string())?;
        self.edit_named(id, "rename_project", |doc| {
            doc.name = name.clone();
            Ok(())
        })
    }

    pub fn add_scene(&self, id: &str, name: String) -> Result<Document, String> {
        self.edit_named(id, "add_scene", |doc| {
            let fallback = format!("Scene {}", doc.scenes.len() + 1);
            let name = clean_name(&name).unwrap_or(fallback);
            doc.scenes.push(Scene::new(name));
            Ok(())
        })
    }

    pub fn rename_scene(
        &self,
        id: &str,
        scene_id: &str,
        name: String,
    ) -> Result<Document, String> {
        let name = clean_name(&name).ok_or_else(|| "name is empty".to_string())?;
        self.edit_named(id, "rename_scene", |doc| {
            let index = doc.scene_index(scene_id)?;
            doc.scenes[index].name = name.clone();
            Ok(())
        })
    }

    pub fn remove_scene(&self, id: &str, scene_id: &str) -> Result<Document, String> {
        self.edit_named(id, "remove_scene", |doc| {
            if doc.scenes.len() < 2 {
                return Err("a document needs at least one scene".to_string());
            }
            let index = doc.scene_index(scene_id)?;
            doc.scenes.remove(index);
            Ok(())
        })
    }

    pub fn duplicate_scene(&self, id: &str, scene_id: &str) -> Result<Document, String> {
        self.edit_named(id, "duplicate_scene", |doc| {
            let index = doc.scene_index(scene_id)?;
            let mut copy = doc.scenes[index].clone();
            copy.id = new_id("s");
            copy.name = format!("{} copy", copy.name);
            for layer in &mut copy.layers {
                layer.id = new_id("l");
            }
            doc.scenes.insert(index + 1, copy);
            Ok(())
        })
    }

    pub fn move_scene(
        &self,
        id: &str,
        scene_id: &str,
        index: usize,
    ) -> Result<Document, String> {
        self.edit_named(id, "move_scene", |doc| {
            let from = doc.scene_index(scene_id)?;
            let scene = doc.scenes.remove(from);
            let to = index.min(doc.scenes.len());
            doc.scenes.insert(to, scene);
            Ok(())
        })
    }

    pub fn add_layer(
        &self,
        id: &str,
        scene_id: &str,
        name: String,
    ) -> Result<Document, String> {
        self.edit_named(id, "add_layer", |doc| {
            let index = doc.scene_index(scene_id)?;
            let scene = &mut doc.scenes[index];
            let fallback = format!("Layer {}", scene.layers.len() + 1);
            scene
                .layers
                .insert(0, Layer::new(clean_name(&name).unwrap_or(fallback)));
            Ok(())
        })
    }

    pub fn set_layer(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        name: Option<String>,
        visible: Option<bool>,
        locked: Option<bool>,
        opacity: Option<f64>,
    ) -> Result<Document, String> {
        let name = match name {
            Some(value) => Some(clean_name(&value).ok_or_else(|| "name is empty".to_string())?),
            None => None,
        };
        let step = if name.is_some() {
            "rename_layer"
        } else if visible.is_some() {
            "layer_visibility"
        } else if locked.is_some() {
            "layer_lock"
        } else {
            "layer_opacity"
        };
        self.edit_named(id, step, |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            if let Some(name) = &name {
                layer.name = name.clone();
            }
            if let Some(visible) = visible {
                layer.visible = visible;
            }
            if let Some(locked) = locked {
                layer.locked = locked;
            }
            if let Some(opacity) = opacity {
                layer.opacity = opacity.clamp(0.0, 1.0);
            }
            Ok(())
        })
    }

    pub fn remove_layer(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
    ) -> Result<Document, String> {
        self.edit_named(id, "remove_layer", |doc| {
            let index = doc.scene_index(scene_id)?;
            let scene = &mut doc.scenes[index];
            if scene.layers.len() < 2 {
                return Err("a scene needs at least one layer".to_string());
            }
            let layer = scene.layer_index(layer_id)?;
            scene.layers.remove(layer);
            Ok(())
        })
    }

    pub fn move_layer(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        index: usize,
    ) -> Result<Document, String> {
        self.edit_named(id, "move_layer", |doc| {
            let scene_index = doc.scene_index(scene_id)?;
            let scene = &mut doc.scenes[scene_index];
            let from = scene.layer_index(layer_id)?;
            let layer = scene.layers.remove(from);
            let to = index.min(scene.layers.len());
            scene.layers.insert(to, layer);
            Ok(())
        })
    }

    pub fn insert_frame(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
    ) -> Result<Document, String> {
        self.edit_named(id, "insert_frame", |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let at = frame.min(layer.length);
            for key in &mut layer.keys {
                if key.frame > at {
                    key.frame += 1;
                }
            }
            layer.length += 1;
            Ok(())
        })
    }

    pub fn keyframe(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        blank: bool,
    ) -> Result<Document, String> {
        let step = if blank { "blank_keyframe" } else { "add_keyframe" };
        self.edit_named(id, step, |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let index = layer.key_at(frame);
            if blank {
                let key = &mut layer.keys[index];
                key.shapes.clear();
                key.transform = Transform::default();
                key.tween = false;
            }
            Ok(())
        })
    }

    pub fn remove_frame(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
    ) -> Result<Document, String> {
        self.edit_named(id, "remove_frame", |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            if let Some(index) = layer.key_index(frame) {
                layer.keys.remove(index);
            }
            for key in &mut layer.keys {
                if key.frame > frame {
                    key.frame -= 1;
                }
            }
            layer.length = layer.length.saturating_sub(1).max(1);
            if layer.keys.is_empty() {
                layer.keys.push(Keyframe::empty(0));
            }
            Ok(())
        })
    }

    pub fn set_tween(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        tween: bool,
    ) -> Result<Document, String> {
        let step = if tween { "add_tween" } else { "remove_tween" };
        self.edit_named(id, step, |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let index = layer.key_at(frame);
            layer.keys[index].tween = tween;
            Ok(())
        })
    }

    pub fn set_label(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        label: Option<String>,
    ) -> Result<Document, String> {
        let label = label.and_then(|value| clean_name(&value));
        let step = if label.is_some() { "set_label" } else { "clear_label" };
        self.edit_named(id, step, |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let index = layer.key_at(frame);
            layer.keys[index].label = label.clone();
            Ok(())
        })
    }

    pub fn draw(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        shape: Shape,
    ) -> Result<Document, String> {
        validate(&shape)?;
        let step = match &shape {
            Shape::Stroke { .. } => "draw_stroke",
            Shape::Rect { .. } => "draw_rect",
            Shape::Ellipse { .. } => "draw_ellipse",
            Shape::Polygon { .. } => "draw_polygon",
            Shape::Text { .. } => "draw_text",
            Shape::Path { .. } => "draw_path",
        };
        self.edit_named(id, step, |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let index = layer.key_at(frame);
            layer.keys[index].shapes.push(shape);
            Ok(())
        })
    }

    pub fn erase(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        path: Vec<Point>,
        radius: f64,
    ) -> Result<Document, String> {
        if path.is_empty() {
            return Err("eraser path is empty".to_string());
        }
        if path.len() > 5_000 {
            return Err("eraser path is too long".to_string());
        }
        if radius < 0.5 {
            return Err("eraser size is too small".to_string());
        }
        let samples = densify(&path, radius / 2.0);
        self.edit_named(id, "erase", |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let index = layer.key_at(frame);
            let key = &mut layer.keys[index];
            let mut kept: Vec<Shape> = Vec::new();
            for shape in key.shapes.drain(..) {
                match shape {
                    Shape::Stroke {
                        points,
                        color,
                        width,
                    } => {
                        let reach = radius + width / 2.0;
                        let mut run: Vec<Point> = Vec::new();
                        for point in points {
                            if samples.iter().any(|sample| within(&point, sample, reach)) {
                                if run.len() > 1 {
                                    kept.push(Shape::Stroke {
                                        points: run.clone(),
                                        color: color.clone(),
                                        width,
                                    });
                                }
                                run.clear();
                            } else {
                                run.push(point);
                            }
                        }
                        if run.len() > 1 {
                            kept.push(Shape::Stroke {
                                points: run,
                                color,
                                width,
                            });
                        }
                    }
                    other => {
                        if !samples.iter().any(|sample| shape_hit(&other, sample, radius)) {
                            kept.push(other);
                        }
                    }
                }
            }
            key.shapes = kept;
            Ok(())
        })
    }

    pub fn paint_shape(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        index: usize,
        color: String,
    ) -> Result<Document, String> {
        self.edit_named(id, "paint_shape", |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let key_index = layer.key_at(frame);
            let key = &mut layer.keys[key_index];
            let shape = key
                .shapes
                .get_mut(index)
                .ok_or_else(|| "unknown shape".to_string())?;
            match shape {
                Shape::Stroke { color: target, .. } | Shape::Text { color: target, .. } => {
                    *target = color;
                }
                Shape::Rect { fill, .. }
                | Shape::Ellipse { fill, .. }
                | Shape::Polygon { fill, .. }
                | Shape::Path { fill, .. } => {
                    *fill = color;
                }
            }
            Ok(())
        })
    }

    pub fn delete_shape(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        index: usize,
    ) -> Result<Document, String> {
        self.edit_named(id, "delete_shape", |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let key_index = layer.key_at(frame);
            let key = &mut layer.keys[key_index];
            if index >= key.shapes.len() {
                return Err("unknown shape".to_string());
            }
            key.shapes.remove(index);
            Ok(())
        })
    }

    pub fn transform_shapes(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        indices: Vec<usize>,
        pivot: Point,
        dx: f64,
        dy: f64,
        sx: f64,
        sy: f64,
        rotation: f64,
    ) -> Result<Document, String> {
        if indices.is_empty() {
            return Err("no shapes selected".to_string());
        }
        if !sx.is_finite() || sx <= 0.0 || !sy.is_finite() || sy <= 0.0 {
            return Err("scale must be positive".to_string());
        }
        if !dx.is_finite()
            || !dy.is_finite()
            || !rotation.is_finite()
            || !pivot.x.is_finite()
            || !pivot.y.is_finite()
        {
            return Err("transform values must be finite".to_string());
        }
        let matrix = affine_from(&pivot, dx, dy, sx, sy, rotation);
        let step = if rotation != 0.0 {
            "rotate_shapes"
        } else if sx != 1.0 || sy != 1.0 {
            "scale_shapes"
        } else {
            "move_shapes"
        };
        self.edit_named(id, step, |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let source = layer
                .held_index(frame)
                .map(|index| layer.keys[index].shapes.clone())
                .unwrap_or_default();
            let mut updated = Vec::new();
            for &shape_index in &indices {
                let shape = source
                    .get(shape_index)
                    .ok_or_else(|| "unknown shape".to_string())?;
                let next = transform_shape(shape, &matrix, sx, sy, rotation)?;
                validate(&next)?;
                updated.push((shape_index, next));
            }
            let index = layer.key_at(frame);
            let key = &mut layer.keys[index];
            for (shape_index, next) in updated {
                key.shapes[shape_index] = next;
            }
            Ok(())
        })
    }

    pub fn reorder_shapes(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        indices: Vec<usize>,
        to_front: bool,
    ) -> Result<Document, String> {
        if indices.is_empty() {
            return Err("no shapes selected".to_string());
        }
        let mut sorted = indices;
        sorted.sort_unstable();
        sorted.dedup();
        let step = if to_front { "bring_to_front" } else { "send_to_back" };
        self.edit_named(id, step, |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let len = layer
                .held_index(frame)
                .map(|index| layer.keys[index].shapes.len())
                .unwrap_or(0);
            for &shape_index in &sorted {
                if shape_index >= len {
                    return Err("unknown shape".to_string());
                }
            }
            let index = layer.key_at(frame);
            let key = &mut layer.keys[index];
            let mut moved = Vec::new();
            for &shape_index in sorted.iter().rev() {
                moved.push(key.shapes.remove(shape_index));
            }
            moved.reverse();
            if to_front {
                key.shapes.extend(moved);
            } else {
                key.shapes.splice(0..0, moved);
            }
            Ok(())
        })
    }

    pub fn delete_shapes(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        indices: Vec<usize>,
    ) -> Result<Document, String> {
        if indices.is_empty() {
            return Err("no shapes selected".to_string());
        }
        let mut sorted = indices;
        sorted.sort_unstable();
        sorted.dedup();
        self.edit_named(id, "delete_shapes", |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let len = layer
                .held_index(frame)
                .map(|index| layer.keys[index].shapes.len())
                .unwrap_or(0);
            for &shape_index in &sorted {
                if shape_index >= len {
                    return Err("unknown shape".to_string());
                }
            }
            let index = layer.key_at(frame);
            let key = &mut layer.keys[index];
            for &shape_index in sorted.iter().rev() {
                key.shapes.remove(shape_index);
            }
            Ok(())
        })
    }

    pub fn set_transform(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        transform: Transform,
    ) -> Result<Document, String> {
        self.edit_named(id, "set_transform", |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let index = layer.key_at(frame);
            layer.keys[index].transform = transform.sanitized();
            Ok(())
        })
    }

    pub fn replace_shape(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        index: usize,
        shape: Shape,
    ) -> Result<Document, String> {
        validate(&shape)?;
        self.edit_named(id, "replace_shape", |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let key_index = layer.key_at(frame);
            let key = &mut layer.keys[key_index];
            if index >= key.shapes.len() {
                return Err("unknown shape".to_string());
            }
            key.shapes[index] = shape;
            Ok(())
        })
    }

    pub fn undo(&self, id: &str) -> Result<Document, String> {
        let mut docs = self.docs.lock().map_err(locked)?;
        let state = docs.get_mut(id).ok_or_else(|| "unknown document".to_string())?;
        let previous = state.undo.pop().ok_or_else(|| "nothing to undo".to_string())?;
        state.redo.push(HistoryEntry {
            doc: state.doc.clone(),
            name: state.current_name.clone(),
            at: state.current_at,
        });
        state.doc = previous.doc;
        state.current_name = previous.name;
        state.current_at = previous.at;
        state.updated_at = now();
        self.write(state)?;
        Ok(state.doc.clone())
    }

    pub fn redo(&self, id: &str) -> Result<Document, String> {
        let mut docs = self.docs.lock().map_err(locked)?;
        let state = docs.get_mut(id).ok_or_else(|| "unknown document".to_string())?;
        let next = state.redo.pop().ok_or_else(|| "nothing to redo".to_string())?;
        state.undo.push(HistoryEntry {
            doc: state.doc.clone(),
            name: state.current_name.clone(),
            at: state.current_at,
        });
        state.doc = next.doc;
        state.current_name = next.name;
        state.current_at = next.at;
        state.updated_at = now();
        self.write(state)?;
        Ok(state.doc.clone())
    }

    pub fn history(&self, id: &str) -> Result<Vec<HistoryStep>, String> {
        let docs = self.docs.lock().map_err(locked)?;
        let state = docs.get(id).ok_or_else(|| "unknown document".to_string())?;
        let mut steps = Vec::new();
        for entry in &state.undo {
            steps.push(HistoryStep {
                index: steps.len(),
                name: entry.name.clone(),
                at: entry.at,
                kind: "undo".to_string(),
            });
        }
        steps.push(HistoryStep {
            index: steps.len(),
            name: state.current_name.clone(),
            at: state.current_at,
            kind: "current".to_string(),
        });
        for entry in state.redo.iter().rev() {
            steps.push(HistoryStep {
                index: steps.len(),
                name: entry.name.clone(),
                at: entry.at,
                kind: "redo".to_string(),
            });
        }
        Ok(steps)
    }

    pub fn jump(&self, id: &str, index: usize) -> Result<Document, String> {
        let mut docs = self.docs.lock().map_err(locked)?;
        let state = docs.get_mut(id).ok_or_else(|| "unknown document".to_string())?;
        let total = state.undo.len() + 1 + state.redo.len();
        if index >= total {
            return Err("history step is out of range".to_string());
        }
        while state.undo.len() > index {
            let previous = state.undo.pop().expect("history entry");
            state.redo.push(HistoryEntry {
                doc: state.doc.clone(),
                name: state.current_name.clone(),
                at: state.current_at,
            });
            state.doc = previous.doc;
            state.current_name = previous.name;
            state.current_at = previous.at;
        }
        while state.undo.len() < index {
            let next = state.redo.pop().expect("history entry");
            state.undo.push(HistoryEntry {
                doc: state.doc.clone(),
                name: state.current_name.clone(),
                at: state.current_at,
            });
            state.doc = next.doc;
            state.current_name = next.name;
            state.current_at = next.at;
        }
        state.updated_at = now();
        self.write(state)?;
        Ok(state.doc.clone())
    }

    fn checkpoint_dir(&self, id: &str) -> Result<PathBuf, String> {
        safe_component(id)?;
        Ok(self.dir.join("checkpoints").join(id))
    }

    pub fn checkpoint_save(&self, id: &str, name: String) -> Result<CheckpointInfo, String> {
        let name = clean_checkpoint_name(&name)?;
        let dir = self.checkpoint_dir(id)?;
        let docs = self.docs.lock().map_err(locked)?;
        let state = docs.get(id).ok_or_else(|| "unknown document".to_string())?;
        let file = CheckpointFile {
            id: new_id("c"),
            name,
            created_at: now(),
            document: state.doc.clone(),
        };
        let bytes = serde_json::to_vec(&file).map_err(|error| error.to_string())?;
        if bytes.len() > CHECKPOINT_SIZE_LIMIT {
            return Err("checkpoint is too large".to_string());
        }
        let existing = match fs::read_dir(&dir) {
            Ok(entries) => entries
                .flatten()
                .filter(|entry| {
                    entry.path().extension().and_then(|ext| ext.to_str()) == Some("json")
                })
                .count(),
            Err(_) => 0,
        };
        if existing >= CHECKPOINT_COUNT_LIMIT {
            return Err("too many checkpoints".to_string());
        }
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        write_atomic(&dir.join(format!("{}.json", file.id)), &bytes)?;
        Ok(CheckpointInfo {
            id: file.id,
            name: file.name,
            created_at: file.created_at,
        })
    }

    pub fn checkpoint_list(&self, id: &str) -> Result<Vec<CheckpointInfo>, String> {
        let dir = self.checkpoint_dir(id)?;
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => return Ok(Vec::new()),
        };
        let mut list = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            let file: CheckpointFile = match serde_json::from_slice(&bytes) {
                Ok(file) => file,
                Err(_) => continue,
            };
            list.push(CheckpointInfo {
                id: file.id,
                name: file.name,
                created_at: file.created_at,
            });
        }
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
        Ok(list)
    }

    fn read_checkpoint(&self, id: &str, checkpoint_id: &str) -> Result<CheckpointFile, String> {
        safe_component(checkpoint_id)?;
        let path = self.checkpoint_dir(id)?.join(format!("{checkpoint_id}.json"));
        let bytes = fs::read(&path).map_err(|_| "unknown checkpoint".to_string())?;
        serde_json::from_slice(&bytes).map_err(|_| "unknown checkpoint".to_string())
    }

    pub fn checkpoint_restore(&self, id: &str, checkpoint_id: &str) -> Result<Document, String> {
        let file = self.read_checkpoint(id, checkpoint_id)?;
        let mut document = file.document;
        document.id = id.to_string();
        self.edit_named(id, "restore_checkpoint", move |doc| {
            *doc = document;
            Ok(())
        })
    }

    pub fn checkpoint_delete(&self, id: &str, checkpoint_id: &str) -> Result<(), String> {
        safe_component(checkpoint_id)?;
        let path = self.checkpoint_dir(id)?.join(format!("{checkpoint_id}.json"));
        if !path.exists() {
            return Err("unknown checkpoint".to_string());
        }
        fs::remove_file(&path).map_err(|error| error.to_string())
    }

    pub fn evaluate_range(
        &self,
        id: &str,
        scene_id: &str,
        start_frame: u32,
        end_frame: u32,
    ) -> Result<Vec<EvalFrame>, String> {
        if end_frame < start_frame || end_frame - start_frame > 600 {
            return Err("frame range is invalid".to_string());
        }
        let docs = self.docs.lock().map_err(locked)?;
        let state = docs.get(id).ok_or_else(|| "unknown document".to_string())?;
        (start_frame..=end_frame)
            .map(|frame| state.doc.evaluate(scene_id, frame))
            .collect()
    }
}

pub(crate) fn clean_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn safe_component(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.contains('/')
        || value.contains('\\')
        || value.contains("..")
        || value.chars().any(|character| character.is_control())
    {
        return Err("invalid identifier".to_string());
    }
    Ok(())
}

fn clean_checkpoint_name(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("checkpoint name is empty".to_string());
    }
    if trimmed.chars().count() > CHECKPOINT_NAME_LIMIT {
        return Err("checkpoint name is too long".to_string());
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.chars().any(|character| character.is_control())
    {
        return Err("checkpoint name is invalid".to_string());
    }
    Ok(trimmed.to_string())
}

fn read_recovery(path: &Path) -> Result<RecoveryFile, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = target.with_extension("tmp");
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temp, target).map_err(|error| {
        let _ = fs::remove_file(&temp);
        error.to_string()
    })
}

#[tauri::command]
pub fn doc_new(
    store: State<'_, DocStore>,
    name: String,
    width: u32,
    height: u32,
    fps: u32,
    background: String,
) -> Result<Document, String> {
    store.create(name, width, height, fps, background)
}

#[tauri::command]
pub fn doc_list(store: State<'_, DocStore>) -> Result<Vec<ProjectSummary>, String> {
    store.list()
}

#[tauri::command]
pub fn doc_recovery_report(store: State<'_, DocStore>) -> Result<Vec<String>, String> {
    store.take_problems()
}

#[tauri::command]
pub fn doc_get(store: State<'_, DocStore>, id: String) -> Result<Document, String> {
    store.get(&id)
}

#[tauri::command]
pub fn doc_close(store: State<'_, DocStore>, id: String) -> Result<(), String> {
    store.close(&id)
}

#[tauri::command]
pub fn doc_delete(store: State<'_, DocStore>, id: String) -> Result<(), String> {
    store.delete(&id)
}

#[tauri::command]
pub fn doc_rename(
    store: State<'_, DocStore>,
    id: String,
    name: String,
) -> Result<Document, String> {
    store.rename(&id, name)
}

#[tauri::command]
pub fn doc_add_scene(
    store: State<'_, DocStore>,
    id: String,
    name: String,
) -> Result<Document, String> {
    store.add_scene(&id, name)
}

#[tauri::command]
pub fn doc_rename_scene(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    name: String,
) -> Result<Document, String> {
    store.rename_scene(&id, &scene_id, name)
}

#[tauri::command]
pub fn doc_remove_scene(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
) -> Result<Document, String> {
    store.remove_scene(&id, &scene_id)
}

#[tauri::command]
pub fn doc_duplicate_scene(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
) -> Result<Document, String> {
    store.duplicate_scene(&id, &scene_id)
}

#[tauri::command]
pub fn doc_move_scene(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    index: usize,
) -> Result<Document, String> {
    store.move_scene(&id, &scene_id, index)
}

#[tauri::command]
pub fn doc_add_layer(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    name: String,
) -> Result<Document, String> {
    store.add_layer(&id, &scene_id, name)
}

#[tauri::command]
pub fn doc_set_layer(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    name: Option<String>,
    visible: Option<bool>,
    locked: Option<bool>,
    opacity: Option<f64>,
) -> Result<Document, String> {
    store.set_layer(&id, &scene_id, &layer_id, name, visible, locked, opacity)
}

#[tauri::command]
pub fn doc_remove_layer(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
) -> Result<Document, String> {
    store.remove_layer(&id, &scene_id, &layer_id)
}

#[tauri::command]
pub fn doc_move_layer(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    index: usize,
) -> Result<Document, String> {
    store.move_layer(&id, &scene_id, &layer_id, index)
}

#[tauri::command]
pub fn doc_insert_frame(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
) -> Result<Document, String> {
    store.insert_frame(&id, &scene_id, &layer_id, frame)
}

#[tauri::command]
pub fn doc_keyframe(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    blank: bool,
) -> Result<Document, String> {
    store.keyframe(&id, &scene_id, &layer_id, frame, blank)
}

#[tauri::command]
pub fn doc_remove_frame(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
) -> Result<Document, String> {
    store.remove_frame(&id, &scene_id, &layer_id, frame)
}

#[tauri::command]
pub fn doc_set_tween(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    tween: bool,
) -> Result<Document, String> {
    store.set_tween(&id, &scene_id, &layer_id, frame, tween)
}

#[tauri::command]
pub fn doc_set_label(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    label: Option<String>,
) -> Result<Document, String> {
    store.set_label(&id, &scene_id, &layer_id, frame, label)
}

#[tauri::command]
pub fn doc_draw(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    shape: Shape,
) -> Result<Document, String> {
    store.draw(&id, &scene_id, &layer_id, frame, shape)
}

#[tauri::command]
pub fn doc_erase(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    path: Vec<Point>,
    radius: f64,
) -> Result<Document, String> {
    store.erase(&id, &scene_id, &layer_id, frame, path, radius)
}

#[tauri::command]
pub fn doc_paint_shape(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    index: usize,
    color: String,
) -> Result<Document, String> {
    store.paint_shape(&id, &scene_id, &layer_id, frame, index, color)
}

#[tauri::command]
pub fn doc_replace_shape(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    index: usize,
    shape: Shape,
) -> Result<Document, String> {
    store.replace_shape(&id, &scene_id, &layer_id, frame, index, shape)
}

#[tauri::command]
pub fn doc_delete_shape(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    index: usize,
) -> Result<Document, String> {
    store.delete_shape(&id, &scene_id, &layer_id, frame, index)
}

#[tauri::command]
pub fn doc_transform_shapes(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    indices: Vec<usize>,
    pivot: Point,
    dx: f64,
    dy: f64,
    sx: f64,
    sy: f64,
    rotation: f64,
) -> Result<Document, String> {
    store.transform_shapes(
        &id, &scene_id, &layer_id, frame, indices, pivot, dx, dy, sx, sy, rotation,
    )
}

#[tauri::command]
pub fn doc_reorder_shapes(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    indices: Vec<usize>,
    to_front: bool,
) -> Result<Document, String> {
    store.reorder_shapes(&id, &scene_id, &layer_id, frame, indices, to_front)
}

#[tauri::command]
pub fn doc_delete_shapes(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    indices: Vec<usize>,
) -> Result<Document, String> {
    store.delete_shapes(&id, &scene_id, &layer_id, frame, indices)
}

#[tauri::command]
pub fn doc_set_transform(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    transform: Transform,
) -> Result<Document, String> {
    store.set_transform(&id, &scene_id, &layer_id, frame, transform)
}

#[tauri::command]
pub fn doc_undo(store: State<'_, DocStore>, id: String) -> Result<Document, String> {
    store.undo(&id)
}

#[tauri::command]
pub fn doc_redo(store: State<'_, DocStore>, id: String) -> Result<Document, String> {
    store.redo(&id)
}

#[tauri::command]
pub fn doc_evaluate(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    start_frame: u32,
    end_frame: u32,
) -> Result<Vec<EvalFrame>, String> {
    store.evaluate_range(&id, &scene_id, start_frame, end_frame)
}

#[tauri::command]
pub fn doc_history(store: State<'_, DocStore>, id: String) -> Result<Vec<HistoryStep>, String> {
    store.history(&id)
}

#[tauri::command]
pub fn doc_history_jump(
    store: State<'_, DocStore>,
    id: String,
    index: usize,
) -> Result<Document, String> {
    store.jump(&id, index)
}

#[tauri::command]
pub fn doc_checkpoint_save(
    store: State<'_, DocStore>,
    id: String,
    name: String,
) -> Result<CheckpointInfo, String> {
    store.checkpoint_save(&id, name)
}

#[tauri::command]
pub fn doc_checkpoint_list(
    store: State<'_, DocStore>,
    id: String,
) -> Result<Vec<CheckpointInfo>, String> {
    store.checkpoint_list(&id)
}

#[tauri::command]
pub fn doc_checkpoint_restore(
    store: State<'_, DocStore>,
    id: String,
    checkpoint_id: String,
) -> Result<Document, String> {
    store.checkpoint_restore(&id, &checkpoint_id)
}

#[tauri::command]
pub fn doc_checkpoint_delete(
    store: State<'_, DocStore>,
    id: String,
    checkpoint_id: String,
) -> Result<(), String> {
    store.checkpoint_delete(&id, &checkpoint_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path::PATH_STEPS;

    struct Fixture {
        store: DocStore,
        doc: Document,
        scene: String,
        layer: String,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("stickmate-{tag}-{}", new_id("t")));
            let store = DocStore::load(dir);
            let doc = store
                .create("Test".to_string(), 800, 600, 24, "#ffffff".to_string())
                .expect("create");
            let scene = doc.scenes[0].id.clone();
            let layer = doc.scenes[0].layers[0].id.clone();
            Self {
                store,
                doc,
                scene,
                layer,
            }
        }

        fn target<'a>(&self, doc: &'a Document) -> &'a Layer {
            &doc.scenes[0].layers[0]
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.store.dir);
        }
    }

    fn stroke(x: f64) -> Shape {
        Shape::Stroke {
            points: vec![Point { x, y: 0.0 }, Point { x, y: 10.0 }],
            color: "#000000".to_string(),
            width: 2.0,
        }
    }

    #[test]
    fn new_document_has_one_scene_and_layer() {
        let fixture = Fixture::new("new");
        assert_eq!(fixture.doc.scenes.len(), 1);
        assert_eq!(fixture.doc.scenes[0].layers.len(), 1);
        assert_eq!(fixture.doc.scenes[0].length(), 1);
        assert_eq!(fixture.target(&fixture.doc).keys.len(), 1);
        assert_eq!(fixture.store.list().expect("list").len(), 1);
    }

    #[test]
    fn create_rejects_invalid_settings() {
        let fixture = Fixture::new("invalid");
        assert!(fixture
            .store
            .create("Bad".to_string(), 0, 600, 24, "#fff".to_string())
            .is_err());
        assert!(fixture
            .store
            .create("Bad".to_string(), 800, 600, 120, "#fff".to_string())
            .is_err());
        assert_eq!(fixture.store.list().expect("list").len(), 1);
    }

    #[test]
    fn draw_creates_keyframe_and_extends_layer() {
        let fixture = Fixture::new("draw");
        let id = &fixture.doc.id;
        let edited = fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 4, stroke(1.0))
            .expect("draw");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 5);
        assert_eq!(target.keys.len(), 2);
        assert_eq!(target.keys[1].frame, 4);
        assert_eq!(target.keys[1].shapes.len(), 1);
    }

    #[test]
    fn draw_on_held_frame_copies_content_into_new_key() {
        let fixture = Fixture::new("held-draw");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("first");
        let edited = fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 5, stroke(2.0))
            .expect("second");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 6);
        assert_eq!(target.keys.len(), 2);
        assert_eq!(target.keys[1].frame, 5);
        assert_eq!(target.keys[1].shapes.len(), 2);
    }

    #[test]
    fn locked_layer_rejects_edits() {
        let fixture = Fixture::new("locked");
        let id = &fixture.doc.id;
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None)
            .expect("lock");
        let error = fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect_err("locked");
        assert_eq!(error, "layer is locked");
    }

    #[test]
    fn insert_frame_shifts_keys_right() {
        let fixture = Fixture::new("insert");
        let id = &fixture.doc.id;
        fixture
            .store
            .keyframe(id, &fixture.scene, &fixture.layer, 4, false)
            .expect("key");
        let edited = fixture
            .store
            .insert_frame(id, &fixture.scene, &fixture.layer, 2)
            .expect("insert");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 6);
        assert_eq!(
            target.keys.iter().map(|key| key.frame).collect::<Vec<_>>(),
            vec![0, 5]
        );
    }

    #[test]
    fn insert_frame_on_key_keeps_the_key() {
        let fixture = Fixture::new("insert-key");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(2.0))
            .expect("draw");
        fixture
            .store
            .keyframe(id, &fixture.scene, &fixture.layer, 4, false)
            .expect("key");
        let edited = fixture
            .store
            .insert_frame(id, &fixture.scene, &fixture.layer, 0)
            .expect("insert");
        let target = fixture.target(&edited);
        assert_eq!(
            target.keys.iter().map(|key| key.frame).collect::<Vec<_>>(),
            vec![0, 5]
        );
        assert_eq!(target.keys[0].shapes.len(), 1);
        assert_eq!(target.length, 6);
        let extended = fixture
            .store
            .insert_frame(id, &fixture.scene, &fixture.layer, 5)
            .expect("insert on key");
        let target = fixture.target(&extended);
        assert_eq!(
            target.keys.iter().map(|key| key.frame).collect::<Vec<_>>(),
            vec![0, 5]
        );
        assert_eq!(target.length, 7);
    }

    #[test]
    fn insert_frame_at_end_extends_without_new_key() {
        let fixture = Fixture::new("insert-end");
        let edited = fixture
            .store
            .insert_frame(&fixture.doc.id, &fixture.scene, &fixture.layer, 99)
            .expect("insert");
        assert_eq!(fixture.target(&edited).length, 2);
        assert_eq!(fixture.target(&edited).keys.len(), 1);
        assert_eq!(edited.scenes[0].length(), 2);
    }

    #[test]
    fn keyframe_copies_held_content_and_blank_clears_it() {
        let fixture = Fixture::new("key");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(3.0))
            .expect("draw");
        let copied = fixture
            .store
            .keyframe(id, &fixture.scene, &fixture.layer, 5, false)
            .expect("keyframe");
        assert_eq!(fixture.target(&copied).keys[1].shapes.len(), 1);
        let blank = fixture
            .store
            .keyframe(id, &fixture.scene, &fixture.layer, 8, true)
            .expect("blank");
        assert!(fixture.target(&blank).keys[2].shapes.is_empty());
        assert_eq!(fixture.target(&blank).keys[2].transform, Transform::default());
    }

    #[test]
    fn remove_frame_shifts_keys_and_shrinks_layer() {
        let fixture = Fixture::new("remove");
        let id = &fixture.doc.id;
        fixture
            .store
            .keyframe(id, &fixture.scene, &fixture.layer, 3, false)
            .expect("key");
        fixture
            .store
            .keyframe(id, &fixture.scene, &fixture.layer, 6, false)
            .expect("key");
        let edited = fixture
            .store
            .remove_frame(id, &fixture.scene, &fixture.layer, 3)
            .expect("remove");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 6);
        assert_eq!(
            target.keys.iter().map(|key| key.frame).collect::<Vec<_>>(),
            vec![0, 5]
        );
    }

    #[test]
    fn remove_last_frame_keeps_a_key_at_zero() {
        let fixture = Fixture::new("remove-last");
        let edited = fixture
            .store
            .remove_frame(&fixture.doc.id, &fixture.scene, &fixture.layer, 0)
            .expect("remove");
        let target = fixture.target(&edited);
        assert_eq!(target.keys.len(), 1);
        assert_eq!(target.keys[0].frame, 0);
        assert_eq!(target.length, 1);
    }

    #[test]
    fn held_frame_reuses_previous_shapes() {
        let fixture = Fixture::new("held");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(7.0))
            .expect("draw");
        fixture
            .store
            .keyframe(id, &fixture.scene, &fixture.layer, 4, true)
            .expect("blank");
        fixture
            .store
            .insert_frame(id, &fixture.scene, &fixture.layer, 5)
            .expect("extend");
        let frames = fixture
            .store
            .evaluate_range(id, &fixture.scene, 0, 5)
            .expect("evaluate");
        assert_eq!(frames[2].layers[0].shapes.len(), 1);
        assert!(frames[5].layers[0].shapes.is_empty());
        assert_eq!(frames.len(), 6);
    }

    #[test]
    fn tween_interpolates_transform_deterministically() {
        let fixture = Fixture::new("tween");
        let id = &fixture.doc.id;
        fixture
            .store
            .set_tween(id, &fixture.scene, &fixture.layer, 0, true)
            .expect("tween");
        fixture
            .store
            .set_transform(
                id,
                &fixture.scene,
                &fixture.layer,
                10,
                Transform {
                    x: 100.0,
                    y: -50.0,
                    rotation: 90.0,
                    scale: 2.0,
                    opacity: 0.5,
                },
            )
            .expect("transform");
        let frames = fixture
            .store
            .evaluate_range(id, &fixture.scene, 0, 10)
            .expect("evaluate");
        let middle = frames[5].layers[0].transform;
        assert_eq!(middle.x, 50.0);
        assert_eq!(middle.y, -25.0);
        assert_eq!(middle.rotation, 45.0);
        assert_eq!(middle.scale, 1.5);
        assert_eq!(frames[5].layers[0].opacity, 0.75);
        assert_eq!(frames[10].layers[0].transform.x, 100.0);
        let again = fixture
            .store
            .evaluate_range(id, &fixture.scene, 5, 5)
            .expect("evaluate");
        assert_eq!(again[0], frames[5]);
    }

    #[test]
    fn tween_without_next_key_holds_transform() {
        let fixture = Fixture::new("tween-hold");
        let id = &fixture.doc.id;
        for _ in 0..3 {
            fixture
                .store
                .insert_frame(id, &fixture.scene, &fixture.layer, 99)
                .expect("extend");
        }
        fixture
            .store
            .set_tween(id, &fixture.scene, &fixture.layer, 0, true)
            .expect("tween");
        fixture
            .store
            .set_transform(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                Transform {
                    x: 20.0,
                    ..Transform::default()
                },
            )
            .expect("transform");
        let frames = fixture
            .store
            .evaluate_range(id, &fixture.scene, 3, 3)
            .expect("evaluate");
        assert_eq!(frames[0].layers[0].transform.x, 20.0);
    }

    fn tween_span(fixture: &Fixture, start: Vec<Shape>, end: Vec<Shape>) -> Vec<EvalFrame> {
        let store = &fixture.store;
        let id = &fixture.doc.id;
        for shape in start {
            store
                .draw(id, &fixture.scene, &fixture.layer, 0, shape)
                .expect("draw start");
        }
        store
            .keyframe(id, &fixture.scene, &fixture.layer, 2, true)
            .expect("blank key");
        for shape in end {
            store
                .draw(id, &fixture.scene, &fixture.layer, 2, shape)
                .expect("draw end");
        }
        store
            .set_tween(id, &fixture.scene, &fixture.layer, 0, true)
            .expect("tween");
        store
            .evaluate_range(id, &fixture.scene, 0, 2)
            .expect("evaluate")
    }

    #[test]
    fn tween_moves_the_shapes_themselves() {
        let fixture = Fixture::new("tween-shapes");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(100.0, 100.0))
            .expect("draw start");
        store
            .keyframe(id, &fixture.scene, &fixture.layer, 10, true)
            .expect("blank key");
        store
            .draw(id, &fixture.scene, &fixture.layer, 10, box_shape(300.0, 100.0))
            .expect("draw end");
        store
            .set_tween(id, &fixture.scene, &fixture.layer, 0, true)
            .expect("tween");
        let frames = store
            .evaluate_range(id, &fixture.scene, 0, 10)
            .expect("evaluate");
        assert_eq!(frames[0].layers[0].shapes, vec![box_shape(100.0, 100.0)]);
        assert_eq!(frames[2].layers[0].shapes, vec![box_shape(140.0, 100.0)]);
        assert_eq!(frames[5].layers[0].shapes, vec![box_shape(200.0, 100.0)]);
        assert_eq!(frames[10].layers[0].shapes, vec![box_shape(300.0, 100.0)]);
        store
            .set_tween(id, &fixture.scene, &fixture.layer, 0, false)
            .expect("tween off");
        let held = store
            .evaluate_range(id, &fixture.scene, 5, 5)
            .expect("evaluate");
        assert_eq!(held[0].layers[0].shapes, vec![box_shape(100.0, 100.0)]);
    }

    #[test]
    fn tween_blends_colors_and_holds_the_ones_it_cannot_read() {
        let fixture = Fixture::new("tween-colors");
        let start = Shape::Rect {
            x: 0.0,
            y: 0.0,
            w: 10.0,
            h: 10.0,
            fill: "#f00".to_string(),
            stroke: "#000000".to_string(),
            width: 2.0,
        };
        let end = Shape::Rect {
            x: 20.0,
            y: 0.0,
            w: 10.0,
            h: 10.0,
            fill: "#0000ff".to_string(),
            stroke: "none".to_string(),
            width: 4.0,
        };
        let middle = tween_span(&fixture, vec![start], vec![end.clone()])[1]
            .layers[0]
            .shapes[0]
            .clone();
        let Shape::Rect {
            x,
            fill,
            stroke,
            width,
            ..
        } = middle
        else {
            panic!("expected a rectangle");
        };
        assert_eq!(x, 10.0);
        assert_eq!(fill, "#800080");
        assert_eq!(stroke, "#000000");
        assert_eq!(width, 3.0);
    }

    #[test]
    fn tween_holds_shapes_it_cannot_pair() {
        let ball = Shape::Ellipse {
            x: 40.0,
            y: 40.0,
            w: 20.0,
            h: 20.0,
            fill: "#22c55e".to_string(),
            stroke: "#000000".to_string(),
            width: 1.0,
        };
        let fixture = Fixture::new("tween-kinds");
        let frames = tween_span(&fixture, vec![box_shape(0.0, 0.0)], vec![ball.clone()]);
        assert_eq!(frames[1].layers[0].shapes, vec![box_shape(0.0, 0.0)]);
        assert_eq!(frames[2].layers[0].shapes, vec![ball.clone()]);
        let second = Fixture::new("tween-count");
        let extra = tween_span(
            &second,
            vec![box_shape(0.0, 0.0), box_shape(60.0, 0.0)],
            vec![ball.clone(), box_shape(0.0, 40.0), ball],
        );
        assert_eq!(
            extra[1].layers[0].shapes,
            vec![box_shape(0.0, 0.0), box_shape(30.0, 20.0)]
        );
    }

    #[test]
    fn tween_interpolates_path_points_and_handles() {
        let fixture = Fixture::new("tween-path");
        let start = Shape::Path {
            nodes: vec![
                PathNode {
                    point: Point { x: 0.0, y: 0.0 },
                    handle_in: None,
                    handle_out: Some(Point { x: 10.0, y: 0.0 }),
                },
                PathNode {
                    point: Point { x: 0.0, y: 20.0 },
                    handle_in: Some(Point { x: 0.0, y: 10.0 }),
                    handle_out: None,
                },
            ],
            closed: false,
            fill: "#3b82f6".to_string(),
            stroke: "#000000".to_string(),
            width: 2.0,
        };
        let end = Shape::Path {
            nodes: vec![
                PathNode {
                    point: Point { x: 20.0, y: 0.0 },
                    handle_in: Some(Point { x: 15.0, y: 5.0 }),
                    handle_out: Some(Point { x: 30.0, y: 0.0 }),
                },
                PathNode {
                    point: Point { x: 20.0, y: 40.0 },
                    handle_in: None,
                    handle_out: None,
                },
            ],
            closed: false,
            fill: "#3b82f6".to_string(),
            stroke: "#000000".to_string(),
            width: 2.0,
        };
        let frames = tween_span(&fixture, vec![start], vec![end.clone()]);
        let middle = frames[1].layers[0].shapes[0].clone();
        assert_eq!(
            middle,
            Shape::Path {
                nodes: vec![
                    PathNode {
                        point: Point { x: 10.0, y: 0.0 },
                        handle_in: Some(Point { x: 7.5, y: 2.5 }),
                        handle_out: Some(Point { x: 20.0, y: 0.0 }),
                    },
                    PathNode {
                        point: Point { x: 10.0, y: 30.0 },
                        handle_in: Some(Point { x: 10.0, y: 25.0 }),
                        handle_out: None,
                    },
                ],
                closed: false,
                fill: "#3b82f6".to_string(),
                stroke: "#000000".to_string(),
                width: 2.0,
            }
        );
        assert_eq!(frames[2].layers[0].shapes, vec![end]);
    }

    #[test]
    fn tween_interpolates_text_but_holds_its_words() {
        let fixture = Fixture::new("tween-text");
        let start = Shape::Text {
            x: 10.0,
            y: 20.0,
            text: "In".to_string(),
            size: 20.0,
            family: "sans-serif".to_string(),
            color: "#000000".to_string(),
            matrix: Some(Affine {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 0.0,
                f: 0.0,
            }),
        };
        let end = Shape::Text {
            x: 30.0,
            y: 60.0,
            text: "Out".to_string(),
            size: 40.0,
            family: "monospace".to_string(),
            color: "#ffffff".to_string(),
            matrix: Some(Affine {
                a: 2.0,
                b: 0.0,
                c: 0.0,
                d: 2.0,
                e: 10.0,
                f: 20.0,
            }),
        };
        let middle = tween_span(&fixture, vec![start], vec![end.clone()])[1]
            .layers[0]
            .shapes[0]
            .clone();
        let Shape::Text {
            x,
            y,
            text,
            size,
            family,
            color,
            matrix,
        } = middle
        else {
            panic!("expected text");
        };
        assert_eq!((x, y, size), (20.0, 40.0, 30.0));
        assert_eq!(text, "In");
        assert_eq!(family, "sans-serif");
        assert_eq!(color, "#808080");
        assert_eq!(
            matrix,
            Some(Affine {
                a: 1.5,
                b: 0.0,
                c: 0.0,
                d: 1.5,
                e: 5.0,
                f: 10.0,
            })
        );
    }

    #[test]
    fn hidden_layer_and_out_of_range_frame_evaluate_empty() {
        let fixture = Fixture::new("visible");
        let id = &fixture.doc.id;
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, Some(false), None, None)
            .expect("hide");
        let frames = fixture
            .store
            .evaluate_range(id, &fixture.scene, 0, 0)
            .expect("evaluate");
        assert!(frames[0].layers.is_empty());
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, Some(true), None, None)
            .expect("show");
        let frames = fixture
            .store
            .evaluate_range(id, &fixture.scene, 9, 9)
            .expect("evaluate");
        assert!(frames[0].layers.is_empty());
    }

    #[test]
    fn layer_opacity_multiplies_transform_opacity() {
        let fixture = Fixture::new("opacity");
        let id = &fixture.doc.id;
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, None, Some(0.5))
            .expect("opacity");
        fixture
            .store
            .set_transform(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                Transform {
                    opacity: 0.5,
                    ..Transform::default()
                },
            )
            .expect("transform");
        let frames = fixture
            .store
            .evaluate_range(id, &fixture.scene, 0, 0)
            .expect("evaluate");
        assert_eq!(frames[0].layers[0].opacity, 0.25);
    }

    #[test]
    fn transform_values_are_sanitized() {
        let fixture = Fixture::new("sanitize");
        let edited = fixture
            .store
            .set_transform(
                &fixture.doc.id,
                &fixture.scene,
                &fixture.layer,
                0,
                Transform {
                    scale: -3.0,
                    opacity: 4.0,
                    ..Transform::default()
                },
            )
            .expect("transform");
        let transform = fixture.target(&edited).keys[0].transform;
        assert_eq!(transform.scale, 0.01);
        assert_eq!(transform.opacity, 1.0);
    }

    #[test]
    fn undo_redo_restore_snapshots_and_clear_redo_on_edit() {
        let fixture = Fixture::new("history");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("first");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(2.0))
            .expect("second");
        let undone = fixture.store.undo(id).expect("undo");
        assert_eq!(fixture.target(&undone).keys[0].shapes.len(), 1);
        let redone = fixture.store.redo(id).expect("redo");
        assert_eq!(fixture.target(&redone).keys[0].shapes.len(), 2);
        fixture.store.rename(id, "Renamed".to_string()).expect("rename");
        assert_eq!(fixture.store.redo(id).expect_err("redo"), "nothing to redo");
        let undone = fixture.store.undo(id).expect("undo");
        assert_eq!(undone.name, "Test");
    }

    #[test]
    fn undo_past_start_reports_nothing_to_undo() {
        let fixture = Fixture::new("undo-empty");
        assert_eq!(
            fixture.store.undo(&fixture.doc.id).expect_err("undo"),
            "nothing to undo"
        );
    }

    #[test]
    fn history_is_capped_and_persisted() {
        let fixture = Fixture::new("cap");
        let id = &fixture.doc.id;
        for step in 0..120 {
            fixture
                .store
                .rename(id, format!("Step {step}"))
                .expect("rename");
        }
        for _ in 0..HISTORY_LIMIT {
            fixture.store.undo(id).expect("undo");
        }
        assert_eq!(fixture.store.undo(id).expect_err("undo"), "nothing to undo");
        let current = fixture.store.get(id).expect("get");
        assert_eq!(current.name, "Step 19");
    }

    #[test]
    fn recovery_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("stickmate-recovery-{}", new_id("t")));
        let (id, expected) = {
            let store = DocStore::load(dir.clone());
            let doc = store
                .create("Saved".to_string(), 1920, 1080, 30, "#101010".to_string())
                .expect("create");
            let scene = doc.scenes[0].id.clone();
            let layer = doc.scenes[0].layers[0].id.clone();
            store
                .draw(&doc.id, &scene, &layer, 6, stroke(4.0))
                .expect("draw");
            store
                .set_tween(&doc.id, &scene, &layer, 6, true)
                .expect("tween");
            store
                .set_label(&doc.id, &scene, &layer, 6, Some("walk".to_string()))
                .expect("label");
            let expected = store.get(&doc.id).expect("get");
            (doc.id, expected)
        };
        let reloaded = DocStore::load(dir.clone());
        let restored = reloaded.get(&id).expect("loaded");
        assert_eq!(restored, expected);
        assert_eq!(restored.scenes[0].layers[0].keys[1].label.as_deref(), Some("walk"));
        assert!(reloaded.take_problems().expect("report").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_recovery_is_kept_aside_and_reported() {
        let dir = std::env::temp_dir().join(format!("stickmate-corrupt-{}", new_id("t")));
        fs::create_dir_all(&dir).expect("dir");
        fs::write(dir.join("broken.json"), b"{ not json").expect("write");
        let store = DocStore::load(dir.clone());
        assert!(store.list().expect("list").is_empty());
        let problems = store.take_problems().expect("report");
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("broken.json"));
        assert!(dir.join("broken.invalid").exists());
        assert!(!dir.join("broken.json").exists());
        assert!(store.take_problems().expect("report").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_edit_does_not_touch_history() {
        let fixture = Fixture::new("failed");
        let id = &fixture.doc.id;
        let error = fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, Some("  ".to_string()), None, None, None)
            .expect_err("empty name");
        assert_eq!(error, "name is empty");
        assert_eq!(fixture.store.undo(id).expect_err("undo"), "nothing to undo");
        assert_eq!(fixture.target(&fixture.store.get(id).expect("get")).name, "Layer 1");
    }

    #[test]
    fn scene_and_layer_minimums_are_enforced() {
        let fixture = Fixture::new("minimum");
        let id = &fixture.doc.id;
        assert!(fixture
            .store
            .remove_scene(id, &fixture.scene)
            .expect_err("scene")
            .contains("at least one scene"));
        assert!(fixture
            .store
            .remove_layer(id, &fixture.scene, &fixture.layer)
            .expect_err("layer")
            .contains("at least one layer"));
    }

    #[test]
    fn scenes_can_be_added_duplicated_moved_and_removed() {
        let fixture = Fixture::new("scenes");
        let id = &fixture.doc.id;
        let added = fixture.store.add_scene(id, "  ".to_string()).expect("add");
        assert_eq!(added.scenes.len(), 2);
        assert_eq!(added.scenes[1].name, "Scene 2");
        let second = added.scenes[1].id.clone();
        let duplicated = fixture.store.duplicate_scene(id, &second).expect("duplicate");
        assert_eq!(duplicated.scenes.len(), 3);
        assert_ne!(duplicated.scenes[1].id, duplicated.scenes[2].id);
        assert_ne!(
            duplicated.scenes[1].layers[0].id,
            duplicated.scenes[2].layers[0].id
        );
        let moved = fixture.store.move_scene(id, &second, 0).expect("move");
        assert_eq!(moved.scenes[0].id, second);
        let removed = fixture.store.remove_scene(id, &second).expect("remove");
        assert_eq!(removed.scenes.len(), 2);
    }

    #[test]
    fn layers_can_be_added_renamed_reordered_and_removed() {
        let fixture = Fixture::new("layers");
        let id = &fixture.doc.id;
        let added = fixture.store.add_layer(id, &fixture.scene, "Ink".to_string()).expect("add");
        assert_eq!(added.scenes[0].layers.len(), 2);
        assert_eq!(added.scenes[0].layers[0].name, "Ink");
        let ink = added.scenes[0].layers[0].id.clone();
        let renamed = fixture
            .store
            .set_layer(id, &fixture.scene, &ink, Some("Paint".to_string()), None, None, Some(0.4))
            .expect("set");
        assert_eq!(renamed.scenes[0].layers[0].name, "Paint");
        assert_eq!(renamed.scenes[0].layers[0].opacity, 0.4);
        let moved = fixture.store.move_layer(id, &fixture.scene, &ink, 1).expect("move");
        assert_eq!(moved.scenes[0].layers[1].id, ink);
        let removed = fixture.store.remove_layer(id, &fixture.scene, &ink).expect("remove");
        assert_eq!(removed.scenes[0].layers.len(), 1);
    }

    #[test]
    fn shapes_can_be_deleted_and_unknown_index_rejected() {
        let fixture = Fixture::new("shapes");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("draw");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(2.0))
            .expect("draw");
        let edited = fixture
            .store
            .delete_shape(id, &fixture.scene, &fixture.layer, 0, 0)
            .expect("delete");
        assert_eq!(fixture.target(&edited).keys[0].shapes.len(), 1);
        assert_eq!(
            fixture
                .store
                .delete_shape(id, &fixture.scene, &fixture.layer, 0, 9)
                .expect_err("index"),
            "unknown shape"
        );
    }

    #[test]
    fn labels_are_trimmed_and_cleared() {
        let fixture = Fixture::new("labels");
        let id = &fixture.doc.id;
        let labelled = fixture
            .store
            .set_label(id, &fixture.scene, &fixture.layer, 0, Some("  walk  ".to_string()))
            .expect("label");
        assert_eq!(fixture.target(&labelled).keys[0].label.as_deref(), Some("walk"));
        let cleared = fixture
            .store
            .set_label(id, &fixture.scene, &fixture.layer, 0, Some("   ".to_string()))
            .expect("clear");
        assert_eq!(fixture.target(&cleared).keys[0].label, None);
    }

    #[test]
    fn close_keeps_recovery_and_delete_removes_it() {
        let fixture = Fixture::new("close");
        let id = fixture.doc.id.clone();
        let path = fixture.store.dir.join(format!("{id}.json"));
        assert!(path.exists());
        fixture.store.close(&id).expect("close");
        assert!(path.exists());
        assert!(fixture.store.get(&id).is_err());
        let reloaded = DocStore::load(fixture.store.dir.clone());
        assert_eq!(reloaded.list().expect("list").len(), 1);
        reloaded.delete(&id).expect("delete");
        assert!(!path.exists());
        assert!(reloaded.list().expect("list").is_empty());
    }

    #[test]
    fn unknown_ids_and_bad_ranges_are_rejected() {
        let fixture = Fixture::new("unknown");
        assert_eq!(
            fixture.store.get("missing").expect_err("get"),
            "unknown document"
        );
        assert_eq!(
            fixture
                .store
                .draw("missing", &fixture.scene, &fixture.layer, 0, stroke(1.0))
                .expect_err("draw"),
            "unknown document"
        );
        assert_eq!(
            fixture
                .store
                .draw(&fixture.doc.id, "missing", &fixture.layer, 0, stroke(1.0))
                .expect_err("scene"),
            "unknown scene"
        );
        assert_eq!(
            fixture
                .store
                .draw(&fixture.doc.id, &fixture.scene, "missing", 0, stroke(1.0))
                .expect_err("layer"),
            "unknown layer"
        );
        assert!(fixture
            .store
            .evaluate_range(&fixture.doc.id, &fixture.scene, 5, 1)
            .is_err());
        assert!(fixture
            .store
            .evaluate_range(&fixture.doc.id, &fixture.scene, 0, 601)
            .is_err());
    }

    #[test]
    fn atomic_write_replaces_previous_recovery() {
        let dir = std::env::temp_dir().join(format!("stickmate-atomic-{}", new_id("t")));
        fs::create_dir_all(&dir).expect("dir");
        let target = dir.join("doc.json");
        write_atomic(&target, b"first").expect("first");
        write_atomic(&target, b"second").expect("second");
        assert_eq!(fs::read(&target).expect("read"), b"second");
        assert!(!dir.join("doc.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn shape_serialization_uses_kind_tags() {
        let shape = stroke(5.0);
        let json = serde_json::to_value(&shape).expect("serialize");
        assert_eq!(json["kind"], "Stroke");
        let back: Shape = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, shape);
        let rect = Shape::Rect {
            x: 1.0,
            y: 2.0,
            w: 3.0,
            h: 4.0,
            fill: "#ff0000".to_string(),
            stroke: "#000000".to_string(),
            width: 1.0,
        };
        let back: Shape =
            serde_json::from_value(serde_json::to_value(&rect).expect("serialize")).expect("back");
        assert_eq!(back, rect);
    }

    fn polygon(sides: u32) -> Shape {
        Shape::Polygon {
            x: 200.0,
            y: 10.0,
            w: 20.0,
            h: 20.0,
            sides,
            fill: "#00ff00".to_string(),
            stroke: "#000000".to_string(),
            width: 1.0,
        }
    }

    fn text(value: &str, size: f64) -> Shape {
        Shape::Text {
            x: 300.0,
            y: 10.0,
            text: value.to_string(),
            size,
            family: "Segoe UI".to_string(),
            color: "#000000".to_string(),
            matrix: None,
        }
    }

    fn box_shape(x: f64, y: f64) -> Shape {
        Shape::Rect {
            x,
            y,
            w: 20.0,
            h: 20.0,
            fill: "#ff0000".to_string(),
            stroke: "#000000".to_string(),
            width: 1.0,
        }
    }

    fn line_stroke(from: f64, to: f64) -> Shape {
        let mut points = Vec::new();
        let mut x = from;
        while x <= to {
            points.push(Point { x, y: 50.0 });
            x += 2.0;
        }
        Shape::Stroke {
            points,
            color: "#000000".to_string(),
            width: 2.0,
        }
    }

    #[test]
    fn polygon_and_text_round_trip_and_draw() {
        let fixture = Fixture::new("newkinds");
        let id = &fixture.doc.id;
        for shape in [polygon(5), text("Hello", 24.0)] {
            let json = serde_json::to_value(&shape).expect("serialize");
            let back: Shape = serde_json::from_value(json).expect("deserialize");
            assert_eq!(back, shape);
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, shape)
                .expect("draw");
        }
        let json = serde_json::to_value(polygon(5)).expect("serialize");
        assert_eq!(json["kind"], "Polygon");
        assert_eq!(json["sides"], 5);
        let json = serde_json::to_value(text("Hi", 12.0)).expect("serialize");
        assert_eq!(json["kind"], "Text");
        let doc = fixture.store.get(id).expect("get");
        assert_eq!(fixture.target(&doc).keys[0].shapes.len(), 2);
    }

    #[test]
    fn draw_rejects_invalid_polygon_and_text() {
        let fixture = Fixture::new("badkinds");
        let id = &fixture.doc.id;
        assert_eq!(
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, polygon(2))
                .expect_err("sides"),
            "polygon needs at least 3 sides"
        );
        assert_eq!(
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, text("   ", 12.0))
                .expect_err("blank"),
            "text is empty"
        );
        assert_eq!(
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, text("Hi", 0.0))
                .expect_err("size"),
            "text size must be positive"
        );
        assert!(fixture.target(&fixture.doc).keys[0].shapes.is_empty());
        assert_eq!(fixture.store.undo(id).expect_err("undo"), "nothing to undo");
    }

    #[test]
    fn polygon_vertices_start_at_top_and_text_width_uses_advance() {
        let vertices = polygon_vertices(0.0, 0.0, 100.0, 100.0, 3);
        assert_eq!(vertices.len(), 3);
        assert!((vertices[0].x - 50.0).abs() < 1e-9);
        assert!(vertices[0].y.abs() < 1e-9);
        assert!(vertices[1].x > vertices[2].x);
        assert_eq!(text_width("AB", 10.0), 12.0);
    }

    #[test]
    fn eraser_splits_a_stroke_into_two() {
        let fixture = Fixture::new("split");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, line_stroke(0.0, 100.0))
            .expect("draw");
        let erased = fixture
            .store
            .erase(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![Point { x: 50.0, y: 50.0 }],
                4.0,
            )
            .expect("erase");
        let shapes = &fixture.target(&erased).keys[0].shapes;
        assert_eq!(shapes.len(), 2);
        for shape in shapes {
            match shape {
                Shape::Stroke { points, .. } => {
                    assert!(points.len() > 1);
                    assert!(points.iter().all(|p| (p.x - 50.0).abs() > 5.0));
                }
                _ => panic!("expected stroke"),
            }
        }
    }

    #[test]
    fn eraser_removes_only_touched_closed_shapes() {
        let fixture = Fixture::new("closed");
        let id = &fixture.doc.id;
        for shape in [
            box_shape(10.0, 10.0),
            Shape::Ellipse {
                x: 100.0,
                y: 10.0,
                w: 20.0,
                h: 20.0,
                fill: "#ff0000".to_string(),
                stroke: "#000000".to_string(),
                width: 1.0,
            },
            polygon(5),
            text("Hi", 10.0),
        ] {
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, shape)
                .expect("draw");
        }
        let erased = fixture
            .store
            .erase(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![Point { x: 20.0, y: 20.0 }],
                3.0,
            )
            .expect("erase");
        let shapes = &fixture.target(&erased).keys[0].shapes;
        assert_eq!(shapes.len(), 3);
        assert!(shapes.iter().all(|shape| !matches!(shape, Shape::Rect { .. })));
    }

    #[test]
    fn eraser_respects_polygon_geometry_not_its_box() {
        let fixture = Fixture::new("polyhit");
        let id = &fixture.doc.id;
        let triangle = Shape::Polygon {
            x: 0.0,
            y: 0.0,
            w: 100.0,
            h: 100.0,
            sides: 3,
            fill: "#ff0000".to_string(),
            stroke: "#000000".to_string(),
            width: 1.0,
        };
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, triangle)
            .expect("draw");
        let corner = fixture
            .store
            .erase(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![Point { x: 5.0, y: 5.0 }],
                1.0,
            )
            .expect("erase corner");
        assert_eq!(fixture.target(&corner).keys[0].shapes.len(), 1);
        let centre = fixture
            .store
            .erase(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![Point { x: 50.0, y: 50.0 }],
                1.0,
            )
            .expect("erase centre");
        assert!(fixture.target(&centre).keys[0].shapes.is_empty());
    }

    #[test]
    fn eraser_bridges_gaps_between_fast_pointer_samples() {
        let fixture = Fixture::new("densify");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(40.0, 40.0))
            .expect("draw");
        let erased = fixture
            .store
            .erase(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![Point { x: 0.0, y: 50.0 }, Point { x: 100.0, y: 50.0 }],
                2.0,
            )
            .expect("erase");
        assert!(fixture.target(&erased).keys[0].shapes.is_empty());
    }

    #[test]
    fn eraser_is_a_single_undo_step() {
        let fixture = Fixture::new("eraseundo");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, line_stroke(0.0, 100.0))
            .expect("stroke");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(40.0, 40.0))
            .expect("rect");
        fixture
            .store
            .erase(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![Point { x: 50.0, y: 50.0 }],
                6.0,
            )
            .expect("erase");
        let undone = fixture.store.undo(id).expect("undo");
        assert_eq!(fixture.target(&undone).keys[0].shapes.len(), 2);
    }

    #[test]
    fn eraser_rejects_bad_input_and_locked_layers() {
        let fixture = Fixture::new("erasebad");
        let id = &fixture.doc.id;
        let point = vec![Point { x: 1.0, y: 1.0 }];
        assert_eq!(
            fixture
                .store
                .erase(id, &fixture.scene, &fixture.layer, 0, Vec::new(), 4.0)
                .expect_err("empty"),
            "eraser path is empty"
        );
        assert_eq!(
            fixture
                .store
                .erase(id, &fixture.scene, &fixture.layer, 0, point.clone(), 0.1)
                .expect_err("radius"),
            "eraser size is too small"
        );
        assert_eq!(
            fixture
                .store
                .erase(id, &fixture.scene, &fixture.layer, 0, vec![Point { x: 0.0, y: 0.0 }; 5_001], 4.0)
                .expect_err("long"),
            "eraser path is too long"
        );
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None)
            .expect("lock");
        assert_eq!(
            fixture
                .store
                .erase(id, &fixture.scene, &fixture.layer, 0, point, 4.0)
                .expect_err("locked"),
            "layer is locked"
        );
    }

    #[test]
    fn paint_shape_recolors_each_kind() {
        let fixture = Fixture::new("paint");
        let id = &fixture.doc.id;
        for shape in [box_shape(10.0, 10.0), stroke(1.0), polygon(6), text("Hi", 12.0)] {
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, shape)
                .expect("draw");
        }
        let mut doc = fixture.doc.clone();
        for index in 0..4 {
            doc = fixture
                .store
                .paint_shape(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    index,
                    "#123456".to_string(),
                )
                .expect("paint");
        }
        let shapes = &fixture.target(&doc).keys[0].shapes;
        assert!(matches!(&shapes[0], Shape::Rect { fill, .. } if fill == "#123456"));
        assert!(matches!(&shapes[1], Shape::Stroke { color, .. } if color == "#123456"));
        assert!(matches!(&shapes[2], Shape::Polygon { fill, .. } if fill == "#123456"));
        assert!(matches!(&shapes[3], Shape::Text { color, .. } if color == "#123456"));
        assert_eq!(
            fixture
                .store
                .paint_shape(id, &fixture.scene, &fixture.layer, 0, 9, "#000000".to_string())
                .expect_err("index"),
            "unknown shape"
        );
    }

    #[test]
    fn paint_shape_respects_locked_layers() {
        let fixture = Fixture::new("paintlocked");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(10.0, 10.0))
            .expect("draw");
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None)
            .expect("lock");
        assert_eq!(
            fixture
                .store
                .paint_shape(id, &fixture.scene, &fixture.layer, 0, 0, "#000000".to_string())
                .expect_err("locked"),
            "layer is locked"
        );
    }

    #[test]
    fn replace_shape_edits_text_and_polygon_in_place() {
        let fixture = Fixture::new("replace");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, text("Hi", 12.0))
            .expect("draw");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, polygon(5))
            .expect("draw");
        fixture
            .store
            .replace_shape(id, &fixture.scene, &fixture.layer, 0, 0, text("Hello", 24.0))
            .expect("replace");
        let doc = fixture
            .store
            .replace_shape(id, &fixture.scene, &fixture.layer, 0, 1, polygon(8))
            .expect("replace");
        let shapes = &fixture.target(&doc).keys[0].shapes;
        assert_eq!(shapes.len(), 2);
        assert!(matches!(&shapes[0], Shape::Text { text, size, .. } if text == "Hello" && *size == 24.0));
        assert!(matches!(&shapes[1], Shape::Polygon { sides, .. } if *sides == 8));
        assert_eq!(
            fixture
                .store
                .replace_shape(id, &fixture.scene, &fixture.layer, 0, 5, box_shape(0.0, 0.0))
                .expect_err("index"),
            "unknown shape"
        );
        assert_eq!(
            fixture
                .store
                .replace_shape(id, &fixture.scene, &fixture.layer, 0, 0, polygon(2))
                .expect_err("sides"),
            "polygon needs at least 3 sides"
        );
        assert_eq!(
            fixture
                .store
                .replace_shape(id, &fixture.scene, &fixture.layer, 0, 0, text("  ", 12.0))
                .expect_err("empty"),
            "text is empty"
        );
        let restored = fixture.store.undo(id).expect("undo");
        assert!(matches!(
            &fixture.target(&restored).keys[0].shapes[1],
            Shape::Polygon { sides, .. } if *sides == 5
        ));
    }

    #[test]
    fn replace_shape_respects_locked_layers() {
        let fixture = Fixture::new("replacelocked");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(10.0, 10.0))
            .expect("draw");
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None)
            .expect("lock");
        assert_eq!(
            fixture
                .store
                .replace_shape(id, &fixture.scene, &fixture.layer, 0, 0, box_shape(20.0, 20.0))
                .expect_err("locked"),
            "layer is locked"
        );
    }

    fn curve_nodes() -> Vec<PathNode> {
        vec![
            PathNode {
                point: Point { x: 0.0, y: 0.0 },
                handle_in: None,
                handle_out: Some(Point { x: 0.0, y: 100.0 }),
            },
            PathNode {
                point: Point { x: 100.0, y: 0.0 },
                handle_in: Some(Point { x: 100.0, y: 100.0 }),
                handle_out: None,
            },
        ]
    }

    fn curve_path(closed: bool) -> Shape {
        Shape::Path {
            nodes: curve_nodes(),
            closed,
            fill: "#ff0000".to_string(),
            stroke: "#000000".to_string(),
            width: 1.0,
        }
    }

    #[test]
    fn flatten_path_samples_cubic_segments() {
        let flat = flatten_path(&curve_nodes(), false);
        assert_eq!(flat.len(), 1 + PATH_STEPS);
        assert_eq!(flat[0], Point { x: 0.0, y: 0.0 });
        assert_eq!(flat[4], Point { x: 15.625, y: 56.25 });
        assert_eq!(flat[8], Point { x: 50.0, y: 75.0 });
        assert_eq!(flat[16], Point { x: 100.0, y: 0.0 });
        let mut triangle = curve_nodes();
        triangle.push(PathNode {
            point: Point { x: 50.0, y: -50.0 },
            handle_in: None,
            handle_out: None,
        });
        let closed = flatten_path(&triangle, true);
        assert_eq!(closed.len(), 1 + 3 * PATH_STEPS);
        assert_eq!(closed.last(), closed.first());
        assert_eq!(flatten_path(&[], false).len(), 0);
    }

    #[test]
    fn path_hit_follows_the_curve_not_the_chord() {
        let shape = curve_path(false);
        assert!(shape_hit(&shape, &Point { x: 50.0, y: 75.0 }, 1.0));
        assert!(!shape_hit(&shape, &Point { x: 50.0, y: 0.0 }, 1.0));
        let closed = curve_path(true);
        assert!(shape_hit(&closed, &Point { x: 50.0, y: 30.0 }, 1.0));
        assert!(!shape_hit(&closed, &Point { x: 50.0, y: -10.0 }, 1.0));
    }

    #[test]
    fn path_validation_rejects_bad_input() {
        let fixture = Fixture::new("pathbad");
        let id = &fixture.doc.id;
        let single = Shape::Path {
            nodes: vec![PathNode {
                point: Point { x: 0.0, y: 0.0 },
                handle_in: None,
                handle_out: None,
            }],
            closed: false,
            fill: "#ff0000".to_string(),
            stroke: "#000000".to_string(),
            width: 1.0,
        };
        assert_eq!(
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, single)
                .expect_err("single"),
            "path needs at least 2 nodes"
        );
        assert_eq!(
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, curve_path(true))
                .expect_err("closed two"),
            "closed path needs at least 3 nodes"
        );
        let mut nodes = curve_nodes();
        nodes[0].handle_out = Some(Point { x: f64::NAN, y: 0.0 });
        let non_finite = Shape::Path {
            nodes,
            closed: false,
            fill: "#ff0000".to_string(),
            stroke: "#000000".to_string(),
            width: 1.0,
        };
        assert_eq!(
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, non_finite)
                .expect_err("nan"),
            "path coordinates must be finite"
        );
        let zero_width = Shape::Path {
            nodes: curve_nodes(),
            closed: false,
            fill: "#ff0000".to_string(),
            stroke: "#000000".to_string(),
            width: 0.0,
        };
        assert_eq!(
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, zero_width)
                .expect_err("width"),
            "width must be between 0.5 and 200"
        );
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, curve_path(false))
            .expect("draw");
        let mut shrunk = curve_nodes();
        shrunk.pop();
        assert_eq!(
            fixture
                .store
                .replace_shape(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    0,
                    Shape::Path {
                        nodes: shrunk,
                        closed: false,
                        fill: "#ff0000".to_string(),
                        stroke: "#000000".to_string(),
                        width: 1.0,
                    }
                )
                .expect_err("shrunk"),
            "path needs at least 2 nodes"
        );
        assert_eq!(fixture.target(&fixture.store.get(id).expect("get")).keys[0].shapes.len(), 1);
    }

    #[test]
    fn path_serialization_uses_kind_tag_and_null_handles() {
        let shape = curve_path(false);
        let json = serde_json::to_value(&shape).expect("serialize");
        assert_eq!(json["kind"], "Path");
        assert_eq!(json["nodes"][0]["handle_in"], serde_json::Value::Null);
        assert_eq!(json["nodes"][0]["handle_out"]["y"], 100.0);
        let back: Shape = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, shape);
    }

    #[test]
    fn eraser_deletes_a_crossed_path() {
        let fixture = Fixture::new("patherase");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, curve_path(false))
            .expect("draw");
        let missed = fixture
            .store
            .erase(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![Point { x: 50.0, y: 0.0 }],
                2.0,
            )
            .expect("erase chord");
        assert_eq!(fixture.target(&missed).keys[0].shapes.len(), 1);
        let erased = fixture
            .store
            .erase(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![Point { x: 50.0, y: 75.0 }],
                2.0,
            )
            .expect("erase curve");
        assert!(fixture.target(&erased).keys[0].shapes.is_empty());
    }

    #[test]
    fn locked_layer_rejects_a_path_draw() {
        let fixture = Fixture::new("pathlocked");
        let id = &fixture.doc.id;
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None)
            .expect("lock");
        assert_eq!(
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, curve_path(false))
                .expect_err("locked"),
            "layer is locked"
        );
    }

    #[test]
    fn a_committed_path_is_one_undo_step() {
        let fixture = Fixture::new("pathundo");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, curve_path(false))
            .expect("draw");
        let undone = fixture.store.undo(id).expect("undo");
        assert!(fixture.target(&undone).keys[0].shapes.is_empty());
        let redone = fixture.store.redo(id).expect("redo");
        assert_eq!(fixture.target(&redone).keys[0].shapes.len(), 1);
        assert_eq!(fixture.store.undo(id).expect("undo again").scenes[0].layers[0].keys[0].shapes.len(), 0);
    }

    fn ellipse_shape(x: f64, y: f64, w: f64, h: f64) -> Shape {
        Shape::Ellipse {
            x,
            y,
            w,
            h,
            fill: "#ff0000".to_string(),
            stroke: "#000000".to_string(),
            width: 1.0,
        }
    }

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} != {b}");
    }

    #[test]
    fn affine_and_bounds_match_the_shared_contract() {
        let pivot = Point { x: 10.0, y: 10.0 };
        let matrix = affine_from(&pivot, 5.0, -3.0, 2.0, 3.0, 90.0);
        let moved = apply_affine(&matrix, &Point { x: 20.0, y: 30.0 });
        close(moved.x, -45.0);
        close(moved.y, 27.0);
        let identity = affine_from(&pivot, 0.0, 0.0, 1.0, 1.0, 0.0);
        let same = apply_affine(&identity, &Point { x: 7.0, y: -2.0 });
        close(same.x, 7.0);
        close(same.y, -2.0);
        let box_bounds = shape_bounds(&box_shape(10.0, 20.0));
        assert_eq!(
            box_bounds,
            Bounds { x: 10.0, y: 20.0, w: 20.0, h: 20.0 }
        );
        let stroke_bounds = shape_bounds(&stroke(4.0));
        assert_eq!(
            stroke_bounds,
            Bounds { x: 3.0, y: -1.0, w: 2.0, h: 12.0 }
        );
        let text_bounds = shape_bounds(&text("AB", 10.0));
        assert_eq!(
            text_bounds,
            Bounds { x: 300.0, y: 10.0, w: 12.0, h: 10.0 }
        );
        let path_bounds = shape_bounds(&curve_path(false));
        close(path_bounds.x, -0.5);
        close(path_bounds.y, -0.5);
        close(path_bounds.w, 101.0);
        close(path_bounds.h, 76.0);
    }

    #[test]
    fn transform_moves_selected_shapes_as_one_undo_step() {
        let fixture = Fixture::new("transform-move");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(10.0, 10.0))
            .expect("first");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(50.0))
            .expect("second");
        let before = fixture.store.get(id).expect("get");
        let pivot = Point { x: 0.0, y: 0.0 };
        let edited = fixture
            .store
            .transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 1], pivot, 7.0, -4.0, 1.0, 1.0, 0.0)
            .expect("move");
        let shapes = &fixture.target(&edited).keys[0].shapes;
        assert!(matches!(&shapes[0], Shape::Rect { x, y, w, h, .. } if *x == 17.0 && *y == 6.0 && *w == 20.0 && *h == 20.0));
        assert!(matches!(&shapes[1], Shape::Stroke { points, width, .. } if points[0].x == 57.0 && points[0].y == -4.0 && *width == 2.0));
        let undone = fixture.store.undo(id).expect("undo");
        assert_eq!(undone, before);
    }

    #[test]
    fn transform_scales_about_a_custom_pivot() {
        let fixture = Fixture::new("transform-scale");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(10.0, 10.0))
            .expect("draw");
        let pivot = Point { x: 10.0, y: 10.0 };
        let edited = fixture
            .store
            .transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0], pivot, 0.0, 0.0, 2.0, 3.0, 0.0)
            .expect("scale");
        assert!(matches!(
            &fixture.target(&edited).keys[0].shapes[0],
            Shape::Rect { x, y, w, h, width, .. } if *x == 10.0 && *y == 10.0 && *w == 40.0 && *h == 60.0 && *width == 1.0
        ));
        let ellipse = fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, ellipse_shape(0.0, 0.0, 20.0, 10.0))
            .expect("ellipse");
        let scaled = fixture
            .store
            .transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![1], Point { x: 0.0, y: 0.0 }, 0.0, 0.0, 2.0, 2.0, 0.0)
            .expect("scale ellipse");
        assert!(matches!(
            &fixture.target(&scaled).keys[0].shapes[1],
            Shape::Ellipse { x, y, w, h, .. } if *x == 0.0 && *y == 0.0 && *w == 40.0 && *h == 20.0
        ));
        assert_eq!(ellipse.scenes[0].layers[0].keys[0].shapes.len(), 2);
    }

    #[test]
    fn rotating_a_rect_becomes_a_faithful_four_node_path() {
        let fixture = Fixture::new("transform-rotate");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 0.0))
            .expect("draw");
        let pivot = Point { x: 10.0, y: 10.0 };
        let edited = fixture
            .store
            .transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0], pivot, 0.0, 0.0, 1.0, 1.0, 90.0)
            .expect("rotate");
        let shape = &fixture.target(&edited).keys[0].shapes[0];
        let Shape::Path { nodes, closed, fill, width, .. } = shape else {
            panic!("expected path");
        };
        assert!(*closed);
        assert_eq!(*fill, "#ff0000");
        assert_eq!(*width, 1.0);
        assert_eq!(nodes.len(), 4);
        let expected = [(20.0, 0.0), (20.0, 20.0), (0.0, 20.0), (0.0, 0.0)];
        for (node, (x, y)) in nodes.iter().zip(expected) {
            close(node.point.x, x);
            close(node.point.y, y);
            assert!(node.handle_in.is_none());
            assert!(node.handle_out.is_none());
        }
    }

    #[test]
    fn rotating_a_polygon_becomes_a_path_and_ellipse_quarter_turns_swap_axes() {
        let fixture = Fixture::new("transform-rotate-kinds");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, polygon(3))
            .expect("polygon");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, ellipse_shape(0.0, 0.0, 20.0, 10.0))
            .expect("ellipse");
        let pivot = Point { x: 0.0, y: 0.0 };
        let edited = fixture
            .store
            .transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0], pivot.clone(), 0.0, 0.0, 1.0, 1.0, 90.0)
            .expect("rotate polygon");
        let Shape::Path { nodes, closed, .. } = &fixture.target(&edited).keys[0].shapes[0] else {
            panic!("expected path");
        };
        assert!(*closed);
        assert_eq!(nodes.len(), 3);
        let turned = fixture
            .store
            .transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![1], pivot, 0.0, 0.0, 1.0, 1.0, 90.0)
            .expect("rotate ellipse");
        let Shape::Ellipse { x, y, w, h, .. } = &fixture.target(&turned).keys[0].shapes[1] else {
            panic!("expected ellipse");
        };
        close(*w, 10.0);
        close(*h, 20.0);
        close(*x, -10.0);
        close(*y, 0.0);
    }

    #[test]
    fn unrepresentable_transforms_are_rejected_without_changes() {
        let fixture = Fixture::new("transform-reject");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, text("Hi", 12.0))
            .expect("text");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, ellipse_shape(0.0, 0.0, 20.0, 10.0))
            .expect("ellipse");
        let before = fixture.store.get(id).expect("get");
        let pivot = Point { x: 0.0, y: 0.0 };
        assert_eq!(
            fixture
                .store
                .transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![1], pivot.clone(), 0.0, 0.0, 1.0, 1.0, 30.0)
                .expect_err("ellipse rotation"),
            "ellipse cannot be rotated"
        );
        assert_eq!(
            fixture
                .store
                .transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 1], pivot.clone(), 5.0, 5.0, 1.0, 1.0, 30.0)
                .expect_err("mixed batch"),
            "ellipse cannot be rotated"
        );
        assert_eq!(
            fixture
                .store
                .transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0], pivot.clone(), 0.0, 0.0, -1.0, 1.0, 0.0)
                .expect_err("negative scale"),
            "scale must be positive"
        );
        assert_eq!(
            fixture
                .store
                .transform_shapes(id, &fixture.scene, &fixture.layer, 0, Vec::new(), pivot.clone(), 0.0, 0.0, 1.0, 1.0, 0.0)
                .expect_err("empty"),
            "no shapes selected"
        );
        assert_eq!(
            fixture
                .store
                .transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![9], pivot, 0.0, 0.0, 1.0, 1.0, 0.0)
                .expect_err("index"),
            "unknown shape"
        );
        assert_eq!(fixture.store.get(id).expect("get"), before);
        let undone = fixture.store.undo(id).expect("undo");
        assert_eq!(fixture.target(&undone).keys[0].shapes.len(), 1);
    }

    #[test]
    fn text_affines_compose_preserve_content_and_undo() {
        let fixture = Fixture::new("text-affines");
        let id = &fixture.doc.id;
        let original = fixture.store.draw(id, &fixture.scene, &fixture.layer, 0, text("A𐐀", 12.0)).unwrap();
        let pivot = Point { x: 15.0, y: -4.0 };
        let first = affine_from(&pivot, 7.0, -9.0, 2.0, 3.0, 35.0);
        let second = affine_from(&pivot, -2.0, 8.0, 4.0, 0.5, -70.0);
        let rotated = fixture.store.transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0], pivot.clone(), 7.0, -9.0, 2.0, 3.0, 35.0).unwrap();
        let stretched = fixture.store.transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0], pivot.clone(), -2.0, 8.0, 4.0, 0.5, -70.0).unwrap();
        let moved = fixture.store.transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0], pivot.clone(), 5.0, 6.0, 2.0, 2.0, 0.0).unwrap();
        let third = affine_from(&pivot, 5.0, 6.0, 2.0, 2.0, 0.0);
        let shape = &fixture.target(&moved).keys[0].shapes[0];
        let Shape::Text { x, y, text, size, family, matrix: Some(matrix), .. } = shape else {
            panic!("expected editable transformed text");
        };
        assert_eq!((*x, *y, *size), (300.0, 10.0, 12.0));
        assert_eq!(text, "A𐐀");
        assert_eq!(family, "Segoe UI");
        for point in text_corners(*x, *y, text, *size, &None) {
            let expected = apply_affine(&third, &apply_affine(&second, &apply_affine(&first, &point)));
            let actual = apply_affine(matrix, &point);
            close(actual.x, expected.x);
            close(actual.y, expected.y);
        }
        let json = serde_json::to_string(shape).unwrap();
        let mut restored = serde_json::from_str::<Shape>(&json).unwrap();
        if let Shape::Text { matrix: Some(m), .. } = &mut restored {
            for (actual, expected) in [m.a, m.b, m.c, m.d, m.e, m.f].into_iter()
                .zip([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]) {
                close(actual, expected);
            }
            *m = *matrix;
        }
        assert_eq!(restored, *shape);
        assert_eq!(fixture.store.undo(id).unwrap(), stretched);
        assert_eq!(fixture.store.undo(id).unwrap(), rotated);
        assert_eq!(fixture.store.undo(id).unwrap(), original);
        assert_eq!(fixture.store.redo(id).unwrap(), rotated);
    }

    #[test]
    fn text_bounds_and_hits_follow_the_transformed_rectangle() {
        let mut shape = text("AB", 10.0);
        if let Shape::Text { x, y, matrix, .. } = &mut shape {
            *x = 0.0;
            *y = 0.0;
            *matrix = Some(Affine { a: 2.0, b: 2.0, c: -1.0, d: 1.0, e: 10.0, f: 20.0 });
        }
        assert_eq!(shape_bounds(&shape), Bounds { x: 0.0, y: 20.0, w: 34.0, h: 34.0 });
        assert!(shape_hit(&shape, &Point { x: 17.0, y: 37.0 }, 0.0));
        assert!(!shape_hit(&shape, &Point { x: 1.0, y: 21.0 }, 1.0));
        assert!(!shape_hit(&shape, &Point { x: 23.0, y: 31.0 }, 1.0));
        assert!(shape_hit(&shape, &Point { x: 23.0, y: 31.0 }, 1.5));
        assert!(!shape_hit(&shape, &Point { x: 10.0, y: 18.0 }, 1.5));
        assert!(shape_hit(&shape, &Point { x: 10.0, y: 18.0 }, 2.0));
        if let Shape::Text { matrix: Some(m), .. } = &mut shape {
            m.c = 0.0;
            m.d = 0.0;
        }
        assert!(shape_hit(&shape, &Point { x: 22.0, y: 32.0 }, 0.0));
        assert!(!shape_hit(&shape, &Point { x: 23.0, y: 31.0 }, 1.0));
    }

    #[test]
    fn text_matrix_is_optional_and_validated() {
        let original = text("Hi", 12.0);
        let json = serde_json::to_value(&original).unwrap();
        assert!(json.get("matrix").is_none());
        assert_eq!(serde_json::from_value::<Shape>(json).unwrap(), original);
        for size in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(validate(&text("Hi", size)).is_err());
        }
        for index in 0..6 {
            for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                let mut values = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
                values[index] = invalid;
                let mut shape = original.clone();
                if let Shape::Text { matrix, .. } = &mut shape {
                    let [a, b, c, d, e, f] = values;
                    *matrix = Some(Affine { a, b, c, d, e, f });
                }
                assert_eq!(validate(&shape).unwrap_err(), "text matrix must be finite");
            }
        }
    }

    #[test]
    fn uniform_text_scale_and_path_handles_transform() {
        let fixture = Fixture::new("transform-text-path");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, text("Hi", 12.0))
            .expect("text");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, curve_path(false))
            .expect("path");
        let pivot = Point { x: 0.0, y: 0.0 };
        let edited = fixture
            .store
            .transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 1], pivot, 0.0, 0.0, 2.0, 2.0, 0.0)
            .expect("scale");
        let shapes = &fixture.target(&edited).keys[0].shapes;
        assert!(matches!(&shapes[0], Shape::Text { x, y, size, .. } if *x == 600.0 && *y == 20.0 && *size == 24.0));
        let Shape::Path { nodes, width, .. } = &shapes[1] else {
            panic!("expected path");
        };
        assert_eq!(*width, 1.0);
        assert_eq!(nodes[0].point, Point { x: 0.0, y: 0.0 });
        assert_eq!(nodes[0].handle_out, Some(Point { x: 0.0, y: 200.0 }));
        assert_eq!(nodes[1].handle_in, Some(Point { x: 200.0, y: 200.0 }));
    }

    #[test]
    fn transform_on_a_held_frame_materializes_a_keyframe() {
        let fixture = Fixture::new("transform-held");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(10.0, 10.0))
            .expect("draw");
        for _ in 0..5 {
            fixture
                .store
                .insert_frame(id, &fixture.scene, &fixture.layer, 0)
                .expect("extend");
        }
        let pivot = Point { x: 0.0, y: 0.0 };
        let edited = fixture
            .store
            .transform_shapes(id, &fixture.scene, &fixture.layer, 5, vec![0], pivot, 3.0, 4.0, 1.0, 1.0, 0.0)
            .expect("move held");
        let target = fixture.target(&edited);
        assert_eq!(target.keys.len(), 2);
        assert_eq!(target.keys[1].frame, 5);
        assert!(matches!(&target.keys[0].shapes[0], Shape::Rect { x, y, .. } if *x == 10.0 && *y == 10.0));
        assert!(matches!(&target.keys[1].shapes[0], Shape::Rect { x, y, .. } if *x == 13.0 && *y == 14.0));
    }

    #[test]
    fn rejected_transform_on_a_held_frame_does_not_materialize() {
        let fixture = Fixture::new("transform-held-reject");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, ellipse_shape(0.0, 0.0, 20.0, 10.0))
            .expect("draw");
        for _ in 0..5 {
            fixture
                .store
                .insert_frame(id, &fixture.scene, &fixture.layer, 0)
                .expect("extend");
        }
        let before = fixture.store.get(id).expect("get");
        let pivot = Point { x: 0.0, y: 0.0 };
        assert_eq!(
            fixture
                .store
                .transform_shapes(id, &fixture.scene, &fixture.layer, 5, vec![0], pivot, 0.0, 0.0, 1.0, 1.0, 45.0)
                .expect_err("ellipse rotation"),
            "ellipse cannot be rotated"
        );
        assert_eq!(fixture.store.get(id).expect("get"), before);
        assert_eq!(fixture.target(&before).keys.len(), 1);
    }

    #[test]
    fn locked_layers_reject_every_shape_transform() {
        let fixture = Fixture::new("transform-locked");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(10.0, 10.0))
            .expect("draw");
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None)
            .expect("lock");
        let pivot = Point { x: 0.0, y: 0.0 };
        assert_eq!(
            fixture
                .store
                .transform_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0], pivot, 1.0, 1.0, 1.0, 1.0, 0.0)
                .expect_err("locked move"),
            "layer is locked"
        );
        assert_eq!(
            fixture
                .store
                .reorder_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0], true)
                .expect_err("locked reorder"),
            "layer is locked"
        );
        assert_eq!(
            fixture
                .store
                .delete_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0])
                .expect_err("locked delete"),
            "layer is locked"
        );
    }

    #[test]
    fn reorder_shapes_changes_stacking_in_one_undo_step() {
        let fixture = Fixture::new("transform-reorder");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 0.0))
            .expect("first");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(100.0, 0.0))
            .expect("second");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(200.0, 0.0))
            .expect("third");
        let front = fixture
            .store
            .reorder_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0], true)
            .expect("front");
        let xs: Vec<f64> = fixture
            .target(&front)
            .keys[0]
            .shapes
            .iter()
            .map(|shape| match shape {
                Shape::Rect { x, .. } => *x,
                _ => panic!("expected rect"),
            })
            .collect();
        assert_eq!(xs, vec![100.0, 200.0, 0.0]);
        let back = fixture
            .store
            .reorder_shapes(id, &fixture.scene, &fixture.layer, 0, vec![1, 2], false)
            .expect("back");
        let xs: Vec<f64> = fixture
            .target(&back)
            .keys[0]
            .shapes
            .iter()
            .map(|shape| match shape {
                Shape::Rect { x, .. } => *x,
                _ => panic!("expected rect"),
            })
            .collect();
        assert_eq!(xs, vec![200.0, 0.0, 100.0]);
        assert_eq!(
            fixture
                .store
                .reorder_shapes(id, &fixture.scene, &fixture.layer, 0, vec![9], true)
                .expect_err("index"),
            "unknown shape"
        );
    }

    #[test]
    fn delete_shapes_removes_all_selected_in_one_undo_step() {
        let fixture = Fixture::new("transform-delete");
        let id = &fixture.doc.id;
        for x in [0.0, 100.0, 200.0] {
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(x, 0.0))
                .expect("draw");
        }
        let before = fixture.store.get(id).expect("get");
        let edited = fixture
            .store
            .delete_shapes(id, &fixture.scene, &fixture.layer, 0, vec![2, 0])
            .expect("delete");
        let shapes = &fixture.target(&edited).keys[0].shapes;
        assert_eq!(shapes.len(), 1);
        assert!(matches!(&shapes[0], Shape::Rect { x, .. } if *x == 100.0));
        assert_eq!(fixture.store.undo(id).expect("undo"), before);
        assert_eq!(
            fixture
                .store
                .delete_shapes(id, &fixture.scene, &fixture.layer, 0, vec![4])
                .expect_err("index"),
            "unknown shape"
        );
        assert_eq!(
            fixture
                .store
                .delete_shapes(id, &fixture.scene, &fixture.layer, 0, Vec::new())
                .expect_err("empty"),
            "no shapes selected"
        );
    }

    #[test]
    fn duplicate_layer_copies_content_with_a_fresh_id() {
        let fixture = Fixture::new("dup-layer");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("first");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 4, stroke(2.0))
            .expect("second");
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, None, Some(0.5))
            .expect("opacity");
        let before = fixture.store.get(id).expect("get");
        let edited = fixture
            .store
            .duplicate_layer(id, &fixture.scene, &fixture.layer)
            .expect("duplicate");
        let scene = &edited.scenes[0];
        assert_eq!(scene.layers.len(), 2);
        let source = &scene.layers[0];
        let copy = &scene.layers[1];
        assert_ne!(copy.id, source.id);
        assert_eq!(copy.name, "Layer 1 copy");
        assert_eq!(copy.visible, source.visible);
        assert_eq!(copy.locked, source.locked);
        assert_eq!(copy.opacity, 0.5);
        assert_eq!(copy.length, source.length);
        assert_eq!(copy.keys, source.keys);
        assert_eq!(source, fixture.target(&before));
        fixture
            .store
            .draw(id, &fixture.scene, &copy.id, 0, stroke(3.0))
            .expect("draw copy");
        let after = fixture.store.get(id).expect("get");
        assert_eq!(after.scenes[0].layers[0].keys[0].shapes.len(), 1);
        assert_eq!(after.scenes[0].layers[1].keys[0].shapes.len(), 2);
    }

    #[test]
    fn duplicate_layer_lands_after_the_source_and_is_one_undo_step() {
        let fixture = Fixture::new("dup-layer-position");
        let id = &fixture.doc.id;
        let top = fixture
            .store
            .add_layer(id, &fixture.scene, "Top".to_string())
            .expect("add");
        let top_id = top.scenes[0].layers[0].id.clone();
        let before = fixture.store.get(id).expect("get");
        let edited = fixture
            .store
            .duplicate_layer(id, &fixture.scene, &fixture.layer)
            .expect("duplicate");
        let names: Vec<String> = edited.scenes[0]
            .layers
            .iter()
            .map(|layer| layer.name.clone())
            .collect();
        assert_eq!(names, vec!["Top", "Layer 1", "Layer 1 copy"]);
        let edited = fixture
            .store
            .duplicate_layer(id, &fixture.scene, &top_id)
            .expect("duplicate top");
        let names: Vec<String> = edited.scenes[0]
            .layers
            .iter()
            .map(|layer| layer.name.clone())
            .collect();
        assert_eq!(names, vec!["Top", "Top copy", "Layer 1", "Layer 1 copy"]);
        let mut ids: Vec<String> = edited.scenes[0]
            .layers
            .iter()
            .map(|layer| layer.id.clone())
            .collect();
        let count = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), count);
        let undone = fixture.store.undo(id).expect("undo top");
        assert_eq!(undone.scenes[0].layers.len(), 3);
        assert_eq!(fixture.store.undo(id).expect("undo"), before);
    }

    #[test]
    fn duplicate_layer_is_allowed_on_a_locked_layer() {
        let fixture = Fixture::new("dup-layer-locked");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("draw");
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None)
            .expect("lock");
        let before = fixture.store.get(id).expect("get");
        let edited = fixture
            .store
            .duplicate_layer(id, &fixture.scene, &fixture.layer)
            .expect("duplicate locked");
        assert_eq!(edited.scenes[0].layers.len(), 2);
        assert!(edited.scenes[0].layers[1].locked);
        assert_eq!(&edited.scenes[0].layers[0], fixture.target(&before));
        assert_eq!(fixture.store.undo(id).expect("undo"), before);
    }

    #[test]
    fn duplicate_layer_rejects_unknown_targets() {
        let fixture = Fixture::new("dup-layer-unknown");
        let id = &fixture.doc.id;
        let before = fixture.store.get(id).expect("get");
        assert_eq!(
            fixture
                .store
                .duplicate_layer(id, &fixture.scene, "missing")
                .expect_err("layer"),
            "unknown layer"
        );
        assert_eq!(
            fixture
                .store
                .duplicate_layer(id, "missing", &fixture.layer)
                .expect_err("scene"),
            "unknown scene"
        );
        assert_eq!(fixture.store.get(id).expect("get"), before);
        assert_eq!(
            fixture.store.undo(id).expect_err("undo"),
            "nothing to undo"
        );
    }

    #[test]
    fn history_names_each_edit() {
        let fixture = Fixture::new("hist-names");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("draw");
        fixture
            .store
            .insert_frame(id, &fixture.scene, &fixture.layer, 0)
            .expect("insert");
        fixture
            .store
            .set_layer(
                id,
                &fixture.scene,
                &fixture.layer,
                Some("Ink".to_string()),
                None,
                None,
                None,
            )
            .expect("rename");
        let steps = fixture.store.history(id).expect("history");
        let names: Vec<&str> = steps.iter().map(|step| step.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["new_document", "draw_stroke", "insert_frame", "rename_layer"]
        );
        assert!(steps[..3].iter().all(|step| step.kind == "undo"));
        assert_eq!(steps[3].kind, "current");
        assert_eq!(steps[3].index, 3);
        assert!(steps.iter().all(|step| step.at > 0));
    }

    #[test]
    fn draw_names_follow_shape_kind() {
        let fixture = Fixture::new("hist-shapes");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                Shape::Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 10.0,
                    h: 10.0,
                    fill: "#ffffff".to_string(),
                    stroke: "#000000".to_string(),
                    width: 1.0,
                },
            )
            .expect("rect");
        fixture
            .store
            .draw(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                Shape::Text {
                    x: 0.0,
                    y: 0.0,
                    text: "hi".to_string(),
                    size: 12.0,
                    family: "Segoe UI".to_string(),
                    color: "#000000".to_string(),
                    matrix: None,
                },
            )
            .expect("text");
        let steps = fixture.store.history(id).expect("history");
        assert_eq!(steps[1].name, "draw_rect");
        assert_eq!(steps[2].name, "draw_text");
    }

    #[test]
    fn undo_and_redo_keep_names_and_kinds() {
        let fixture = Fixture::new("hist-undo");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("first");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(2.0))
            .expect("second");
        fixture.store.undo(id).expect("undo");
        let steps = fixture.store.history(id).expect("history");
        let kinds: Vec<&str> = steps.iter().map(|step| step.kind.as_str()).collect();
        assert_eq!(kinds, vec!["undo", "current", "redo"]);
        assert!(steps.iter().all(|step| step.at > 0));
        assert_eq!(steps[2].name, "draw_stroke");
        fixture.store.redo(id).expect("redo");
        let steps = fixture.store.history(id).expect("history");
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[2].kind, "current");
    }

    #[test]
    fn jump_backward_then_forward_keeps_history() {
        let fixture = Fixture::new("hist-jump");
        let id = &fixture.doc.id;
        let first = fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("first");
        fixture
            .store
            .insert_frame(id, &fixture.scene, &fixture.layer, 0)
            .expect("insert");
        let latest = fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(2.0))
            .expect("second");
        let jumped = fixture.store.jump(id, 1).expect("jump back");
        assert_eq!(jumped, first);
        let steps = fixture.store.history(id).expect("history");
        let kinds: Vec<&str> = steps.iter().map(|step| step.kind.as_str()).collect();
        assert_eq!(kinds, vec!["undo", "current", "redo", "redo"]);
        let undone = fixture.store.undo(id).expect("undo after jump");
        assert_eq!(undone, fixture.doc);
        fixture.store.redo(id).expect("redo one");
        fixture.store.redo(id).expect("redo two");
        let redone = fixture.store.redo(id).expect("redo three");
        assert_eq!(redone, latest);
        assert_eq!(
            fixture.store.redo(id).expect_err("redo empty"),
            "nothing to redo"
        );
        let undone = fixture.store.undo(id).expect("undo again");
        assert_ne!(undone, latest);
        assert_eq!(fixture.store.history(id).expect("history")[2].kind, "current");
    }

    #[test]
    fn jump_to_current_is_a_noop() {
        let fixture = Fixture::new("hist-jump-self");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("draw");
        let jumped = fixture.store.jump(id, 1).expect("jump");
        assert_eq!(jumped, fixture.store.get(id).expect("get"));
        assert_eq!(fixture.store.history(id).expect("history").len(), 2);
    }

    #[test]
    fn jump_rejects_out_of_range_and_unknown_document() {
        let fixture = Fixture::new("hist-jump-bad");
        let id = &fixture.doc.id;
        assert_eq!(
            fixture.store.jump(id, 1).expect_err("range"),
            "history step is out of range"
        );
        assert_eq!(
            fixture.store.jump("missing", 0).expect_err("document"),
            "unknown document"
        );
        assert_eq!(
            fixture.store.history("missing").expect_err("document"),
            "unknown document"
        );
    }

    #[test]
    fn jump_is_per_document() {
        let fixture = Fixture::new("hist-jump-iso");
        let id = &fixture.doc.id;
        let other = fixture
            .store
            .create("Other".to_string(), 800, 600, 24, "#ffffff".to_string())
            .expect("other");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("draw a");
        fixture
            .store
            .draw(
                &other.id,
                &other.scenes[0].id,
                &other.scenes[0].layers[0].id,
                0,
                stroke(2.0),
            )
            .expect("draw b");
        fixture.store.jump(id, 0).expect("jump a");
        let steps = fixture.store.history(&other.id).expect("history b");
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[1].kind, "current");
        assert_eq!(
            fixture.store.get(&other.id).expect("get b"),
            fixture.store.get(&other.id).expect("get b again")
        );
        assert_eq!(
            fixture.target(&fixture.store.get(&other.id).expect("get b")).keys[0]
                .shapes
                .len(),
            1
        );
        assert!(fixture
            .target(&fixture.store.get(id).expect("get a"))
            .keys[0]
            .shapes
            .is_empty());
    }

    #[test]
    fn jump_rewrites_recovery_file() {
        let fixture = Fixture::new("hist-jump-disk");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("draw");
        fixture.store.jump(id, 0).expect("jump");
        let path = fixture.store.dir.join(format!("{id}.json"));
        let file = read_recovery(&path).expect("recovery");
        assert_eq!(file.document, fixture.doc);
        let fresh = DocStore::load(fixture.store.dir.clone());
        assert_eq!(fresh.get(id).expect("get"), fixture.doc);
    }

    #[test]
    fn history_limit_keeps_named_steps_bounded() {
        let fixture = Fixture::new("hist-limit");
        let id = &fixture.doc.id;
        for _ in 0..105 {
            fixture
                .store
                .insert_frame(id, &fixture.scene, &fixture.layer, 0)
                .expect("insert");
        }
        let steps = fixture.store.history(id).expect("history");
        assert_eq!(steps.len(), HISTORY_LIMIT + 1);
        assert_eq!(steps[0].name, "insert_frame");
        assert_eq!(steps[0].kind, "undo");
        fixture.store.jump(id, 0).expect("jump");
        assert_eq!(
            fixture.target(&fixture.store.get(id).expect("get")).length,
            6
        );
    }

    #[test]
    fn checkpoint_save_list_restore_and_delete() {
        let fixture = Fixture::new("cp-flow");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("draw");
        let saved = fixture
            .store
            .checkpoint_save(id, "Before".to_string())
            .expect("save");
        assert_eq!(saved.name, "Before");
        assert!(saved.created_at > 0);
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(2.0))
            .expect("draw more");
        let list = fixture.store.checkpoint_list(id).expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, saved.id);
        let restored = fixture
            .store
            .checkpoint_restore(id, &saved.id)
            .expect("restore");
        assert_eq!(fixture.target(&restored).keys[0].shapes.len(), 1);
        let steps = fixture.store.history(id).expect("history");
        assert_eq!(steps.last().expect("step").name, "restore_checkpoint");
        let undone = fixture.store.undo(id).expect("undo restore");
        assert_eq!(fixture.target(&undone).keys[0].shapes.len(), 2);
        fixture
            .store
            .checkpoint_delete(id, &saved.id)
            .expect("delete");
        assert!(fixture.store.checkpoint_list(id).expect("list").is_empty());
        assert_eq!(
            fixture.store.checkpoint_delete(id, &saved.id).expect_err("gone"),
            "unknown checkpoint"
        );
        assert_eq!(
            fixture
                .store
                .checkpoint_restore(id, &saved.id)
                .expect_err("gone"),
            "unknown checkpoint"
        );
    }

    #[test]
    fn checkpoints_survive_a_fresh_load() {
        let fixture = Fixture::new("cp-persist");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("draw");
        let saved = fixture
            .store
            .checkpoint_save(id, "Keep".to_string())
            .expect("save");
        let untitled = fixture
            .store
            .create("   ".to_string(), 800, 600, 24, "#ffffff".to_string())
            .expect("untitled");
        assert_eq!(untitled.name, "Untitled");
        let untitled_save = fixture
            .store
            .checkpoint_save(&untitled.id, "Untitled point".to_string())
            .expect("save untitled");
        let fresh = DocStore::load(fixture.store.dir.clone());
        let list = fresh.checkpoint_list(id).expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Keep");
        let untitled_list = fresh.checkpoint_list(&untitled.id).expect("list untitled");
        assert_eq!(untitled_list.len(), 1);
        assert_eq!(untitled_list[0].id, untitled_save.id);
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(2.0))
            .expect("draw more");
        let restored = fresh.checkpoint_restore(id, &saved.id).expect("restore");
        assert_eq!(fixture.target(&restored).keys[0].shapes.len(), 1);
    }

    #[test]
    fn checkpoint_names_are_validated() {
        let fixture = Fixture::new("cp-names");
        let id = &fixture.doc.id;
        assert_eq!(
            fixture
                .store
                .checkpoint_save(id, "   ".to_string())
                .expect_err("empty"),
            "checkpoint name is empty"
        );
        assert_eq!(
            fixture
                .store
                .checkpoint_save(id, "x".repeat(CHECKPOINT_NAME_LIMIT + 1))
                .expect_err("long"),
            "checkpoint name is too long"
        );
        for bad in ["a/b", "a\\b", "..", "a..b", "a\u{0}b", "a\nb"] {
            assert_eq!(
                fixture
                    .store
                    .checkpoint_save(id, bad.to_string())
                    .expect_err("invalid"),
                "checkpoint name is invalid"
            );
        }
        let saved = fixture
            .store
            .checkpoint_save(id, "  Trimmed  ".to_string())
            .expect("save");
        assert_eq!(saved.name, "Trimmed");
        assert_eq!(fixture.store.history(id).expect("history").len(), 1);
    }

    #[test]
    fn checkpoint_paths_reject_traversal() {
        let fixture = Fixture::new("cp-traversal");
        let id = &fixture.doc.id;
        let saved = fixture
            .store
            .checkpoint_save(id, "Safe".to_string())
            .expect("save");
        assert_eq!(
            fixture
                .store
                .checkpoint_restore(id, "../../evil")
                .expect_err("restore"),
            "invalid identifier"
        );
        assert_eq!(
            fixture
                .store
                .checkpoint_delete(id, "..\\evil")
                .expect_err("delete"),
            "invalid identifier"
        );
        assert_eq!(
            fixture.store.checkpoint_list("../escape").expect_err("list"),
            "invalid identifier"
        );
        assert_eq!(
            fixture
                .store
                .checkpoint_save("missing", "Nope".to_string())
                .expect_err("document"),
            "unknown document"
        );
        assert!(fixture.store.checkpoint_list(id).expect("list").len() == 1);
        assert_eq!(
            fixture.store.checkpoint_list(id).expect("list")[0].id,
            saved.id
        );
    }

    #[test]
    fn checkpoint_count_is_capped() {
        let fixture = Fixture::new("cp-count");
        let id = &fixture.doc.id;
        for index in 0..CHECKPOINT_COUNT_LIMIT {
            fixture
                .store
                .checkpoint_save(id, format!("Point {index}"))
                .expect("save");
        }
        assert_eq!(
            fixture
                .store
                .checkpoint_save(id, "One too many".to_string())
                .expect_err("cap"),
            "too many checkpoints"
        );
        let list = fixture.store.checkpoint_list(id).expect("list");
        assert_eq!(list.len(), CHECKPOINT_COUNT_LIMIT);
        fixture
            .store
            .checkpoint_delete(id, &list[0].id)
            .expect("delete");
        fixture
            .store
            .checkpoint_save(id, "Fits again".to_string())
            .expect("save");
    }

    #[test]
    fn checkpoint_size_is_capped() {
        let fixture = Fixture::new("cp-size");
        let id = &fixture.doc.id;
        fixture
            .store
            .edit_named(id, "bulk", |doc| {
                doc.scenes[0].layers[0].keys[0].shapes.push(Shape::Text {
                    x: 0.0,
                    y: 0.0,
                    text: "x".repeat(CHECKPOINT_SIZE_LIMIT + 1024),
                    size: 12.0,
                    family: "Segoe UI".to_string(),
                    color: "#000000".to_string(),
                    matrix: None,
                });
                Ok(())
            })
            .expect("bulk");
        assert_eq!(
            fixture
                .store
                .checkpoint_save(id, "Huge".to_string())
                .expect_err("size"),
            "checkpoint is too large"
        );
        assert!(fixture.store.checkpoint_list(id).expect("list").is_empty());
    }

    #[test]
    fn deleting_a_project_removes_its_checkpoints() {
        let fixture = Fixture::new("cp-delete-doc");
        let id = &fixture.doc.id;
        fixture
            .store
            .checkpoint_save(id, "Doomed".to_string())
            .expect("save");
        fixture.store.delete(id).expect("delete");
        assert!(fixture.store.checkpoint_list(id).expect("list").is_empty());
    }

    #[test]
    fn command_signatures_match_frontend() {
        let _: fn(State<'_, DocStore>, String) -> Result<Vec<HistoryStep>, String> = doc_history;
        let _: fn(State<'_, DocStore>, String, usize) -> Result<Document, String> =
            doc_history_jump;
        let _: fn(State<'_, DocStore>, String, String) -> Result<CheckpointInfo, String> =
            doc_checkpoint_save;
        let _: fn(State<'_, DocStore>, String) -> Result<Vec<CheckpointInfo>, String> =
            doc_checkpoint_list;
        let _: fn(State<'_, DocStore>, String, String) -> Result<Document, String> =
            doc_checkpoint_restore;
        let _: fn(State<'_, DocStore>, String, String) -> Result<(), String> =
            doc_checkpoint_delete;
    }
}

impl DocStore {
    pub fn duplicate_layer(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
    ) -> Result<Document, String> {
        self.edit_named(id, "duplicate_layer", |doc| {
            let index = doc.scene_index(scene_id)?;
            let scene = &mut doc.scenes[index];
            let at = scene.layer_index(layer_id)?;
            let mut copy = scene.layers[at].clone();
            copy.id = new_id("l");
            copy.name = format!("{} copy", copy.name);
            scene.layers.insert(at + 1, copy);
            Ok(())
        })
    }
}

#[tauri::command]
pub fn doc_duplicate_layer(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
) -> Result<Document, String> {
    store.duplicate_layer(&id, &scene_id, &layer_id)
}