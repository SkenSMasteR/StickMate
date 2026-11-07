use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

const HISTORY_LIMIT: usize = 100;
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
            x, y, text, size, ..
        } => {
            let w = text_width(text, *size);
            p.x >= x - radius && p.x <= x + w + radius && p.y >= y - radius && p.y <= y + size + radius
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
        Shape::Text { text, size, .. } => {
            if text.trim().is_empty() {
                return Err("text is empty".to_string());
            }
            if *size <= 0.0 {
                return Err("text size must be positive".to_string());
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

pub fn evaluate_layer(layer: &Layer, frame: u32) -> Option<EvalLayer> {
    if !layer.visible || frame >= layer.length {
        return None;
    }
    let index = layer.held_index(frame)?;
    let key = &layer.keys[index];
    let mut transform = key.transform;
    if key.tween {
        if let Some(next) = layer.keys.get(index + 1) {
            let span = next.frame.saturating_sub(key.frame);
            if span > 0 {
                let t = ((frame - key.frame) as f64 / span as f64).clamp(0.0, 1.0);
                transform = transform.lerp(next.transform, t);
            }
        }
    }
    Some(EvalLayer {
        id: layer.id.clone(),
        opacity: (layer.opacity * transform.opacity).clamp(0.0, 1.0),
        transform,
        shapes: key.shapes.clone(),
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

struct DocState {
    doc: Document,
    undo: Vec<Document>,
    redo: Vec<Document>,
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
        let mut docs = self.docs.lock().map_err(locked)?;
        let state = docs.get_mut(id).ok_or_else(|| "unknown document".to_string())?;
        let before = state.doc.clone();
        change(&mut state.doc)?;
        if state.doc == before {
            return Ok(before);
        }
        state.undo.push(before);
        if state.undo.len() > HISTORY_LIMIT {
            state.undo.remove(0);
        }
        state.redo.clear();
        state.updated_at = now();
        self.write(state)?;
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
        Ok(())
    }

    pub fn rename(&self, id: &str, name: String) -> Result<Document, String> {
        let name = clean_name(&name).ok_or_else(|| "name is empty".to_string())?;
        self.edit(id, |doc| {
            doc.name = name.clone();
            Ok(())
        })
    }

    pub fn add_scene(&self, id: &str, name: String) -> Result<Document, String> {
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
            let index = doc.scene_index(scene_id)?;
            doc.scenes[index].name = name.clone();
            Ok(())
        })
    }

    pub fn remove_scene(&self, id: &str, scene_id: &str) -> Result<Document, String> {
        self.edit(id, |doc| {
            if doc.scenes.len() < 2 {
                return Err("a document needs at least one scene".to_string());
            }
            let index = doc.scene_index(scene_id)?;
            doc.scenes.remove(index);
            Ok(())
        })
    }

    pub fn duplicate_scene(&self, id: &str, scene_id: &str) -> Result<Document, String> {
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
                | Shape::Polygon { fill, .. } => {
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
        self.edit(id, |doc| {
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

    pub fn set_transform(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        transform: Transform,
    ) -> Result<Document, String> {
        self.edit(id, |doc| {
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
        self.edit(id, |doc| {
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
        state.redo.push(state.doc.clone());
        state.doc = previous;
        state.updated_at = now();
        self.write(state)?;
        Ok(state.doc.clone())
    }

    pub fn redo(&self, id: &str) -> Result<Document, String> {
        let mut docs = self.docs.lock().map_err(locked)?;
        let state = docs.get_mut(id).ok_or_else(|| "unknown document".to_string())?;
        let next = state.redo.pop().ok_or_else(|| "nothing to redo".to_string())?;
        state.undo.push(state.doc.clone());
        state.doc = next;
        state.updated_at = now();
        self.write(state)?;
        Ok(state.doc.clone())
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let mut doc = fixture
            .store
            .replace_shape(id, &fixture.scene, &fixture.layer, 0, 0, text("Hello", 24.0))
            .expect("replace");
        doc = fixture
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
}