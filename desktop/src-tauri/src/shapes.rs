use serde::{Deserialize, Serialize};
use tauri::State;

use crate::document::{
    affine_from, evaluate_layer, transform_shape, Affine, DocStore, Document, Layer, Point, Shape,
    Transform,
};
use crate::path::PathNode;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ShapeClip {
    pub shapes: Vec<Shape>,
    pub transform: Transform,
}

#[derive(Debug, Serialize)]
pub struct ShapePaste {
    pub document: Document,
    pub indices: Vec<usize>,
}

fn check_transform(t: &Transform) -> Result<(), String> {
    if ![t.x, t.y, t.rotation, t.scale, t.opacity]
        .iter()
        .all(|v| v.is_finite())
        || t.scale <= 0.0
        || !(0.0..=1.0).contains(&t.opacity)
    {
        return Err("invalid clipboard transform".into());
    }
    Ok(())
}

fn check_shape(shape: &Shape) -> Result<(), String> {
    let point = |p: &Point| p.x.is_finite() && p.y.is_finite();
    let width = |w: f64| w.is_finite() && w >= 0.0;
    let paint = |s: &str| s.len() <= 1024;
    let valid = match shape {
        Shape::Stroke {
            points,
            color,
            width: w,
        } => {
            !points.is_empty()
                && points.len() <= 100_000
                && points.iter().all(point)
                && width(*w)
                && paint(color)
        }
        Shape::Rect {
            x,
            y,
            w,
            h,
            fill,
            stroke,
            width: sw,
        }
        | Shape::Ellipse {
            x,
            y,
            w,
            h,
            fill,
            stroke,
            width: sw,
        }
        | Shape::Polygon {
            x,
            y,
            w,
            h,
            fill,
            stroke,
            width: sw,
            ..
        } => {
            [*x, *y, *w, *h].iter().all(|v| v.is_finite())
                && *w >= 0.0
                && *h >= 0.0
                && width(*sw)
                && paint(fill)
                && paint(stroke)
                && match shape {
                    Shape::Polygon { sides, .. } => (3..=1024).contains(sides),
                    _ => true,
                }
        }
        Shape::Text {
            x,
            y,
            text,
            size,
            family,
            color,
            matrix,
        } => {
            x.is_finite()
                && y.is_finite()
                && size.is_finite()
                && *size > 0.0
                && !text.trim().is_empty()
                && text.len() <= 1_000_000
                && paint(family)
                && paint(color)
                && matrix.as_ref().map_or(true, |m| {
                    [m.a, m.b, m.c, m.d, m.e, m.f].iter().all(|v| v.is_finite())
                })
        }
        Shape::Path {
            nodes,
            closed,
            fill,
            stroke,
            width: w,
        } => {
            nodes.len() >= if *closed { 3 } else { 2 }
                && nodes.len() <= 100_000
                && nodes.iter().all(|n| {
                    point(&n.point)
                        && n.handle_in.as_ref().map_or(true, point)
                        && n.handle_out.as_ref().map_or(true, point)
                })
                && width(*w)
                && paint(fill)
                && paint(stroke)
        }
    };
    if valid {
        Ok(())
    } else {
        Err("invalid clipboard shape".into())
    }
}

fn check_clip(clip: &ShapeClip) -> Result<(), String> {
    if clip.shapes.is_empty() {
        return Err("clipboard is empty".into());
    }
    if clip.shapes.len() > 10_000 {
        return Err("clipboard has too many shapes".into());
    }
    check_transform(&clip.transform)?;
    clip.shapes.iter().try_for_each(check_shape)
}

fn snapshot(layer: &Layer, frame: u32) -> Result<ShapeClip, String> {
    if frame >= layer.length {
        return Err("frame is out of range".into());
    }
    let mut visible = layer.clone();
    visible.visible = true;
    let evaluated = evaluate_layer(&visible, frame).ok_or("frame has no keyframe")?;
    Ok(ShapeClip {
        shapes: evaluated.shapes,
        transform: evaluated.transform,
    })
}

fn conversion(source: Transform, target: Transform) -> Result<(Affine, f64, f64), String> {
    check_transform(&source)?;
    check_transform(&target)?;
    let angle = target.rotation.to_radians();
    let dx = source.x - target.x;
    let dy = source.y - target.y;
    let scale = source.scale / target.scale;
    let rotation = (source.rotation - target.rotation) % 360.0;
    let matrix = affine_from(
        &Point { x: 0.0, y: 0.0 },
        (dx * angle.cos() + dy * angle.sin()) / target.scale,
        (-dx * angle.sin() + dy * angle.cos()) / target.scale,
        scale,
        scale,
        rotation,
    );
    if ![
        matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f, scale, rotation,
    ]
    .iter()
    .all(|v| v.is_finite())
        || scale <= 0.0
    {
        return Err("invalid clipboard conversion".into());
    }
    Ok((matrix, scale, rotation))
}

fn converted(shape: &Shape, matrix: &Affine, scale: f64, rotation: f64) -> Result<Shape, String> {
    let ellipse_path;
    let shape = if let Shape::Ellipse {
        x,
        y,
        w,
        h,
        fill,
        stroke,
        width,
    } = shape
    {
        if rotation % 90.0 != 0.0 {
            let step = std::f64::consts::TAU / 16.0;
            let k = 4.0 / 3.0 * (step / 4.0).tan();
            let nodes = (0..16)
                .map(|i| {
                    let a = i as f64 * step;
                    let p = Point {
                        x: x + w / 2.0 + w / 2.0 * a.cos(),
                        y: y + h / 2.0 + h / 2.0 * a.sin(),
                    };
                    let dx = -w / 2.0 * a.sin() * k;
                    let dy = h / 2.0 * a.cos() * k;
                    PathNode {
                        handle_in: Some(Point {
                            x: p.x - dx,
                            y: p.y - dy,
                        }),
                        handle_out: Some(Point {
                            x: p.x + dx,
                            y: p.y + dy,
                        }),
                        point: p,
                    }
                })
                .collect();
            ellipse_path = Shape::Path {
                nodes,
                closed: true,
                fill: fill.clone(),
                stroke: stroke.clone(),
                width: *width,
            };
            &ellipse_path
        } else {
            shape
        }
    } else {
        shape
    };
    let mut result = transform_shape(shape, matrix, scale, scale, rotation)?;
    match &mut result {
        Shape::Stroke { width, .. }
        | Shape::Rect { width, .. }
        | Shape::Ellipse { width, .. }
        | Shape::Polygon { width, .. }
        | Shape::Path { width, .. } => *width *= scale,
        Shape::Text { .. } => {}
    }
    check_shape(&result)?;
    Ok(result)
}

impl DocStore {
    pub(crate) fn copy_shapes(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        mut indices: Vec<usize>,
    ) -> Result<ShapeClip, String> {
        let mut doc = self.get(id)?;
        let mut clip = snapshot(doc.layer_mut(scene_id, layer_id)?, frame)?;
        indices.sort_unstable();
        indices.dedup();
        clip.shapes = indices
            .iter()
            .map(|&i| {
                clip.shapes
                    .get(i)
                    .cloned()
                    .ok_or_else(|| "shape index is out of range".to_string())
            })
            .collect::<Result<_, _>>()?;
        check_clip(&clip)?;
        Ok(clip)
    }

    pub(crate) fn paste_shapes(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        clip: ShapeClip,
    ) -> Result<ShapePaste, String> {
        check_clip(&clip)?;
        let mut indices = Vec::new();
        let document = self.edit_named(id, "paste_shapes", |doc| {
            let layer = doc.layer_mut(scene_id, layer_id)?;
            layer.writable()?;
            let target = snapshot(layer, frame)?;
            let (matrix, scale, rotation) = conversion(clip.transform, target.transform)?;
            let shapes = clip
                .shapes
                .iter()
                .map(|s| converted(s, &matrix, scale, rotation))
                .collect::<Result<Vec<_>, _>>()?;
            let index = layer.key_at(frame);
            let key = &mut layer.keys[index];
            key.transform = target.transform;
            indices = (key.shapes.len()..key.shapes.len() + shapes.len()).collect();
            key.shapes.extend(shapes);
            Ok(())
        })?;
        Ok(ShapePaste { document, indices })
    }
}

#[tauri::command]
pub fn doc_copy_shapes(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    indices: Vec<usize>,
) -> Result<ShapeClip, String> {
    store.copy_shapes(&id, &scene_id, &layer_id, frame, indices)
}

#[tauri::command]
pub fn doc_paste_shapes(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    clip: ShapeClip,
) -> Result<ShapePaste, String> {
    store.paste_shapes(&id, &scene_id, &layer_id, frame, clip)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::new_id;
    use std::path::PathBuf;

    struct Stage {
        dir: PathBuf,
        store: DocStore,
        id: String,
        scene: String,
        source: String,
    }

    impl Stage {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("stickmate-clip-{tag}-{}", new_id("t")));
            let store = DocStore::load(dir.clone());
            let doc = store
                .create("Test".to_string(), 800, 600, 24, "#ffffff".to_string())
                .expect("create");
            Self {
                id: doc.id.clone(),
                scene: doc.scenes[0].id.clone(),
                source: doc.scenes[0].layers[0].id.clone(),
                store,
                dir,
            }
        }

        fn draw(&self, layer: &str, shape: Shape) {
            self.store
                .draw(&self.id, &self.scene, layer, 0, shape)
                .expect("draw");
        }

        fn add_layer(&self) -> String {
            self.store
                .add_layer(&self.id, &self.scene, "Top".to_string())
                .expect("layer")
                .scenes[0]
                .layers[0]
                .id
                .clone()
        }

        fn set(&self, layer: &str, transform: Transform) {
            self.store
                .set_transform(&self.id, &self.scene, layer, 0, transform)
                .expect("transform");
        }

        fn copy(&self, layer: &str, indices: Vec<usize>) -> Result<ShapeClip, String> {
            self.store.copy_shapes(&self.id, &self.scene, layer, 0, indices)
        }

        fn paste(&self, layer: &str, clip: ShapeClip) -> Result<ShapePaste, String> {
            self.store.paste_shapes(&self.id, &self.scene, layer, 0, clip)
        }
    }

    impl Drop for Stage {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn rect(x: f64, y: f64) -> Shape {
        Shape::Rect {
            x,
            y,
            w: 40.0,
            h: 20.0,
            fill: "#ff0000".to_string(),
            stroke: "#000000".to_string(),
            width: 2.0,
        }
    }

    fn ellipse() -> Shape {
        Shape::Ellipse {
            x: 0.0,
            y: 0.0,
            w: 60.0,
            h: 30.0,
            fill: "#ff0000".to_string(),
            stroke: "#000000".to_string(),
            width: 2.0,
        }
    }

    fn transform(x: f64, y: f64, scale: f64, rotation: f64) -> Transform {
        Transform {
            x,
            y,
            rotation,
            scale,
            opacity: 1.0,
        }
    }

    fn anchor(shape: &Shape) -> Point {
        match shape {
            Shape::Rect { x, y, .. }
            | Shape::Ellipse { x, y, .. }
            | Shape::Polygon { x, y, .. }
            | Shape::Text { x, y, .. } => Point { x: *x, y: *y },
            Shape::Stroke { points, .. } => points[0].clone(),
            Shape::Path { nodes, .. } => nodes[0].point.clone(),
        }
    }

    fn shapes(doc: &Document, layer: &str) -> Vec<Shape> {
        doc.scenes[0]
            .layers
            .iter()
            .find(|item| item.id == layer)
            .expect("layer")
            .keys
            .iter()
            .max_by_key(|key| key.shapes.len())
            .map(|key| key.shapes.clone())
            .unwrap_or_default()
    }

    fn close(point: &Point, x: f64, y: f64) -> bool {
        (point.x - x).abs() < 1e-6 && (point.y - y).abs() < 1e-6
    }

    #[test]
    fn paste_appends_the_selection_as_one_history_step() {
        let stage = Stage::new("append");
        stage.draw(&stage.source.clone(), rect(10.0, 20.0));
        let clip = stage.copy(&stage.source.clone(), vec![0]).expect("copy");
        let pasted = stage.paste(&stage.source.clone(), clip).expect("paste");
        assert_eq!(pasted.indices, vec![1]);
        assert_eq!(pasted.document.scenes[0].layers[0].keys[0].shapes.len(), 2);
        let undone = stage.store.undo(&stage.id).expect("undo");
        assert_eq!(undone.scenes[0].layers[0].keys[0].shapes.len(), 1);
    }

    #[test]
    fn copy_sorts_and_dedupes_the_requested_indices() {
        let stage = Stage::new("order");
        stage.draw(&stage.source.clone(), rect(0.0, 0.0));
        stage.draw(&stage.source.clone(), rect(50.0, 0.0));
        stage.draw(&stage.source.clone(), rect(100.0, 0.0));
        let clip = stage.copy(&stage.source.clone(), vec![2, 0, 2]).expect("copy");
        let points: Vec<Point> = clip.shapes.iter().map(anchor).collect();
        assert_eq!(points.len(), 2);
        assert!(close(&points[0], 0.0, 0.0));
        assert!(close(&points[1], 100.0, 0.0));
    }

    #[test]
    fn paste_keeps_the_canvas_place_of_a_moved_source_layer() {
        let stage = Stage::new("shift");
        stage.set(&stage.source.clone(), transform(100.0, 50.0, 1.0, 0.0));
        stage.draw(&stage.source.clone(), rect(10.0, 20.0));
        let clip = stage.copy(&stage.source.clone(), vec![0]).expect("copy");
        let target = stage.add_layer();
        let pasted = stage.paste(&target, clip).expect("paste");
        let shapes = shapes(&pasted.document, &target);
        assert_eq!(shapes.len(), 1);
        assert!(close(&anchor(&shapes[0]), 110.0, 70.0));
    }

    #[test]
    fn paste_rescales_shapes_for_a_zoomed_target_layer() {
        let stage = Stage::new("zoom");
        stage.draw(&stage.source.clone(), rect(100.0, 0.0));
        let clip = stage.copy(&stage.source.clone(), vec![0]).expect("copy");
        let target = stage.add_layer();
        stage.set(&target, transform(0.0, 0.0, 2.0, 0.0));
        let pasted = stage.paste(&target, clip).expect("paste");
        let shapes = shapes(&pasted.document, &target);
        assert!(close(&anchor(&shapes[0]), 50.0, 0.0));
        match &shapes[0] {
            Shape::Rect { w, h, width, .. } => {
                assert!((w - 20.0).abs() < 1e-6);
                assert!((h - 10.0).abs() < 1e-6);
                assert!((width - 1.0).abs() < 1e-6);
            }
            other => panic!("expected a rectangle, got {other:?}"),
        }
    }

    #[test]
    fn rotating_paste_turns_an_ellipse_into_a_curved_path() {
        let stage = Stage::new("rotate");
        stage.draw(&stage.source.clone(), ellipse());
        let clip = stage.copy(&stage.source.clone(), vec![0]).expect("copy");
        let target = stage.add_layer();
        stage.set(&target, transform(0.0, 0.0, 1.0, 45.0));
        let pasted = stage.paste(&target, clip).expect("paste");
        let shapes = shapes(&pasted.document, &target);
        match &shapes[0] {
            Shape::Path { nodes, closed, .. } => {
                assert!(nodes.len() > 4);
                assert!(*closed);
            }
            other => panic!("expected a curved path, got {other:?}"),
        }
    }

    #[test]
    fn copy_rejects_an_index_outside_the_frame() {
        let stage = Stage::new("range");
        stage.draw(&stage.source.clone(), rect(0.0, 0.0));
        let error = stage
            .copy(&stage.source.clone(), vec![7])
            .expect_err("expected failure");
        assert_eq!(error, "shape index is out of range");
    }

    #[test]
    fn paste_rejects_a_malformed_clipboard() {
        let stage = Stage::new("broken");
        let empty = ShapeClip {
            shapes: Vec::new(),
            transform: Transform::default(),
        };
        assert_eq!(
            stage.paste(&stage.source.clone(), empty).expect_err("empty"),
            "clipboard is empty"
        );
        let distorted = ShapeClip {
            shapes: vec![rect(f64::NAN, 0.0)],
            transform: Transform::default(),
        };
        assert_eq!(
            stage
                .paste(&stage.source.clone(), distorted)
                .expect_err("distorted"),
            "invalid clipboard shape"
        );
        let unusable = ShapeClip {
            shapes: vec![rect(0.0, 0.0)],
            transform: transform(0.0, 0.0, 0.0, 0.0),
        };
        assert_eq!(
            stage
                .paste(&stage.source.clone(), unusable)
                .expect_err("unusable"),
            "invalid clipboard transform"
        );
        assert_eq!(shapes(&stage.store.get(&stage.id).expect("doc"), &stage.source.clone()), Vec::new());
    }

    #[test]
    fn paste_into_a_locked_layer_changes_nothing() {
        let stage = Stage::new("locked");
        stage.draw(&stage.source.clone(), rect(0.0, 0.0));
        let clip = stage.copy(&stage.source.clone(), vec![0]).expect("copy");
        stage
            .store
            .set_layer(&stage.id, &stage.scene, &stage.source, None, None, Some(true), None)
            .expect("lock");
        let error = stage
            .paste(&stage.source.clone(), clip)
            .expect_err("expected failure");
        assert_eq!(error, "layer is locked");
        let doc = stage.store.get(&stage.id).expect("doc");
        assert_eq!(doc.scenes[0].layers[0].keys[0].shapes.len(), 1);
    }
}
