use std::collections::HashMap;
use std::f64::consts::TAU;

use crate::document::{
    polygon_vertices, text_block_height, text_block_width, text_lines, Affine, Document, Keyframe,
    Layer, Point, Scene, Shape, Transform, TextAlign,
};
use crate::path::PathNode;

pub const DOM_DOCUMENT: &str = "DOMDocument.xml";
pub const PUBLISH_SETTINGS: &str = "PublishSettings.xml";
pub const METADATA: &str = "META-INF/metadata.xml";
pub const LIBRARY_FOLDER: &str = "LIBRARY/";
pub const KEY_MODE: &str = "9728";

pub struct Contour {
    pub start: Point,
    pub segments: Vec<Segment>,
}

pub struct Segment {
    pub control: Option<Point>,
    pub to: Point,
}

pub struct XflShape {
    pub fill: Option<(String, f64)>,
    pub stroke: Option<(String, f64, f64)>,
    pub contours: Vec<Contour>,
}

pub struct XflText {
    pub matrix: Affine,
    pub width: f64,
    pub height: f64,
    pub text: String,
    pub size: f64,
    pub family: String,
    pub color: String,
    pub alpha: f64,
    pub leading: f64,
    pub align: &'static str,
    pub spacing: f64,
}

#[derive(Clone)]
pub struct XflBitmap {
    pub name: String,
    pub href: String,
    pub width: u32,
    pub height: u32,
}

pub struct XflBitmapInstance {
    pub item: String,
    pub matrix: Affine,
}

#[derive(Default)]
pub struct Library {
    seen: HashMap<String, usize>,
    items: Vec<XflBitmap>,
    files: Vec<Vec<u8>>,
}

impl Library {
    fn register(&mut self, source: &str) -> Option<&XflBitmap> {
        if let Some(index) = self.seen.get(source) {
            return self.items.get(*index);
        }
        let kind = crate::media::kind_of_source(source)?;
        let bytes = crate::media::payload(source)?;
        let info = crate::media::inspect(&bytes).ok()?;
        let index = self.items.len();
        let extension = if kind == "jpeg" { "jpg" } else { kind };
        self.items.push(XflBitmap {
            name: format!("Bitmap {}", index + 1),
            href: format!("Bitmap {}.{extension}", index + 1),
            width: info.width,
            height: info.height,
        });
        self.files.push(bytes);
        self.seen.insert(source.to_string(), index);
        self.items.get(index)
    }

    fn clone_items(&self) -> Vec<XflBitmap> {
        self.items.clone()
    }

    fn members(&self) -> Vec<(String, Vec<u8>)> {
        self.items
            .iter()
            .zip(&self.files)
            .map(|(item, bytes)| (format!("{LIBRARY_FOLDER}{}", item.href), bytes.clone()))
            .collect()
    }
}

pub enum Element {
    Shape(XflShape),
    Text(XflText),
    Bitmap(XflBitmapInstance),
}

pub struct XflFrame {
    pub index: u32,
    pub duration: u32,
    pub elements: Vec<Element>,
}

pub struct XflLayer {
    pub name: String,
    pub color: String,
    pub visible: bool,
    pub locked: bool,
    pub kind: String,
    pub parent: Option<usize>,
    pub frames: Vec<XflFrame>,
}

pub struct XflScene {
    pub name: String,
    pub layers: Vec<XflLayer>,
}

pub struct XflDocument {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub background: String,
    pub media: Vec<XflBitmap>,
    pub scenes: Vec<XflScene>,
}

const PALETTE: [&str; 10] = [
    "#FF0000",
    "#FF6600",
    "#FFCC00",
    "#339900",
    "#00CCCC",
    "#0066FF",
    "#CC66FF",
    "#FF6699",
    "#999999",
    "#000000",
];

pub fn layer_color(index: usize) -> String {
    PALETTE[index % PALETTE.len()].to_string()
}

pub fn num(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_string();
    }
    let rounded = (value * 1000.0).round() / 1000.0;
    if rounded == 0.0 {
        return "0".to_string();
    }
    let mut text = format!("{:.3}", rounded);
    while text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    text
}

pub fn twips(value: f64) -> String {
    num(value * 20.0)
}

pub fn escape(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\u{0}'..='\u{08}' | '\u{0b}' | '\u{0c}' | '\u{0e}'..='\u{1f}' => {}
            other => out.push(other),
        }
    }
    out
}

fn hex2(value: u32) -> String {
    format!("{:02x}", value & 0xff)
}

pub fn color_alpha(value: &str) -> (String, f64) {
    let digits = value.trim().strip_prefix('#').unwrap_or(value.trim()).to_ascii_lowercase();
    let valid = digits.chars().all(|ch| ch.is_ascii_hexdigit());
    let nibble = |ch: char| ch.to_digit(16).unwrap_or(0) * 17;
    if valid && (digits.len() == 3 || digits.len() == 4) {
        let chars: Vec<char> = digits.chars().collect();
        let color = format!(
            "#{}{}{}",
            hex2(nibble(chars[0])),
            hex2(nibble(chars[1])),
            hex2(nibble(chars[2]))
        );
        let alpha = chars
            .get(3)
            .map(|ch| nibble(*ch) as f64 / 255.0)
            .unwrap_or(1.0);
        return (color, alpha);
    }
    if valid && (digits.len() == 6 || digits.len() == 8) {
        let color = format!("#{}", &digits[0..6]);
        let alpha = digits
            .get(6..8)
            .map(|pair| u32::from_str_radix(pair, 16).unwrap_or(255) as f64 / 255.0)
            .unwrap_or(1.0);
        return (color, alpha);
    }
    ("#000000".to_string(), 1.0)
}

pub fn solid_present(value: &str) -> bool {
    value.trim().starts_with('#') && !matches!(value.trim()[1..].to_ascii_lowercase().as_str(), "" | "none")
}

pub fn face(family: &str) -> String {
    let mapped = match family.trim().to_ascii_lowercase().as_str() {
        "arial" => "ArialMT",
        "arial black" => "ArialBlack",
        "times new roman" => "TimesNewRomanPSMT",
        "courier new" => "CourierNewPSMT",
        "verdana" => "Verdana",
        "georgia" => "Georgia",
        "trebuchet ms" => "TrebuchetMS",
        "comic sans ms" => "ComicSansMS",
        "impact" => "Impact",
        "tahoma" => "Tahoma",
        _ => return family.trim().to_string(),
    };
    mapped.to_string()
}

pub fn family(face: &str) -> String {
    let mapped = match face.trim().to_ascii_lowercase().as_str() {
        "arialmt" => "Arial",
        "arialblack" => "Arial Black",
        "timesnewromanpsmt" => "Times New Roman",
        "couriernewpsmt" => "Courier New",
        "verdana" => "Verdana",
        "georgia" => "Georgia",
        "trebuchetms" => "Trebuchet MS",
        "comicsansms" => "Comic Sans MS",
        "impact" => "Impact",
        "tahoma" => "Tahoma",
        _ => return face.trim().to_string(),
    };
    mapped.to_string()
}

fn place(transform: &Transform, point: &Point) -> Point {
    let matrix = transform_matrix(transform);
    apply(&matrix, point)
}

fn transform_matrix(transform: &Transform) -> Affine {
    let angle = transform.rotation.to_radians();
    Affine {
        a: transform.scale * angle.cos(),
        b: transform.scale * angle.sin(),
        c: -transform.scale * angle.sin(),
        d: transform.scale * angle.cos(),
        e: transform.x,
        f: transform.y,
    }
}

fn apply(matrix: &Affine, point: &Point) -> Point {
    Point {
        x: matrix.a * point.x + matrix.c * point.y + matrix.e,
        y: matrix.b * point.x + matrix.d * point.y + matrix.f,
    }
}

fn compose(outer: &Affine, inner: &Affine) -> Affine {
    Affine {
        a: outer.a * inner.a + outer.c * inner.b,
        b: outer.b * inner.a + outer.d * inner.b,
        c: outer.a * inner.c + outer.c * inner.d,
        d: outer.b * inner.c + outer.d * inner.d,
        e: outer.a * inner.e + outer.c * inner.f + outer.e,
        f: outer.b * inner.e + outer.d * inner.f + outer.f,
    }
}

fn identity() -> Affine {
    Affine {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    }
}

fn translate(x: f64, y: f64) -> Affine {
    Affine { e: x, f: y, ..identity() }
}

fn scaled(sx: f64, sy: f64) -> Affine {
    Affine { a: sx, d: sy, ..identity() }
}

fn lerp(a: &Point, b: &Point, t: f64) -> Point {
    Point {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    }
}

fn quadratic_control(start: &Point, one: &Point, two: &Point, end: &Point) -> Point {
    Point {
        x: (3.0 * (one.x + two.x) - start.x - end.x) / 4.0,
        y: (3.0 * (one.y + two.y) - start.y - end.y) / 4.0,
    }
}

fn cubic_drift(a: &Point, one: &Point, two: &Point, b: &Point) -> f64 {
    let x = -a.x + 3.0 * one.x - 3.0 * two.x + b.x;
    let y = -a.y + 3.0 * one.y - 3.0 * two.y + b.y;
    x.hypot(y) * 0.048
}

pub fn cubic_to_quadratics(start: &Point, one: &Point, two: &Point, end: &Point) -> Vec<Segment> {
    let mut segments = Vec::new();
    push_quadratics(start, one, two, end, 0, &mut segments);
    segments
}

fn push_quadratics(
    start: &Point,
    one: &Point,
    two: &Point,
    end: &Point,
    depth: u32,
    out: &mut Vec<Segment>,
) {
    if cubic_drift(start, one, two, end) <= 0.05 || depth == 5 {
        out.push(Segment {
            control: Some(quadratic_control(start, one, two, end)),
            to: end.clone(),
        });
        return;
    }
    let a = lerp(start, one, 0.5);
    let b = lerp(one, two, 0.5);
    let c = lerp(two, end, 0.5);
    let d = lerp(&a, &b, 0.5);
    let e = lerp(&b, &c, 0.5);
    let middle = lerp(&d, &e, 0.5);
    push_quadratics(start, &a, &d, &middle, depth + 1, out);
    push_quadratics(&middle, &e, &c, end, depth + 1, out);
}

fn ellipse_nodes(x: f64, y: f64, w: f64, h: f64) -> Vec<PathNode> {
    let step = TAU / 16.0;
    let k = 4.0 / 3.0 * (step / 4.0).tan();
    (0..16)
        .map(|index| {
            let angle = index as f64 * step;
            let point = Point {
                x: x + w / 2.0 + w / 2.0 * angle.cos(),
                y: y + h / 2.0 + h / 2.0 * angle.sin(),
            };
            let dx = -w / 2.0 * angle.sin() * k;
            let dy = h / 2.0 * angle.cos() * k;
            PathNode {
                handle_in: Some(Point {
                    x: point.x - dx,
                    y: point.y - dy,
                }),
                handle_out: Some(Point {
                    x: point.x + dx,
                    y: point.y + dy,
                }),
                point,
            }
        })
        .collect()
}

fn polyline(points: &[Point]) -> Contour {
    let Some(first) = points.first() else {
        return Contour {
            start: Point { x: 0.0, y: 0.0 },
            segments: Vec::new(),
        };
    };
    Contour {
        start: first.clone(),
        segments: points
            .iter()
            .skip(1)
            .map(|point| Segment {
                control: None,
                to: point.clone(),
            })
            .collect(),
    }
}

fn path_contour(nodes: &[PathNode], closed: bool, matrix: &Affine) -> Contour {
    let placed: Vec<PathNode> = nodes
        .iter()
        .map(|node| PathNode {
            point: apply(matrix, &node.point),
            handle_in: node.handle_in.as_ref().map(|p| apply(matrix, p)),
            handle_out: node.handle_out.as_ref().map(|p| apply(matrix, p)),
        })
        .collect();
    let Some(first) = placed.first() else {
        return Contour {
            start: Point { x: 0.0, y: 0.0 },
            segments: Vec::new(),
        };
    };
    if placed.len() < 2 {
        return Contour {
            start: first.point.clone(),
            segments: Vec::new(),
        };
    }
    let count = if closed { placed.len() } else { placed.len() - 1 };
    let mut segments = Vec::new();
    for index in 0..count {
        let current = &placed[index];
        let next = &placed[(index + 1) % placed.len()];
        let straight = current.handle_out.is_none() && next.handle_in.is_none();
        if straight {
            segments.push(Segment {
                control: None,
                to: next.point.clone(),
            });
            continue;
        }
        let fallback_one = lerp(&current.point, &next.point, 1.0 / 3.0);
        let fallback_two = lerp(&current.point, &next.point, 2.0 / 3.0);
        let one = current.handle_out.as_ref().unwrap_or(&fallback_one);
        let two = next.handle_in.as_ref().unwrap_or(&fallback_two);
        segments.extend(cubic_to_quadratics(&current.point, one, two, &next.point));
    }
    Contour {
        start: first.point.clone(),
        segments,
    }
}

fn straight_contour(points: &[Point]) -> Contour {
    polyline(points)
}

fn shape_contour(shape: &Shape, matrix: &Affine) -> Option<Contour> {
    let contour = match shape {
        Shape::Stroke { points, .. } => straight_contour(
            &points
                .iter()
                .map(|p| apply(matrix, p))
                .collect::<Vec<Point>>(),
        ),
        Shape::Rect { x, y, w, h, .. } => {
            let corners = vec![
                Point { x: *x, y: *y },
                Point {
                    x: x + w,
                    y: *y,
                },
                Point {
                    x: x + w,
                    y: y + h,
                },
                Point {
                    x: *x,
                    y: y + h,
                },
                Point { x: *x, y: *y },
            ]
            .iter()
            .map(|p| apply(matrix, p))
            .collect::<Vec<Point>>();
            straight_contour(&corners)
        }
        Shape::Ellipse { x, y, w, h, .. } => path_contour(&ellipse_nodes(*x, *y, *w, *h), true, matrix),
        Shape::Polygon {
            x, y, w, h, sides, ..
        } => {
            let mut points = polygon_vertices(*x, *y, *w, *h, *sides)
                .iter()
                .map(|p| apply(matrix, p))
                .collect::<Vec<Point>>();
            if points.is_empty() {
                return None;
            }
            points.push(points[0].clone());
            straight_contour(&points)
        }
        Shape::Path { nodes, closed, .. } => path_contour(nodes, *closed, matrix),
        Shape::Text { .. } | Shape::Group { .. } | Shape::Figure { .. } | Shape::Bitmap { .. } => {
            return None
        }
    };
    if contour.segments.is_empty() {
        return None;
    }
    Some(contour)
}

fn ink_of(shape: &Shape, scale: f64, opacity: f64) -> (Option<(String, f64)>, Option<(String, f64, f64)>) {
    let fill_ink = |value: &str| -> Option<(String, f64)> {
        if !solid_present(value) {
            return None;
        }
        let (color, channel) = color_alpha(value);
        Some((color, channel * opacity))
    };
    match shape {
        Shape::Stroke { color, width, .. } => {
            let (hex, channel) = color_alpha(color);
            (
                None,
                Some((hex, channel * opacity, width.max(0.05) * scale)),
            )
        }
        Shape::Rect {
            fill, stroke, width, ..
        }
        | Shape::Ellipse {
            fill, stroke, width, ..
        }
        | Shape::Polygon {
            fill, stroke, width, ..
        }
        | Shape::Path {
            fill, stroke, width, ..
        } => {
            let stroke_ink = if solid_present(stroke) {
                let (color, channel) = color_alpha(stroke);
                Some((color, channel * opacity, width.max(0.05) * scale))
            } else {
                None
            };
            (fill_ink(fill), stroke_ink)
        }
        Shape::Text { color, .. } => (fill_ink(color), None),
        Shape::Group { .. } | Shape::Figure { .. } | Shape::Bitmap { .. } => (None, None),
    }
}

fn frame_elements(key: &Keyframe, transform: &Transform, library: &mut Library) -> Vec<Element> {
    let matrix = transform_matrix(transform);
    let mut out = Vec::new();
    push_elements(&key.shapes, &matrix, transform, &mut out, library);
    out
}

fn push_elements(
    shapes: &[Shape],
    matrix: &Affine,
    transform: &Transform,
    out: &mut Vec<Element>,
    library: &mut Library,
) {
    for shape in shapes {
        match shape {
            Shape::Group { children } => push_elements(children, matrix, transform, out, library),
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
                let placed = local
                    .as_ref()
                    .map(|inner| compose(&matrix, inner))
                    .unwrap_or_else(|| {
                        let point = place(transform, &Point { x: *x, y: *y });
                        Affine {
                            a: matrix.a,
                            b: matrix.b,
                            c: matrix.c,
                            d: matrix.d,
                            e: point.x,
                            f: point.y,
                        }
                    });
                let (hex, channel) = color_alpha(color);
                out.push(Element::Text(XflText {
                    matrix: placed,
                    width: text_block_width(text, *size, *spacing),
                    height: text_block_height(text_lines(text).len(), *size, *leading),
                    text: text.clone(),
                    size: *size,
                    family: family.clone(),
                    color: hex,
                    alpha: channel * transform.opacity,
                    leading: *leading,
                    align: match align {
                        TextAlign::Left => "left",
                        TextAlign::Center => "center",
                        TextAlign::Right => "right",
                    },
                    spacing: *spacing,
                }));
            }
            Shape::Figure { figure } => {
                let places = crate::rig::places(figure);
                let scale = matrix.a.hypot(matrix.b);
                for (index, bone) in figure.bones.iter().enumerate() {
                    let place = &places[index];
                    if bone.length > 0.0 {
                        let (hex, channel) = color_alpha(&bone.color);
                        out.push(Element::Shape(XflShape {
                            fill: None,
                            stroke: Some((
                                hex,
                                channel * transform.opacity,
                                bone.width.max(0.05) * scale,
                            )),
                            contours: vec![Contour {
                                start: apply(matrix, &place.base),
                                segments: vec![Segment {
                                    control: None,
                                    to: apply(matrix, &place.tip),
                                }],
                            }],
                        }));
                    }
                    let frame = compose(matrix, &crate::rig::bone_matrix(place));
                    push_elements(&bone.art, &frame, transform, out, library);
                }
            }
            Shape::Bitmap {
                x,
                y,
                w,
                h,
                source,
                matrix: local,
            } => {
                let Some(item) = library.register(source) else {
                    continue;
                };
                if item.width == 0 || item.height == 0 {
                    continue;
                }
                let natural = compose(
                    &translate(*x, *y),
                    &scaled(*w / item.width as f64, *h / item.height as f64),
                );
                let placed = local
                    .as_ref()
                    .map_or(natural, |inner| compose(inner, &natural));
                out.push(Element::Bitmap(XflBitmapInstance {
                    item: item.name.clone(),
                    matrix: compose(matrix, &placed),
                }));
            }
            other => {
                let Some(contour) = shape_contour(other, &matrix) else {
                    continue;
                };
                let (fill, stroke) = ink_of(other, transform.scale, transform.opacity);
                if fill.is_none() && stroke.is_none() {
                    continue;
                }
                out.push(Element::Shape(XflShape {
                    fill,
                    stroke,
                    contours: vec![contour],
                }));
            }
        }
    }
}

pub fn export_scene(scene: &Scene, library: &mut Library) -> XflScene {
    let mut flat: Vec<(&Layer, Option<usize>)> = Vec::new();
    flatten_layers(&scene.layers, None, &mut flat);
    XflScene {
        name: scene.name.clone(),
        layers: flat
            .iter()
            .enumerate()
            .map(|(index, (layer, parent))| {
                let mut out = export_layer(layer, index, library);
                if layer.folder {
                    out.kind = "folder".to_string();
                } else if flat
                    .get(index + 1)
                    .is_some_and(|(next, _)| next.masked && !next.folder)
                {
                    out.kind = "mask".to_string();
                }
                out.parent = match parent {
                    Some(at) => Some(*at),
                    None if layer.masked && index > 0 => Some(index - 1),
                    None => None,
                };
                out
            })
            .collect(),
    }
}

fn flatten_layers<'a>(
    layers: &'a [Layer],
    folder: Option<usize>,
    out: &mut Vec<(&'a Layer, Option<usize>)>,
) {
    for layer in layers {
        let at = out.len();
        out.push((layer, folder));
        if layer.folder {
            flatten_layers(&layer.children, Some(at), out);
        }
    }
}

pub fn export_layer(layer: &Layer, index: usize, library: &mut Library) -> XflLayer {
    XflLayer {
        name: layer.name.clone(),
        color: layer_color(index),
        visible: layer.visible,
        locked: layer.locked,
        kind: "normal".to_string(),
        parent: None,
        frames: export_frames(layer, library),
    }
}

pub fn export_frames(layer: &Layer, library: &mut Library) -> Vec<XflFrame> {
    let mut frames = Vec::new();
    for (position, key) in layer.keys.iter().enumerate() {
        if position == 0 && key.frame > 0 {
            frames.push(XflFrame {
                index: 0,
                duration: key.frame,
                elements: Vec::new(),
            });
        }
        let end = layer
            .keys
            .get(position + 1)
            .map(|next| next.frame)
            .unwrap_or_else(|| layer.length.max(key.frame + 1));
        frames.push(XflFrame {
            index: key.frame,
            duration: end.saturating_sub(key.frame).max(1),
            elements: frame_elements(key, &key.transform, library),
        });
    }
    frames
}

pub fn export_package(doc: &Document) -> (String, Vec<(String, Vec<u8>)>) {
    let mut library = Library::default();
    let scenes = doc
        .scenes
        .iter()
        .map(|scene| export_scene(scene, &mut library))
        .collect();
    let model = XflDocument {
        width: doc.width,
        height: doc.height,
        fps: doc.fps,
        background: doc.background.clone(),
        media: library.clone_items(),
        scenes,
    };
    (render(&model), library.members())
}

pub fn document_xml(doc: &Document) -> String {
    export_package(doc).0
}

pub fn library_members(doc: &Document) -> Vec<(String, Vec<u8>)> {
    export_package(doc).1
}

pub fn render(model: &XflDocument) -> String {
    let (background, _) = color_alpha(&model.background);
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n");
    out.push_str(&format!(
        "<DOMDocument xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns=\"http://ns.adobe.com/xfl/2008/\" backgroundColor=\"{background}\" width=\"{}\" height=\"{}\" currentTimeline=\"1\" xflVersion=\"2.971\" creatorInfo=\"StickMate\" platform=\"Windows\" versionInfo=\"Saved by StickMate\" majorVersion=\"20\" buildNumber=\"0\" frameRate=\"{:.4}\" nextSceneIdentifier=\"{}\" playOptionsPlayLoop=\"false\" playOptionsPlayPages=\"false\" playOptionsPlayFrameActions=\"false\">\n",
        model.width.max(1),
        model.height.max(1),
        model.fps as f64,
        model.scenes.len() + 1
    ));
    out.push_str(&format!(
        "{}     <symbols/>\n     <timelines>\n",
        media_xml(&model.media)
    ));
    for scene in &model.scenes {
        out.push_str(&format!(
            "          <DOMTimeline name=\"{}\" currentFrame=\"0\" layerDepthEnabled=\"true\">\n               <layers>\n",
            escape(&scene.name)
        ));
        for (index, layer) in scene.layers.iter().enumerate() {
            out.push_str(&layer_xml(layer, "                    ", index == 0));
        }
        out.push_str("               </layers>\n          </DOMTimeline>\n");
    }
    out.push_str("     </timelines>\n</DOMDocument>\n");
    out
}

fn media_xml(items: &[XflBitmap]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let mut out = String::from("     <media>\n");
    for item in items {
        out.push_str(&format!(
            "          <DOMBitmapItem name=\"{}\" allowSmoothing=\"true\" originalCompressionType=\"lossless\" quality=\"50\" href=\"{}\" frameRight=\"{}\" frameBottom=\"{}\"/>\n",
            escape(&item.name),
            escape(&item.href),
            twips(item.width as f64),
            twips(item.height as f64)
        ));
    }
    out.push_str("     </media>\n");
    out
}

fn layer_xml(layer: &XflLayer, indent: &str, current: bool) -> String {
    let mut flags = String::new();
    if !layer.visible {
        flags.push_str(" visible=\"false\"");
    }
    if layer.locked {
        flags.push_str(" locked=\"true\"");
    }
    if layer.kind != "normal" {
        flags.push_str(&format!(" layerType=\"{}\"", escape(&layer.kind)));
    }
    if let Some(parent) = layer.parent {
        flags.push_str(&format!(" parentLayerIndex=\"{parent}\""));
    }
    if current {
        flags.push_str(" current=\"true\" isSelected=\"true\"");
    }
    let body = if layer.frames.is_empty() {
        format!(
            "{indent}     <frames>\n{indent}          <DOMFrame index=\"0\" duration=\"1\" keyMode=\"{KEY_MODE}\">\n{indent}               <elements/>\n{indent}          </DOMFrame>\n{indent}     </frames>\n"
        )
    } else {
        let mut inner = format!("{indent}     <frames>\n");
        for frame in &layer.frames {
            inner.push_str(&frame_xml(frame, &format!("{indent}          ")));
        }
        inner.push_str(&format!("{indent}     </frames>\n"));
        inner
    };
    format!(
        "{indent}<DOMLayer name=\"{}\" color=\"{}\" autoNamed=\"false\"{}>\n{body}{indent}</DOMLayer>\n",
        escape(&layer.name),
        layer.color,
        flags
    )
}

fn frame_xml(frame: &XflFrame, indent: &str) -> String {
    let elements = if frame.elements.is_empty() {
        format!("{indent}     <elements/>\n")
    } else {
        let mut inner = format!("{indent}     <elements>\n");
        for element in &frame.elements {
            match element {
                Element::Shape(shape) => {
                    inner.push_str(&shape_xml(shape, &format!("{indent}          ")))
                }
                Element::Text(text) => {
                    inner.push_str(&text_xml(text, &format!("{indent}          ")))
                }
                Element::Bitmap(instance) => {
                    inner.push_str(&bitmap_xml(instance, &format!("{indent}          ")))
                }
            }
        }
        inner.push_str(&format!("{indent}     </elements>\n"));
        inner
    };
    format!(
        "{indent}<DOMFrame index=\"{}\" duration=\"{}\" keyMode=\"{KEY_MODE}\">\n{elements}{indent}</DOMFrame>\n",
        frame.index,
        frame.duration.max(1)
    )
}

fn shape_xml(shape: &XflShape, indent: &str) -> String {
    let mut out = format!("{indent}<DOMShape>\n");
    if let Some((color, alpha)) = &shape.fill {
        out.push_str(&format!(
            "{indent}     <fills>\n{indent}          <FillStyle index=\"1\">\n{indent}               <SolidColor color=\"{}\"{} />\n{indent}          </FillStyle>\n{indent}     </fills>\n",
            color,
            alpha_attr(*alpha)
        ));
    }
    if let Some((color, alpha, width)) = &shape.stroke {
        out.push_str(&format!(
            "{indent}     <strokes>\n{indent}          <StrokeStyle index=\"1\">\n{indent}               <SolidStroke scaleMode=\"none\" caps=\"none\" joints=\"miter\" hAlign=\"center\" w=\"{}\">\n{indent}                    <SolidColor color=\"{}\"{} />\n{indent}               </SolidStroke>\n{indent}          </StrokeStyle>\n{indent}     </strokes>\n",
            twips(*width),
            color,
            alpha_attr(*alpha)
        ));
    }
    out.push_str(&format!("{indent}     <edges>\n"));
    for contour in &shape.contours {
        if let Some((_, _)) = &shape.fill {
            out.push_str(&format!(
                "{indent}          <Edge fillStyle1=\"1\" edges=\"{}\"/>\n",
                edge_string(contour)
            ));
        }
        if let Some((_, _, _)) = &shape.stroke {
            out.push_str(&format!(
                "{indent}          <Edge strokeStyle=\"1\" edges=\"{}\"/>\n",
                edge_string(contour)
            ));
        }
    }
    out.push_str(&format!("{indent}     </edges>\n{indent}</DOMShape>\n"));
    out
}

fn alpha_attr(alpha: f64) -> String {
    if alpha >= 0.999 {
        String::new()
    } else {
        format!(" alpha=\"{}\"", num(alpha.clamp(0.0, 1.0)))
    }
}

fn text_xml(text: &XflText, indent: &str) -> String {
    format!(
        "{indent}<DOMStaticText width=\"{}\" height=\"{}\" autoExpand=\"true\" isSelectable=\"false\">\n{indent}     <matrix>\n{indent}          <Matrix a=\"{}\" b=\"{}\" c=\"{}\" d=\"{}\" tx=\"{}\" ty=\"{}\"/>\n{indent}     </matrix>\n{indent}     <textRuns>\n{indent}          <DOMTextRun>\n{indent}               <characters>{}</characters>\n{indent}               <textAttrs>\n{indent}                    <DOMTextAttrs aliasText=\"false\" lineHeight=\"{}\" size=\"{}\" face=\"{}\" fillColor=\"{}\" textAlign=\"{}\" letterSpacing=\"{}\"{} />\n{indent}               </textAttrs>\n{indent}          </DOMTextRun>\n{indent}     </textRuns>\n{indent}</DOMStaticText>\n",
        num(text.width.max(1.0)),
        num(text.height.max(1.0)),
        num(text.matrix.a),
        num(text.matrix.b),
        num(text.matrix.c),
        num(text.matrix.d),
        num(text.matrix.e),
        num(text.matrix.f),
        escape(&text.text).replace('\n', "&#xd;"),
        num((text.size * text.leading).max(text.size)),
        num(text.size),
        escape(&face(&text.family)),
        text.color,
        text.align,
        num(text.spacing),
        alpha_attr(text.alpha),
    )
}

fn bitmap_xml(instance: &XflBitmapInstance, indent: &str) -> String {
    format!(
        "{indent}<DOMBitmapInstance libraryItemName=\"{}\">\n{indent}     <matrix>\n{indent}          <Matrix a=\"{}\" b=\"{}\" c=\"{}\" d=\"{}\" tx=\"{}\" ty=\"{}\"/>\n{indent}     </matrix>\n{indent}</DOMBitmapInstance>\n",
        escape(&instance.item),
        num(instance.matrix.a),
        num(instance.matrix.b),
        num(instance.matrix.c),
        num(instance.matrix.d),
        num(instance.matrix.e),
        num(instance.matrix.f),
    )
}

fn edge_string(contour: &Contour) -> String {
    let mut out = String::new();
    let mut current = contour.start.clone();
    for segment in &contour.segments {
        out.push('!');
        out.push_str(&twips(current.x));
        out.push(' ');
        out.push_str(&twips(current.y));
        match &segment.control {
            Some(control) => {
                out.push('[');
                out.push_str(&twips(control.x));
                out.push(' ');
                out.push_str(&twips(control.y));
                out.push(' ');
            }
            None => out.push('|'),
        }
        out.push_str(&twips(segment.to.x));
        out.push(' ');
        out.push_str(&twips(segment.to.y));
        current = segment.to.clone();
    }
    out
}

pub fn publish_settings(name: &str) -> String {
    format!(
        "<flash_profiles>\n<flash_profile version=\"1.0\" name=\"Default\" current=\"true\">\n  <PublishFormatProperties enabled=\"true\">\n    <defaultNames>1</defaultNames>\n    <flash>1</flash>\n    <projectorWin>0</projectorWin>\n    <projectorMac>0</projectorMac>\n    <html>0</html>\n    <gif>0</gif>\n    <jpeg>0</jpeg>\n    <png>0</png>\n    <swc>0</swc>\n    <oam>0</oam>\n    <flashDefaultName>1</flashDefaultName>\n    <projectorWinDefaultName>1</projectorWinDefaultName>\n    <projectorMacDefaultName>1</projectorMacDefaultName>\n    <htmlDefaultName>1</htmlDefaultName>\n    <gifDefaultName>1</gifDefaultName>\n    <jpegDefaultName>1</jpegDefaultName>\n    <pngDefaultName>1</pngDefaultName>\n    <swcDefaultName>1</swcDefaultName>\n    <oamDefaultName>1</oamDefaultName>\n    <flashFileName>{name}.swf</flashFileName>\n    <htmlFileName>{name}.html</htmlFileName>\n  </PublishFormatProperties>\n</flash_profile>\n</flash_profiles>\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{Easing, Keyframe, Transform};
    use crate::media::png;

    fn key(frame: u32, shapes: Vec<Shape>) -> Keyframe {
        Keyframe {
            frame,
            shapes,
            transform: Transform::default(),
            tween: false,
            easing: Easing::linear(),
            label: None,
        }
    }

    fn layer(keys: Vec<Keyframe>, length: u32) -> Layer {
        Layer {
            id: "l1".to_string(),
            name: "Art".to_string(),
            visible: true,
            locked: false,
            opacity: 1.0,
            blend: crate::document::Blend::Normal,
            effects: Vec::new(),
            masked: false,
            length,
            keys,
            folder: false,
            children: Vec::new(),
        }
    }

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Shape {
        Shape::Rect {
            x,
            y,
            w,
            h,
            fill: "#ff0000".to_string(),
            stroke: "none".to_string(),
            width: 0.0,
            gradient: None,
        }
    }

    fn image(x: f64, y: f64, w: f64, h: f64, source: &str) -> Shape {
        Shape::Bitmap {
            x,
            y,
            w,
            h,
            source: source.to_string(),
            matrix: None,
        }
    }

    fn book(shapes: Vec<Shape>) -> Document {
        Document {
            id: "d1".to_string(),
            name: "Book".to_string(),
            width: 640,
            height: 360,
            fps: 24,
            background: "#ffffff".to_string(),
            scenes: vec![Scene {
                id: "s1".to_string(),
                name: "Scene 1".to_string(),
                layers: vec![layer(vec![key(0, shapes)], 1)],
            }],
        }
    }

    fn bits() -> Library {
        Library::default()
    }

    #[test]
    fn numbers_drop_trailing_zeros() {
        assert_eq!(num(1.0), "1");
        assert_eq!(num(-0.0004), "0");
        assert_eq!(num(12.5), "12.5");
        assert_eq!(twips(197.4), "3948");
        assert_eq!(twips(0.025), "0.5");
    }

    #[test]
    fn colours_normalise_to_hex_and_alpha() {
        assert_eq!(color_alpha("#f00"), ("#ff0000".to_string(), 1.0));
        let (color, alpha) = color_alpha("#ff000080");
        assert_eq!(color, "#ff0000");
        assert!((alpha - 0.502).abs() < 0.001);
        assert_eq!(color_alpha("nope"), ("#000000".to_string(), 1.0));
        assert!(solid_present("#fff"));
        assert!(!solid_present("none"));
        assert!(!solid_present(""));
    }

    #[test]
    fn markup_escapes_text() {
        assert_eq!(escape("a<b>&\"'"), "a&lt;b&gt;&amp;&quot;&apos;");
    }

    #[test]
    fn fonts_use_the_postscript_names_animate_expects() {
        assert_eq!(face("Arial"), "ArialMT");
        assert_eq!(face("Times New Roman"), "TimesNewRomanPSMT");
        assert_eq!(face("Helvetica Neue"), "Helvetica Neue");
        assert_eq!(family("ArialMT"), "Arial");
        assert_eq!(family("TimesNewRomanPSMT"), "Times New Roman");
        assert_eq!(family("HelveticaNeue"), "HelveticaNeue");
    }

    #[test]
    fn quadratics_track_the_cubic() {
        let start = Point { x: 0.0, y: 0.0 };
        let one = Point { x: 0.0, y: 60.0 };
        let two = Point { x: 60.0, y: 60.0 };
        let end = Point { x: 60.0, y: 0.0 };
        let segments = cubic_to_quadratics(&start, &one, &two, &end);
        assert!(segments.len() > 2);
        assert_eq!(segments.last().unwrap().to, end);
        let mut worst: f64 = 0.0;
        for step in 0..=40 {
            let t = step as f64 / 40.0;
            let want = cubic_point(&start, &one, &two, &end, t);
            let got = quadratic_at(&start, &segments, t);
            worst = worst.max((want.x - got.x).hypot(want.y - got.y));
        }
        assert!(worst < 0.06, "max deviation {worst}");
    }

    fn cubic_point(a: &Point, one: &Point, two: &Point, b: &Point, t: f64) -> Point {
        let u = 1.0 - t;
        Point {
            x: u * u * u * a.x + 3.0 * u * u * t * one.x + 3.0 * u * t * t * two.x + t * t * t * b.x,
            y: u * u * u * a.y + 3.0 * u * u * t * one.y + 3.0 * u * t * t * two.y + t * t * t * b.y,
        }
    }

    fn quadratic_at(start: &Point, segments: &[Segment], t: f64) -> Point {
        let count = segments.len() as f64;
        let index = ((t * count).floor() as usize).min(segments.len() - 1);
        let local = t * count - index as f64;
        let from = if index == 0 {
            start.clone()
        } else {
            segments[index - 1].to.clone()
        };
        let segment = &segments[index];
        let control = segment.control.clone().unwrap();
        let u = 1.0 - local;
        Point {
            x: u * u * from.x + 2.0 * u * local * control.x + local * local * segment.to.x,
            y: u * u * from.y + 2.0 * u * local * control.y + local * local * segment.to.y,
        }
    }

    #[test]
    fn frames_cover_the_whole_layer() {
        let held = layer(vec![key(0, vec![rect(0.0, 0.0, 2.0, 2.0)]), key(5, Vec::new())], 8);
        let frames = export_frames(&held, &mut bits());
        assert_eq!(frames.len(), 2);
        assert_eq!((frames[0].index, frames[0].duration), (0, 5));
        assert_eq!((frames[1].index, frames[1].duration), (5, 3));

        let late = layer(vec![key(3, Vec::new())], 4);
        let frames = export_frames(&late, &mut bits());
        assert_eq!(frames.len(), 2);
        assert_eq!((frames[0].index, frames[0].duration), (0, 3));
        assert!(frames[0].elements.is_empty());
    }

    #[test]
    fn rect_edges_use_twentieths_of_a_pixel() {
        let held = layer(vec![key(0, vec![rect(0.0, 0.0, 2.0, 2.0)])], 1);
        let xml = render(&XflDocument {
            width: 640,
            height: 360,
            fps: 24,
            background: "#ffffff".to_string(),
            media: Vec::new(),
            scenes: vec![XflScene {
                name: "Scene 1".to_string(),
                layers: vec![export_layer(&held, 0, &mut bits())],
            }],
        });
        assert!(xml.contains("<Edge fillStyle1=\"1\" edges=\"!0 0|40 0!40 0|40 40!40 40|0 40!0 40|0 0\"/>"));
        assert!(xml.contains("<SolidColor color=\"#ff0000\" />"));
        assert!(xml.contains("frameRate=\"24.0000\""));
        assert!(xml.contains("xflVersion=\"2.971\""));
        assert!(xml.contains("backgroundColor=\"#ffffff\""));
    }

    #[test]
    fn transform_is_baked_into_edges() {
        let moved = Transform {
            x: 10.0,
            y: 0.0,
            rotation: 0.0,
            scale: 2.0,
            opacity: 1.0,
        };
        let contour = shape_contour(&rect(0.0, 0.0, 2.0, 2.0), &transform_matrix(&moved))
            .expect("contour");
        let string = edge_string(&contour);
        assert!(string.starts_with("!200 0|280 0"), "{string}");
    }

    #[test]
    fn ellipse_becomes_a_closed_curve_chain() {
        let shape = Shape::Ellipse {
            x: 0.0,
            y: 0.0,
            w: 20.0,
            h: 20.0,
            fill: "#00ff00".to_string(),
            stroke: "#000000".to_string(),
            width: 2.0,
            gradient: None,
        };
        let held = layer(vec![key(0, vec![shape])], 1);
        let frames = export_frames(&held, &mut bits());
        let Element::Shape(part) = &frames[0].elements[0] else {
            panic!("expected a shape");
        };
        assert_eq!(part.contours[0].segments.len(), 16);
        assert!(part.fill.is_some() && part.stroke.is_some());
        let xml = frame_xml(&frames[0], "");
        assert!(xml.contains("<Edge fillStyle1=\"1\""));
        assert!(xml.contains("<Edge strokeStyle=\"1\""));
        assert!(xml.contains("w=\"40\""));
    }

    #[test]
    fn text_runs_keep_font_colour_and_breaks() {
        let shape = Shape::Text {
            x: 4.0,
            y: 6.0,
            text: "hi\nthere".to_string(),
            size: 18.0,
            family: "Arial".to_string(),
            color: "#616161".to_string(),
            spacing: 0.0,
            leading: 1.2,
            align: TextAlign::Center,
            matrix: None,
        };
        let held = layer(vec![key(0, vec![shape])], 1);
        let xml = frame_xml(&export_frames(&held, &mut bits())[0], "");
        assert!(xml.contains("<characters>hi&#xd;there</characters>"));
        assert!(xml.contains("face=\"ArialMT\""));
        assert!(xml.contains("fillColor=\"#616161\""));
        assert!(xml.contains("textAlign=\"center\""));
        assert!(xml.contains("tx=\"4\" ty=\"6\""));
    }

    #[test]
    fn hidden_and_locked_layers_are_marked() {
        let mut held = layer(vec![key(0, Vec::new())], 1);
        held.visible = false;
        held.locked = true;
        let xml = layer_xml(&export_layer(&held, 0, &mut bits()), "", false);
        assert!(xml.contains("visible=\"false\""));
        assert!(xml.contains("locked=\"true\""));
        assert!(xml.contains("<DOMLayer name=\"Art\" color=\"#FF0000\" autoNamed=\"false\""));
    }

    #[test]
    fn folders_export_their_children_under_a_parent_index() {
        let mut folder = layer(Vec::new(), 1);
        folder.folder = true;
        folder.children = vec![
            layer(vec![key(0, vec![rect(0.0, 0.0, 2.0, 2.0)])], 4),
            layer(vec![key(0, Vec::new())], 4),
        ];
        let scene = Scene {
            id: "s1".to_string(),
            name: "Scene 1".to_string(),
            layers: vec![folder],
        };
        let exported = export_scene(&scene, &mut bits());
        assert_eq!(exported.layers.len(), 3);
        assert_eq!(exported.layers[0].kind, "folder");
        assert_eq!(exported.layers[1].parent, Some(0));
        assert_eq!(exported.layers[2].parent, Some(0));
        assert!(!exported.layers[1].frames[0].elements.is_empty());
        assert!(layer_xml(&exported.layers[0], "", false).contains("layerType=\"folder\""));
        assert!(layer_xml(&exported.layers[1], "", false).contains("parentLayerIndex=\"0\""));
    }

    #[test]
    fn a_masked_layer_pairs_with_the_layer_above_it() {
        let mut clip = layer(vec![key(0, vec![rect(0.0, 0.0, 2.0, 2.0)])], 1);
        let mut art = layer(vec![key(0, Vec::new())], 1);
        art.masked = true;
        let scene = Scene {
            id: "s1".to_string(),
            name: "Scene 1".to_string(),
            layers: vec![clip, art],
        };
        let exported = export_scene(&scene, &mut bits());
        assert_eq!(exported.layers[0].kind, "mask");
        assert_eq!(exported.layers[1].kind, "normal");
        assert_eq!(exported.layers[1].parent, Some(0));
        let xml = layer_xml(&exported.layers[0], "", false);
        assert!(xml.contains("layerType=\"mask\""));
        let clipped = layer_xml(&exported.layers[1], "", false);
        assert!(clipped.contains("parentLayerIndex=\"0\""));
        assert!(!clipped.contains("layerType"));
    }

    #[test]
    fn folders_and_masks_survive_a_round_trip() {
        let mut clip = layer(vec![key(0, vec![rect(0.0, 0.0, 2.0, 2.0)])], 1);
        clip.name = "Clip".to_string();
        let mut art = layer(vec![key(0, vec![rect(1.0, 1.0, 2.0, 2.0)])], 1);
        art.name = "Art".to_string();
        art.masked = true;
        let mut folder = layer(Vec::new(), 1);
        folder.name = "Group".to_string();
        folder.folder = true;
        folder.children = vec![clip, art];
        let mut doc = book(Vec::new());
        doc.scenes[0].layers = vec![folder];
        let import = crate::xfl_read::parse(&document_xml(&doc), "Book", &[]).expect("parse");
        let layers = &import.doc.scenes[0].layers;
        assert_eq!(
            layers.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(),
            vec!["Group"]
        );
        assert!(layers[0].folder);
        assert_eq!(
            layers[0]
                .children
                .iter()
                .map(|l| l.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Clip", "Art"]
        );
        assert!(!layers[0].children[0].masked);
        assert!(layers[0].children[1].masked);
        assert!(import.notes.is_empty());
    }

    #[test]
    fn groups_export_their_children_as_plain_elements() {
        let group = Shape::Group {
            children: vec![rect(0.0, 0.0, 2.0, 2.0), rect(3.0, 3.0, 1.0, 1.0)],
        };
        let xml = layer_xml(
            &export_layer(&layer(vec![key(0, vec![group])], 1), 0, &mut bits()),
            "",
            false,
        );
        assert_eq!(xml.matches("<DOMShape").count(), 2);
        assert!(xml.contains("!0 0"));
        assert!(xml.contains("!60 60"));
    }

    #[test]
    fn the_same_image_is_only_in_the_library_once() {
        let shared = crate::media::data_url("png", &png(20, 10));
        let other = crate::media::data_url("png", &png(30, 15));
        let doc = book(vec![
            image(0.0, 0.0, 40.0, 20.0, &shared),
            image(15.0, 5.0, 40.0, 20.0, &shared),
            image(20.0, 30.0, 60.0, 30.0, &other),
        ]);
        let xml = document_xml(&doc);
        assert_eq!(xml.matches("<DOMBitmapItem").count(), 2);
        assert_eq!(xml.matches("<DOMBitmapInstance").count(), 3);
        assert!(xml.contains("name=\"Bitmap 1\" allowSmoothing=\"true\""));
        assert!(xml.contains("href=\"Bitmap 1.png\" frameRight=\"400\" frameBottom=\"200\""));
        assert!(xml.contains("href=\"Bitmap 2.png\" frameRight=\"600\" frameBottom=\"300\""));
        assert!(xml.find("<media>").expect("media") < xml.find("<symbols/>").expect("symbols"));
        assert_eq!(
            library_members(&doc),
            vec![
                ("LIBRARY/Bitmap 1.png".to_string(), png(20, 10)),
                ("LIBRARY/Bitmap 2.png".to_string(), png(30, 15)),
            ]
        );
    }

    #[test]
    fn an_image_at_its_natural_size_lands_where_it_was_placed() {
        let shared = crate::media::data_url("png", &png(20, 10));
        let doc = book(vec![image(150.0, 60.0, 20.0, 10.0, &shared)]);
        let xml = document_xml(&doc);
        assert!(xml.contains("libraryItemName=\"Bitmap 1\""));
        assert!(xml.contains("<Matrix a=\"1\" b=\"0\" c=\"0\" d=\"1\" tx=\"150\" ty=\"60\"/>"));
    }

    #[test]
    fn a_scaled_image_carries_the_scale_of_its_box() {
        let shared = crate::media::data_url("png", &png(20, 10));
        let doc = book(vec![image(10.0, 20.0, 40.0, 30.0, &shared)]);
        let xml = document_xml(&doc);
        assert!(xml.contains("<Matrix a=\"2\" b=\"0\" c=\"0\" d=\"3\" tx=\"10\" ty=\"20\"/>"));
    }

    #[test]
    fn an_image_that_cannot_be_decoded_is_left_out() {
        let broken = "data:image/png;base64,iVBORw0KGgo=".to_string();
        let doc = book(vec![image(0.0, 0.0, 30.0, 30.0, &broken)]);
        let xml = document_xml(&doc);
        assert!(!xml.contains("<media>"));
        assert!(!xml.contains("DOMBitmapInstance"));
        assert!(library_members(&doc).is_empty());
    }
}
