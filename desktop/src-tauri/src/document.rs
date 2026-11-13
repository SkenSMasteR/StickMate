use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::boolean::{bool_history_name, combine, BoolOp};
use crate::path::{flatten_path, PathNode};
use crate::rig::{self, Bone, Figure};

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

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradientStop {
    pub offset: f64,
    pub color: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum Gradient {
    Linear { angle: f64, stops: Vec<GradientStop> },
    Radial { stops: Vec<GradientStop> },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Blend {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Effect {
    Blur { radius: f64 },
    Shadow { x: f64, y: f64, blur: f64, color: String },
}

impl Effect {
    pub fn sanitized(&self) -> Effect {
        match self {
            Effect::Blur { radius } => Effect::Blur {
                radius: clamp_effect(*radius),
            },
            Effect::Shadow { x, y, blur, color } => Effect::Shadow {
                x: x.clamp(-500.0, 500.0),
                y: y.clamp(-500.0, 500.0),
                blur: clamp_effect(*blur),
                color: color.clone(),
            },
        }
    }
}

fn clamp_effect(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 500.0)
    } else {
        0.0
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalMask {
    pub transform: Transform,
    pub shapes: Vec<Shape>,
}

impl Gradient {
    pub fn stops(&self) -> &[GradientStop] {
        match self {
            Gradient::Linear { stops, .. } | Gradient::Radial { stops, .. } => stops,
        }
    }
}

pub(crate) fn validate_gradient(gradient: &Gradient) -> Result<(), String> {
    let stops = gradient.stops();
    if stops.len() < 2 {
        return Err("gradient needs at least 2 stops".to_string());
    }
    if stops.len() > 32 {
        return Err("gradient has too many stops".to_string());
    }
    if matches!(gradient, Gradient::Linear { angle, .. } if !angle.is_finite()) {
        return Err("gradient angle must be finite".to_string());
    }
    let mut previous = 0.0;
    for (index, stop) in stops.iter().enumerate() {
        if !stop.offset.is_finite() || !(0.0..=1.0).contains(&stop.offset) {
            return Err("gradient stop offset must be between 0 and 1".to_string());
        }
        if index > 0 && stop.offset < previous {
            return Err("gradient stops must be in order".to_string());
        }
        if stop.color.len() > 1024 {
            return Err("gradient stop color is too long".to_string());
        }
        previous = stop.offset;
    }
    Ok(())
}

fn gradients_mixable(a: Option<&Gradient>, b: Option<&Gradient>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            std::mem::discriminant(left) == std::mem::discriminant(right)
                && left.stops().len() == right.stops().len()
        }
        _ => false,
    }
}

fn mix_stops(a: &[GradientStop], b: &[GradientStop], t: f64) -> Vec<GradientStop> {
    a.iter()
        .zip(b)
        .map(|(left, right)| GradientStop {
            offset: mix(left.offset, right.offset, t),
            color: mix_color(&left.color, &right.color, t),
        })
        .collect()
}

fn mix_gradient(a: &Option<Gradient>, b: &Option<Gradient>, t: f64) -> Option<Gradient> {
    match (a, b) {
        (
            Some(Gradient::Linear {
                angle,
                stops: left,
            }),
            Some(Gradient::Linear {
                angle: other_angle,
                stops: right,
            }),
        ) if left.len() == right.len() => Some(Gradient::Linear {
            angle: mix(*angle, *other_angle, t),
            stops: mix_stops(left, right, t),
        }),
        (
            Some(Gradient::Radial { stops: left }),
            Some(Gradient::Radial { stops: right }),
        ) if left.len() == right.len() => Some(Gradient::Radial {
            stops: mix_stops(left, right, t),
        }),
        _ => a.clone(),
    }
}

pub(crate) fn shape_gradient(shape: &Shape) -> Option<&Gradient> {
    match shape {
        Shape::Rect { gradient, .. }
        | Shape::Ellipse { gradient, .. }
        | Shape::Polygon { gradient, .. }
        | Shape::Path { gradient, .. } => gradient.as_ref(),
        _ => None,
    }
}

pub(crate) fn rotated_gradient(gradient: &Option<Gradient>, rotation: f64) -> Option<Gradient> {
    match gradient {
        Some(Gradient::Linear { angle, stops }) => Some(Gradient::Linear {
            angle: angle + rotation,
            stops: stops.clone(),
        }),
        other => other.clone(),
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKind {
    #[default]
    Graphic,
    MovieClip,
    Button,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoopMode {
    #[default]
    Loop,
    PlayOnce,
    SingleFrame,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Symbol {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: SymbolKind,
    pub layers: Vec<Layer>,
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
        #[serde(default)]
        gradient: Option<Gradient>,
    },
    Ellipse {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: String,
        stroke: String,
        width: f64,
        #[serde(default)]
        gradient: Option<Gradient>,
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
        #[serde(default)]
        gradient: Option<Gradient>,
    },
    Bitmap {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        source: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        matrix: Option<Affine>,
    },
    Text {
        x: f64,
        y: f64,
        text: String,
        size: f64,
        family: String,
        color: String,
        #[serde(default)]
        spacing: f64,
        #[serde(default = "default_leading")]
        leading: f64,
        #[serde(default)]
        align: TextAlign,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        matrix: Option<Affine>,
    },
    Path {
        nodes: Vec<PathNode>,
        closed: bool,
        fill: String,
        stroke: String,
        width: f64,
        #[serde(default)]
        gradient: Option<Gradient>,
    },
    Group {
        children: Vec<Shape>,
    },
    Figure {
        figure: Figure,
    },
    Instance {
        symbol: String,
        #[serde(default)]
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        matrix: Option<Affine>,
        #[serde(default = "default_true")]
        visible: bool,
        #[serde(default, rename = "firstFrame")]
        first_frame: u32,
        #[serde(default)]
        looping: LoopMode,
    },
}

fn default_true() -> bool {
    true
}

pub const TEXT_ADVANCE: f64 = 0.6;
pub const TEXT_LEADING: f64 = 1.2;

fn default_leading() -> f64 {
    TEXT_LEADING
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

pub fn text_lines(text: &str) -> Vec<&str> {
    text.split('\n').collect()
}

pub fn text_line_width(line: &str, size: f64, spacing: f64) -> f64 {
    let count = line.chars().count() as f64;
    if count == 0.0 {
        return 0.0;
    }
    (count * size * TEXT_ADVANCE + spacing * (count - 1.0)).max(0.0)
}

pub fn text_block_height(lines: usize, size: f64, leading: f64) -> f64 {
    size + size * leading * lines.saturating_sub(1) as f64
}

pub fn text_block_width(text: &str, size: f64, spacing: f64) -> f64 {
    text_lines(text)
        .iter()
        .map(|line| text_line_width(line, size, spacing))
        .fold(0.0, f64::max)
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

impl Default for Affine {
    fn default() -> Self {
        Affine {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 0.0,
            f: 0.0,
        }
    }
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

fn instance_matrix(matrix: &Option<Affine>) -> Affine {
    (*matrix).unwrap_or_default()
}

fn text_corners(
    x: f64,
    y: f64,
    text: &str,
    size: f64,
    spacing: f64,
    leading: f64,
    matrix: &Option<Affine>,
) -> Vec<Point> {
    let w = text_block_width(text, size, spacing);
    let h = text_block_height(text_lines(text).len(), size, leading);
    [
        Point { x, y },
        Point {
            x: x + w,
            y,
        },
        Point {
            x: x + w,
            y: y + h,
        },
        Point { x, y: y + h },
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

fn corners_of_box(x: f64, y: f64, w: f64, h: f64, matrix: &Option<Affine>) -> Vec<Point> {
    [
        Point { x, y },
        Point { x: x + w, y },
        Point {
            x: x + w,
            y: y + h,
        },
        Point { x, y: y + h },
    ]
    .into_iter()
    .map(|point| matrix.as_ref().map_or_else(|| point.clone(), |m| apply_affine(m, &point)))
    .collect()
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
            x,
            y,
            text,
            size,
            spacing,
            leading,
            matrix,
            ..
        } => points_bounds(
            &text_corners(*x, *y, text, *size, *spacing, *leading, matrix),
            0.0,
        ),
        Shape::Rect { x, y, w, h, .. }
        | Shape::Ellipse { x, y, w, h, .. }
        | Shape::Polygon { x, y, w, h, .. } => Bounds {
            x: *x,
            y: *y,
            w: *w,
            h: *h,
        },
        Shape::Bitmap {
            x,
            y,
            w,
            h,
            matrix,
            ..
        } => points_bounds(&corners_of_box(*x, *y, *w, *h, matrix), 0.0),
        Shape::Group { children } => {
            union_of(children, &(0..children.len()).collect::<Vec<_>>())
        }
        Shape::Figure { figure } => rig::figure_bounds(figure).unwrap_or(Bounds {
            x: figure.x,
            y: figure.y,
            w: 0.0,
            h: 0.0,
        }),
        Shape::Instance { matrix, .. } => {
            let origin = apply_affine(&instance_matrix(matrix), &Point { x: 0.0, y: 0.0 });
            Bounds {
                x: origin.x,
                y: origin.y,
                w: 0.0,
                h: 0.0,
            }
        }
    }
}

fn corners_path(
    corners: &[Point],
    matrix: &Affine,
    fill: &str,
    stroke: &str,
    width: f64,
    gradient: Option<Gradient>,
) -> Shape {
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
        gradient,
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
        Shape::Group { children } => Ok(Shape::Group {
            children: children
                .iter()
                .map(|child| transform_shape(child, matrix, sx, sy, rotation))
                .collect::<Result<Vec<_>, _>>()?,
        }),
        Shape::Figure { figure } => {
            if (sx - sy).abs() > 0.0001 {
                return Err("a figure cannot be stretched in one direction".to_string());
            }
            let scale = (matrix.a * matrix.d - matrix.b * matrix.c).sqrt();
            let grown = Affine {
                a: scale,
                b: 0.0,
                c: 0.0,
                d: scale,
                e: 0.0,
                f: 0.0,
            };
            let moved = apply_affine(matrix, &Point {
                x: figure.x,
                y: figure.y,
            });
            let mut bones = Vec::new();
            for bone in &figure.bones {
                bones.push(crate::rig::Bone {
                    anchor: Point {
                        x: bone.anchor.x * scale,
                        y: bone.anchor.y * scale,
                    },
                    length: bone.length * scale,
                    width: bone.width * scale,
                    art: bone
                        .art
                        .iter()
                        .map(|shape| transform_shape(shape, &grown, scale, scale, 0.0))
                        .collect::<Result<Vec<_>, _>>()?,
                    ..bone.clone()
                });
            }
            Ok(Shape::Figure {
                figure: Figure {
                    x: moved.x,
                    y: moved.y,
                    rotation: figure.rotation + rotation,
                    bones,
                },
            })
        }
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
            gradient,
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
            gradient: gradient.clone(),
        }),
        Shape::Text {
            x,
            y,
            text,
            size,
            family,
            color,
            spacing,
            leading,
            align,
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
                spacing: if simple { spacing * sx } else { *spacing },
                leading: *leading,
                align: *align,
                matrix: if simple {
                    None
                } else {
                    Some(local.as_ref().map_or(*matrix, |inner| compose_affine(matrix, inner)))
                },
            })
        }
        Shape::Bitmap {
            x,
            y,
            w,
            h,
            source,
            matrix: local,
        } => {
            let straight = local.is_none() && rotation == 0.0 && sx == sy;
            if straight {
                let scale = (matrix.a * matrix.d - matrix.b * matrix.c).sqrt();
                let corner = apply_affine(matrix, &Point { x: *x, y: *y });
                Ok(Shape::Bitmap {
                    x: corner.x,
                    y: corner.y,
                    w: w * scale,
                    h: h * scale,
                    source: source.clone(),
                    matrix: None,
                })
            } else {
                Ok(Shape::Bitmap {
                    x: *x,
                    y: *y,
                    w: *w,
                    h: *h,
                    source: source.clone(),
                    matrix: Some(local.as_ref().map_or(*matrix, |inner| {
                        compose_affine(matrix, inner)
                    })),
                })
            }
        }
        Shape::Ellipse {
            x,
            y,
            w,
            h,
            fill,
            stroke,
            width,
            gradient,
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
                gradient: gradient.clone(),
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
            gradient,
        } if rotation != 0.0 => {
            let corners = [
                Point { x: *x, y: *y },
                Point { x: x + w, y: *y },
                Point { x: x + w, y: y + h },
                Point { x: *x, y: y + h },
            ];
            Ok(corners_path(
                &corners,
                matrix,
                fill,
                stroke,
                *width,
                rotated_gradient(gradient, rotation),
            ))
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
            gradient,
        } if rotation != 0.0 => {
            let vertices = polygon_vertices(*x, *y, *w, *h, *sides);
            Ok(corners_path(
                &vertices,
                matrix,
                fill,
                stroke,
                *width,
                rotated_gradient(gradient, rotation),
            ))
        }
        Shape::Rect {
            x,
            y,
            w,
            h,
            fill,
            stroke,
            width,
            gradient,
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
                gradient: gradient.clone(),
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
            gradient,
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
                gradient: gradient.clone(),
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
            gradient,
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
                gradient: gradient.clone(),
            })
        }
        Shape::Instance {
            symbol,
            name,
            matrix: place,
            visible,
            first_frame,
            looping,
        } => Ok(Shape::Instance {
            symbol: symbol.clone(),
            name: name.clone(),
            matrix: Some(compose_affine(matrix, &instance_matrix(place))),
            visible: *visible,
            first_frame: *first_frame,
            looping: *looping,
        }),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlignMode {
    Left,
    CenterH,
    Right,
    Top,
    CenterV,
    Bottom,
    DistributeH,
    DistributeV,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlignReference {
    Stage,
    Selection,
}

impl AlignMode {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "left" => Ok(Self::Left),
            "center_h" => Ok(Self::CenterH),
            "right" => Ok(Self::Right),
            "top" => Ok(Self::Top),
            "center_v" => Ok(Self::CenterV),
            "bottom" => Ok(Self::Bottom),
            "distribute_h" => Ok(Self::DistributeH),
            "distribute_v" => Ok(Self::DistributeV),
            _ => Err("unknown align mode".to_string()),
        }
    }
}

impl AlignReference {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "stage" => Ok(Self::Stage),
            "selection" => Ok(Self::Selection),
            _ => Err("unknown align reference".to_string()),
        }
    }
}

fn union_of(source: &[Shape], indices: &[usize]) -> Bounds {
    let mut union: Option<Bounds> = None;
    for &index in indices {
        let Some(shape) = source.get(index) else {
            continue;
        };
        let item = shape_bounds(shape);
        union = Some(match union {
            None => item,
            Some(current) => {
                let x = current.x.min(item.x);
                let y = current.y.min(item.y);
                Bounds {
                    x,
                    y,
                    w: (current.x + current.w).max(item.x + item.w) - x,
                    h: (current.y + current.h).max(item.y + item.h) - y,
                }
            }
        });
    }
    union.unwrap_or(Bounds {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
    })
}

fn paint_fill(shape: &mut Shape, color: &str) {
    match shape {
        Shape::Rect { fill, gradient, .. }
        | Shape::Ellipse { fill, gradient, .. }
        | Shape::Polygon { fill, gradient, .. }
        | Shape::Path { fill, gradient, .. } => {
            *fill = color.to_string();
            *gradient = None;
        }
        Shape::Group { children } => {
            for child in children {
                paint_fill(child, color);
            }
        }
        Shape::Figure { figure } => {
            for bone in &mut figure.bones {
                bone.color = color.to_string();
                for shape in &mut bone.art {
                    paint_fill(shape, color);
                }
            }
        }
        _ => {}
    }
}

fn figure_of(shape: &Shape) -> Result<&crate::rig::Figure, String> {
    match shape {
        Shape::Figure { figure } => Ok(figure),
        _ => Err("shape is not a figure".to_string()),
    }
}

fn align_offsets(
    stage: Bounds,
    source: &[Shape],
    indices: &[usize],
    mode: AlignMode,
    reference: AlignReference,
) -> Vec<(usize, f64, f64)> {
    let reference_box = match reference {
        AlignReference::Stage => stage,
        AlignReference::Selection => union_of(source, indices),
    };
    let mut offsets: Vec<(usize, f64, f64)> = Vec::new();
    match mode {
        AlignMode::Left | AlignMode::CenterH | AlignMode::Right => {
            for &index in indices {
                let item = shape_bounds(&source[index]);
                let dx = match mode {
                    AlignMode::Left => reference_box.x - item.x,
                    AlignMode::Right => reference_box.x + reference_box.w - (item.x + item.w),
                    _ => reference_box.x + reference_box.w / 2.0 - (item.x + item.w / 2.0),
                };
                offsets.push((index, dx, 0.0));
            }
        }
        AlignMode::Top | AlignMode::CenterV | AlignMode::Bottom => {
            for &index in indices {
                let item = shape_bounds(&source[index]);
                let dy = match mode {
                    AlignMode::Top => reference_box.y - item.y,
                    AlignMode::Bottom => reference_box.y + reference_box.h - (item.y + item.h),
                    _ => reference_box.y + reference_box.h / 2.0 - (item.y + item.h / 2.0),
                };
                offsets.push((index, 0.0, dy));
            }
        }
        AlignMode::DistributeH | AlignMode::DistributeV => {
            if indices.len() >= 3 {
                let horizontal = mode == AlignMode::DistributeH;
                let mut placed: Vec<(f64, f64, usize)> = indices
                    .iter()
                    .map(|&index| {
                        let item = shape_bounds(&source[index]);
                        if horizontal {
                            (item.x, item.w, index)
                        } else {
                            (item.y, item.h, index)
                        }
                    })
                    .collect();
                placed.sort_by(|a, b| {
                    a.0.partial_cmp(&b.0)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then(a.2.cmp(&b.2))
                });
                let start = if horizontal {
                    reference_box.x
                } else {
                    reference_box.y
                };
                let span = if horizontal {
                    reference_box.w
                } else {
                    reference_box.h
                };
                let total: f64 = placed.iter().map(|item| item.1).sum();
                let gap = (span - total) / (placed.len() as f64 - 1.0);
                let mut cursor = start;
                for (edge, size, index) in placed {
                    let delta = cursor - edge;
                    if horizontal {
                        offsets.push((index, delta, 0.0));
                    } else {
                        offsets.push((index, 0.0, delta));
                    }
                    cursor += size + gap;
                }
            }
        }
    }
    offsets.retain(|(_, dx, dy)| *dx != 0.0 || *dy != 0.0);
    offsets
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
        Shape::Group { .. } | Shape::Instance { .. } => {
            let box_ = shape_bounds(shape);
            p.x >= box_.x - radius
                && p.x <= box_.x + box_.w + radius
                && p.y >= box_.y - radius
                && p.y <= box_.y + box_.h + radius
        }
        Shape::Figure { figure } => {
            let places = rig::places(figure);
            places.iter().enumerate().any(|(index, place)| {
                near_segment(p, &place.base, &place.tip, radius + figure.bones[index].width / 2.0)
                    || within(p, &place.tip, radius + figure.bones[index].width / 2.0)
            }) || rig::art_shapes(figure)
                .iter()
                .any(|shape| shape_hit(shape, p, radius))
        }
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
        Shape::Bitmap {
            x, y, w, h, matrix, ..
        } => {
            let vertices = corners_of_box(*x, *y, *w, *h, matrix);
            inside_polygon(p, &vertices)
                || vertices.iter().enumerate().any(|(index, a)| {
                    near_segment(p, a, &vertices[(index + 1) % vertices.len()], radius)
                })
        }
        Shape::Text {
            x,
            y,
            text,
            size,
            spacing,
            leading,
            matrix,
            ..
        } => {
            let vertices = text_corners(*x, *y, text, *size, *spacing, *leading, matrix);
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
    if let Some(gradient) = shape_gradient(shape) {
        validate_gradient(gradient)?;
    }
    match shape {
        Shape::Group { children } => {
            if children.is_empty() {
                return Err("group is empty".to_string());
            }
            for child in children {
                validate(child)?;
            }
            Ok(())
        }
        Shape::Polygon { sides, .. } if *sides < 3 => {
            Err("polygon needs at least 3 sides".to_string())
        }
        Shape::Text {
            x,
            y,
            text,
            size,
            spacing,
            leading,
            matrix,
            ..
        } => {
            if text.trim().is_empty() {
                return Err("text is empty".to_string());
            }
            if !size.is_finite() || *size <= 0.0 {
                return Err("text size must be positive".to_string());
            }
            if !spacing.is_finite() || *spacing < -500.0 || *spacing > 500.0 {
                return Err("text spacing must be between -500 and 500".to_string());
            }
            if !leading.is_finite() || *leading < 0.2 || *leading > 10.0 {
                return Err("text line spacing must be between 0.2 and 10".to_string());
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
            stroke,
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
            if *stroke != "none" && !(0.5..=200.0).contains(width) {
                return Err("width must be between 0.5 and 200".to_string());
            }
            Ok(())
        }
        Shape::Bitmap {
            x,
            y,
            w,
            h,
            source,
            matrix,
        } => {
            if !x.is_finite() || !y.is_finite() {
                return Err("bitmap coordinates must be finite".to_string());
            }
            if !w.is_finite() || !h.is_finite() || *w <= 0.0 || *h <= 0.0 || *w > 16384.0 || *h > 16384.0
            {
                return Err("bitmap size must be between 1 and 16384".to_string());
            }
            if !crate::media::looks_like_image(source) {
                return Err("bitmap must be an embedded png, jpeg, gif or svg".to_string());
            }
            if let Some(m) = matrix {
                if [m.a, m.b, m.c, m.d, m.e, m.f]
                    .iter()
                    .any(|value| !value.is_finite())
                {
                    return Err("bitmap matrix must be finite".to_string());
                }
            }
            Ok(())
        }
        Shape::Instance {
            symbol,
            name,
            matrix,
            ..
        } => {
            if symbol.is_empty() || symbol.len() > 256 {
                return Err("a symbol instance needs a library symbol".to_string());
            }
            if name.len() > 256 {
                return Err("symbol instance names must stay short".to_string());
            }
            if let Some(m) = matrix {
                if [m.a, m.b, m.c, m.d, m.e, m.f]
                    .iter()
                    .any(|value| !value.is_finite())
                {
                    return Err("symbol instance matrix must be finite".to_string());
                }
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

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Easing {
    #[serde(default = "Easing::linear_x1")]
    pub x1: f64,
    #[serde(default = "Easing::linear_y1")]
    pub y1: f64,
    #[serde(default = "Easing::linear_x2")]
    pub x2: f64,
    #[serde(default = "Easing::linear_y2")]
    pub y2: f64,
}

impl Easing {
    pub fn linear() -> Self {
        Self {
            x1: 0.0,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
        }
    }

    fn linear_x1() -> f64 {
        0.0
    }

    fn linear_y1() -> f64 {
        0.0
    }

    fn linear_x2() -> f64 {
        1.0
    }

    fn linear_y2() -> f64 {
        1.0
    }

    fn is_linear(self) -> bool {
        self.x1 == self.y1 && self.x2 == self.y2
    }

    fn sanitized(self) -> Self {
        let value = [self.x1, self.y1, self.x2, self.y2];
        if value.iter().any(|number| !number.is_finite()) {
            return Self::linear();
        }
        Self {
            x1: self.x1.clamp(0.0, 1.0),
            y1: self.y1.clamp(-1.0, 2.0),
            x2: self.x2.clamp(0.0, 1.0),
            y2: self.y2.clamp(-1.0, 2.0),
        }
    }
}

fn cubic_value(p1: f64, p2: f64, u: f64) -> f64 {
    let inv = 1.0 - u;
    3.0 * inv * inv * u * p1 + 3.0 * inv * u * u * p2 + u * u * u
}

fn cubic_slope(p1: f64, p2: f64, u: f64) -> f64 {
    let inv = 1.0 - u;
    3.0 * inv * inv * p1 + 6.0 * inv * u * (p2 - p1) + 3.0 * u * u * (1.0 - p2)
}

fn solve_curve_unit(x1: f64, x2: f64, target: f64) -> f64 {
    let mut u = target;
    let mut steps = 0;
    while steps < 8 {
        let error = cubic_value(x1, x2, u) - target;
        if error.abs() <= 1e-7 {
            return u;
        }
        let slope = cubic_slope(x1, x2, u);
        if slope.abs() <= 1e-7 {
            break;
        }
        let next = u - error / slope;
        if !(0.0..=1.0).contains(&next) {
            break;
        }
        u = next;
        steps += 1;
    }
    let mut low = 0.0;
    let mut high = 1.0;
    for _ in 0..32 {
        let middle = (low + high) / 2.0;
        if cubic_value(x1, x2, middle) < target {
            low = middle;
        } else {
            high = middle;
        }
    }
    (low + high) / 2.0
}

pub fn ease_progress(t: f64, easing: Easing) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    if easing.is_linear() {
        return t;
    }
    let u = solve_curve_unit(easing.x1, easing.x2, t);
    cubic_value(easing.y1, easing.y2, u)
}

#[derive(Clone, Debug, Deserialize)]
pub struct FrameRun {
    pub shapes: Vec<Shape>,
    pub span: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Keyframe {
    pub frame: u32,
    pub shapes: Vec<Shape>,
    pub transform: Transform,
    pub tween: bool,
    #[serde(default = "Easing::linear")]
    pub easing: Easing,
    pub label: Option<String>,
}

impl Keyframe {
    fn empty(frame: u32) -> Self {
        Self {
            frame,
            shapes: Vec::new(),
            transform: Transform::default(),
            tween: false,
            easing: Easing::linear(),
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
    #[serde(default)]
    pub blend: Blend,
    #[serde(default)]
    pub effects: Vec<Effect>,
    #[serde(default)]
    pub masked: bool,
    pub length: u32,
    pub keys: Vec<Keyframe>,
    #[serde(default)]
    pub folder: bool,
    #[serde(default)]
    pub children: Vec<Layer>,
}

impl Layer {
    fn new(name: String) -> Self {
        Self {
            id: new_id("l"),
            name,
            visible: true,
            locked: false,
            opacity: 1.0,
            blend: Blend::default(),
            effects: Vec::new(),
            masked: false,
            length: 1,
            keys: vec![Keyframe::empty(0)],
            folder: false,
            children: Vec::new(),
        }
    }

    fn new_folder(name: String) -> Self {
        Self {
            id: new_id("l"),
            name,
            visible: true,
            locked: false,
            opacity: 1.0,
            blend: Blend::default(),
            effects: Vec::new(),
            masked: false,
            length: 0,
            keys: Vec::new(),
            folder: true,
            children: Vec::new(),
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
                easing: Easing::linear(),
                label: None,
            },
            None => Keyframe::empty(frame),
        };
        let index = self.keys.iter().filter(|k| k.frame < frame).count();
        self.keys.insert(index, key);
        self.length = self.length.max(frame + 1);
        index
    }

    pub(crate) fn content_length(&self) -> u32 {
        if self.folder {
            self.children
                .iter()
                .map(Layer::content_length)
                .max()
                .unwrap_or(1)
                .max(1)
        } else {
            self.length
        }
    }

    pub(crate) fn writable(&self) -> Result<(), String> {
        if self.locked {
            Err("layer is locked".to_string())
        } else {
            Ok(())
        }
    }
}

pub(crate) const MAX_FOLDER_DEPTH: usize = 16;

pub(crate) fn find_layer<'a>(layers: &'a [Layer], id: &str) -> Option<&'a Layer> {
    layers.iter().find_map(|layer| {
        if layer.id == id {
            Some(layer)
        } else {
            find_layer(&layer.children, id)
        }
    })
}

fn layer_path(layers: &[Layer], id: &str, trail: &[usize]) -> Option<Vec<usize>> {
    for (index, layer) in layers.iter().enumerate() {
        let mut next = trail.to_vec();
        next.push(index);
        if layer.id == id {
            return Some(next);
        }
        if let Some(found) = layer_path(&layer.children, id, &next) {
            return Some(found);
        }
    }
    None
}

fn descend<'a>(layers: &'a mut [Layer], path: &[usize]) -> Option<&'a mut Layer> {
    let (&first, rest) = path.split_first()?;
    let item = layers.get_mut(first)?;
    if rest.is_empty() {
        return Some(item);
    }
    descend(&mut item.children, rest)
}

fn ancestor_locked(layers: &[Layer], path: &[usize]) -> bool {
    let mut current = layers;
    let mut locked = false;
    for (depth, index) in path.iter().enumerate() {
        let Some(layer) = current.get(*index) else {
            return locked;
        };
        if depth + 1 == path.len() {
            return locked;
        }
        locked |= layer.locked;
        current = &layer.children;
    }
    locked
}

pub(crate) fn find_layer_mut<'a>(
    layers: &'a mut [Layer],
    id: &str,
) -> Option<(&'a mut Layer, bool)> {
    let path = layer_path(layers, id, &[])?;
    let inherited = ancestor_locked(layers, &path);
    Some((descend(layers, &path)?, inherited))
}

pub(crate) fn leaf_count(layers: &[Layer]) -> usize {
    layers
        .iter()
        .map(|layer| {
            if layer.folder {
                leaf_count(&layer.children)
            } else {
                1
            }
        })
        .sum()
}

pub(crate) fn contains_layer(layers: &[Layer], id: &str) -> bool {
    layers
        .iter()
        .any(|layer| layer.id == id || contains_layer(&layer.children, id))
}

fn validate_folders(layers: &[Layer], level: usize, ids: &mut Vec<String>) -> Result<(), String> {
    for layer in layers {
        if level > MAX_FOLDER_DEPTH {
            return Err("folders cannot nest deeper than 16 levels".to_string());
        }
        if layer.id.is_empty() || ids.contains(&layer.id) {
            return Err("duplicate layer id".to_string());
        }
        ids.push(layer.id.clone());
        if layer.folder {
            if !layer.keys.is_empty() || layer.masked {
                return Err("folders cannot hold keyframes or clips".to_string());
            }
            validate_folders(&layer.children, level + 1, ids)?;
        } else if !layer.children.is_empty() {
            return Err("only folders can hold layers".to_string());
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub layers: Vec<Layer>,
}

fn validate_layer_masks(layers: &mut [Layer]) {
    for index in 1..layers.len() {
        let provider_clipped = layers[index - 1].masked || layers[index - 1].folder;
        if layers[index].folder || layers[index].masked && provider_clipped {
            layers[index].masked = false;
        }
    }
    if let Some(top) = layers.first_mut() {
        top.masked = false;
    }
    for layer in layers.iter_mut() {
        validate_layer_masks(&mut layer.children);
    }
}

fn validate_scene_masks(scene: &mut Scene) -> Result<(), String> {
    let mut ids = Vec::new();
    validate_folders(&scene.layers, 1, &mut ids)?;
    validate_layer_masks(&mut scene.layers);
    Ok(())
}

fn remove_layer_tree(layers: &mut Vec<Layer>, layer_id: &str) -> Result<Layer, String> {
    if let Some(index) = layers.iter().position(|layer| layer.id == layer_id) {
        return Ok(layers.remove(index));
    }
    for layer in layers.iter_mut() {
        if let Ok(removed) = remove_layer_tree(&mut layer.children, layer_id) {
            return Ok(removed);
        }
    }
    Err("unknown layer".to_string())
}

fn insert_layer_tree(
    layers: &mut Vec<Layer>,
    parent: Option<&str>,
    index: usize,
    layer: Layer,
) -> Result<(), String> {
    let Some(parent_id) = parent else {
        let at = index.min(layers.len());
        layers.insert(at, layer);
        return Ok(());
    };
    for current in layers.iter_mut() {
        if current.id == parent_id {
            if !current.folder {
                return Err("target is not a folder".to_string());
            }
            let at = index.min(current.children.len());
            current.children.insert(at, layer);
            return Ok(());
        }
        if find_layer(&current.children, parent_id).is_some() {
            return insert_layer_tree(&mut current.children, Some(parent_id), index, layer);
        }
    }
    Err("unknown folder".to_string())
}

fn layer_depth(layers: &[Layer], layer_id: &str, level: usize) -> Option<usize> {
    layers.iter().find_map(|layer| {
        if layer.id == layer_id {
            Some(level)
        } else {
            layer_depth(&layer.children, layer_id, level + 1)
        }
    })
}

fn subtree_height(layer: &Layer) -> usize {
    1 + layer
        .children
        .iter()
        .map(subtree_height)
        .max()
        .unwrap_or(0)
}

fn subtree_leaf_count(layer: &Layer) -> usize {
    if layer.folder {
        layer.children.iter().map(subtree_leaf_count).sum()
    } else {
        1
    }
}

fn set_layer_mask(
    layers: &mut Vec<Layer>,
    layer_id: &str,
    masked: bool,
) -> Result<(), String> {
    for index in 0..layers.len() {
        if layers[index].id == layer_id {
            if masked {
                if layers[index].folder {
                    return Err("folders cannot be clipped".to_string());
                }
                if index == 0 {
                    return Err("the top layer cannot be clipped".to_string());
                }
                if layers[index - 1].masked {
                    return Err("a mask layer cannot itself be clipped".to_string());
                }
                if layers[index - 1].folder {
                    return Err("clipping needs a layer directly above".to_string());
                }
            }
            layers[index].masked = masked;
            return Ok(());
        }
        if find_layer(&layers[index].children, layer_id).is_some() {
            return set_layer_mask(&mut layers[index].children, layer_id, masked);
        }
    }
    Err("unknown layer".to_string())
}

fn open_folder(layers: &mut Vec<Layer>, folder_id: &str) -> Result<(), String> {
    if let Some(index) = layers.iter().position(|layer| layer.id == folder_id) {
        if !layers[index].folder {
            return Err("target is not a folder".to_string());
        }
        let folder = layers.remove(index);
        for (offset, child) in folder.children.into_iter().enumerate() {
            layers.insert(index + offset, child);
        }
        return Ok(());
    }
    for layer in layers.iter_mut() {
        if find_layer(&layer.children, folder_id).is_some() {
            return open_folder(&mut layer.children, folder_id);
        }
    }
    Err("unknown folder".to_string())
}

fn duplicate_layer_tree(layers: &mut Vec<Layer>, layer_id: &str) -> Result<(), String> {
    for index in 0..layers.len() {
        if layers[index].id == layer_id {
            let mut copy = layers[index].clone();
            reseed_layer(&mut copy);
            copy.name = format!("{} copy", copy.name);
            layers.insert(index + 1, copy);
            return Ok(());
        }
        if find_layer(&layers[index].children, layer_id).is_some() {
            return duplicate_layer_tree(&mut layers[index].children, layer_id);
        }
    }
    Err("unknown layer".to_string())
}

fn reseed_layer(layer: &mut Layer) {
    layer.id = new_id("l");
    for child in &mut layer.children {
        reseed_layer(child);
    }
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
            .map(Layer::content_length)
            .max()
            .unwrap_or(1)
            .max(1)
    }

    pub(crate) fn leaf_count(&self) -> usize {
        leaf_count(&self.layers)
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
    #[serde(default)]
    pub symbols: Vec<Symbol>,
}

impl Document {
    pub(crate) fn scene_index(&self, scene_id: &str) -> Result<usize, String> {
        self.scenes
            .iter()
            .position(|scene| scene.id == scene_id)
            .ok_or_else(|| "unknown scene".to_string())
    }

    pub(crate) fn leaf_mut(
        &mut self,
        scene_id: &str,
        layer_id: &str,
    ) -> Result<&mut Layer, String> {
        let scene = self
            .scenes
            .iter_mut()
            .find(|scene| scene.id == scene_id)
            .ok_or_else(|| "unknown scene".to_string())?;
        let (layer, inherited) = find_layer_mut(&mut scene.layers, layer_id)
            .ok_or_else(|| "unknown layer".to_string())?;
        if layer.folder {
            return Err("folders cannot hold frames or shapes".to_string());
        }
        if inherited {
            return Err("layer is locked".to_string());
        }
        Ok(layer)
    }

    pub fn evaluate(&self, scene_id: &str, frame: u32) -> Result<EvalFrame, String> {
        let index = self.scene_index(scene_id)?;
        Ok(EvalFrame {
            frame,
            layers: evaluate_layers(
                &self.scenes[index].layers,
                frame,
                &self.symbols,
                &mut Placements::default(),
            ),
        })
    }
}

fn evaluate_layers(
    layers: &[Layer],
    frame: u32,
    symbols: &[Symbol],
    book: &mut Placements,
) -> Vec<EvalLayer> {
    let mut evaluated = Vec::new();
    for (position, layer) in layers.iter().enumerate() {
        let mut item = if layer.folder {
            match evaluate_folder(layer, frame, symbols, book) {
                Some(item) => item,
                None => continue,
            }
        } else {
            match evaluate_layer(layer, frame) {
                Some(item) => item,
                None => continue,
            }
        };
        if !layer.folder {
            let elapsed = frame - held_frame(layer, frame);
            item.shapes = expand_shapes(&item.shapes, elapsed, symbols, book);
        }
        if layer.masked && position > 0 {
            item.mask = mask_from(&layers[position - 1], frame, symbols, book);
        }
        evaluated.push(item);
    }
    evaluated
}

fn evaluate_folder(
    folder: &Layer,
    frame: u32,
    symbols: &[Symbol],
    book: &mut Placements,
) -> Option<EvalLayer> {
    if !folder.visible {
        return None;
    }
    let children = evaluate_layers(&folder.children, frame, symbols, book);
    if children.is_empty() {
        return None;
    }
    Some(EvalLayer {
        id: folder.id.clone(),
        folder: true,
        opacity: folder.opacity.clamp(0.0, 1.0),
        blend: folder.blend,
        effects: folder.effects.clone(),
        mask: None,
        transform: Transform::default(),
        shapes: Vec::new(),
        children,
    })
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EvalLayer {
    pub id: String,
    #[serde(default)]
    pub folder: bool,
    pub opacity: f64,
    pub blend: Blend,
    pub effects: Vec<Effect>,
    #[serde(default)]
    pub mask: Option<EvalMask>,
    pub transform: Transform,
    pub shapes: Vec<Shape>,
    #[serde(default)]
    pub children: Vec<EvalLayer>,
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

fn mixable(a: &Shape, b: &Shape) -> bool {
    let fills_alike = gradients_mixable(shape_gradient(a), shape_gradient(b));
    match (a, b) {
        (Shape::Rect { .. }, Shape::Rect { .. })
        | (Shape::Ellipse { .. }, Shape::Ellipse { .. })
        | (Shape::Text { .. }, Shape::Text { .. }) => fills_alike,
        (Shape::Polygon { sides, .. }, Shape::Polygon { sides: other, .. }) => {
            sides == other && fills_alike
        }
        (Shape::Stroke { points, .. }, Shape::Stroke { points: other, .. }) => {
            points.len() == other.len() && points.len() > 1
        }
        (
            Shape::Path { nodes, closed, .. },
            Shape::Path {
                nodes: other,
                closed: other_closed,
                ..
            },
        ) => closed == other_closed && nodes.len() == other.len() && nodes.len() > 1 && fills_alike,
        (Shape::Group { children }, Shape::Group { children: other }) => {
            !children.is_empty()
                && children.len() == other.len()
                && children.iter().zip(other).all(|(left, right)| mixable(left, right))
        }
        (Shape::Figure { figure }, Shape::Figure { figure: other }) => {
            figure.bones.len() == other.bones.len()
                && figure
                    .bones
                    .iter()
                    .zip(&other.bones)
                    .all(|(left, right)| left.parent == right.parent && {
                        left.art.len() == right.art.len()
                            && left
                                .art
                                .iter()
                                .zip(&right.art)
                                .all(|(a, b)| mixable(a, b))
                    })
        }
        (Shape::Bitmap { .. }, Shape::Bitmap { .. }) => true,
        _ => false,
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
        (Shape::Group { children }, Shape::Group { children: other }) if mixable(a, b) => {
            Shape::Group {
                children: children
                    .iter()
                    .zip(other)
                    .map(|(left, right)| mix_shape(left, right, t))
                    .collect(),
            }
        }
        (Shape::Figure { figure }, Shape::Figure { figure: other }) if mixable(a, b) => {
            Shape::Figure {
                figure: Figure {
                    x: mix(figure.x, other.x, t),
                    y: mix(figure.y, other.y, t),
                    rotation: mix(figure.rotation, other.rotation, t),
                    bones: figure
                        .bones
                        .iter()
                        .zip(&other.bones)
                        .map(|(left, right)| Bone {
                            parent: left.parent,
                            anchor: mix_point(&left.anchor, &right.anchor, t),
                            length: mix(left.length, right.length, t),
                            twist: mix(left.twist, right.twist, t),
                            width: mix(left.width, right.width, t),
                            color: mix_color(&left.color, &right.color, t),
                            art: left
                                .art
                                .iter()
                                .zip(&right.art)
                                .map(|(a, b)| mix_shape(a, b, t))
                                .collect(),
                        })
                        .collect(),
                },
            }
        }
        (
            Shape::Rect {
                x,
                y,
                w,
                h,
                fill,
                stroke,
                width,
                gradient,
            },
            Shape::Rect {
                x: bx,
                y: by,
                w: bw,
                h: bh,
                fill: bf,
                stroke: bs,
                width: bwidth,
                gradient: bgradient,
            },
        ) => Shape::Rect {
            x: mix(*x, *bx, t),
            y: mix(*y, *by, t),
            w: mix(*w, *bw, t),
            h: mix(*h, *bh, t),
            fill: mix_color(fill, bf, t),
            stroke: mix_color(stroke, bs, t),
            width: mix(*width, *bwidth, t),
            gradient: mix_gradient(gradient, bgradient, t),
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
                gradient,
            },
            Shape::Ellipse {
                x: bx,
                y: by,
                w: bw,
                h: bh,
                fill: bf,
                stroke: bs,
                width: bwidth,
                gradient: bgradient,
            },
        ) => Shape::Ellipse {
            x: mix(*x, *bx, t),
            y: mix(*y, *by, t),
            w: mix(*w, *bw, t),
            h: mix(*h, *bh, t),
            fill: mix_color(fill, bf, t),
            stroke: mix_color(stroke, bs, t),
            width: mix(*width, *bwidth, t),
            gradient: mix_gradient(gradient, bgradient, t),
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
                gradient,
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
                gradient: bgradient,
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
            gradient: mix_gradient(gradient, bgradient, t),
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
                gradient,
            },
            Shape::Path {
                nodes: bnodes,
                closed: bclosed,
                fill: bf,
                stroke: bs,
                width: bwidth,
                gradient: bgradient,
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
            gradient: mix_gradient(gradient, bgradient, t),
        },
        (
            Shape::Text {
                x,
                y,
                text,
                size,
                family,
                color,
                spacing,
                leading,
                align,
                matrix,
            },
            Shape::Text {
                x: bx,
                y: by,
                text: _,
                size: bsize,
                family: _,
                color: bcolor,
                spacing: bspacing,
                leading: bleading,
                align: _,
                matrix: bmatrix,
            },
        ) => Shape::Text {
            x: mix(*x, *bx, t),
            y: mix(*y, *by, t),
            text: text.clone(),
            size: mix(*size, *bsize, t),
            family: family.clone(),
            color: mix_color(color, bcolor, t),
            spacing: mix(*spacing, *bspacing, t),
            leading: mix(*leading, *bleading, t),
            align: *align,
            matrix: match (matrix, bmatrix) {
                (Some(left), Some(right)) => Some(mix_affine(left, right, t)),
                (Some(left), None) | (None, Some(left)) => Some(left.clone()),
                (None, None) => None,
            },
        },
        (
            Shape::Bitmap {
                x,
                y,
                w,
                h,
                source,
                matrix,
            },
            Shape::Bitmap {
                x: bx,
                y: by,
                w: bw,
                h: bh,
                matrix: bmatrix,
                ..
            },
        ) => Shape::Bitmap {
            x: mix(*x, *bx, t),
            y: mix(*y, *by, t),
            w: mix(*w, *bw, t),
            h: mix(*h, *bh, t),
            source: source.clone(),
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
                let raw = ((frame - key.frame) as f64 / span as f64).clamp(0.0, 1.0);
                let t = ease_progress(raw, key.easing);
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
        folder: false,
        opacity: (layer.opacity * transform.opacity).clamp(0.0, 1.0),
        blend: layer.blend,
        effects: layer.effects.clone(),
        mask: None,
        transform,
        shapes,
        children: Vec::new(),
    })
}

fn mask_from(
    layer: &Layer,
    frame: u32,
    symbols: &[Symbol],
    book: &mut Placements,
) -> Option<EvalMask> {
    if layer.folder || !layer.visible || frame >= layer.length {
        return None;
    }
    let evaluated = evaluate_layer(layer, frame)?;
    let elapsed = frame.saturating_sub(held_frame(layer, frame));
    Some(EvalMask {
        transform: evaluated.transform,
        shapes: expand_shapes(&evaluated.shapes, elapsed, symbols, book),
    })
}

#[derive(Default)]
struct Placements {
    memo: HashMap<(usize, u32), Vec<Shape>>,
    chain: Vec<usize>,
}

impl Symbol {
    pub(crate) fn length(&self) -> u32 {
        self.layers
            .iter()
            .map(|layer| layer.length)
            .max()
            .unwrap_or(1)
            .max(1)
    }
}

fn held_frame(layer: &Layer, frame: u32) -> u32 {
    layer
        .held_index(frame)
        .map(|index| layer.keys[index].frame)
        .unwrap_or(frame)
}

fn local_frame(length: u32, looping: LoopMode, first: u32, elapsed: u32) -> u32 {
    match looping {
        LoopMode::SingleFrame => first,
        LoopMode::PlayOnce => (first + elapsed).min(length.saturating_sub(1)),
        LoopMode::Loop => {
            if first >= length {
                return first;
            }
            first + elapsed % (length - first)
        }
    }
}

fn decompose(matrix: &Affine) -> (f64, f64, f64) {
    (
        (matrix.a * matrix.a + matrix.b * matrix.b).sqrt(),
        (matrix.c * matrix.c + matrix.d * matrix.d).sqrt(),
        matrix.b.atan2(matrix.a) * 180.0 / std::f64::consts::PI,
    )
}

fn curved_ellipse(shape: &Shape, rotation: f64) -> Shape {
    match shape {
        Shape::Ellipse {
            x,
            y,
            w,
            h,
            fill,
            stroke,
            width,
            gradient,
        } if rotation % 90.0 != 0.0 => Shape::Path {
            nodes: crate::xfl::ellipse_nodes(*x, *y, *w, *h),
            closed: true,
            fill: fill.clone(),
            stroke: stroke.clone(),
            width: *width,
            gradient: rotated_gradient(gradient, rotation),
        },
        Shape::Group { children } => Shape::Group {
            children: children
                .iter()
                .map(|child| curved_ellipse(child, rotation))
                .collect(),
        },
        other => other.clone(),
    }
}

fn bake(shape: &Shape, matrix: &Affine) -> Option<Shape> {
    let (sx, sy, rotation) = decompose(matrix);
    let ready = curved_ellipse(shape, rotation);
    transform_shape(&ready, matrix, sx, sy, rotation).ok()
}

fn layer_matrix(place: &Transform) -> Affine {
    affine_from(
        &Point { x: 0.0, y: 0.0 },
        place.x,
        place.y,
        place.scale,
        place.scale,
        place.rotation,
    )
}

fn shade(value: &str, opacity: f64) -> String {
    if opacity >= 0.999 || !value.starts_with('#') {
        return value.to_string();
    }
    let (hex, alpha) = crate::xfl::color_alpha(value);
    let byte = (alpha * opacity.clamp(0.0, 1.0) * 255.0).round() as u32;
    format!("{hex}{byte:02x}")
}

fn tinted(shape: &Shape, opacity: f64) -> Shape {
    let mut out = shape.clone();
    if opacity >= 0.999 {
        return out;
    }
    match &mut out {
        Shape::Stroke { color, .. } => *color = shade(color, opacity),
        Shape::Text { color, .. } => *color = shade(color, opacity),
        Shape::Rect {
            fill,
            stroke,
            gradient,
            ..
        }
        | Shape::Ellipse {
            fill,
            stroke,
            gradient,
            ..
        }
        | Shape::Polygon {
            fill,
            stroke,
            gradient,
            ..
        }
        | Shape::Path {
            fill,
            stroke,
            gradient,
            ..
        } => {
            *fill = shade(fill, opacity);
            *stroke = shade(stroke, opacity);
            if let Some(value) = gradient {
                let stops = match value {
                    Gradient::Linear { stops, .. } | Gradient::Radial { stops } => stops,
                };
                for stop in stops {
                    stop.color = shade(&stop.color, opacity);
                }
            }
        }
        Shape::Group { children } => {
            for child in children {
                *child = tinted(child, opacity);
            }
        }
        Shape::Figure { figure } => {
            for bone in &mut figure.bones {
                bone.color = shade(&bone.color, opacity);
                for item in &mut bone.art {
                    *item = tinted(item, opacity);
                }
            }
        }
        Shape::Bitmap { .. } | Shape::Instance { .. } => {}
    }
    out
}

fn expand_shapes(
    shapes: &[Shape],
    elapsed: u32,
    symbols: &[Symbol],
    book: &mut Placements,
) -> Vec<Shape> {
    shapes
        .iter()
        .flat_map(|shape| expand_shape(shape, elapsed, symbols, book))
        .collect()
}

fn expand_shape(
    shape: &Shape,
    elapsed: u32,
    symbols: &[Symbol],
    book: &mut Placements,
) -> Vec<Shape> {
    match shape {
        Shape::Instance {
            symbol,
            matrix,
            visible,
            first_frame,
            looping,
            ..
        } => {
            if !visible {
                return Vec::new();
            }
            let Some(index) = symbols.iter().position(|item| item.id == *symbol) else {
                return vec![shape.clone()];
            };
            let local = local_frame(
                symbols[index].length(),
                *looping,
                *first_frame,
                elapsed,
            );
            let place = instance_matrix(matrix);
            vec![Shape::Group {
                children: symbol_shapes(index, local, symbols, book)
                    .into_iter()
                    .map(|item| bake(&item, &place).unwrap_or(item))
                    .collect(),
            }]
        }
        Shape::Group { children } => vec![Shape::Group {
            children: expand_shapes(children, elapsed, symbols, book),
        }],
        other => vec![other.clone()],
    }
}

fn symbol_shapes(
    index: usize,
    frame: u32,
    symbols: &[Symbol],
    book: &mut Placements,
) -> Vec<Shape> {
    if let Some(found) = book.memo.get(&(index, frame)) {
        return found.clone();
    }
    if book.chain.contains(&index) {
        return Vec::new();
    }
    let Some(symbol) = symbols.get(index) else {
        return Vec::new();
    };
    book.chain.push(index);
    let out = symbol_layers(&symbol.layers, frame, 1.0, symbols, book);
    book.chain.pop();
    book.memo.insert((index, frame), out.clone());
    out
}

fn symbol_layers(
    layers: &[Layer],
    frame: u32,
    opacity: f64,
    symbols: &[Symbol],
    book: &mut Placements,
) -> Vec<Shape> {
    let mut out = Vec::new();
    for layer in layers {
        if layer.folder {
            out.extend(symbol_layers(
                &layer.children,
                frame,
                opacity * layer.opacity,
                symbols,
                book,
            ));
            continue;
        }
        let Some(item) = evaluate_layer(layer, frame) else {
            continue;
        };
        let ink = (opacity * item.opacity).clamp(0.0, 1.0);
        let elapsed = frame.saturating_sub(held_frame(layer, frame));
        let place = layer_matrix(&item.transform);
        for shape in expand_shapes(&item.shapes, elapsed, symbols, book) {
            match bake(&shape, &place) {
                Some(moved) => out.push(tinted(&moved, ink)),
                None => out.push(tinted(&shape, ink)),
            }
        }
    }
    out
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
        if fps == 0 || fps > 120 {
            return Err("frame rate must be between 1 and 120".to_string());
        }
        let doc = Document {
            id: new_id("d"),
            name: clean_name(&name).unwrap_or_else(|| "Untitled".to_string()),
            width,
            height,
            fps,
            background,
            scenes: vec![Scene::new("Scene 1".to_string())],
            symbols: Vec::new(),
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
                reseed_layer(layer);
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
        parent_id: Option<String>,
    ) -> Result<Document, String> {
        self.edit_named(id, "add_layer", |doc| {
            let index = doc.scene_index(scene_id)?;
            let scene = &mut doc.scenes[index];
            let fallback = format!("Layer {}", scene.leaf_count() + 1);
            let layer = Layer::new(clean_name(&name).unwrap_or(fallback));
            insert_layer_tree(&mut scene.layers, parent_id.as_deref(), 0, layer)?;
            validate_scene_masks(scene)
        })
    }

    pub fn add_folder(
        &self,
        id: &str,
        scene_id: &str,
        name: String,
        parent_id: Option<String>,
    ) -> Result<Document, String> {
        self.edit_named(id, "add_folder", |doc| {
            let index = doc.scene_index(scene_id)?;
            let scene = &mut doc.scenes[index];
            let fallback = format!("Folder {}", scene.leaf_count() + 1);
            let folder = Layer::new_folder(clean_name(&name).unwrap_or(fallback));
            insert_layer_tree(&mut scene.layers, parent_id.as_deref(), 0, folder)?;
            validate_scene_masks(scene)
        })
    }

    pub fn remove_folder(
        &self,
        id: &str,
        scene_id: &str,
        folder_id: &str,
    ) -> Result<Document, String> {
        self.edit_named(id, "remove_folder", |doc| {
            let index = doc.scene_index(scene_id)?;
            let scene = &mut doc.scenes[index];
            open_folder(&mut scene.layers, folder_id)?;
            validate_scene_masks(scene)
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
        blend: Option<Blend>,
        effects: Option<Vec<Effect>>,
        mask: Option<bool>,
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
        } else if blend.is_some() {
            "layer_blend"
        } else if effects.is_some() {
            "layer_effects"
        } else if mask.is_some() {
            "layer_mask"
        } else {
            "layer_opacity"
        };
        self.edit_named(id, step, |doc| {
            let scene_index = doc.scene_index(scene_id)?;
            let scene = &mut doc.scenes[scene_index];
            if let Some(masked) = mask {
                set_layer_mask(&mut scene.layers, layer_id, masked)?;
            }
            let (layer, _) = find_layer_mut(&mut scene.layers, layer_id)
                .ok_or_else(|| "unknown layer".to_string())?;
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
            if let Some(blend) = blend {
                layer.blend = blend;
            }
            if let Some(effects) = effects {
                layer.effects = effects.iter().map(Effect::sanitized).collect();
            }
            validate_scene_masks(scene)
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
            if scene.leaf_count() < 2 {
                return Err("a scene needs at least one layer".to_string());
            }
            let removed = find_layer(&scene.layers, layer_id)
                .ok_or_else(|| "unknown layer".to_string())?;
            let leaves = subtree_leaf_count(removed);
            if scene.leaf_count() - leaves < 1 {
                return Err("a scene needs at least one layer".to_string());
            }
            remove_layer_tree(&mut scene.layers, layer_id)?;
            validate_scene_masks(scene)
        })
    }

    pub fn move_layer(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        index: usize,
        parent_id: Option<String>,
    ) -> Result<Document, String> {
        self.edit_named(id, "move_layer", |doc| {
            let scene_index = doc.scene_index(scene_id)?;
            let scene = &mut doc.scenes[scene_index];
            let target = parent_id.as_deref();
            let (height, cycle) = {
                let moved = find_layer(&scene.layers, layer_id)
                    .ok_or_else(|| "unknown layer".to_string())?;
                let nested = target.map_or(false, |parent| {
                    parent == layer_id || contains_layer(&moved.children, parent)
                });
                (subtree_height(moved), nested)
            };
            if let Some(parent) = target {
                let depth = layer_depth(&scene.layers, parent, 1)
                    .ok_or_else(|| "unknown folder".to_string())?;
                let folder =
                    find_layer(&scene.layers, parent).ok_or_else(|| "unknown folder".to_string())?;
                if !folder.folder {
                    return Err("target is not a folder".to_string());
                }
                if cycle {
                    return Err("a folder cannot contain itself".to_string());
                }
                if depth + height > MAX_FOLDER_DEPTH {
                    return Err("folders cannot nest deeper than 16 levels".to_string());
                }
            }
            let moved = remove_layer_tree(&mut scene.layers, layer_id)?;
            insert_layer_tree(&mut scene.layers, parent_id.as_deref(), index, moved)?;
            validate_scene_masks(scene)
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
            let layer = doc.leaf_mut(scene_id, layer_id)?;
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
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            let index = layer.key_at(frame);
            if blank {
                let key = &mut layer.keys[index];
                key.shapes.clear();
                key.transform = Transform::default();
                key.tween = false;
                key.easing = Easing::linear();
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
            let layer = doc.leaf_mut(scene_id, layer_id)?;
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
        easing: Option<Easing>,
    ) -> Result<Document, String> {
        let step = if tween { "add_tween" } else { "remove_tween" };
        self.edit_named(id, step, |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            let index = layer.key_at(frame);
            let key = &mut layer.keys[index];
            key.tween = tween;
            if let Some(curve) = easing {
                key.easing = curve.sanitized();
            }
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
            let layer = doc.leaf_mut(scene_id, layer_id)?;
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
            Shape::Bitmap { .. } => "draw_bitmap",
            Shape::Text { .. } => "draw_text",
            Shape::Path { .. } => "draw_path",
            Shape::Group { .. } => "draw_group",
            Shape::Figure { .. } => "draw_figure",
            Shape::Instance { .. } => "draw_instance",
        };
        self.edit_named(id, step, |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            let index = layer.key_at(frame);
            layer.keys[index].shapes.push(shape);
            Ok(())
        })
    }

    pub fn set_keyframes(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        run: Vec<Vec<Shape>>,
    ) -> Result<Document, String> {
        for shapes in &run {
            for shape in shapes {
                validate(shape)?;
            }
        }
        self.edit_named(id, "place_image_sequence", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            for (offset, shapes) in run.into_iter().enumerate() {
                let index = layer.key_at(frame + offset as u32);
                layer.keys[index].shapes = shapes;
            }
            Ok(())
        })
    }

    pub fn set_frames(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        run: Vec<FrameRun>,
    ) -> Result<Document, String> {
        for step in &run {
            if step.span == 0 {
                return Err("a frame must last at least one frame".to_string());
            }
            for shape in &step.shapes {
                validate(shape)?;
            }
        }
        self.edit_named(id, "place_animation", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            let mut at = frame;
            for step in &run {
                let index = layer.key_at(at);
                layer.keys[index].shapes = step.shapes.clone();
                layer.length = layer.length.max(at + step.span);
                at += step.span;
            }
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
            let layer = doc.leaf_mut(scene_id, layer_id)?;
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
                        if matches!(other, Shape::Group { .. })
                            || !samples.iter().any(|sample| shape_hit(&other, sample, radius))
                        {
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
            let layer = doc.leaf_mut(scene_id, layer_id)?;
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
                Shape::Group { children } => {
                    for child in children {
                        paint_fill(child, &color);
                    }
                }
                Shape::Figure { .. } => paint_fill(shape, &color),
                Shape::Bitmap { .. } => {}
                Shape::Instance { .. } => {}
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
            let layer = doc.leaf_mut(scene_id, layer_id)?;
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
            let layer = doc.leaf_mut(scene_id, layer_id)?;
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

    pub fn align_shapes(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        indices: Vec<usize>,
        mode: AlignMode,
        reference: AlignReference,
    ) -> Result<Document, String> {
        if indices.is_empty() {
            return Err("no shapes selected".to_string());
        }
        let mut sorted = indices;
        sorted.sort_unstable();
        sorted.dedup();
        self.edit_named(id, "align_shapes", |doc| {
            let stage = Bounds {
                x: 0.0,
                y: 0.0,
                w: f64::from(doc.width),
                h: f64::from(doc.height),
            };
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            let source = layer
                .held_index(frame)
                .map(|index| layer.keys[index].shapes.clone())
                .unwrap_or_default();
            for &shape_index in &sorted {
                if shape_index >= source.len() {
                    return Err("unknown shape".to_string());
                }
            }
            let offsets = align_offsets(stage, &source, &sorted, mode, reference);
            if offsets.is_empty() {
                return Ok(());
            }
            let pivot = Point { x: 0.0, y: 0.0 };
            let mut updated = Vec::new();
            for (shape_index, dx, dy) in offsets {
                let matrix = affine_from(&pivot, dx, dy, 1.0, 1.0, 0.0);
                let next = transform_shape(&source[shape_index], &matrix, 1.0, 1.0, 0.0)?;
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
            let layer = doc.leaf_mut(scene_id, layer_id)?;
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
            let layer = doc.leaf_mut(scene_id, layer_id)?;
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

    pub fn group_shapes(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        indices: Vec<usize>,
    ) -> Result<Document, String> {
        let mut sorted = indices;
        sorted.sort_unstable();
        sorted.dedup();
        if sorted.len() < 2 {
            return Err("select at least two shapes".to_string());
        }
        self.edit_named(id, "group_shapes", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            let source = layer
                .held_index(frame)
                .map(|index| layer.keys[index].shapes.clone())
                .unwrap_or_default();
            for &shape_index in &sorted {
                if shape_index >= source.len() {
                    return Err("unknown shape".to_string());
                }
            }
            let children: Vec<Shape> = sorted
                .iter()
                .map(|&shape_index| source[shape_index].clone())
                .collect();
            let group = Shape::Group { children };
            validate(&group)?;
            let at = sorted[0];
            let index = layer.key_at(frame);
            let key = &mut layer.keys[index];
            for &shape_index in sorted.iter().rev() {
                key.shapes.remove(shape_index);
            }
            key.shapes.insert(at, group);
            Ok(())
        })
    }

    pub fn ungroup_shape(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        index: usize,
    ) -> Result<Document, String> {
        self.edit_named(id, "ungroup_shape", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            let source = layer
                .held_index(frame)
                .map(|held| layer.keys[held].shapes.clone())
                .unwrap_or_default();
            let children = match source.get(index) {
                Some(Shape::Group { children }) => children.clone(),
                Some(_) => return Err("shape is not a group".to_string()),
                None => return Err("unknown shape".to_string()),
            };
            for child in &children {
                validate(child)?;
            }
            let key_index = layer.key_at(frame);
            let key = &mut layer.keys[key_index];
            key.shapes.splice(index..index + 1, children);
            Ok(())
        })
    }

    pub fn bool_shapes(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        indices: Vec<usize>,
        op: BoolOp,
    ) -> Result<Document, String> {
        let mut sorted = indices;
        sorted.sort_unstable();
        sorted.dedup();
        if sorted.len() < 2 {
            return Err("select at least two shapes".to_string());
        }
        self.edit_named(id, bool_history_name(op), |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            let source = layer
                .held_index(frame)
                .map(|held| layer.keys[held].shapes.clone())
                .unwrap_or_default();
            for &shape_index in &sorted {
                if shape_index >= source.len() {
                    return Err("unknown shape".to_string());
                }
            }
            let merged = combine(&source, &sorted, op)?;
            for shape in &merged {
                validate(shape)?;
            }
            let at = sorted[0];
            let key_index = layer.key_at(frame);
            let key = &mut layer.keys[key_index];
            for &shape_index in sorted.iter().rev() {
                key.shapes.remove(shape_index);
            }
            for (offset, shape) in merged.into_iter().enumerate() {
                key.shapes.insert(at + offset, shape);
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
            let layer = doc.leaf_mut(scene_id, layer_id)?;
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
            let layer = doc.leaf_mut(scene_id, layer_id)?;
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

    pub fn add_figure(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        x: f64,
        y: f64,
        height: f64,
    ) -> Result<Document, String> {
        self.draw(
            id,
            scene_id,
            layer_id,
            frame,
            Shape::Figure {
                figure: crate::rig::humanoid(x, y, height),
            },
        )
    }

    pub fn pose_figure(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        index: usize,
        bone: usize,
        target: Point,
    ) -> Result<Document, String> {
        self.edit_named(id, "pose_figure", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            let key_index = layer.key_at(frame);
            let shape = layer
                .keys
                .get_mut(key_index)
                .and_then(|key| key.shapes.get_mut(index))
                .ok_or_else(|| "unknown shape".to_string())?;
            let figure = match shape {
                Shape::Figure { figure } => figure,
                _ => return Err("shape is not a figure".to_string()),
            };
            crate::rig::swing(figure, bone, &target)?;
            validate(shape)
        })
    }

    pub fn reach_figure(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        index: usize,
        bone: usize,
        target: Point,
    ) -> Result<Document, String> {
        self.edit_named(id, "reach_figure", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            let key_index = layer.key_at(frame);
            let shape = layer
                .keys
                .get_mut(key_index)
                .and_then(|key| key.shapes.get_mut(index))
                .ok_or_else(|| "unknown shape".to_string())?;
            let figure = match shape {
                Shape::Figure { figure } => figure,
                _ => return Err("shape is not a figure".to_string()),
            };
            crate::rig::reach(figure, bone, &target)?;
            validate(shape)
        })
    }

    pub fn attach_art(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        index: usize,
        bone: usize,
        shapes: Vec<usize>,
    ) -> Result<Document, String> {
        if shapes.is_empty() {
            return Err("no shapes selected".to_string());
        }
        self.edit_named(id, "attach_art", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            let key_index = layer.key_at(frame);
            let mut taken = shapes;
            taken.sort_unstable();
            taken.dedup();
            for &item in &taken {
                if item == index || item >= layer.keys[key_index].shapes.len() {
                    return Err("unknown shape".to_string());
                }
            }
            figure_of(&layer.keys[key_index].shapes[index]).map(drop)?;
            let mut moved = Vec::new();
            for &item in taken.iter().rev() {
                moved.push(layer.keys[key_index].shapes.remove(item));
            }
            moved.reverse();
            let shift = taken.iter().filter(|&&item| item < index).count();
            let shape = &mut layer.keys[key_index].shapes[index - shift];
            crate::rig::place_art(
                match shape {
                    Shape::Figure { figure } => figure,
                    _ => return Err("shape is not a figure".to_string()),
                },
                bone,
                moved,
            )?;
            validate(shape)
        })
    }

    pub fn detach_art(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        index: usize,
        bone: usize,
    ) -> Result<Document, String> {
        self.edit_named(id, "detach_art", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            let key_index = layer.key_at(frame);
            let shapes = &mut layer.keys[key_index].shapes;
            let world = crate::rig::detach_art(figure_of(&shapes[index])?, bone)?;
            if world.is_empty() {
                return Err("that bone carries no artwork".to_string());
            }
            for shape in &world {
                validate(shape)?;
            }
            match &mut shapes[index] {
                Shape::Figure { figure } => figure.bones[bone].art.clear(),
                _ => return Err("shape is not a figure".to_string()),
            }
            shapes.extend(world);
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
    parent_id: Option<String>,
) -> Result<Document, String> {
    store.add_layer(&id, &scene_id, name, parent_id)
}

#[tauri::command]
pub fn doc_add_folder(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    name: String,
    parent_id: Option<String>,
) -> Result<Document, String> {
    store.add_folder(&id, &scene_id, name, parent_id)
}

#[tauri::command]
pub fn doc_remove_folder(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    folder_id: String,
) -> Result<Document, String> {
    store.remove_folder(&id, &scene_id, &folder_id)
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
    blend: Option<Blend>,
    effects: Option<Vec<Effect>>,
    mask: Option<bool>,
) -> Result<Document, String> {
    store.set_layer(
        &id, &scene_id, &layer_id, name, visible, locked, opacity, blend, effects, mask,
    )
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
    parent_id: Option<String>,
) -> Result<Document, String> {
    store.move_layer(&id, &scene_id, &layer_id, index, parent_id)
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
    easing: Option<Easing>,
) -> Result<Document, String> {
    store.set_tween(&id, &scene_id, &layer_id, frame, tween, easing)
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
pub fn doc_set_keyframes(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    run: Vec<Vec<Shape>>,
) -> Result<Document, String> {
    store.set_keyframes(&id, &scene_id, &layer_id, frame, run)
}

#[tauri::command]
pub fn doc_set_frames(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    run: Vec<FrameRun>,
) -> Result<Document, String> {
    store.set_frames(&id, &scene_id, &layer_id, frame, run)
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
pub fn doc_add_figure(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    x: f64,
    y: f64,
    height: f64,
) -> Result<Document, String> {
    store.add_figure(&id, &scene_id, &layer_id, frame, x, y, height)
}

#[tauri::command]
pub fn doc_pose_figure(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    index: usize,
    bone: usize,
    target: Point,
) -> Result<Document, String> {
    store.pose_figure(&id, &scene_id, &layer_id, frame, index, bone, target)
}

#[tauri::command]
pub fn doc_reach_figure(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    index: usize,
    bone: usize,
    target: Point,
) -> Result<Document, String> {
    store.reach_figure(&id, &scene_id, &layer_id, frame, index, bone, target)
}

#[tauri::command]
pub fn doc_attach_art(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    index: usize,
    bone: usize,
    shapes: Vec<usize>,
) -> Result<Document, String> {
    store.attach_art(&id, &scene_id, &layer_id, frame, index, bone, shapes)
}

#[tauri::command]
pub fn doc_detach_art(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    index: usize,
    bone: usize,
) -> Result<Document, String> {
    store.detach_art(&id, &scene_id, &layer_id, frame, index, bone)
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
pub fn doc_align_shapes(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    indices: Vec<usize>,
    mode: String,
    reference: String,
) -> Result<Document, String> {
    let parsed_mode = AlignMode::parse(&mode)?;
    let parsed_reference = AlignReference::parse(&reference)?;
    store.align_shapes(
        &id,
        &scene_id,
        &layer_id,
        frame,
        indices,
        parsed_mode,
        parsed_reference,
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
pub fn doc_group_shapes(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    indices: Vec<usize>,
) -> Result<Document, String> {
    store.group_shapes(&id, &scene_id, &layer_id, frame, indices)
}

#[tauri::command]
pub fn doc_ungroup_shape(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    index: usize,
) -> Result<Document, String> {
    store.ungroup_shape(&id, &scene_id, &layer_id, frame, index)
}

#[tauri::command]
pub fn doc_shape_bool(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    indices: Vec<usize>,
    op: BoolOp,
) -> Result<Document, String> {
    store.bool_shapes(&id, &scene_id, &layer_id, frame, indices, op)
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
            .create("Bad".to_string(), 800, 600, 121, "#fff".to_string())
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
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None, None, None, None)
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
            .set_tween(id, &fixture.scene, &fixture.layer, 0, true, None)
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
            .set_tween(id, &fixture.scene, &fixture.layer, 0, true, None)
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
            .set_tween(id, &fixture.scene, &fixture.layer, 0, true, None)
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
            .set_tween(id, &fixture.scene, &fixture.layer, 0, true, None)
            .expect("tween");
        let frames = store
            .evaluate_range(id, &fixture.scene, 0, 10)
            .expect("evaluate");
        assert_eq!(frames[0].layers[0].shapes, vec![box_shape(100.0, 100.0)]);
        assert_eq!(frames[2].layers[0].shapes, vec![box_shape(140.0, 100.0)]);
        assert_eq!(frames[5].layers[0].shapes, vec![box_shape(200.0, 100.0)]);
        assert_eq!(frames[10].layers[0].shapes, vec![box_shape(300.0, 100.0)]);
        store
            .set_tween(id, &fixture.scene, &fixture.layer, 0, false, None)
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
            gradient: None,
        };
        let end = Shape::Rect {
            x: 20.0,
            y: 0.0,
            w: 10.0,
            h: 10.0,
            fill: "#0000ff".to_string(),
            stroke: "none".to_string(),
            width: 4.0,
            gradient: None,
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
            gradient: None,
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
            gradient: None,
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
            gradient: None,
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
                gradient: None,
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
            spacing: 2.0,
            leading: 1.5,
            align: TextAlign::Left,
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
            spacing: 6.0,
            leading: 1.0,
            align: TextAlign::Right,
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
            spacing,
            leading,
            align,
            matrix,
        } = middle
        else {
            panic!("expected text");
        };
        assert_eq!((x, y, size), (20.0, 40.0, 30.0));
        assert_eq!(text, "In");
        assert_eq!(family, "sans-serif");
        assert_eq!(color, "#808080");
        assert_eq!((spacing, leading), (4.0, 1.25));
        assert_eq!(align, TextAlign::Left);
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

    fn ease_in() -> Easing {
        Easing {
            x1: 0.42,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
        }
    }

    #[test]
    fn ease_progress_holds_the_endpoints_and_the_linear_curve() {
        assert_eq!(ease_progress(0.0, ease_in()), 0.0);
        assert_eq!(ease_progress(1.0, ease_in()), 1.0);
        assert_eq!(ease_progress(-0.4, ease_in()), 0.0);
        assert_eq!(ease_progress(1.6, ease_in()), 1.0);
        let linear = Easing::linear();
        assert!(linear.is_linear());
        for step in 0..=10 {
            let t = step as f64 / 10.0;
            assert_eq!(ease_progress(t, linear), t);
        }
        let mirrored = Easing {
            x1: 0.5,
            y1: 0.5,
            x2: 0.8,
            y2: 0.8,
        };
        assert_eq!(ease_progress(0.25, mirrored), 0.25);
    }

    #[test]
    fn ease_in_progress_is_monotonic_and_starts_slow() {
        let mut previous = 0.0;
        for step in 0..=10 {
            let t = step as f64 / 10.0;
            let eased = ease_progress(t, ease_in());
            assert!(eased >= previous, "easing must not run backwards");
            previous = eased;
            if t > 0.0 && t < 1.0 {
                assert!(eased < t, "ease in lags the linear ramp at {t}");
            }
        }
        assert!((previous - 1.0).abs() < 1e-12);
        assert!((ease_progress(0.5, ease_in()) - 0.315_356_812_505_893).abs() < 1e-12);
    }

    #[test]
    fn overshoot_curve_passes_the_transform_and_holds_the_shapes() {
        let back = Easing {
            x1: 0.34,
            y1: 1.56,
            x2: 0.64,
            y2: 1.0,
        };
        assert_eq!(ease_progress(0.0, back), 0.0);
        assert_eq!(ease_progress(1.0, back), 1.0);
        assert!(ease_progress(0.5, back) > 1.0);
        let fixture = Fixture::new("easing-overshoot");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(100.0, 100.0))
            .expect("draw start");
        fixture
            .store
            .keyframe(id, &fixture.scene, &fixture.layer, 10, true)
            .expect("blank key");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 10, box_shape(300.0, 100.0))
            .expect("draw end");
        fixture
            .store
            .set_transform(
                id,
                &fixture.scene,
                &fixture.layer,
                10,
                Transform {
                    x: 200.0,
                    ..Transform::default()
                },
            )
            .expect("transform");
        fixture
            .store
            .set_tween(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                true,
                Some(back),
            )
            .expect("tween");
        let frames = fixture
            .store
            .evaluate_range(id, &fixture.scene, 0, 10)
            .expect("evaluate");
        assert_eq!(frames[0].layers[0].transform.x, 0.0);
        assert!(
            frames[5].layers[0].transform.x > 200.0,
            "expected an overshoot, got {}",
            frames[5].layers[0].transform.x
        );
        assert_eq!(frames[10].layers[0].transform.x, 200.0);
        assert_eq!(frames[0].layers[0].shapes, vec![box_shape(100.0, 100.0)]);
        assert_eq!(frames[10].layers[0].shapes, vec![box_shape(300.0, 100.0)]);
    }

    #[test]
    fn easing_control_points_are_clamped() {
        let clamped = Easing {
            x1: -2.0,
            y1: 5.0,
            x2: 3.0,
            y2: -3.0,
        }
        .sanitized();
        assert_eq!(
            clamped,
            Easing {
                x1: 0.0,
                y1: 2.0,
                x2: 1.0,
                y2: -1.0,
            }
        );
        assert_eq!(
            Easing {
                x1: f64::NAN,
                y1: 0.4,
                x2: 0.6,
                y2: 1.0,
            }
            .sanitized(),
            Easing::linear()
        );
        let fixture = Fixture::new("easing-clamp");
        let id = &fixture.doc.id;
        let edited = fixture
            .store
            .set_tween(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                true,
                Some(Easing {
                    x1: -1.0,
                    y1: 4.0,
                    x2: 2.0,
                    y2: -2.0,
                }),
            )
            .expect("tween");
        assert_eq!(
            fixture.target(&edited).keys[0].easing,
            Easing {
                x1: 0.0,
                y1: 2.0,
                x2: 1.0,
                y2: -1.0,
            }
        );
    }

    #[test]
    fn tween_toggle_keeps_the_curve_and_a_new_tween_starts_linear() {
        let fixture = Fixture::new("easing-keep");
        let id = &fixture.doc.id;
        let curved = fixture
            .store
            .set_tween(id, &fixture.scene, &fixture.layer, 0, true, Some(ease_in()))
            .expect("curve");
        assert_eq!(fixture.target(&curved).keys[0].easing, ease_in());
        let toggled = fixture
            .store
            .set_tween(id, &fixture.scene, &fixture.layer, 0, false, None)
            .expect("toggle");
        assert!(!fixture.target(&toggled).keys[0].tween);
        assert_eq!(fixture.target(&toggled).keys[0].easing, ease_in());
        let edited = fixture
            .store
            .keyframe(id, &fixture.scene, &fixture.layer, 4, false)
            .expect("key");
        let target = fixture.target(&edited);
        assert_eq!(target.keys.len(), 2);
        assert_eq!(target.keys[1].easing, Easing::linear());
    }

    #[test]
    fn eased_tween_drives_the_transform_and_the_shapes() {
        let fixture = Fixture::new("easing-span");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(100.0, 100.0))
            .expect("draw start");
        fixture
            .store
            .keyframe(id, &fixture.scene, &fixture.layer, 10, true)
            .expect("blank key");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 10, box_shape(300.0, 100.0))
            .expect("draw end");
        fixture
            .store
            .set_transform(
                id,
                &fixture.scene,
                &fixture.layer,
                10,
                Transform {
                    x: 200.0,
                    ..Transform::default()
                },
            )
            .expect("transform");
        fixture
            .store
            .set_tween(id, &fixture.scene, &fixture.layer, 0, true, Some(ease_in()))
            .expect("tween");
        let frames = fixture
            .store
            .evaluate_range(id, &fixture.scene, 0, 10)
            .expect("evaluate");
        assert_eq!(frames[0].layers[0].shapes, vec![box_shape(100.0, 100.0)]);
        assert_eq!(frames[0].layers[0].transform.x, 0.0);
        assert_eq!(frames[10].layers[0].shapes, vec![box_shape(300.0, 100.0)]);
        assert_eq!(frames[10].layers[0].transform.x, 200.0);
        let Shape::Rect { x, .. } = frames[5].layers[0].shapes[0] else {
            panic!("expected a rectangle");
        };
        assert!((x - 163.071_362_501_178_6).abs() < 1e-9, "got {x}");
        assert!(
            (frames[5].layers[0].transform.x - 63.071_362_501_178_6).abs() < 1e-9,
            "got {}",
            frames[5].layers[0].transform.x
        );
        assert!(
            (frames[2].layers[0].transform.x - 12.456_400_265_113_877).abs() < 1e-9,
            "got {}",
            frames[2].layers[0].transform.x
        );
    }

    #[test]
    fn old_documents_without_easing_load_as_linear() {
        let legacy = serde_json::json!({
            "frame": 3,
            "shapes": [],
            "transform": { "x": 1.0, "y": 2.0, "rotation": 0.0, "scale": 1.0, "opacity": 1.0 },
            "tween": true,
            "label": "walk"
        });
        let key: Keyframe = serde_json::from_value(legacy).expect("legacy keyframe");
        assert_eq!(key.frame, 3);
        assert!(key.tween);
        assert_eq!(key.easing, Easing::linear());
        let partial: Keyframe = serde_json::from_value(serde_json::json!({
            "frame": 0,
            "shapes": [],
            "transform": { "x": 0.0, "y": 0.0, "rotation": 0.0, "scale": 1.0, "opacity": 1.0 },
            "tween": true,
            "label": null,
            "easing": { "x1": 0.42 }
        }))
        .expect("partial easing");
        assert_eq!(
            partial.easing,
            Easing {
                x1: 0.42,
                y1: 0.0,
                x2: 1.0,
                y2: 1.0,
            }
        );
        let json = serde_json::to_value(&key).expect("serialize");
        assert_eq!(json["easing"]["x2"], 1.0);
        assert_eq!(json["easing"]["y1"], 0.0);
    }

    #[test]
    fn easing_survives_save_and_reopen() {
        let dir = std::env::temp_dir().join(format!("stickmate-easing-{}", new_id("t")));
        let (id, expected) = {
            let store = DocStore::load(dir.clone());
            let doc = store
                .create("Saved".to_string(), 1920, 1080, 30, "#101010".to_string())
                .expect("create");
            let scene = doc.scenes[0].id.clone();
            let layer = doc.scenes[0].layers[0].id.clone();
            store
                .set_tween(&doc.id, &scene, &layer, 0, true, Some(ease_in()))
                .expect("tween");
            let expected = store.get(&doc.id).expect("get");
            (doc.id, expected)
        };
        let reloaded = DocStore::load(dir.clone());
        let restored = reloaded.get(&id).expect("loaded");
        assert_eq!(restored, expected);
        assert_eq!(restored.scenes[0].layers[0].keys[0].easing, ease_in());
        assert!(restored.scenes[0].layers[0].keys[0].tween);
        let legacy = serde_json::json!({
            "document": {
                "id": "legacy",
                "name": "Legacy",
                "width": 800,
                "height": 600,
                "fps": 24,
                "background": "#ffffff",
                "scenes": [{
                    "id": "s0",
                    "name": "Scene 1",
                    "layers": [{
                        "id": "l0",
                        "name": "Layer 1",
                        "visible": true,
                        "locked": false,
                        "opacity": 1.0,
                        "length": 11,
                        "keys": [{
                            "frame": 0,
                            "shapes": [],
                            "transform": { "x": 0.0, "y": 0.0, "rotation": 0.0, "scale": 1.0, "opacity": 1.0 },
                            "tween": true,
                            "label": null
                        }, {
                            "frame": 10,
                            "shapes": [],
                            "transform": { "x": 100.0, "y": 0.0, "rotation": 0.0, "scale": 1.0, "opacity": 1.0 },
                            "tween": false,
                            "label": null
                        }]
                    }]
                }]
            },
            "updated_at": 0
        });
        fs::write(
            dir.join("legacy.json"),
            serde_json::to_vec(&legacy).expect("json"),
        )
        .expect("write");
        let with_legacy = DocStore::load(dir.clone());
        let loaded = with_legacy.get("legacy").expect("legacy loaded");
        let key = &loaded.scenes[0].layers[0].keys[0];
        assert_eq!(key.easing, Easing::linear());
        let frames = with_legacy
            .evaluate_range("legacy", "s0", 5, 5)
            .expect("evaluate");
        assert_eq!(frames[0].layers[0].transform.x, 50.0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_layer_and_out_of_range_frame_evaluate_empty() {
        let fixture = Fixture::new("visible");
        let id = &fixture.doc.id;
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, Some(false), None, None, None, None, None)
            .expect("hide");
        let frames = fixture
            .store
            .evaluate_range(id, &fixture.scene, 0, 0)
            .expect("evaluate");
        assert!(frames[0].layers.is_empty());
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, Some(true), None, None, None, None, None)
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
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, None, Some(0.5), None, None, None)
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
    fn layer_effects_are_clamped_and_undone() {
        let fixture = Fixture::new("effects");
        let id = &fixture.doc.id;
        let effects = vec![
            Effect::Blur { radius: 900.0 },
            Effect::Shadow {
                x: -4.0,
                y: 6.0,
                blur: 3.0,
                color: "#ff0000".to_string(),
            },
        ];
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, None, None, None, Some(effects), None)
            .expect("effects");
        let stored = fixture
            .store
            .evaluate_range(id, &fixture.scene, 0, 0)
            .expect("evaluate");
        assert_eq!(
            stored[0].layers[0].effects,
            vec![
                Effect::Blur { radius: 500.0 },
                Effect::Shadow {
                    x: -4.0,
                    y: 6.0,
                    blur: 3.0,
                    color: "#ff0000".to_string(),
                },
            ]
        );
        assert_eq!(fixture.store.history(id).unwrap()[1].name, "layer_effects");
        fixture.store.undo(id).expect("undo");
        let cleared = fixture
            .store
            .evaluate_range(id, &fixture.scene, 0, 0)
            .expect("evaluate");
        assert!(cleared[0].layers[0].effects.is_empty());
    }

    fn rect(x: f64) -> Shape {
        Shape::Rect {
            x,
            y: 10.0,
            w: 40.0,
            h: 40.0,
            fill: "#22cc55".to_string(),
            stroke: "#000000".to_string(),
            width: 0.0,
            gradient: None,
        }
    }

    #[test]
    fn layer_masks_clip_to_the_layer_above() {
        let fixture = Fixture::new("masks");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, rect(0.0))
            .expect("draw content");
        let added = fixture
            .store
            .add_layer(id, &fixture.scene, "Mask".to_string(), None)
            .expect("add");
        let mask_id = added.scenes[0].layers[0].id.clone();
        fixture
            .store
            .draw(id, &fixture.scene, &mask_id, 0, rect(20.0))
            .expect("draw mask");
        let mask = fixture.store.get(id).expect("get").scenes[0].layers[0]
            .keys[0]
            .shapes[0]
            .clone();
        assert_eq!(
            fixture
                .store
                .set_layer(id, &fixture.scene, &mask_id, None, None, None, None, None, None, Some(true))
                .expect_err("top layer"),
            "the top layer cannot be clipped"
        );
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, None, None, None, None, Some(true))
            .expect("mask");
        let frames = fixture
            .store
            .evaluate_range(id, &fixture.scene, 0, 0)
            .expect("evaluate");
        let content = frames[0].layers.iter().find(|l| l.id == fixture.layer).expect("content");
        assert_eq!(content.mask.as_ref().expect("mask").shapes, vec![mask]);
        assert_eq!(
            fixture.store.history(id).unwrap()[4].name,
            "layer_mask"
        );
        fixture.store.undo(id).expect("undo");
        let cleared = fixture
            .store
            .evaluate_range(id, &fixture.scene, 0, 0)
            .expect("evaluate");
        let content = cleared[0]
            .layers
            .iter()
            .find(|l| l.id == fixture.layer)
            .expect("content");
        assert_eq!(content.mask, None);
    }

    #[test]
    fn layer_masks_break_when_layers_move() {
        let fixture = Fixture::new("mask-move");
        let id = &fixture.doc.id;
        let added = fixture
            .store
            .add_layer(id, &fixture.scene, "Top".to_string(), None)
            .expect("add");
        let top_id = added.scenes[0].layers[0].id.clone();
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, None, None, None, None, Some(true))
            .expect("mask");
        fixture
            .store
            .move_layer(id, &fixture.scene, &top_id, 1, None)
            .expect("move");
        let scene = &fixture.store.get(id).expect("get").scenes[0];
        assert!(!scene.layers[0].masked);
        assert!(!scene.layers[1].masked);
    }

    #[test]
    fn masked_layers_cannot_chain() {
        let fixture = Fixture::new("mask-chain");
        let id = &fixture.doc.id;
        let added = fixture
            .store
            .add_layer(id, &fixture.scene, "Middle".to_string(), None)
            .expect("add");
        let middle_id = added.scenes[0].layers[0].id.clone();
        fixture
            .store
            .add_layer(id, &fixture.scene, "Top".to_string(), None)
            .expect("add top");
        fixture
            .store
            .set_layer(id, &fixture.scene, &middle_id, None, None, None, None, None, None, Some(true))
            .expect("clip middle");
        assert_eq!(
            fixture
                .store
                .set_layer(id, &fixture.scene, &fixture.layer, None, None, None, None, None, None, Some(true))
                .expect_err("chain"),
            "a mask layer cannot itself be clipped"
        );
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
                .set_tween(&doc.id, &scene, &layer, 6, true, None)
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
            .set_layer(id, &fixture.scene, &fixture.layer, Some("  ".to_string()), None, None, None, None, None, None)
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
        let added = fixture.store.add_layer(id, &fixture.scene, "Ink".to_string(), None).expect("add");
        assert_eq!(added.scenes[0].layers.len(), 2);
        assert_eq!(added.scenes[0].layers[0].name, "Ink");
        let ink = added.scenes[0].layers[0].id.clone();
        let renamed = fixture
            .store
            .set_layer(id, &fixture.scene, &ink, Some("Paint".to_string()), None, None, Some(0.4), None, None, None)
            .expect("set");
        assert_eq!(renamed.scenes[0].layers[0].name, "Paint");
        assert_eq!(renamed.scenes[0].layers[0].opacity, 0.4);
        let moved = fixture.store.move_layer(id, &fixture.scene, &ink, 1, None).expect("move");
        assert_eq!(moved.scenes[0].layers[1].id, ink);
        let removed = fixture.store.remove_layer(id, &fixture.scene, &ink).expect("remove");
        assert_eq!(removed.scenes[0].layers.len(), 1);
    }

    fn folder_of(doc: &Document, name: &str) -> String {
        doc.scenes[0]
            .layers
            .iter()
            .find(|layer| layer.name == name)
            .expect("folder")
            .id
            .clone()
    }

    fn child_of<'a>(layer: &'a Layer, name: &str) -> &'a Layer {
        layer
            .children
            .iter()
            .find(|child| child.name == name)
            .expect("child")
    }

    #[test]
    fn folders_hold_layers_and_keep_their_own_identity() {
        let fixture = Fixture::new("folders");
        let id = &fixture.doc.id;
        let added = fixture
            .store
            .add_folder(id, &fixture.scene, "Art".to_string(), None)
            .expect("add folder");
        let folder = folder_of(&added, "Art");
        assert!(added.scenes[0].layers[0].folder);
        assert_eq!(added.scenes[0].layers[0].keys.len(), 0);
        let moved = fixture
            .store
            .move_layer(id, &fixture.scene, &fixture.layer, 0, Some(folder.clone()))
            .expect("move in");
        assert_eq!(moved.scenes[0].layers.len(), 1);
        assert_eq!(moved.scenes[0].layers[0].children.len(), 1);
        assert_eq!(moved.scenes[0].layers[0].children[0].id, fixture.layer);
        assert_eq!(leaf_count(&moved.scenes[0].layers), 1);
        let restored: Layer =
            serde_json::from_str(&serde_json::to_string(&moved.scenes[0].layers[0]).expect("json"))
                .expect("layer");
        assert_eq!(restored, moved.scenes[0].layers[0]);
    }

    #[test]
    fn documents_saved_before_folders_still_load() {
        let fixture = Fixture::new("folder-legacy");
        let mut stored = serde_json::to_value(&fixture.doc).expect("json");
        for scene in stored["scenes"].as_array_mut().expect("scenes") {
            for layer in scene["layers"].as_array_mut().expect("layers") {
                layer.as_object_mut().expect("object").remove("folder");
                layer.as_object_mut().expect("object").remove("children");
            }
        }
        let restored: Document = serde_json::from_value(stored).expect("legacy document");
        assert_eq!(restored, fixture.doc);
    }

    #[test]
    fn a_locked_folder_locks_every_layer_inside() {
        let fixture = Fixture::new("folder-lock");
        let id = &fixture.doc.id;
        let folder = fixture
            .store
            .add_folder(id, &fixture.scene, "Art".to_string(), None)
            .expect("folder");
        let folder_id = folder_of(&folder, "Art");
        fixture
            .store
            .move_layer(id, &fixture.scene, &fixture.layer, 0, Some(folder_id.clone()))
            .expect("move in");
        fixture
            .store
            .set_layer(id, &fixture.scene, &folder_id, None, None, Some(true), None, None, None, None)
            .expect("lock folder");
        assert_eq!(
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
                .expect_err("locked"),
            "layer is locked"
        );
        assert_eq!(
            fixture
                .store
                .insert_frame(id, &fixture.scene, &fixture.layer, 0)
                .expect_err("locked"),
            "layer is locked"
        );
        assert_eq!(
            fixture
                .store
                .set_transform(id, &fixture.scene, &fixture.layer, 0, Transform::default())
                .expect_err("locked"),
            "layer is locked"
        );
        fixture
            .store
            .set_layer(id, &fixture.scene, &folder_id, None, None, Some(false), None, None, None, None)
            .expect("unlock folder");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("draw after unlock");
    }

    #[test]
    fn a_hidden_folder_hides_every_layer_inside() {
        let fixture = Fixture::new("folder-visibility");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("draw");
        let added = fixture
            .store
            .add_folder(id, &fixture.scene, "Art".to_string(), None)
            .expect("folder");
        let folder_id = folder_of(&added, "Art");
        fixture
            .store
            .move_layer(id, &fixture.scene, &fixture.layer, 0, Some(folder_id.clone()))
            .expect("move in");
        let visible = fixture
            .store
            .get(id)
            .expect("get")
            .evaluate(&fixture.scene, 0)
            .expect("evaluate");
        assert_eq!(visible.layers.len(), 1);
        assert_eq!(visible.layers[0].children.len(), 1);
        fixture
            .store
            .set_layer(id, &fixture.scene, &folder_id, None, Some(false), None, None, None, None, None)
            .expect("hide folder");
        assert!(fixture
            .store
            .get(id)
            .expect("get")
            .evaluate(&fixture.scene, 0)
            .expect("evaluate")
            .layers
            .is_empty());
        fixture
            .store
            .set_layer(id, &fixture.scene, &folder_id, None, Some(true), None, None, None, None, None)
            .expect("show folder");
        assert_eq!(
            fixture
                .store
                .get(id)
                .expect("get")
                .evaluate(&fixture.scene, 0)
                .expect("evaluate")
                .layers
                .len(),
            1
        );
    }

    #[test]
    fn folders_refuse_frames_and_shapes() {
        let fixture = Fixture::new("folder-frames");
        let id = &fixture.doc.id;
        let added = fixture
            .store
            .add_folder(id, &fixture.scene, "Art".to_string(), None)
            .expect("folder");
        let folder_id = folder_of(&added, "Art");
        assert_eq!(
            fixture
                .store
                .draw(id, &fixture.scene, &folder_id, 0, stroke(1.0))
                .expect_err("draw"),
            "folders cannot hold frames or shapes"
        );
        assert_eq!(
            fixture
                .store
                .insert_frame(id, &fixture.scene, &folder_id, 0)
                .expect_err("frame"),
            "folders cannot hold frames or shapes"
        );
        assert_eq!(
            fixture
                .store
                .remove_frames(id, &fixture.scene, &folder_id, 0, 1)
                .expect_err("remove frames"),
            "folders cannot hold frames or shapes"
        );
    }

    #[test]
    fn removing_a_folder_splices_its_layers_back_in_order() {
        let fixture = Fixture::new("folder-open");
        let id = &fixture.doc.id;
        let added = fixture
            .store
            .add_folder(id, &fixture.scene, "Art".to_string(), None)
            .expect("folder");
        let folder_id = folder_of(&added, "Art");
        let second = fixture
            .store
            .add_layer(id, &fixture.scene, "Ink".to_string(), Some(folder_id.clone()))
            .expect("layer in folder");
        let ink = child_of(&second.scenes[0].layers[0], "Ink").id.clone();
        fixture
            .store
            .move_layer(id, &fixture.scene, &fixture.layer, 1, Some(folder_id.clone()))
            .expect("move in");
        let opened = fixture
            .store
            .remove_folder(id, &fixture.scene, &folder_id)
            .expect("open");
        assert_eq!(opened.scenes[0].layers.len(), 2);
        assert_eq!(opened.scenes[0].layers[0].id, ink);
        assert_eq!(opened.scenes[0].layers[1].id, fixture.layer);
        assert_eq!(opened.scenes[0].layers[1].name, "Layer 1");
        assert_eq!(
            fixture
                .store
                .remove_folder(id, &fixture.scene, &ink)
                .expect_err("not a folder"),
            "target is not a folder"
        );
    }

    #[test]
    fn folder_nesting_is_capped_and_cycles_refused() {
        let fixture = Fixture::new("folder-depth");
        let id = &fixture.doc.id;
        let mut parent: Option<String> = None;
        let mut deepest = String::new();
        let mut outermost = String::new();
        let mut inner = String::new();
        for level in 0..MAX_FOLDER_DEPTH {
            let added = fixture
                .store
                .add_folder(id, &fixture.scene, format!("Level {level}"), parent.clone())
                .expect("folder");
            let newest = match &parent {
                None => added.scenes[0].layers[0].id.clone(),
                Some(open) => find_layer(&added.scenes[0].layers, open)
                    .expect("open folder")
                    .children[0]
                    .id
                    .clone(),
            };
            deepest = newest.clone();
            if level == 0 {
                outermost = newest.clone();
            }
            if level == 1 {
                inner = newest.clone();
            }
            parent = Some(newest);
        }
        assert_eq!(
            fixture
                .store
                .move_layer(id, &fixture.scene, &fixture.layer, 0, Some(deepest.clone()))
                .expect_err("too deep"),
            "folders cannot nest deeper than 16 levels"
        );
        assert_eq!(
            fixture
                .store
                .move_layer(id, &fixture.scene, &deepest, 0, Some(deepest.clone()))
                .expect_err("cycle"),
            "a folder cannot contain itself"
        );
        assert_eq!(
            fixture
                .store
                .move_layer(id, &fixture.scene, &outermost, 0, Some(deepest.clone()))
                .expect_err("ancestor into descendant"),
            "a folder cannot contain itself"
        );
        fixture
            .store
            .move_layer(id, &fixture.scene, &inner, 0, Some(outermost.clone()))
            .expect("reorder inside the current folder");
        assert_eq!(
            fixture
                .store
                .move_layer(id, &fixture.scene, &deepest, 0, Some(fixture.layer.clone()))
                .expect_err("leaf parent"),
            "target is not a folder"
        );
        assert_eq!(
            fixture
                .store
                .move_layer(id, &fixture.scene, &fixture.layer, 0, Some("nope".to_string()))
                .expect_err("unknown"),
            "unknown folder"
        );
    }

    #[test]
    fn clipping_ignores_folders_and_refuses_folder_targets() {
        let fixture = Fixture::new("folder-mask");
        let id = &fixture.doc.id;
        let added = fixture
            .store
            .add_folder(id, &fixture.scene, "Art".to_string(), None)
            .expect("folder");
        let folder_id = folder_of(&added, "Art");
        assert_eq!(
            fixture
                .store
                .set_layer(id, &fixture.scene, &folder_id, None, None, None, None, None, None, Some(true))
                .expect_err("folder clip"),
            "folders cannot be clipped"
        );
        let second = fixture
            .store
            .add_layer(id, &fixture.scene, "Ink".to_string(), None)
            .expect("layer");
        let ink = second.scenes[0].layers[0].id.clone();
        let base = second.scenes[0].layers[2].id.clone();
        assert_eq!(
            fixture
                .store
                .set_layer(id, &fixture.scene, &ink, None, None, None, None, None, None, Some(true))
                .expect_err("top clip"),
            "the top layer cannot be clipped"
        );
        assert_eq!(
            fixture
                .store
                .set_layer(id, &fixture.scene, &base, None, None, None, None, None, None, Some(true))
                .expect_err("clip below folder"),
            "clipping needs a layer directly above"
        );
        fixture
            .store
            .move_layer(id, &fixture.scene, &folder_id, 2, None)
            .expect("move folder down");
        fixture
            .store
            .set_layer(id, &fixture.scene, &base, None, None, None, None, None, None, Some(true))
            .expect("clip under a plain layer");
        assert!(fixture.store.get(id).expect("get").scenes[0].layers[1].masked);
    }

    #[test]
    fn scene_length_follows_layers_inside_folders() {
        let fixture = Fixture::new("folder-length");
        let id = &fixture.doc.id;
        let added = fixture
            .store
            .add_folder(id, &fixture.scene, "Art".to_string(), None)
            .expect("folder");
        let folder_id = folder_of(&added, "Art");
        fixture
            .store
            .insert_frames(id, &fixture.scene, &fixture.layer, 0, 7)
            .expect("extend");
        let scene = fixture.store.get(id).expect("get").scenes[0].clone();
        assert_eq!(scene.length(), 8);
        let moved = fixture
            .store
            .move_layer(id, &fixture.scene, &fixture.layer, 0, Some(folder_id))
            .expect("move in");
        assert_eq!(moved.scenes[0].length(), 8);
    }

    #[test]
    fn evaluation_returns_a_tree_of_layers() {
        let fixture = Fixture::new("folder-evaluate");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(1.0))
            .expect("draw");
        let added = fixture
            .store
            .add_folder(id, &fixture.scene, "Art".to_string(), None)
            .expect("folder");
        let folder_id = folder_of(&added, "Art");
        let inner = fixture
            .store
            .add_layer(id, &fixture.scene, "Ink".to_string(), Some(folder_id.clone()))
            .expect("layer");
        let ink = child_of(&inner.scenes[0].layers[0], "Ink").id.clone();
        fixture
            .store
            .draw(id, &fixture.scene, &ink, 0, stroke(2.0))
            .expect("draw inside");
        let frame = fixture
            .store
            .get(id)
            .expect("get")
            .evaluate(&fixture.scene, 0)
            .expect("evaluate");
        assert_eq!(frame.layers.len(), 2);
        let folder = frame.layers.iter().find(|layer| layer.id == folder_id).expect("folder");
        assert!(folder.folder);
        assert_eq!(folder.children.len(), 1);
        assert_eq!(folder.children[0].shapes.len(), 1);
        assert!(folder.shapes.is_empty());
        assert_eq!(folder.transform, Transform::default());
        let empty = fixture
            .store
            .remove_layer(id, &fixture.scene, &ink)
            .expect("remove inner");
        assert_eq!(
            empty
                .evaluate(&fixture.scene, 0)
                .expect("evaluate")
                .layers
                .len(),
            1
        );
    }

    #[test]
    fn duplicating_a_folder_reseeds_every_layer_inside() {
        let fixture = Fixture::new("folder-duplicate");
        let id = &fixture.doc.id;
        let added = fixture
            .store
            .add_folder(id, &fixture.scene, "Art".to_string(), None)
            .expect("folder");
        let folder_id = folder_of(&added, "Art");
        fixture
            .store
            .move_layer(id, &fixture.scene, &fixture.layer, 0, Some(folder_id.clone()))
            .expect("move in");
        let copy = fixture
            .store
            .duplicate_layer(id, &fixture.scene, &folder_id)
            .expect("duplicate");
        assert_eq!(copy.scenes[0].layers.len(), 2);
        let original = &copy.scenes[0].layers[0];
        let clone = &copy.scenes[0].layers[1];
        assert_eq!(clone.name, "Art copy");
        assert_eq!(clone.children.len(), 1);
        assert_eq!(clone.children[0].name, "Layer 1");
        assert_ne!(clone.children[0].id, fixture.layer);
        assert!(!contains_layer(&original.children, &clone.children[0].id));
        let _ = fixture.store.undo(id).expect("undo");
        assert_eq!(fixture.store.get(id).expect("get").scenes[0].layers.len(), 1);
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
            gradient: None,
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
            gradient: None,
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
            spacing: 0.0,
            leading: TEXT_LEADING,
            align: TextAlign::Left,
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
            gradient: None,
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
    fn polygon_vertices_start_at_top_and_text_metrics_use_advance() {
        let vertices = polygon_vertices(0.0, 0.0, 100.0, 100.0, 3);
        assert_eq!(vertices.len(), 3);
        assert!((vertices[0].x - 50.0).abs() < 1e-9);
        assert!(vertices[0].y.abs() < 1e-9);
        assert!(vertices[1].x > vertices[2].x);
        assert_eq!(text_block_width("AB", 10.0, 0.0), 12.0);
        assert_eq!(text_block_width("AB", 10.0, 3.0), 15.0);
        assert_eq!(text_block_width("A\nABC", 10.0, 0.0), 18.0);
        assert_eq!(text_line_width("AB", 10.0, 3.0), 15.0);
        assert_eq!(text_block_height(3, 10.0, 1.2), 34.0);
    }

    fn paragraph(value: &str, spacing: f64, leading: f64, align: TextAlign) -> Shape {
        Shape::Text {
            x: 300.0,
            y: 10.0,
            text: value.to_string(),
            size: 10.0,
            family: "Segoe UI".to_string(),
            color: "#000000".to_string(),
            spacing,
            leading,
            align,
            matrix: None,
        }
    }

    #[test]
    fn text_paragraphs_default_keep_size_and_reject_extremes() {
        let json = r##"{"kind":"Text","x":10.0,"y":20.0,"text":"hi","size":10.0,"family":"sans-serif","color":"#000000"}"##;
        let legacy: Shape = serde_json::from_str(json).expect("legacy text");
        let Shape::Text {
            spacing,
            leading,
            align,
            ..
        } = legacy
        else {
            panic!("expected text");
        };
        assert_eq!((spacing, leading), (0.0, TEXT_LEADING));
        assert_eq!(align, TextAlign::Left);

        let block = paragraph("A\nBCDE", 2.0, 2.0, TextAlign::Right);
        assert_eq!(
            shape_bounds(&block),
            Bounds {
                x: 300.0,
                y: 10.0,
                w: 30.0,
                h: 30.0
            }
        );
        let restored: Shape =
            serde_json::from_str(&serde_json::to_string(&block).expect("json")).expect("shape");
        assert_eq!(restored, block);

        let fixture = Fixture::new("text-paragraph");
        let id = &fixture.doc.id;
        assert_eq!(
            fixture
                .store
                .draw(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    paragraph("A", 900.0, 1.0, TextAlign::Left)
                )
                .expect_err("spacing"),
            "text spacing must be between -500 and 500"
        );
        assert_eq!(
            fixture
                .store
                .draw(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    paragraph("A", 0.0, 20.0, TextAlign::Left)
                )
                .expect_err("leading"),
            "text line spacing must be between 0.2 and 10"
        );
        assert!(fixture.target(&fixture.doc).keys[0].shapes.is_empty());
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
                gradient: None,
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
            gradient: None,
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
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None, None, None, None)
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
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None, None, None, None)
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
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None, None, None, None)
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
            gradient: None,
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
            gradient: None,
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
            gradient: None,
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
            gradient: None,
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
                        gradient: None,
                    }
                )
                .expect_err("shrunk"),
            "path needs at least 2 nodes"
        );
        fixture
            .store
            .replace_shape(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                0,
                Shape::Path {
                    nodes: curve_nodes(),
                    closed: false,
                    fill: "#ff0000".to_string(),
                    stroke: "none".to_string(),
                    width: 0.0,
                    gradient: None,
                }
            )
            .expect("unstroked");
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
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None, None, None, None)
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
            gradient: None,
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
        let Shape::Text { x, y, text, size, family, spacing, leading, matrix: Some(matrix), .. } = shape else {
            panic!("expected editable transformed text");
        };
        assert_eq!((*x, *y, *size), (300.0, 10.0, 12.0));
        assert_eq!(text, "A𐐀");
        assert_eq!(family, "Segoe UI");
        for point in text_corners(*x, *y, text, *size, *spacing, *leading, &None) {
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
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None, None, None, None)
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

    fn rect_xs(layer: &Layer) -> Vec<f64> {
        rect_axis(layer, true)
    }

    fn rect_ys(layer: &Layer) -> Vec<f64> {
        rect_axis(layer, false)
    }

    fn rect_axis(layer: &Layer, horizontal: bool) -> Vec<f64> {
        layer.keys[0]
            .shapes
            .iter()
            .map(|shape| match shape {
                Shape::Rect { x, y, .. } => {
                    if horizontal {
                        *x
                    } else {
                        *y
                    }
                }
                _ => panic!("expected rect"),
            })
            .collect()
    }

    #[test]
    fn align_shapes_moves_edges_and_centers_to_the_stage_reference() {
        let fixture = Fixture::new("align-stage");
        let id = &fixture.doc.id;
        for (x, y) in [(100.0, 50.0), (300.0, 200.0)] {
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(x, y))
                .expect("draw");
        }
        let edges = [
            (AlignMode::Left, true, 0.0),
            (AlignMode::Right, true, 780.0),
            (AlignMode::CenterH, true, 390.0),
            (AlignMode::Top, false, 0.0),
            (AlignMode::Bottom, false, 580.0),
            (AlignMode::CenterV, false, 290.0),
        ];
        for (mode, horizontal, wanted) in edges {
            let edited = fixture
                .store
                .align_shapes(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    vec![0, 1],
                    mode,
                    AlignReference::Stage,
                )
                .expect("align");
            let placed = if horizontal {
                rect_xs(fixture.target(&edited))
            } else {
                rect_ys(fixture.target(&edited))
            };
            assert_eq!(placed, vec![wanted, wanted], "{:?}", mode);
        }
    }

    #[test]
    fn align_shapes_uses_the_selection_bounds_when_reference_is_selection() {
        let fixture = Fixture::new("align-selection");
        let id = &fixture.doc.id;
        for (x, y) in [(100.0, 50.0), (300.0, 200.0)] {
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(x, y))
                .expect("draw");
        }
        let spread = fixture.store.get(id).expect("spread");
        let cases = [
            (AlignMode::Left, vec![100.0, 100.0]),
            (AlignMode::Right, vec![300.0, 300.0]),
            (AlignMode::CenterH, vec![200.0, 200.0]),
        ];
        for (mode, expected) in cases {
            let edited = fixture
                .store
                .align_shapes(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    vec![0, 1],
                    mode,
                    AlignReference::Selection,
                )
                .expect("align");
            assert_eq!(rect_xs(fixture.target(&edited)), expected, "{:?}", mode);
            assert_eq!(fixture.store.undo(id).expect("undo"), spread, "{:?}", mode);
        }
        let centered = fixture
            .store
            .align_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0, 1],
                AlignMode::CenterV,
                AlignReference::Selection,
            )
            .expect("center");
        assert_eq!(rect_ys(fixture.target(&centered)), vec![125.0, 125.0]);
    }

    #[test]
    fn align_shapes_distributes_across_the_stage_edges() {
        let fixture = Fixture::new("align-distribute");
        let id = &fixture.doc.id;
        for x in [100.0, 200.0, 300.0] {
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(x, 40.0))
                .expect("draw");
        }
        let edited = fixture
            .store
            .align_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0, 1, 2],
                AlignMode::DistributeH,
                AlignReference::Stage,
            )
            .expect("distribute");
        let shapes = &fixture.target(&edited).keys[0].shapes;
        assert_eq!(rect_xs(fixture.target(&edited)), vec![0.0, 390.0, 780.0]);
        for shape in shapes {
            let Shape::Rect { y, w, h, .. } = shape else {
                panic!("expected rect");
            };
            assert_eq!(*y, 40.0);
            assert_eq!(*w, 20.0);
            assert_eq!(*h, 20.0);
        }
        let before = fixture.store.get(id).expect("get");
        let steps = fixture.store.history(id).expect("history").len();
        for tag in ["distribute_h", "distribute_v"] {
            let mode = AlignMode::parse(tag).expect("mode");
            let edited = fixture
                .store
                .align_shapes(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    vec![0, 1],
                    mode,
                    AlignReference::Stage,
                )
                .expect("two shapes");
            assert_eq!(edited, before);
            assert_eq!(fixture.store.history(id).expect("history").len(), steps);
        }
    }

    #[test]
    fn align_shapes_distributes_by_position_and_fills_the_selection_box() {
        let fixture = Fixture::new("align-distribute-order");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 50.0))
            .expect("first");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 300.0))
            .expect("second");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 100.0))
            .expect("third");
        let edited = fixture
            .store
            .align_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![2, 0, 1],
                AlignMode::DistributeV,
                AlignReference::Selection,
            )
            .expect("distribute");
        assert_eq!(rect_ys(fixture.target(&edited)), vec![50.0, 300.0, 175.0]);
    }

    #[test]
    fn align_shapes_is_one_undo_step_and_a_no_op_pushes_no_history() {
        let fixture = Fixture::new("align-history");
        let id = &fixture.doc.id;
        for x in [100.0, 200.0, 300.0] {
            fixture
                .store
                .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(x, 0.0))
                .expect("draw");
        }
        let before = fixture.store.get(id).expect("get");
        let steps = fixture.store.history(id).expect("history").len();
        let untouched = fixture
            .store
            .align_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0, 1, 2],
                AlignMode::Top,
                AlignReference::Stage,
            )
            .expect("no-op");
        assert_eq!(untouched, before);
        assert_eq!(fixture.store.history(id).expect("history").len(), steps);
        let edited = fixture
            .store
            .align_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0, 1, 2],
                AlignMode::DistributeH,
                AlignReference::Stage,
            )
            .expect("distribute");
        assert_ne!(edited, before);
        let history = fixture.store.history(id).expect("history");
        assert_eq!(history.len(), steps + 1);
        assert_eq!(history.last().expect("step").name, "align_shapes");
        drop(history);
        assert_eq!(fixture.store.undo(id).expect("undo"), before);
        let restored = fixture.store.get(id).expect("get");
        assert_eq!(
            rect_xs(&restored.scenes[0].layers[0]),
            vec![100.0, 200.0, 300.0]
        );
    }

    #[test]
    fn align_shapes_moves_every_shape_kind_and_keeps_the_text_matrix() {
        let fixture = Fixture::new("align-kinds");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(100.0))
            .expect("stroke");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, ellipse_shape(200.0, 0.0, 40.0, 20.0))
            .expect("ellipse");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, polygon(6))
            .expect("polygon");
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, curve_path(false))
            .expect("path");
        fixture
            .store
            .draw(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                Shape::Text {
                    x: 100.0,
                    y: 50.0,
                    text: "hi".to_string(),
                    size: 20.0,
                    family: "Segoe UI".to_string(),
                    color: "#000000".to_string(),
                    spacing: 0.0,
                    leading: TEXT_LEADING,
                    align: TextAlign::Center,
                    matrix: Some(affine_from(&Point { x: 110.0, y: 60.0 }, 0.0, 0.0, 1.0, 1.0, 30.0)),
                },
            )
            .expect("text");
        let indices: Vec<usize> = (0..5).collect();
        let edited = fixture
            .store
            .align_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                indices,
                AlignMode::Left,
                AlignReference::Stage,
            )
            .expect("align");
        let shapes = &fixture.target(&edited).keys[0].shapes;
        assert_eq!(shapes.len(), 5);
        for shape in shapes {
            close(shape_bounds(shape).x, 0.0);
        }
        let Shape::Text { matrix, text, size, .. } = &shapes[4] else {
            panic!("expected text");
        };
        assert_eq!(text.as_str(), "hi");
        assert_eq!(*size, 20.0);
        assert!(matrix.is_some());
    }

    #[test]
    fn align_shapes_rejects_unknown_arguments_and_locked_layers() {
        let fixture = Fixture::new("align-errors");
        let id = &fixture.doc.id;
        fixture
            .store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(10.0, 10.0))
            .expect("draw");
        assert_eq!(
            fixture
                .store
                .align_shapes(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    Vec::new(),
                    AlignMode::Left,
                    AlignReference::Stage
                )
                .expect_err("empty"),
            "no shapes selected"
        );
        assert_eq!(
            fixture
                .store
                .align_shapes(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    vec![9],
                    AlignMode::CenterH,
                    AlignReference::Selection
                )
                .expect_err("index"),
            "unknown shape"
        );
        assert_eq!(
            AlignMode::parse("sideways").expect_err("mode"),
            "unknown align mode"
        );
        assert_eq!(
            AlignReference::parse("canvas").expect_err("reference"),
            "unknown align reference"
        );
        fixture
            .store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None, None, None, None)
            .expect("lock");
        assert_eq!(
            fixture
                .store
                .align_shapes(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    vec![0],
                    AlignMode::Top,
                    AlignReference::Stage
                )
                .expect_err("locked"),
            "layer is locked"
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
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, None, Some(0.5), None, None, None)
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
            .add_layer(id, &fixture.scene, "Top".to_string(), None)
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
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None, None, None, None)
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
                    gradient: None,
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
                    spacing: 0.0,
                    leading: TEXT_LEADING,
                    align: TextAlign::Left,
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
                    spacing: 0.0,
                    leading: TEXT_LEADING,
                    align: TextAlign::Left,
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

    #[test]
    fn group_command_signatures_match_frontend() {
        let _: fn(State<'_, DocStore>, String, String, String, u32, Vec<usize>) -> Result<Document, String> =
            doc_group_shapes;
        let _: fn(State<'_, DocStore>, String, String, String, u32, usize) -> Result<Document, String> =
            doc_ungroup_shape;
    }

    #[test]
    fn bool_command_signature_matches_frontend() {
        let _: fn(
            State<'_, DocStore>,
            String,
            String,
            String,
            u32,
            Vec<usize>,
            BoolOp,
        ) -> Result<Document, String> = doc_shape_bool;
    }

    #[test]
    fn group_then_ungroup_round_trips_the_shapes() {
        let fixture = Fixture::new("group-round");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        let first = box_shape(0.0, 0.0);
        let middle = box_shape(50.0, 0.0);
        let last = box_shape(100.0, 0.0);
        for shape in [first.clone(), middle.clone(), last.clone()] {
            store
                .draw(id, &fixture.scene, &fixture.layer, 0, shape)
                .expect("draw");
        }
        let before = store.history(id).expect("history").len();
        let grouped = store
            .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![2, 0, 2])
            .expect("group");
        let shapes = &fixture.target(&grouped).keys[0].shapes;
        assert_eq!(shapes.len(), 2);
        assert_eq!(
            shapes[0],
            Shape::Group {
                children: vec![first.clone(), last.clone()]
            }
        );
        assert_eq!(shapes[1], middle);
        assert_eq!(store.history(id).expect("history").len(), before + 1);
        assert_eq!(store.history(id).expect("history")[before].name, "group_shapes");
        let ungrouped = store
            .ungroup_shape(id, &fixture.scene, &fixture.layer, 0, 0)
            .expect("ungroup");
        assert_eq!(
            fixture.target(&ungrouped).keys[0].shapes,
            vec![first.clone(), last.clone(), middle.clone()]
        );
        let undone = store.undo(id).expect("undo");
        assert_eq!(
            fixture.target(&undone).keys[0].shapes,
            vec![
                Shape::Group {
                    children: vec![first.clone(), last.clone()]
                },
                middle.clone()
            ]
        );
        let undone = store.undo(id).expect("undo group");
        assert_eq!(
            fixture.target(&undone).keys[0].shapes,
            vec![first, middle, last]
        );
    }

    #[test]
    fn group_rejects_bad_indices_without_history() {
        let fixture = Fixture::new("group-bad");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 0.0))
            .expect("draw");
        let before = store.history(id).expect("history").len();
        assert_eq!(
            store
                .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0])
                .expect_err("single"),
            "select at least two shapes"
        );
        assert_eq!(
            store
                .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 0])
                .expect_err("duplicate"),
            "select at least two shapes"
        );
        assert_eq!(
            store
                .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 4])
                .expect_err("range"),
            "unknown shape"
        );
        assert_eq!(store.history(id).expect("history").len(), before);
    }

    #[test]
    fn ungroup_rejects_non_groups_without_history() {
        let fixture = Fixture::new("ungroup-bad");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 0.0))
            .expect("draw");
        let before = store.history(id).expect("history").len();
        assert_eq!(
            store
                .ungroup_shape(id, &fixture.scene, &fixture.layer, 0, 0)
                .expect_err("plain"),
            "shape is not a group"
        );
        assert_eq!(
            store
                .ungroup_shape(id, &fixture.scene, &fixture.layer, 0, 5)
                .expect_err("range"),
            "unknown shape"
        );
        assert_eq!(store.history(id).expect("history").len(), before);
    }

    #[test]
    fn nested_groups_ungroup_one_level_at_a_time() {
        let fixture = Fixture::new("group-nest");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        let shapes: Vec<Shape> = (0..4)
            .map(|index| box_shape(f64::from(index) * 40.0, 0.0))
            .collect();
        for shape in shapes.clone() {
            store
                .draw(id, &fixture.scene, &fixture.layer, 0, shape)
                .expect("draw");
        }
        store
            .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 1])
            .expect("inner");
        let nested = store
            .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 2])
            .expect("outer");
        let outer = &fixture.target(&nested).keys[0].shapes;
        assert_eq!(outer.len(), 2);
        let Shape::Group { children } = &outer[0] else {
            panic!("expected a group");
        };
        assert_eq!(children.len(), 2);
        assert!(matches!(children[0], Shape::Group { .. }));
        assert_eq!(children[1], shapes[3]);
        let opened = store
            .ungroup_shape(id, &fixture.scene, &fixture.layer, 0, 0)
            .expect("open outer");
        let flat = &fixture.target(&opened).keys[0].shapes;
        assert_eq!(flat.len(), 3);
        assert!(matches!(flat[0], Shape::Group { .. }));
        let opened = store
            .ungroup_shape(id, &fixture.scene, &fixture.layer, 0, 0)
            .expect("open inner");
        assert_eq!(
            fixture.target(&opened).keys[0].shapes,
            vec![shapes[0].clone(), shapes[1].clone(), shapes[3].clone(), shapes[2].clone()]
        );
    }

    #[test]
    fn group_transform_moves_and_scales_every_child() {
        let fixture = Fixture::new("group-transform");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        for shape in [box_shape(0.0, 0.0), box_shape(40.0, 20.0)] {
            store
                .draw(id, &fixture.scene, &fixture.layer, 0, shape)
                .expect("draw");
        }
        let grouped = store
            .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 1])
            .expect("group");
        let group = fixture.target(&grouped).keys[0].shapes[0].clone();
        let bounds = shape_bounds(&group);
        assert_eq!(
            bounds,
            Bounds {
                x: 0.0,
                y: 0.0,
                w: 60.0,
                h: 40.0
            }
        );
        let moved = store
            .transform_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0],
                Point { x: 0.0, y: 0.0 },
                10.0,
                5.0,
                2.0,
                2.0,
                0.0,
            )
            .expect("transform");
        assert_eq!(
            fixture.target(&moved).keys[0].shapes[0],
            Shape::Group {
                children: vec![box_shape(10.0, 5.0), box_shape(90.0, 45.0)]
                    .into_iter()
                    .map(|shape| match shape {
                        Shape::Rect {
                            x,
                            y,
                            fill,
                            stroke,
                            width,
                            ..
                        } => Shape::Rect {
                            x,
                            y,
                            w: 40.0,
                            h: 40.0,
                            fill,
                            stroke,
                            width,
                            gradient: None,
                        },
                        other => other,
                    })
                    .collect()
            }
        );
    }

    #[test]
    fn group_rotation_recurses_and_keeps_the_ellipse_guard() {
        let fixture = Fixture::new("group-rotate");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 0.0))
            .expect("draw rect");
        store
            .draw(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                Shape::Ellipse {
                    x: 40.0,
                    y: 0.0,
                    w: 20.0,
                    h: 10.0,
                    fill: "#ff0000".to_string(),
                    stroke: "#000000".to_string(),
                    width: 1.0,
                    gradient: None,
                },
            )
            .expect("draw ellipse");
        store
            .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 1])
            .expect("group");
        assert_eq!(
            store
                .transform_shapes(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    vec![0],
                    Point { x: 0.0, y: 0.0 },
                    0.0,
                    0.0,
                    1.0,
                    1.0,
                    45.0,
                )
                .expect_err("ellipse"),
            "ellipse cannot be rotated"
        );
        store.delete_shape(id, &fixture.scene, &fixture.layer, 0, 0).expect("drop group");
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 0.0))
            .expect("rect a");
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(40.0, 0.0))
            .expect("rect b");
        store
            .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 1])
            .expect("group rects");
        let rotated = store
            .transform_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0],
                Point { x: 0.0, y: 0.0 },
                0.0,
                0.0,
                1.0,
                1.0,
                90.0,
            )
            .expect("rotate");
        let Shape::Group { children } = &fixture.target(&rotated).keys[0].shapes[0] else {
            panic!("expected a group");
        };
        assert!(children.iter().all(|child| matches!(child, Shape::Path { .. })));
    }

    #[test]
    fn tween_mixes_matching_groups_and_holds_the_rest() {
        let fixture = Fixture::new("tween-group");
        let start = Shape::Group {
            children: vec![box_shape(0.0, 0.0), box_shape(40.0, 0.0)],
        };
        let end = Shape::Group {
            children: vec![box_shape(20.0, 0.0), box_shape(60.0, 0.0)],
        };
        let frames = tween_span(&fixture, vec![start.clone()], vec![end.clone()]);
        assert_eq!(
            frames[1].layers[0].shapes,
            vec![Shape::Group {
                children: vec![box_shape(10.0, 0.0), box_shape(50.0, 0.0)]
            }]
        );
        let mismatch = Fixture::new("tween-group-count");
        let wider = Shape::Group {
            children: vec![box_shape(20.0, 0.0), box_shape(60.0, 0.0), box_shape(90.0, 0.0)],
        };
        let frames = tween_span(&mismatch, vec![start.clone()], vec![wider.clone()]);
        assert_eq!(frames[1].layers[0].shapes, vec![start.clone()]);
        assert_eq!(frames[2].layers[0].shapes, vec![wider]);
        let kinds = Fixture::new("tween-group-kinds");
        let mixed = Shape::Group {
            children: vec![box_shape(20.0, 0.0), stroke(60.0)],
        };
        let frames = tween_span(&kinds, vec![start.clone()], vec![mixed.clone()]);
        assert_eq!(frames[1].layers[0].shapes, vec![start]);
        assert_eq!(frames[2].layers[0].shapes, vec![mixed]);
    }

    fn posed_figure(twist: f64, art: f64) -> Figure {
        Figure {
            x: 100.0,
            y: 200.0,
            rotation: 0.0,
            bones: vec![
                Bone {
                    parent: None,
                    anchor: Point { x: 0.0, y: 0.0 },
                    length: 30.0,
                    twist,
                    width: 4.0,
                    color: "#27272a".to_string(),
                    art: vec![box_shape(art, 0.0)],
                },
                Bone {
                    parent: Some(0),
                    anchor: Point { x: 0.0, y: 0.0 },
                    length: 20.0,
                    twist: twist / 2.0,
                    width: 4.0,
                    color: "#27272a".to_string(),
                    art: Vec::new(),
                },
            ],
        }
    }

    #[test]
    fn tween_blends_poses_and_their_artwork() {
        let fixture = Fixture::new("tween-figure");
        let start = Shape::Figure {
            figure: posed_figure(0.0, 0.0),
        };
        let end = Shape::Figure {
            figure: posed_figure(30.0, 20.0),
        };
        let frames = tween_span(&fixture, vec![start.clone()], vec![end.clone()]);
        match &frames[1].layers[0].shapes[0] {
            Shape::Figure { figure } => {
                assert_eq!(figure.bones[0].twist, 15.0);
                assert_eq!(figure.bones[1].twist, 7.5);
                assert_eq!(figure.bones[0].length, 30.0);
                match &figure.bones[0].art[0] {
                    Shape::Rect { x, .. } => assert_eq!(*x, 10.0),
                    other => panic!("expected a rectangle, got {other:?}"),
                }
            }
            other => panic!("expected a figure, got {other:?}"),
        }
        let mismatch = Fixture::new("tween-figure-rig");
        let mut shorter = posed_figure(30.0, 20.0);
        shorter.bones.pop();
        let frames = tween_span(
            &mismatch,
            vec![start.clone()],
            vec![Shape::Figure {
                figure: shorter.clone(),
            }],
        );
        assert_eq!(frames[1].layers[0].shapes, vec![start]);
        assert_eq!(
            frames[2].layers[0].shapes,
            vec![Shape::Figure { figure: shorter }]
        );
    }

    #[test]
    fn group_and_ungroup_refuse_locked_layers() {
        let fixture = Fixture::new("group-locked");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        for shape in [box_shape(0.0, 0.0), box_shape(40.0, 0.0)] {
            store
                .draw(id, &fixture.scene, &fixture.layer, 0, shape)
                .expect("draw");
        }
        store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None, None, None, None)
            .expect("lock");
        assert_eq!(
            store
                .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 1])
                .expect_err("locked"),
            "layer is locked"
        );
        assert_eq!(
            store
                .ungroup_shape(id, &fixture.scene, &fixture.layer, 0, 0)
                .expect_err("locked"),
            "layer is locked"
        );
    }

    #[test]
    fn grouping_on_a_held_frame_copies_the_key() {
        let fixture = Fixture::new("group-held");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        for shape in [box_shape(0.0, 0.0), box_shape(40.0, 0.0)] {
            store
                .draw(id, &fixture.scene, &fixture.layer, 0, shape)
                .expect("draw");
        }
        let grouped = store
            .group_shapes(id, &fixture.scene, &fixture.layer, 5, vec![0, 1])
            .expect("group");
        let target = fixture.target(&grouped);
        assert_eq!(target.keys.len(), 2);
        assert_eq!(target.keys[1].frame, 5);
        assert_eq!(target.keys[0].shapes.len(), 2);
        assert_eq!(target.keys[1].shapes.len(), 1);
        assert!(matches!(target.keys[1].shapes[0], Shape::Group { .. }));
    }

    #[test]
    fn paint_bucket_fills_group_children_that_have_a_fill() {
        let fixture = Fixture::new("group-paint");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 0.0))
            .expect("rect");
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, stroke(40.0))
            .expect("stroke");
        store
            .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 1])
            .expect("group");
        let painted = store
            .paint_shape(id, &fixture.scene, &fixture.layer, 0, 0, "#123456".to_string())
            .expect("paint");
        let Shape::Group { children } = &fixture.target(&painted).keys[0].shapes[0] else {
            panic!("expected a group");
        };
        let Shape::Rect { fill, .. } = &children[0] else {
            panic!("expected a rectangle");
        };
        assert_eq!(fill, "#123456");
        let Shape::Stroke { color, .. } = &children[1] else {
            panic!("expected a stroke");
        };
        assert_eq!(color, "#000000");
    }

    #[test]
    fn eraser_leaves_groups_alone() {
        let fixture = Fixture::new("group-erase");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 0.0))
            .expect("rect a");
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(40.0, 0.0))
            .expect("rect b");
        store
            .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 1])
            .expect("group");
        let before = store.get(id).expect("doc");
        let after = store
            .erase(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![Point { x: 10.0, y: 10.0 }, Point { x: 50.0, y: 10.0 }],
                8.0,
            )
            .expect("erase");
        assert_eq!(
            fixture.target(&before).keys[0].shapes,
            fixture.target(&after).keys[0].shapes
        );
    }

    #[test]
    fn group_validation_rejects_empty_and_invalid_children() {
        assert_eq!(
            validate(&Shape::Group { children: Vec::new() }).expect_err("empty"),
            "group is empty"
        );
        assert_eq!(
            validate(&Shape::Group {
                children: vec![Shape::Group { children: Vec::new() }]
            })
            .expect_err("nested"),
            "group is empty"
        );
        assert!(validate(&Shape::Group {
            children: vec![box_shape(0.0, 0.0), box_shape(20.0, 0.0)]
        })
        .is_ok());
    }

    #[test]
    fn group_serializes_with_kind_and_children() {
        let group = Shape::Group {
            children: vec![box_shape(0.0, 0.0)],
        };
        let json = serde_json::to_string(&group).expect("serialize");
        assert!(json.contains("\"kind\":\"Group\""));
        assert!(json.contains("\"children\":["));
        let back: Shape = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, group);
    }

    fn stops(pairs: &[(f64, &str)]) -> Vec<GradientStop> {
        pairs
            .iter()
            .map(|(offset, color)| GradientStop {
                offset: *offset,
                color: color.to_string(),
            })
            .collect()
    }

    fn linear(angle: f64, pairs: &[(f64, &str)]) -> Option<Gradient> {
        Some(Gradient::Linear {
            angle,
            stops: stops(pairs),
        })
    }

    fn filled_rect(x: f64, gradient: Option<Gradient>) -> Shape {
        Shape::Rect {
            x,
            y: 0.0,
            w: 20.0,
            h: 20.0,
            fill: "#ff0000".to_string(),
            stroke: "#000000".to_string(),
            width: 1.0,
            gradient,
        }
    }

    fn gradient_of(shape: &Shape) -> Option<Gradient> {
        match shape {
            Shape::Rect { gradient, .. } => gradient.clone(),
            other => panic!("expected a rectangle, got {other:?}"),
        }
    }

    #[test]
    fn gradient_validation_bounds_stops_and_angle() {
        let one = filled_rect(0.0, linear(0.0, &[(0.0, "#ff0000")]));
        assert_eq!(
            validate(&one).expect_err("one stop"),
            "gradient needs at least 2 stops"
        );
        let crowded: Vec<(f64, &str)> = (0..33)
            .map(|index| (index as f64 / 32.0, "#ffffff"))
            .collect();
        let many = filled_rect(0.0, linear(0.0, &crowded));
        assert_eq!(
            validate(&many).expect_err("many stops"),
            "gradient has too many stops"
        );
        let outside = filled_rect(0.0, linear(0.0, &[(0.0, "#ff0000"), (1.5, "#0000ff")]));
        assert_eq!(
            validate(&outside).expect_err("offset range"),
            "gradient stop offset must be between 0 and 1"
        );
        let unordered = filled_rect(0.0, linear(0.0, &[(0.8, "#ff0000"), (0.2, "#0000ff")]));
        assert_eq!(
            validate(&unordered).expect_err("stop order"),
            "gradient stops must be in order"
        );
        let tilted = filled_rect(0.0, linear(f64::NAN, &[(0.0, "#ff0000"), (1.0, "#0000ff")]));
        assert_eq!(
            validate(&tilted).expect_err("angle"),
            "gradient angle must be finite"
        );
        let long = filled_rect(0.0, linear(0.0, &[(0.0, "#ff0000"), (1.0, &"x".repeat(1025))]));
        assert_eq!(
            validate(&long).expect_err("color"),
            "gradient stop color is too long"
        );
        assert!(validate(&filled_rect(
            0.0,
            linear(-45.0, &[(0.0, "#ff0000"), (0.5, "#00ff00"), (1.0, "#0000ff")])
        ))
        .is_ok());
        assert!(validate(&filled_rect(
            0.0,
            Some(Gradient::Radial {
                stops: stops(&[(0.0, "#ff0000"), (1.0, "#0000ff")])
            })
        ))
        .is_ok());
    }

    #[test]
    fn gradient_survives_scaling_and_follows_rotation() {
        let shape = filled_rect(0.0, linear(30.0, &[(0.0, "#ff0000"), (1.0, "#0000ff")]));
        let matrix = affine_from(
            &Point { x: 10.0, y: 10.0 },
            0.0,
            0.0,
            2.0,
            2.0,
            0.0,
        );
        let scaled = transform_shape(&shape, &matrix, 2.0, 2.0, 0.0).expect("scale");
        assert_eq!(gradient_of(&scaled), linear(30.0, &[(0.0, "#ff0000"), (1.0, "#0000ff")]));
        let turned = transform_shape(&shape, &matrix, 1.0, 1.0, 90.0).expect("rotate");
        match turned {
            Shape::Path {
                nodes,
                closed,
                gradient,
                ..
            } => {
                assert!(closed);
                assert_eq!(nodes.len(), 4);
                assert_eq!(gradient, linear(120.0, &[(0.0, "#ff0000"), (1.0, "#0000ff")]));
            }
            other => panic!("expected a path, got {other:?}"),
        }
    }

    #[test]
    fn tween_blends_gradient_stops_and_holds_mismatched_fills() {
        let fixture = Fixture::new("tween-gradient");
        let start = filled_rect(0.0, linear(0.0, &[(0.0, "#ff0000"), (1.0, "#0000ff")]));
        let end = filled_rect(20.0, linear(90.0, &[(0.25, "#00ff00"), (0.75, "#ffffff")]));
        let frames = tween_span(&fixture, vec![start.clone()], vec![end.clone()]);
        assert_eq!(
            gradient_of(&frames[1].layers[0].shapes[0]),
            linear(45.0, &[(0.125, "#808000"), (0.875, "#8080ff")])
        );
        let other = Fixture::new("tween-gradient-stops");
        let frames = tween_span(
            &other,
            vec![start.clone()],
            vec![filled_rect(
                20.0,
                linear(
                    0.0,
                    &[(0.0, "#000000"), (0.5, "#404040"), (1.0, "#ffffff")],
                ),
            )],
        );
        assert_eq!(
            gradient_of(&frames[1].layers[0].shapes[0]),
            linear(0.0, &[(0.0, "#ff0000"), (1.0, "#0000ff")])
        );
        let solid = Fixture::new("tween-gradient-solid");
        let frames = tween_span(&solid, vec![start.clone()], vec![filled_rect(20.0, None)]);
        assert_eq!(
            gradient_of(&frames[1].layers[0].shapes[0]),
            linear(0.0, &[(0.0, "#ff0000"), (1.0, "#0000ff")])
        );
        let frames = tween_span(
            &Fixture::new("tween-gradient-solid-end"),
            vec![filled_rect(0.0, None)],
            vec![start.clone()],
        );
        assert_eq!(gradient_of(&frames[1].layers[0].shapes[0]), None);
    }

    #[test]
    fn mixable_requires_matching_gradients() {
        let gradient = filled_rect(0.0, linear(0.0, &[(0.0, "#ff0000"), (1.0, "#0000ff")]));
        assert!(!mixable(&filled_rect(0.0, None), &gradient));
        assert!(mixable(&gradient, &gradient.clone()));
        assert!(!mixable(
            &gradient,
            &filled_rect(
                0.0,
                Some(Gradient::Radial {
                    stops: stops(&[(0.0, "#ff0000"), (1.0, "#0000ff")])
                })
            )
        ));
        assert!(!mixable(
            &gradient,
            &filled_rect(
                0.0,
                linear(0.0, &[(0.0, "#ff0000"), (0.5, "#00ff00"), (1.0, "#0000ff")])
            )
        ));
    }

    #[test]
    fn painting_a_shape_drops_its_gradient() {
        let mut shape = filled_rect(0.0, linear(0.0, &[(0.0, "#ff0000"), (1.0, "#0000ff")]));
        paint_fill(&mut shape, "#00ff00");
        assert_eq!(gradient_of(&shape), None);
        match &shape {
            Shape::Rect { fill, .. } => assert_eq!(fill, "#00ff00"),
            other => panic!("expected a rectangle, got {other:?}"),
        }
    }

    #[test]
    fn gradient_shapes_round_trip_and_default_to_solid() {
        let shape = filled_rect(
            0.0,
            Some(Gradient::Radial {
                stops: stops(&[(0.0, "#ff0000"), (1.0, "#0000ff")]),
            }),
        );
        let json = serde_json::to_string(&shape).expect("serialize");
        assert!(json.contains("\"gradient\":{\"kind\":\"radial\",\"stops\":[{\"offset\":0.0,\"color\":\"#ff0000\"}"));
        let back: Shape = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, shape);
        let plain: Shape = serde_json::from_str(
            "{\"kind\":\"Rect\",\"x\":0.0,\"y\":0.0,\"w\":20.0,\"h\":20.0,\"fill\":\"#ff0000\",\"stroke\":\"#000000\",\"width\":1.0}"
        )
        .expect("legacy shape");
        assert_eq!(plain, filled_rect(0.0, None));
    }

    #[test]
    fn store_replaces_and_undoes_a_gradient_fill() {
        let fixture = Fixture::new("store-gradient");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 0.0))
            .expect("draw");
        let filled = filled_rect(0.0, linear(0.0, &[(0.0, "#ff0000"), (1.0, "#0000ff")]));
        let doc = store
            .replace_shape(id, &fixture.scene, &fixture.layer, 0, 0, filled.clone())
            .expect("replace");
        assert_eq!(doc.scenes[0].layers[0].keys[0].shapes, vec![filled.clone()]);
        let broken = filled_rect(0.0, linear(0.0, &[(0.0, "#ff0000")]));
        assert_eq!(
            store
                .replace_shape(id, &fixture.scene, &fixture.layer, 0, 0, broken)
                .expect_err("broken"),
            "gradient needs at least 2 stops"
        );
        assert_eq!(
            store
                .replace_shape(id, &fixture.scene, &fixture.layer, 0, 4, filled)
                .expect_err("index"),
            "unknown shape"
        );
        let undone = store.undo(id).expect("undo");
        assert_eq!(
            undone.scenes[0].layers[0].keys[0].shapes,
            vec![box_shape(0.0, 0.0)]
        );
    }

    #[test]
    fn grouped_children_keep_their_gradients() {
        let fixture = Fixture::new("group-gradient");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 0.0))
            .expect("draw");
        store
            .draw(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                filled_rect(40.0, linear(20.0, &[(0.0, "#ffffff"), (1.0, "#000000")])),
            )
            .expect("draw filled");
        let doc = store
            .group_shapes(id, &fixture.scene, &fixture.layer, 0, vec![0, 1])
            .expect("group");
        let group = doc.scenes[0].layers[0].keys[0].shapes[0].clone();
        let moved = transform_shape(
            &group,
            &affine_from(&Point { x: 0.0, y: 0.0 }, 5.0, 5.0, 2.0, 2.0, 0.0),
            2.0,
            2.0,
            0.0,
        )
        .expect("transform");
        match moved {
            Shape::Group { children } => {
                assert_eq!(
                    shape_gradient(&children[1]).cloned(),
                    linear(20.0, &[(0.0, "#ffffff"), (1.0, "#000000")])
                );
                match &children[1] {
                    Shape::Rect { x, .. } => assert_eq!(*x, 85.0),
                    other => panic!("expected a rectangle, got {other:?}"),
                }
            }
            other => panic!("expected a group, got {other:?}"),
        }
        let ungrouped = store
            .ungroup_shape(id, &fixture.scene, &fixture.layer, 0, 0)
            .expect("ungroup");
        assert_eq!(
            gradient_of(&ungrouped.scenes[0].layers[0].keys[0].shapes[1]),
            linear(20.0, &[(0.0, "#ffffff"), (1.0, "#000000")])
        );
    }

    fn held_figure(doc: &Document, frame: u32) -> Figure {
        let layer = &doc.scenes[0].layers[0];
        let index = layer
            .keys
            .iter()
            .rposition(|key| key.frame <= frame)
            .expect("key");
        layer.keys[index]
            .shapes
            .iter()
            .find_map(|shape| match shape {
                Shape::Figure { figure } => Some(figure.clone()),
                _ => None,
            })
            .expect("figure")
    }

    #[test]
    fn adding_a_figure_draws_a_humanoid() {
        let fixture = Fixture::new("figure-add");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        let doc = store
            .add_figure(id, &fixture.scene, &fixture.layer, 0, 200.0, 320.0, 200.0)
            .expect("figure");
        let figure = held_figure(&doc, 0);
        assert_eq!(figure.bones.len(), 12);
        assert_eq!(figure.x, 200.0);
        assert_eq!(figure.bones[3].art.len(), 1);
        let bounds = rig::figure_bounds(&figure).expect("bounds");
        assert!((bounds.y - 220.0).abs() < 0.0001);
        assert_eq!(store.history(id).expect("history")[1].name, "draw_figure");
    }

    #[test]
    fn posing_a_joint_keys_the_pose() {
        let fixture = Fixture::new("figure-pose");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .add_figure(id, &fixture.scene, &fixture.layer, 0, 200.0, 320.0, 200.0)
            .expect("figure");
        store
            .keyframe(id, &fixture.scene, &fixture.layer, 10, false)
            .expect("key");
        store
            .set_tween(id, &fixture.scene, &fixture.layer, 0, true, None)
            .expect("tween");
        let posed = store
            .pose_figure(
                id,
                &fixture.scene,
                &fixture.layer,
                5,
                0,
                4,
                Point { x: 260.0, y: 300.0 },
            )
            .expect("pose");
        let layer = &posed.scenes[0].layers[0];
        assert_eq!(
            layer.keys.iter().map(|key| key.frame).collect::<Vec<_>>(),
            vec![0, 5, 10]
        );
        assert!(!layer.keys[1].tween);
        let figure = held_figure(&posed, 5);
        let place = &rig::places(&figure)[4];
        let aimed = (place.tip.y - place.base.y).atan2(place.tip.x - place.base.x);
        let want = (300.0 - 268.0_f64).atan2(260.0 - 200.0);
        assert!((aimed - want).abs() < 0.0001);
        assert_eq!(held_figure(&posed, 0).bones[4].twist, 168.0);
        assert_eq!(store.history(id).expect("history").last().expect("step").name, "pose_figure");
    }

    #[test]
    fn reaching_a_leaf_joint_keys_the_whole_limb_as_one_step() {
        let fixture = Fixture::new("figure-reach");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        let added = store
            .add_figure(id, &fixture.scene, &fixture.layer, 0, 200.0, 320.0, 200.0)
            .expect("figure");
        let started = held_figure(&added, 0);
        store
            .keyframe(id, &fixture.scene, &fixture.layer, 10, false)
            .expect("key");
        let target = Point { x: 150.0, y: 250.0 };
        let reached = store
            .reach_figure(id, &fixture.scene, &fixture.layer, 5, 0, 5, target)
            .expect("reach");
        let layer = &reached.scenes[0].layers[0];
        assert_eq!(
            layer.keys.iter().map(|key| key.frame).collect::<Vec<_>>(),
            vec![0, 5, 10]
        );
        let figure = held_figure(&reached, 5);
        let place = &rig::places(&figure)[5];
        assert!((place.tip.x - target.x).hypot(place.tip.y - target.y) < 0.01);
        assert_ne!(figure.bones[4].twist, started.bones[4].twist);
        assert_eq!(figure.bones[1].twist, started.bones[1].twist);
        assert_eq!(held_figure(&reached, 0).bones[5].twist, -10.0);
        let steps = store.history(id).expect("history");
        assert_eq!(steps.last().expect("step").name, "reach_figure");
        let undone = store.undo(id).expect("undo");
        let back = held_figure(&undone, 5);
        assert_eq!(back.bones[4].twist, started.bones[4].twist);
        assert_eq!(back.bones[5].twist, started.bones[5].twist);
    }

    #[test]
    fn posing_is_one_undo_step_and_a_no_op_pushes_no_history() {
        let fixture = Fixture::new("figure-undo");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        let start = store
            .add_figure(id, &fixture.scene, &fixture.layer, 0, 200.0, 320.0, 200.0)
            .expect("figure");
        let target = Point { x: 120.0, y: 340.0 };
        let posed = store
            .pose_figure(id, &fixture.scene, &fixture.layer, 0, 0, 5, target)
            .expect("pose");
        assert_eq!(store.history(id).expect("history").len(), 3);
        let again = store
            .pose_figure(id, &fixture.scene, &fixture.layer, 0, 0, 5, target)
            .expect("again");
        assert_eq!(again, posed);
        assert_eq!(store.history(id).expect("history").len(), 3);
        assert_eq!(store.undo(id).expect("undo"), start);
    }

    #[test]
    fn artwork_attaches_to_a_bone_and_detaches_to_the_stage() {
        let fixture = Fixture::new("figure-art");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .add_figure(id, &fixture.scene, &fixture.layer, 0, 200.0, 320.0, 200.0)
            .expect("figure");
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(190.0, 250.0))
            .expect("art");
        let attached = store
            .attach_art(id, &fixture.scene, &fixture.layer, 0, 0, 0, vec![1])
            .expect("attach");
        assert_eq!(attached.scenes[0].layers[0].keys[0].shapes.len(), 1);
        assert_eq!(held_figure(&attached, 0).bones[0].art.len(), 1);
        assert_eq!(store.history(id).expect("history").last().expect("step").name, "attach_art");
        let detached = store
            .detach_art(id, &fixture.scene, &fixture.layer, 0, 0, 0)
            .expect("detach");
        let shapes = &detached.scenes[0].layers[0].keys[0].shapes;
        assert_eq!(shapes.len(), 2);
        assert_eq!(shapes[1], box_shape(190.0, 250.0));
        assert!(held_figure(&detached, 0).bones[0].art.is_empty());
        assert_eq!(store.history(id).expect("history").last().expect("step").name, "detach_art");
    }

    #[test]
    fn attaching_uses_the_figure_after_the_taken_shapes() {
        let fixture = Fixture::new("figure-shift");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 0.0))
            .expect("art");
        store
            .add_figure(id, &fixture.scene, &fixture.layer, 0, 200.0, 320.0, 200.0)
            .expect("figure");
        let attached = store
            .attach_art(id, &fixture.scene, &fixture.layer, 0, 1, 0, vec![0])
            .expect("attach");
        assert_eq!(held_figure(&attached, 0).bones[0].art.len(), 1);
    }

    #[test]
    fn figure_edits_refuse_unknown_targets() {
        let fixture = Fixture::new("figure-refuse");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, box_shape(0.0, 0.0))
            .expect("draw");
        let elbow = Point { x: 240.0, y: 300.0 };
        assert_eq!(
            store
                .pose_figure(id, &fixture.scene, &fixture.layer, 0, 9, 0, elbow)
                .expect_err("gone"),
            "unknown shape"
        );
        assert_eq!(
            store
                .pose_figure(id, &fixture.scene, &fixture.layer, 0, 0, 0, elbow)
                .expect_err("rect"),
            "shape is not a figure"
        );
        assert_eq!(
            store
                .attach_art(id, &fixture.scene, &fixture.layer, 0, 0, 0, Vec::new())
                .expect_err("empty"),
            "no shapes selected"
        );
        store
            .add_figure(id, &fixture.scene, &fixture.layer, 0, 200.0, 320.0, 200.0)
            .expect("figure");
        assert_eq!(
            store
                .attach_art(id, &fixture.scene, &fixture.layer, 0, 1, 0, vec![1])
                .expect_err("itself"),
            "unknown shape"
        );
        assert_eq!(
            store
                .attach_art(id, &fixture.scene, &fixture.layer, 0, 1, 40, vec![0])
                .expect_err("bone"),
            "no such bone"
        );
        assert_eq!(
            store
                .pose_figure(id, &fixture.scene, &fixture.layer, 0, 1, 40, elbow)
                .expect_err("bone"),
            "no such bone"
        );
        assert_eq!(
            store
                .reach_figure(id, &fixture.scene, &fixture.layer, 0, 9, 0, elbow)
                .expect_err("gone"),
            "unknown shape"
        );
        assert_eq!(
            store
                .reach_figure(id, &fixture.scene, &fixture.layer, 0, 0, 0, elbow)
                .expect_err("rect"),
            "shape is not a figure"
        );
        assert_eq!(
            store
                .reach_figure(id, &fixture.scene, &fixture.layer, 0, 1, 40, elbow)
                .expect_err("bone"),
            "no such bone"
        );
        assert_eq!(
            store
                .detach_art(id, &fixture.scene, &fixture.layer, 0, 1, 40)
                .expect_err("bone"),
            "no such bone"
        );
        assert_eq!(
            store
                .detach_art(id, &fixture.scene, &fixture.layer, 0, 1, 0)
                .expect_err("empty bone"),
            "that bone carries no artwork"
        );
        assert_eq!(
            store
                .detach_art(id, &fixture.scene, &fixture.layer, 0, 0, 0)
                .expect_err("rect"),
            "shape is not a figure"
        );
    }

    #[test]
    fn locked_layers_refuse_figure_edits() {
        let fixture = Fixture::new("figure-locked");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .add_figure(id, &fixture.scene, &fixture.layer, 0, 200.0, 320.0, 200.0)
            .expect("figure");
        store
            .set_layer(id, &fixture.scene, &fixture.layer, None, None, Some(true), None, None, None, None)
            .expect("lock");
        assert_eq!(
            store
                .pose_figure(id, &fixture.scene, &fixture.layer, 0, 0, 0, Point { x: 1.0, y: 1.0 })
                .expect_err("locked"),
            "layer is locked"
        );
        assert_eq!(
            store
                .reach_figure(id, &fixture.scene, &fixture.layer, 0, 0, 5, Point { x: 1.0, y: 1.0 })
                .expect_err("locked"),
            "layer is locked"
        );
        assert_eq!(
            store
                .attach_art(id, &fixture.scene, &fixture.layer, 0, 0, 0, vec![0])
                .expect_err("locked"),
            "layer is locked"
        );
        assert_eq!(
            store
                .detach_art(id, &fixture.scene, &fixture.layer, 0, 0, 0)
                .expect_err("locked"),
            "layer is locked"
        );
    }

    #[test]
    fn a_figure_moves_and_scales_as_one_shape() {
        let fixture = Fixture::new("figure-transform");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .add_figure(id, &fixture.scene, &fixture.layer, 0, 200.0, 320.0, 200.0)
            .expect("figure");
        let moved = store
            .transform_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0],
                Point { x: 0.0, y: 0.0 },
                12.0,
                -8.0,
                1.0,
                1.0,
                0.0,
            )
            .expect("move");
        let figure = held_figure(&moved, 0);
        assert_eq!((figure.x, figure.y), (212.0, 312.0));
        assert_eq!(figure.bones[1].length, 52.0);
        assert_eq!(figure.bones[1].width, 12.0);
        let grown = store
            .transform_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0],
                Point { x: 212.0, y: 312.0 },
                0.0,
                0.0,
                2.0,
                2.0,
                0.0,
            )
            .expect("grow");
        let figure = held_figure(&grown, 0);
        assert_eq!((figure.x, figure.y), (212.0, 312.0));
        assert_eq!(figure.bones[1].length, 104.0);
        assert_eq!(figure.bones[3].art.len(), 1);
        let turned = store
            .transform_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0],
                Point { x: 212.0, y: 312.0 },
                0.0,
                0.0,
                1.0,
                1.0,
                90.0,
            )
            .expect("turn");
        let figure = held_figure(&turned, 0);
        assert_eq!(figure.rotation, 90.0);
        assert!((figure.x - 212.0).abs() < 0.0001);
        assert_eq!(
            store
                .transform_shapes(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    vec![0],
                    Point { x: 212.0, y: 312.0 },
                    0.0,
                    0.0,
                    1.0,
                    2.0,
                    0.0,
                )
                .expect_err("stretch"),
            "a figure cannot be stretched in one direction"
        );
    }

    #[test]
    fn painting_a_figure_recolors_bones_and_artwork() {
        let fixture = Fixture::new("figure-paint");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .add_figure(id, &fixture.scene, &fixture.layer, 0, 200.0, 320.0, 200.0)
            .expect("figure");
        let painted = store
            .paint_shape(id, &fixture.scene, &fixture.layer, 0, 0, "#ff0000".to_string())
            .expect("paint");
        let figure = held_figure(&painted, 0);
        assert!(figure.bones.iter().all(|bone| bone.color == "#ff0000"));
        match &figure.bones[3].art[0] {
            Shape::Ellipse { fill, stroke, .. } => {
                assert_eq!(fill, "#ff0000");
                assert_eq!(stroke, "none");
            }
            other => panic!("expected a skull, got {other:?}"),
        }
    }

    #[test]
    fn a_figure_is_pickable_at_its_limbs_and_artwork() {
        let shape = Shape::Figure {
            figure: rig::humanoid(200.0, 320.0, 200.0),
        };
        assert!(shape_hit(&shape, &Point { x: 200.0, y: 300.0 }, 4.0));
        assert!(shape_hit(&shape, &Point { x: 200.0, y: 240.0 }, 4.0));
        assert!(!shape_hit(&shape, &Point { x: 60.0, y: 60.0 }, 4.0));
    }

    #[test]
    fn a_figure_round_trips_through_json() {
        let shape = Shape::Figure {
            figure: rig::humanoid(10.0, 20.0, 100.0),
        };
        let text = serde_json::to_string(&shape).expect("json");
        assert!(text.starts_with("{\"kind\":\"Figure\""));
        assert_eq!(serde_json::from_str::<Shape>(&text).expect("read"), shape);
    }

    const IMAGE: &str = "data:image/png;base64,iVBORw0KGgo=";

    fn picture(x: f64, y: f64, w: f64, h: f64) -> Shape {
        Shape::Bitmap {
            x,
            y,
            w,
            h,
            source: IMAGE.to_string(),
            matrix: None,
        }
    }

    fn image(x: f64, y: f64) -> Shape {
        picture(x, y, 40.0, 20.0)
    }

    fn tilted(shape: &Shape, matrix: Affine) -> Shape {
        let mut next = shape.clone();
        if let Shape::Bitmap { matrix: slot, .. } = &mut next {
            *slot = Some(matrix);
        }
        next
    }

    #[test]
    fn a_placed_image_is_a_shape_with_its_own_history_step() {
        let fixture = Fixture::new("bitmap-draw");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        let drawn = store
            .draw(id, &fixture.scene, &fixture.layer, 0, image(100.0, 50.0))
            .expect("draw");
        let shapes = &fixture.target(&drawn).keys[0].shapes;
        assert_eq!(shapes, &vec![image(100.0, 50.0)]);
        assert_eq!(
            shape_bounds(&shapes[0]),
            Bounds {
                x: 100.0,
                y: 50.0,
                w: 40.0,
                h: 20.0
            }
        );
        assert_eq!(
            store.history(id).expect("history").last().expect("step").name,
            "draw_bitmap"
        );
        let undone = store.undo(id).expect("undo");
        assert!(fixture.target(&undone).keys[0].shapes.is_empty());
    }

    #[test]
    fn draw_refuses_an_image_it_cannot_place() {
        let fixture = Fixture::new("bitmap-refuse");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        for source in [
            "",
            "https://example.com/a.png",
            "data:image/tiff;base64,AAAA",
            "data:image/png;base64,",
        ] {
            let mut shape = picture(0.0, 0.0, 40.0, 20.0);
            if let Shape::Bitmap {
                source: slot, ..
            } = &mut shape
            {
                *slot = source.to_string();
            }
            assert_eq!(
                validate(&shape).unwrap_err(),
                "bitmap must be an embedded png, jpeg, gif or svg"
            );
        }
        for size in [0.0, -1.0, f64::NAN, f64::INFINITY, 20_000.0] {
            assert_eq!(
                validate(&picture(0.0, 0.0, size, 20.0)).unwrap_err(),
                "bitmap size must be between 1 and 16384"
            );
            assert_eq!(
                validate(&picture(0.0, 0.0, 40.0, size)).unwrap_err(),
                "bitmap size must be between 1 and 16384"
            );
        }
        for index in 0..6 {
            for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                let mut values = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
                values[index] = invalid;
                let [a, b, c, d, e, f] = values;
                let shape = tilted(
                    &picture(0.0, 0.0, 40.0, 20.0),
                    Affine { a, b, c, d, e, f },
                );
                assert_eq!(validate(&shape).unwrap_err(), "bitmap matrix must be finite");
            }
        }
        let before = store.history(id).expect("history").len();
        assert_eq!(
            store
                .draw(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    tilted(&picture(0.0, 0.0, 40.0, 20.0), Affine {
                        a: f64::NAN,
                        b: 0.0,
                        c: 0.0,
                        d: 1.0,
                        e: 0.0,
                        f: 0.0,
                    }),
                )
                .unwrap_err(),
            "bitmap matrix must be finite"
        );
        assert_eq!(store.history(id).expect("history").len(), before);
    }

    #[test]
    fn an_svg_picture_can_be_placed() {
        let fixture = Fixture::new("bitmap-svg");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        let mut shape = picture(12.0, 8.0, 40.0, 20.0);
        if let Shape::Bitmap { source, .. } = &mut shape {
            *source = crate::media::data_url("svg", &crate::media::svg(40, 20));
        }
        validate(&shape).expect("svg bitmap");
        let drawn = store
            .draw(id, &fixture.scene, &fixture.layer, 0, shape.clone())
            .expect("draw");
        assert_eq!(fixture.target(&drawn).keys[0].shapes, vec![shape]);
    }

    #[test]
    fn an_animation_holds_each_frame_for_its_span() {
        let fixture = Fixture::new("animation-frames");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        let run = vec![
            FrameRun {
                shapes: vec![image(0.0, 0.0)],
                span: 3,
            },
            FrameRun {
                shapes: vec![image(40.0, 0.0)],
                span: 2,
            },
        ];
        let placed = store
            .set_frames(id, &fixture.scene, &fixture.layer, 1, run)
            .expect("animation");
        let target = fixture.target(&placed);
        assert_eq!(
            target
                .keys
                .iter()
                .map(|key| (key.frame, key.shapes.clone()))
                .collect::<Vec<_>>(),
            vec![(0, Vec::new()), (1, vec![image(0.0, 0.0)]), (4, vec![image(40.0, 0.0)])]
        );
        assert_eq!(target.length, 6);
        assert_eq!(
            store.history(id).expect("history").last().expect("step").name,
            "place_animation"
        );
        let undone = store.undo(id).expect("undo");
        assert_eq!(fixture.target(&undone).keys.len(), 1);
        assert_eq!(fixture.target(&undone).length, 1);
    }

    #[test]
    fn an_animation_refuses_spans_shapes_and_locks() {
        let fixture = Fixture::new("animation-refuse");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        assert_eq!(
            store
                .set_frames(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    vec![FrameRun {
                        shapes: vec![image(0.0, 0.0)],
                        span: 0,
                    }]
                )
                .unwrap_err(),
            "a frame must last at least one frame"
        );
        assert_eq!(
            store
                .set_frames(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    vec![FrameRun {
                        shapes: vec![picture(0.0, 0.0, 0.0, 4.0)],
                        span: 2,
                    }]
                )
                .unwrap_err(),
            "bitmap size must be between 1 and 16384"
        );
        store
            .set_layer(
                id,
                &fixture.scene,
                &fixture.layer,
                None,
                None,
                Some(true),
                None,
                None,
                None,
                None,
            )
            .expect("lock");
        let before = store.history(id).expect("history").len();
        assert_eq!(
            store
                .set_frames(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    vec![FrameRun {
                        shapes: vec![image(0.0, 0.0)],
                        span: 2,
                    }]
                )
                .unwrap_err(),
            "layer is locked"
        );
        assert_eq!(store.history(id).expect("history").len(), before);
    }

    #[test]
    fn an_image_sequence_writes_one_keyframe_per_frame() {
        let fixture = Fixture::new("bitmap-sequence");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        let run = vec![
            vec![image(0.0, 0.0)],
            vec![image(10.0, 0.0)],
            vec![image(20.0, 0.0)],
        ];
        let placed = store
            .set_keyframes(id, &fixture.scene, &fixture.layer, 0, run)
            .expect("sequence");
        let target = fixture.target(&placed);
        assert_eq!(
            target.keys.iter().map(|key| key.frame).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(target.length, 3);
        assert_eq!(target.keys[2].shapes, vec![image(20.0, 0.0)]);
        let steps = store.history(id).expect("history");
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[1].name, "place_image_sequence");
        let replaced = store
            .set_keyframes(
                id,
                &fixture.scene,
                &fixture.layer,
                1,
                vec![vec![image(9.0, 9.0)]],
            )
            .expect("replace");
        assert_eq!(fixture.target(&replaced).keys.len(), 3);
        assert_eq!(
            fixture.target(&replaced).keys[1].shapes,
            vec![image(9.0, 9.0)]
        );
        let undone = store.undo(id).expect("undo the replace");
        assert_eq!(
            fixture.target(&undone).keys[1].shapes,
            vec![image(10.0, 0.0)]
        );
        let undone = store.undo(id).expect("undo the run");
        assert_eq!(fixture.target(&undone).keys.len(), 1);
    }

    #[test]
    fn a_sequence_refuses_an_empty_run_a_bad_shape_and_a_locked_layer() {
        let fixture = Fixture::new("bitmap-sequence-refuse");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        let empty = store
            .set_keyframes(id, &fixture.scene, &fixture.layer, 0, vec![])
            .expect("empty");
        assert_eq!(empty, fixture.doc);
        assert_eq!(store.history(id).expect("history").len(), 1);
        assert_eq!(
            store
                .set_keyframes(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    vec![vec![image(0.0, 0.0)], vec![picture(0.0, 0.0, 0.0, 20.0)]],
                )
                .expect_err("bad shape"),
            "bitmap size must be between 1 and 16384"
        );
        assert_eq!(store.history(id).expect("history").len(), 1);
        store
            .set_layer(
                id,
                &fixture.scene,
                &fixture.layer,
                None,
                None,
                Some(true),
                None,
                None,
                None,
                None,
            )
            .expect("lock");
        assert_eq!(
            store
                .set_keyframes(
                    id,
                    &fixture.scene,
                    &fixture.layer,
                    0,
                    vec![vec![image(0.0, 0.0)]]
                )
                .expect_err("locked"),
            "layer is locked"
        );
        assert!(fixture
            .target(&store.get(id).expect("get"))
            .keys[0]
            .shapes
            .is_empty());
    }

    #[test]
    fn an_image_grows_with_its_box_and_folds_a_stretch() {
        let fixture = Fixture::new("bitmap-grow");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, image(100.0, 50.0))
            .expect("draw");
        let grown = store
            .transform_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0],
                Point { x: 0.0, y: 0.0 },
                10.0,
                5.0,
                2.0,
                2.0,
                0.0,
            )
            .expect("grow");
        assert_eq!(
            fixture.target(&grown).keys[0].shapes[0],
            picture(210.0, 105.0, 80.0, 40.0)
        );
        let stretched = store
            .transform_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0],
                Point { x: 0.0, y: 0.0 },
                0.0,
                0.0,
                3.0,
                1.0,
                0.0,
            )
            .expect("stretch");
        let Shape::Bitmap {
            x,
            y,
            w,
            h,
            matrix,
            ..
        } = &fixture.target(&stretched).keys[0].shapes[0]
        else {
            panic!("expected a bitmap");
        };
        assert_eq!((*x, *y, *w, *h), (210.0, 105.0, 80.0, 40.0));
        let matrix = matrix.as_ref().expect("folded matrix");
        close(matrix.a, 3.0);
        close(matrix.d, 1.0);
        assert_eq!(
            shape_bounds(&fixture.target(&stretched).keys[0].shapes[0]),
            Bounds {
                x: 630.0,
                y: 105.0,
                w: 240.0,
                h: 40.0
            }
        );
        assert_eq!(
            store.undo(id).expect("undo").scenes[0].layers[0].keys[0].shapes,
            vec![picture(210.0, 105.0, 80.0, 40.0)]
        );
    }

    #[test]
    fn a_turned_image_keeps_its_picture_and_gains_a_matrix() {
        let fixture = Fixture::new("bitmap-turn");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, image(100.0, 50.0))
            .expect("draw");
        let turned = store
            .transform_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0],
                Point { x: 120.0, y: 60.0 },
                0.0,
                0.0,
                1.0,
                1.0,
                90.0,
            )
            .expect("turn");
        let shape = &fixture.target(&turned).keys[0].shapes[0];
        let Shape::Bitmap {
            x,
            y,
            w,
            h,
            source,
            matrix,
        } = shape
        else {
            panic!("expected a bitmap");
        };
        assert_eq!((*x, *y, *w, *h), (100.0, 50.0, 40.0, 20.0));
        assert_eq!(source, IMAGE);
        let matrix = matrix.as_ref().expect("folded matrix");
        close(matrix.a, 0.0);
        close(matrix.b, 1.0);
        close(matrix.c, -1.0);
        close(matrix.d, 0.0);
        let bounds = shape_bounds(shape);
        close(bounds.x, 110.0);
        close(bounds.y, 40.0);
        close(bounds.w, 20.0);
        close(bounds.h, 40.0);
        assert!(validate(shape).is_ok());
    }

    #[test]
    fn an_image_is_pickable_inside_its_turned_corners() {
        let flat = image(0.0, 0.0);
        assert!(shape_hit(&flat, &Point { x: 20.0, y: 10.0 }, 0.0));
        assert!(!shape_hit(&flat, &Point { x: 45.0, y: 10.0 }, 4.0));
        assert!(shape_hit(&flat, &Point { x: 45.0, y: 10.0 }, 5.5));
        let turned = tilted(
            &picture(0.0, 0.0, 40.0, 20.0),
            Affine {
                a: 0.0,
                b: 1.0,
                c: -1.0,
                d: 0.0,
                e: 0.0,
                f: 0.0,
            },
        );
        assert_eq!(
            shape_bounds(&turned),
            Bounds {
                x: -20.0,
                y: 0.0,
                w: 20.0,
                h: 40.0
            }
        );
        assert!(shape_hit(&turned, &Point { x: -10.0, y: 20.0 }, 0.0));
        assert!(!shape_hit(&turned, &Point { x: 10.0, y: 10.0 }, 0.0));
    }

    #[test]
    fn a_tweened_image_moves_with_the_timeline() {
        let frames = tween_span(
            &Fixture::new("tween-bitmap"),
            vec![image(100.0, 100.0)],
            vec![image(300.0, 100.0)],
        );
        assert_eq!(frames[0].layers[0].shapes, vec![image(100.0, 100.0)]);
        assert_eq!(frames[1].layers[0].shapes, vec![image(200.0, 100.0)]);
        assert_eq!(frames[2].layers[0].shapes, vec![image(300.0, 100.0)]);
    }

    #[test]
    fn an_image_rides_a_bone_and_returns_to_the_stage() {
        let fixture = Fixture::new("bitmap-art");
        let store = &fixture.store;
        let id = &fixture.doc.id;
        store
            .add_figure(id, &fixture.scene, &fixture.layer, 0, 200.0, 320.0, 200.0)
            .expect("figure");
        store
            .draw(id, &fixture.scene, &fixture.layer, 0, image(190.0, 250.0))
            .expect("art");
        let attached = store
            .attach_art(id, &fixture.scene, &fixture.layer, 0, 0, 0, vec![1])
            .expect("attach");
        let art = &held_figure(&attached, 0).bones[0].art;
        assert_eq!(art, &vec![image(-10.0, -70.0)]);
        let grown = store
            .transform_shapes(
                id,
                &fixture.scene,
                &fixture.layer,
                0,
                vec![0],
                Point { x: 200.0, y: 320.0 },
                0.0,
                0.0,
                2.0,
                2.0,
                0.0,
            )
            .expect("grow");
        let art = &held_figure(&grown, 0).bones[0].art;
        assert_eq!(art, &vec![picture(-20.0, -140.0, 80.0, 40.0)]);
        let detached = store
            .detach_art(id, &fixture.scene, &fixture.layer, 0, 0, 0)
            .expect("detach");
        let shapes = &fixture.target(&detached).keys[0].shapes;
        assert_eq!(shapes.len(), 2);
        assert_eq!(shapes[1], picture(180.0, 180.0, 80.0, 40.0));
    }

    #[test]
    fn an_image_serializes_its_matrix_only_when_it_has_one() {
        let flat = picture(0.0, 0.0, 40.0, 20.0);
        let json = serde_json::to_value(&flat).expect("json");
        assert_eq!(json["kind"], "Bitmap");
        assert!(json.get("matrix").is_none());
        assert_eq!(
            serde_json::from_value::<Shape>(json).expect("read"),
            flat
        );
        let turned = tilted(
            &flat,
            Affine {
                a: 1.0,
                b: 0.5,
                c: -0.5,
                d: 1.0,
                e: 12.0,
                f: -3.0,
            },
        );
        let json = serde_json::to_value(&turned).expect("json");
        assert_eq!(json["matrix"]["e"], 12.0);
        assert_eq!(
            serde_json::from_value::<Shape>(json).expect("read"),
            turned
        );
        assert!(validate(&turned).is_ok());
    }

    fn placement(symbol: &str, matrix: Option<Affine>) -> Shape {
        Shape::Instance {
            symbol: symbol.to_string(),
            name: "hero".to_string(),
            matrix,
            visible: true,
            first_frame: 2,
            looping: LoopMode::PlayOnce,
        }
    }

    #[test]
    fn a_placement_keeps_its_library_reference_in_json() {
        let shape = placement("y1", Some(Affine::default()));
        let json = serde_json::to_value(&shape).expect("json");
        assert_eq!(json["kind"], "Instance");
        assert_eq!(json["symbol"], "y1");
        assert_eq!(json["firstFrame"], 2);
        assert_eq!(json["looping"], "playOnce");
        assert_eq!(serde_json::from_value::<Shape>(json).expect("read"), shape);
        let bare = serde_json::to_value(placement("y1", None)).expect("json");
        assert!(bare.get("matrix").is_none());
        assert_eq!(
            serde_json::from_value::<Shape>(serde_json::json!({
                "kind": "Instance",
                "symbol": "y1"
            }))
            .expect("read"),
            Shape::Instance {
                symbol: "y1".to_string(),
                name: String::new(),
                matrix: None,
                visible: true,
                first_frame: 0,
                looping: LoopMode::Loop,
            }
        );
    }

    #[test]
    fn a_library_symbol_round_trips_with_the_document() {
        let fixture = Fixture::new("library");
        let mut doc = fixture.doc.clone();
        let layers = doc.scenes[0].layers.clone();
        doc.symbols = vec![Symbol {
            id: "y1".to_string(),
            name: "Guy".to_string(),
            kind: SymbolKind::MovieClip,
            layers,
        }];
        let stored = serde_json::to_value(&doc).expect("json");
        assert_eq!(stored["symbols"][0]["kind"], "movieClip");
        let restored: Document = serde_json::from_value(stored).expect("read");
        assert_eq!(restored, doc);
        assert_eq!(restored.symbols[0].layers.len(), 1);
    }

    #[test]
    fn an_older_document_has_an_empty_library() {
        let fixture = Fixture::new("older-library");
        let doc = fixture.doc.clone();
        let mut stored = serde_json::to_value(&doc).expect("json");
        stored
            .as_object_mut()
            .expect("map")
            .remove("symbols")
            .expect("library");
        let restored: Document = serde_json::from_value(stored).expect("read");
        assert!(restored.symbols.is_empty());
        assert_eq!(restored.scenes, doc.scenes);
    }

    #[test]
    fn a_placement_needs_a_library_symbol_and_a_finite_matrix() {
        assert_eq!(
            validate(&placement("", None)).unwrap_err(),
            "a symbol instance needs a library symbol"
        );
        assert_eq!(
            validate(&placement(&"y".repeat(300), None)).unwrap_err(),
            "a symbol instance needs a library symbol"
        );
        assert_eq!(
            validate(&placement(
                "y1",
                Some(Affine {
                    a: f64::NAN,
                    ..Affine::default()
                })
            ))
            .unwrap_err(),
            "symbol instance matrix must be finite"
        );
        assert_eq!(
            validate(&Shape::Instance {
                symbol: "y1".to_string(),
                name: "h".repeat(300),
                matrix: None,
                visible: true,
                first_frame: 0,
                looping: LoopMode::Loop,
            })
            .unwrap_err(),
            "symbol instance names must stay short"
        );
        assert!(validate(&placement("y1", Some(Affine::default()))).is_ok());
    }

    #[test]
    fn moving_a_placement_composes_its_matrix() {
        let moved = transform_shape(
            &placement(
                "y1",
                Some(Affine {
                    a: 2.0,
                    b: 0.0,
                    c: 0.0,
                    d: 2.0,
                    e: 10.0,
                    f: 20.0,
                }),
            ),
            &Affine {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 5.0,
                f: -4.0,
            },
            1.0,
            1.0,
            0.0,
        )
        .expect("move");
        assert_eq!(
            moved,
            placement(
                "y1",
                Some(Affine {
                    a: 2.0,
                    b: 0.0,
                    c: 0.0,
                    d: 2.0,
                    e: 15.0,
                    f: 16.0,
                })
            )
        );
        let dropped = transform_shape(
            &placement("y1", None),
            &Affine {
                a: 3.0,
                b: 0.0,
                c: 0.0,
                d: 3.0,
                e: 0.0,
                f: 0.0,
            },
            3.0,
            3.0,
            0.0,
        )
        .expect("scale");
        assert_eq!(
            dropped,
            placement(
                "y1",
                Some(Affine {
                    a: 3.0,
                    b: 0.0,
                    c: 0.0,
                    d: 3.0,
                    e: 0.0,
                    f: 0.0,
                })
            )
        );
    }

    #[test]
    fn a_placement_is_hit_at_its_own_origin() {
        let at = placement(
            "y1",
            Some(Affine {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 10.0,
                f: 20.0,
            }),
        );
        let bounds = shape_bounds(&at);
        assert_eq!((bounds.x, bounds.y, bounds.w, bounds.h), (10.0, 20.0, 0.0, 0.0));
        assert!(shape_hit(&at, &Point { x: 11.0, y: 20.0 }, 2.0));
        assert!(!shape_hit(&at, &Point { x: 40.0, y: 20.0 }, 2.0));
    }

    fn plate(x: f64) -> Shape {
        Shape::Rect {
            x,
            y: 0.0,
            w: 10.0,
            h: 10.0,
            fill: "#ff0000".to_string(),
            stroke: "none".to_string(),
            width: 0.0,
            gradient: None,
        }
    }

    fn held(frame: u32, shapes: Vec<Shape>) -> Keyframe {
        Keyframe {
            frame,
            shapes,
            transform: Transform::default(),
            tween: false,
            easing: Easing::linear(),
            label: None,
        }
    }

    fn ink_layer(id: &str, opacity: f64, length: u32, keys: Vec<Keyframe>) -> Layer {
        Layer {
            id: id.to_string(),
            name: "Art".to_string(),
            visible: true,
            locked: false,
            opacity,
            blend: Blend::Normal,
            effects: Vec::new(),
            masked: false,
            length,
            keys,
            folder: false,
            children: Vec::new(),
        }
    }

    fn symbol(id: &str, layers: Vec<Layer>) -> Symbol {
        Symbol {
            id: id.to_string(),
            name: "Hero".to_string(),
            kind: SymbolKind::Graphic,
            layers,
        }
    }

    fn placed(symbol: &str, looping: LoopMode, first_frame: u32, visible: bool) -> Shape {
        Shape::Instance {
            symbol: symbol.to_string(),
            name: "hero".to_string(),
            matrix: None,
            visible,
            first_frame,
            looping,
        }
    }

    fn drawn(layers: &[EvalLayer]) -> Vec<Shape> {
        let mut out = Vec::new();
        for layer in layers {
            out.extend(layer.shapes.iter().cloned());
            out.extend(drawn(&layer.children));
        }
        out
    }

    fn boxes(shapes: &[Shape]) -> Vec<(f64, f64, f64, f64)> {
        let mut out = Vec::new();
        for shape in shapes {
            match shape {
                Shape::Rect { x, y, w, h, .. } => out.push((*x, *y, *w, *h)),
                Shape::Group { children } => out.extend(boxes(children)),
                _ => {}
            }
        }
        out
    }

    fn ink_of(shapes: &[Shape]) -> Vec<String> {
        let mut out = Vec::new();
        for shape in shapes {
            match shape {
                Shape::Rect { fill, .. } => out.push(fill.clone()),
                Shape::Group { children } => out.extend(ink_of(children)),
                _ => {}
            }
        }
        out
    }

    #[test]
    fn a_placement_draws_its_library_artwork() {
        let fixture = Fixture::new("expand");
        let mut doc = fixture.doc.clone();
        doc.symbols = vec![symbol("y1", vec![ink_layer("s1", 1.0, 1, vec![held(0, vec![plate(5.0)])])])];
        doc.scenes[0].layers[0].keys[0].shapes = vec![placement(
            "y1",
            Some(Affine {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 20.0,
                f: 30.0,
            }),
        )];
        let frame = doc.evaluate(&doc.scenes[0].id.clone(), 0).expect("evaluate");
        assert_eq!(boxes(&drawn(&frame.layers)), vec![(25.0, 30.0, 10.0, 10.0)]);
    }

    #[test]
    fn a_scaled_placement_scales_its_artwork() {
        let fixture = Fixture::new("expand-scale");
        let mut doc = fixture.doc.clone();
        doc.symbols = vec![symbol("y1", vec![ink_layer("s1", 1.0, 1, vec![held(0, vec![plate(10.0)])])])];
        doc.scenes[0].layers[0].keys[0].shapes = vec![placement(
            "y1",
            Some(Affine {
                a: 2.0,
                b: 0.0,
                c: 0.0,
                d: 2.0,
                e: 0.0,
                f: 0.0,
            }),
        )];
        let frame = doc.evaluate(&doc.scenes[0].id.clone(), 0).expect("evaluate");
        assert_eq!(boxes(&drawn(&frame.layers)), vec![(20.0, 0.0, 20.0, 20.0)]);
    }

    #[test]
    fn a_flipped_placement_mirrors_its_artwork() {
        let fixture = Fixture::new("expand-flip");
        let mut doc = fixture.doc.clone();
        doc.symbols = vec![symbol("y1", vec![ink_layer("s1", 1.0, 1, vec![held(0, vec![plate(10.0)])])])];
        doc.scenes[0].layers[0].keys[0].shapes = vec![placement(
            "y1",
            Some(Affine {
                a: -1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: 100.0,
                f: 0.0,
            }),
        )];
        let frame = doc.evaluate(&doc.scenes[0].id.clone(), 0).expect("evaluate");
        let shapes = drawn(&frame.layers);
        let Shape::Group { children } = &shapes[0] else {
            panic!("a flipped placement should draw a group");
        };
        assert!(matches!(&children[0], Shape::Path { closed: true, .. }));
        let bounds = shape_bounds(&children[0]);
        assert_eq!((bounds.x, bounds.y, bounds.w, bounds.h), (80.0, 0.0, 10.0, 10.0));
    }

    #[test]
    fn a_rotated_placement_keeps_its_round_artwork_turned() {
        let fixture = Fixture::new("expand-rotate");
        let mut doc = fixture.doc.clone();
        doc.symbols = vec![symbol(
            "y1",
            vec![ink_layer(
                "s1",
                1.0,
                1,
                vec![held(0, vec![ellipse_shape(0.0, 0.0, 10.0, 10.0)])],
            )],
        )];
        let matrix = affine_from(&Point { x: 0.0, y: 0.0 }, 0.0, 0.0, 1.0, 1.0, 30.0);
        doc.scenes[0].layers[0].keys[0].shapes = vec![placement("y1", Some(matrix.clone()))];
        let frame = doc.evaluate(&doc.scenes[0].id.clone(), 0).expect("evaluate");
        let shapes = drawn(&frame.layers);
        let Shape::Group { children } = &shapes[0] else {
            panic!("a placement should draw a group");
        };
        let Shape::Path { nodes, closed, .. } = &children[0] else {
            panic!("a turned circle should draw as a path, got {:?}", children[0]);
        };
        assert!(closed);
        assert_eq!(nodes.len(), 16);
        let at = apply_affine(&matrix, &Point { x: 10.0, y: 5.0 });
        close(nodes[0].point.x, at.x);
        close(nodes[0].point.y, at.y);
    }

    #[test]
    fn a_play_once_placement_freezes_on_its_last_frame() {
        let fixture = Fixture::new("expand-once");
        let mut doc = fixture.doc.clone();
        doc.symbols = vec![symbol(
            "y1",
            vec![ink_layer(
                "s1",
                1.0,
                3,
                vec![held(0, vec![plate(0.0)]), held(2, vec![plate(40.0)])],
            )],
        )];
        doc.scenes[0].layers[0].keys[0].shapes =
            vec![placed("y1", LoopMode::PlayOnce, 0, true)];
        doc.scenes[0].layers[0].length = 12;
        let scene = doc.scenes[0].id.clone();
        assert_eq!(
            boxes(&drawn(&doc.evaluate(&scene, 0).expect("evaluate").layers)),
            vec![(0.0, 0.0, 10.0, 10.0)]
        );
        assert_eq!(
            boxes(&drawn(&doc.evaluate(&scene, 9).expect("evaluate").layers)),
            vec![(40.0, 0.0, 10.0, 10.0)]
        );
    }

    #[test]
    fn a_looping_placement_wraps_inside_its_symbol() {
        let fixture = Fixture::new("expand-loop");
        let mut doc = fixture.doc.clone();
        doc.symbols = vec![symbol(
            "y1",
            vec![ink_layer(
                "s1",
                1.0,
                3,
                vec![
                    held(0, vec![plate(0.0)]),
                    held(1, vec![plate(10.0)]),
                    held(2, vec![plate(20.0)]),
                ],
            )],
        )];
        doc.scenes[0].layers[0].keys[0].shapes =
            vec![placed("y1", LoopMode::Loop, 1, true)];
        doc.scenes[0].layers[0].length = 12;
        let scene = doc.scenes[0].id.clone();
        let seen: Vec<f64> = (0..4)
            .map(|frame| boxes(&drawn(&doc.evaluate(&scene, frame).expect("evaluate").layers))[0].0)
            .collect();
        assert_eq!(seen, vec![10.0, 20.0, 10.0, 20.0]);
    }

    #[test]
    fn a_single_frame_placement_shows_only_its_start() {
        let fixture = Fixture::new("expand-still");
        let mut doc = fixture.doc.clone();
        doc.symbols = vec![symbol(
            "y1",
            vec![ink_layer("s1", 1.0, 3, vec![held(0, vec![plate(0.0)]), held(2, vec![plate(40.0)])])],
        )];
        doc.scenes[0].layers[0].keys[0].shapes =
            vec![placed("y1", LoopMode::SingleFrame, 2, true)];
        doc.scenes[0].layers[0].length = 12;
        let scene = doc.scenes[0].id.clone();
        for frame in [0, 5] {
            assert_eq!(
                boxes(&drawn(&doc.evaluate(&scene, frame).expect("evaluate").layers)),
                vec![(40.0, 0.0, 10.0, 10.0)],
                "frame {frame}"
            );
        }
    }

    #[test]
    fn a_hidden_placement_draws_nothing() {
        let fixture = Fixture::new("expand-hidden");
        let mut doc = fixture.doc.clone();
        doc.symbols = vec![symbol("y1", vec![ink_layer("s1", 1.0, 1, vec![held(0, vec![plate(5.0)])])])];
        doc.scenes[0].layers[0].keys[0].shapes = vec![placed("y1", LoopMode::Loop, 0, false)];
        let scene = doc.scenes[0].id.clone();
        assert!(drawn(&doc.evaluate(&scene, 0).expect("evaluate").layers).is_empty());
    }

    #[test]
    fn a_placement_without_its_symbol_keeps_the_reference() {
        let fixture = Fixture::new("expand-missing");
        let mut doc = fixture.doc.clone();
        doc.symbols = Vec::new();
        doc.scenes[0].layers[0].keys[0].shapes = vec![placed("y1", LoopMode::Loop, 0, true)];
        let scene = doc.scenes[0].id.clone();
        let shapes = drawn(&doc.evaluate(&scene, 0).expect("evaluate").layers);
        assert!(matches!(&shapes[0], Shape::Instance { symbol, .. } if symbol == "y1"));
    }

    #[test]
    fn a_placement_inside_a_symbol_expands_too() {
        let fixture = Fixture::new("expand-nested");
        let mut doc = fixture.doc.clone();
        doc.symbols = vec![
            symbol("y1", vec![ink_layer("s1", 1.0, 1, vec![held(0, vec![plate(5.0)])])]),
            symbol(
                "y2",
                vec![ink_layer("s2", 1.0, 1, vec![held(0, vec![placed("y1", LoopMode::Loop, 0, true)])])],
            ),
        ];
        doc.scenes[0].layers[0].keys[0].shapes = vec![placed("y2", LoopMode::Loop, 0, true)];
        let scene = doc.scenes[0].id.clone();
        assert_eq!(
            boxes(&drawn(&doc.evaluate(&scene, 0).expect("evaluate").layers)),
            vec![(5.0, 0.0, 10.0, 10.0)]
        );
    }

    #[test]
    fn a_symbol_that_places_itself_stops_at_the_guard() {
        let fixture = Fixture::new("expand-cycle");
        let mut doc = fixture.doc.clone();
        doc.symbols = vec![symbol(
            "y1",
            vec![ink_layer(
                "s1",
                1.0,
                1,
                vec![held(0, vec![plate(5.0), placed("y1", LoopMode::Loop, 0, true)])],
            )],
        )];
        doc.scenes[0].layers[0].keys[0].shapes = vec![placed("y1", LoopMode::Loop, 0, true)];
        let scene = doc.scenes[0].id.clone();
        assert_eq!(
            boxes(&drawn(&doc.evaluate(&scene, 0).expect("evaluate").layers)),
            vec![(5.0, 0.0, 10.0, 10.0)]
        );
    }

    #[test]
    fn a_symbol_layer_dims_its_ink() {
        let fixture = Fixture::new("expand-opacity");
        let mut doc = fixture.doc.clone();
        doc.symbols = vec![symbol("y1", vec![ink_layer("s1", 0.5, 1, vec![held(0, vec![plate(5.0)])])])];
        doc.scenes[0].layers[0].keys[0].shapes = vec![placed("y1", LoopMode::Loop, 0, true)];
        let scene = doc.scenes[0].id.clone();
        assert_eq!(
            ink_of(&drawn(&doc.evaluate(&scene, 0).expect("evaluate").layers)),
            vec!["#ff000080".to_string()]
        );
    }

    #[test]
    fn two_placements_of_one_symbol_keep_two_slots() {
        let fixture = Fixture::new("expand-slots");
        let mut doc = fixture.doc.clone();
        doc.symbols = vec![symbol("y1", vec![ink_layer("s1", 1.0, 1, vec![held(0, vec![plate(5.0)])])])];
        doc.scenes[0].layers[0].keys[0].shapes = vec![
            placed("y1", LoopMode::Loop, 0, true),
            placed("y1", LoopMode::Loop, 0, true),
        ];
        let scene = doc.scenes[0].id.clone();
        let shapes = drawn(&doc.evaluate(&scene, 0).expect("evaluate").layers);
        assert_eq!(shapes.len(), 2);
        assert!(shapes
            .iter()
            .all(|shape| matches!(shape, Shape::Group { children } if children.len() == 1)));
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
            duplicate_layer_tree(&mut scene.layers, layer_id)?;
            validate_scene_masks(scene)
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
