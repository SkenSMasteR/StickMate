use serde::{Deserialize, Serialize};
use tauri::State;

use crate::document::{find_layer, DocStore, Document, Easing, Keyframe, Layer, Transform};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FrameClip {
    pub span: u32,
    pub keys: Vec<Keyframe>,
}

fn check_count(count: u32) -> Result<(), String> {
    if count == 0 || count > 1000 {
        return Err("frame count must be between 1 and 1000".to_string());
    }
    Ok(())
}

fn check_frame(layer: &Layer, frame: u32) -> Result<(), String> {
    if frame >= layer.length {
        return Err("frame is out of range".to_string());
    }
    Ok(())
}

fn empty_key(frame: u32) -> Keyframe {
    Keyframe {
        frame,
        shapes: Vec::new(),
        transform: Transform::default(),
        tween: false,
        easing: Easing::linear(),
        label: None,
    }
}

fn check_clip(clip: &FrameClip) -> Result<(), String> {
    check_count(clip.span)?;
    if clip.keys.is_empty() {
        return Err("clipboard is empty".to_string());
    }
    if clip.keys.iter().any(|key| key.frame >= clip.span)
        || clip.keys.windows(2).any(|pair| pair[0].frame >= pair[1].frame)
    {
        return Err("clipboard is invalid".to_string());
    }
    Ok(())
}

fn clip_of(layer: &Layer, frame: u32, count: u32) -> FrameClip {
    let mut keys: Vec<Keyframe> = Vec::new();
    if layer.key_index(frame).is_none() {
        if let Some(index) = layer.held_index(frame) {
            let held = &layer.keys[index];
            keys.push(Keyframe {
                frame: 0,
                shapes: held.shapes.clone(),
                transform: held.transform,
                tween: false,
                easing: Easing::linear(),
                label: None,
            });
        }
    }
    for key in &layer.keys {
        if key.frame >= frame && key.frame - frame < count {
            let mut copy = key.clone();
            copy.frame -= frame;
            keys.push(copy);
        }
    }
    FrameClip { span: count, keys }
}

fn paste_into(layer: &mut Layer, frame: u32, clip: &FrameClip) {
    for key in &mut layer.keys {
        if key.frame >= frame {
            key.frame += clip.span;
        }
    }
    for key in &clip.keys {
        let mut copy = key.clone();
        copy.frame += frame;
        layer.keys.push(copy);
    }
    if frame == 0 && layer.key_index(0).is_none() {
        layer.keys.push(empty_key(0));
    }
    layer.keys.sort_by_key(|key| key.frame);
    layer.length += clip.span;
}

fn remove_range(layer: &mut Layer, frame: u32, count: u32) {
    let head = if frame == 0 {
        layer.held_index(0).map(|index| layer.keys[index].clone())
    } else {
        None
    };
    layer
        .keys
        .retain(|key| key.frame < frame || key.frame - frame >= count);
    for key in &mut layer.keys {
        if key.frame >= frame {
            key.frame -= count;
        }
    }
    layer.length = layer.length.saturating_sub(count).max(1);
    if layer.key_index(0).is_none() {
        let key = match head {
            Some(mut held) => {
                held.frame = 0;
                held.tween = false;
                held.label = None;
                held
            }
            None => empty_key(0),
        };
        layer.keys.insert(0, key);
    }
}

impl DocStore {
    pub(crate) fn insert_frames(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        count: u32,
    ) -> Result<Document, String> {
        self.edit_named(id, "insert_frames", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            check_count(count)?;
            check_frame(layer, frame)?;
            for key in &mut layer.keys {
                if key.frame >= frame {
                    key.frame += count;
                }
            }
            layer.length += count;
            Ok(())
        })
    }

    pub(crate) fn remove_frames(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        count: u32,
    ) -> Result<Document, String> {
        self.edit_named(id, "remove_frames", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            check_count(count)?;
            check_frame(layer, frame)?;
            remove_range(layer, frame, count);
            Ok(())
        })
    }

    pub(crate) fn copy_frames(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        count: u32,
    ) -> Result<FrameClip, String> {
        let doc = self.get(id)?;
        let scene = doc
            .scenes
            .iter()
            .find(|scene| scene.id == scene_id)
            .ok_or_else(|| "unknown scene".to_string())?;
        let layer = find_layer(&scene.layers, layer_id)
            .filter(|layer| !layer.folder)
            .ok_or_else(|| "unknown layer".to_string())?;
        check_count(count)?;
        check_frame(layer, frame)?;
        Ok(clip_of(layer, frame, count))
    }

    pub(crate) fn paste_frames(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        clip: FrameClip,
    ) -> Result<Document, String> {
        self.edit_named(id, "paste_frames", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            check_clip(&clip)?;
            check_frame(layer, frame)?;
            paste_into(layer, frame, &clip);
            Ok(())
        })
    }

    pub(crate) fn duplicate_frames(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        count: u32,
    ) -> Result<Document, String> {
        self.edit_named(id, "duplicate_frames", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            check_count(count)?;
            check_frame(layer, frame)?;
            let clip = clip_of(layer, frame, count);
            paste_into(layer, frame + count, &clip);
            Ok(())
        })
    }

    pub(crate) fn move_frames(
        &self,
        id: &str,
        scene_id: &str,
        layer_id: &str,
        frame: u32,
        count: u32,
        target: u32,
    ) -> Result<Document, String> {
        self.edit_named(id, "move_frames", |doc| {
            let layer = doc.leaf_mut(scene_id, layer_id)?;
            layer.writable()?;
            check_count(count)?;
            check_frame(layer, frame)?;
            check_frame(layer, target)?;
            if target == frame {
                return Err("target equals source frame".to_string());
            }
            let clip = clip_of(layer, frame, count);
            remove_range(layer, frame, count);
            let at = if target > frame {
                target.saturating_sub(count)
            } else {
                target
            };
            paste_into(layer, at, &clip);
            Ok(())
        })
    }
}

#[tauri::command]
pub fn doc_insert_frames(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    count: u32,
) -> Result<Document, String> {
    store.insert_frames(&id, &scene_id, &layer_id, frame, count)
}

#[tauri::command]
pub fn doc_remove_frames(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    count: u32,
) -> Result<Document, String> {
    store.remove_frames(&id, &scene_id, &layer_id, frame, count)
}

#[tauri::command]
pub fn doc_copy_frames(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    count: u32,
) -> Result<FrameClip, String> {
    store.copy_frames(&id, &scene_id, &layer_id, frame, count)
}

#[tauri::command]
pub fn doc_paste_frames(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    clip: FrameClip,
) -> Result<Document, String> {
    store.paste_frames(&id, &scene_id, &layer_id, frame, clip)
}

#[tauri::command]
pub fn doc_duplicate_frames(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    count: u32,
) -> Result<Document, String> {
    store.duplicate_frames(&id, &scene_id, &layer_id, frame, count)
}

#[tauri::command]
pub fn doc_move_frames(
    store: State<'_, DocStore>,
    id: String,
    scene_id: String,
    layer_id: String,
    frame: u32,
    count: u32,
    target: u32,
) -> Result<Document, String> {
    store.move_frames(&id, &scene_id, &layer_id, frame, count, target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{new_id, Blend, Point, Scene, Shape};
    use std::fs;
    use std::path::PathBuf;

    struct Fixture {
        store: DocStore,
        doc: Document,
        scene: String,
        layer: String,
        dir: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str, keys: Vec<Keyframe>, length: u32) -> Self {
            let layer = Layer {
                id: new_id("l"),
                name: "Layer 1".to_string(),
                visible: true,
                locked: false,
                opacity: 1.0,
                blend: Blend::default(),
                effects: Vec::new(),
                masked: false,
                length,
                keys,
                folder: false,
                children: Vec::new(),
            };
            Self::with_layer(tag, layer)
        }

        fn with_layer(tag: &str, layer: Layer) -> Self {
            let doc = Document {
                id: new_id("d"),
                name: "Test".to_string(),
                width: 800,
                height: 600,
                fps: 24,
                background: "#ffffff".to_string(),
                scenes: vec![Scene {
                    id: new_id("s"),
                    name: "Scene 1".to_string(),
                    layers: vec![layer],
                }],
            };
            let dir = std::env::temp_dir().join(format!("stickmate-frames-{tag}-{}", new_id("t")));
            fs::create_dir_all(&dir).expect("dir");
            let file = serde_json::json!({ "document": doc, "updated_at": 0 });
            fs::write(
                dir.join(format!("{}.json", doc.id)),
                serde_json::to_vec(&file).expect("json"),
            )
            .expect("write");
            let store = DocStore::load(dir.clone());
            let scene = doc.scenes[0].id.clone();
            let layer = doc.scenes[0].layers[0].id.clone();
            Self {
                store,
                doc,
                scene,
                layer,
                dir,
            }
        }

        fn target<'a>(&self, doc: &'a Document) -> &'a Layer {
            &doc.scenes[0].layers[0]
        }

        fn json(&self, doc: &Document) -> String {
            serde_json::to_string(doc).expect("json")
        }

        fn undo_restores(&self, before: &Document) {
            let restored = self.store.undo(&self.doc.id).expect("undo");
            assert_eq!(self.json(&restored), self.json(before));
            assert_eq!(
                self.store.undo(&self.doc.id).unwrap_err(),
                "nothing to undo"
            );
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn key(frame: u32, x: f64) -> Keyframe {
        Keyframe {
            frame,
            shapes: vec![Shape::Stroke {
                points: vec![Point { x, y: 0.0 }, Point { x, y: 10.0 }],
                color: "#000000".to_string(),
                width: 2.0,
            }],
            transform: Transform::default(),
            tween: false,
            easing: Easing::linear(),
            label: None,
        }
    }

    #[test]
    fn insert_shifts_keys_and_extends_length() {
        let fixture = Fixture::new("insert", vec![key(0, 1.0), key(4, 2.0), key(7, 3.0)], 10);
        let edited = fixture
            .store
            .insert_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 4, 3)
            .expect("insert");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 13);
        assert_eq!(
            target.keys.iter().map(|k| k.frame).collect::<Vec<_>>(),
            vec![0, 7, 10]
        );
        fixture.undo_restores(&fixture.doc);
    }

    #[test]
    fn insert_on_existing_key_keeps_that_key() {
        let mut start = key(4, 2.0);
        start.tween = true;
        start.label = Some("walk".to_string());
        let fixture = Fixture::new("insert-key", vec![key(0, 1.0), start], 8);
        let edited = fixture
            .store
            .insert_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 4, 2)
            .expect("insert");
        let target = fixture.target(&edited);
        assert_eq!(target.keys[1].frame, 6);
        assert_eq!(target.keys[1].shapes, fixture.doc.scenes[0].layers[0].keys[1].shapes);
        assert!(target.keys[1].tween);
        assert_eq!(target.keys[1].label.as_deref(), Some("walk"));
        fixture.undo_restores(&fixture.doc);
    }

    #[test]
    fn remove_drops_shifts_and_shrinks() {
        let fixture = Fixture::new(
            "remove",
            vec![key(0, 1.0), key(2, 2.0), key(4, 3.0), key(6, 4.0)],
            8,
        );
        let edited = fixture
            .store
            .remove_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 2, 3)
            .expect("remove");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 5);
        assert_eq!(
            target.keys.iter().map(|k| k.frame).collect::<Vec<_>>(),
            vec![0, 3]
        );
        assert_eq!(target.keys[1].shapes, vec![Shape::Stroke {
            points: vec![Point { x: 4.0, y: 0.0 }, Point { x: 4.0, y: 10.0 }],
            color: "#000000".to_string(),
            width: 2.0,
        }]);
        fixture.undo_restores(&fixture.doc);
    }

    #[test]
    fn remove_clamps_length_and_materializes_frame_zero() {
        let fixture = Fixture::new("remove-zero", vec![key(0, 1.0), key(2, 2.0)], 3);
        let edited = fixture
            .store
            .remove_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 0, 5)
            .expect("remove");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 1);
        assert_eq!(target.keys.len(), 1);
        assert_eq!(target.keys[0].frame, 0);
        assert_eq!(target.keys[0].shapes, fixture.doc.scenes[0].layers[0].keys[0].shapes);
        fixture.undo_restores(&fixture.doc);
    }

    #[test]
    fn remove_keeps_existing_frame_zero_key() {
        let fixture = Fixture::new("remove-keep", vec![key(0, 1.0), key(5, 2.0)], 8);
        let edited = fixture
            .store
            .remove_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 1, 3)
            .expect("remove");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 5);
        assert_eq!(target.keys[0], fixture.doc.scenes[0].layers[0].keys[0]);
        assert_eq!(target.keys[1].frame, 2);
        fixture.undo_restores(&fixture.doc);
    }

    #[test]
    fn copy_mid_hold_synthesizes_offset_zero() {
        let fixture = Fixture::new("copy-hold", vec![key(0, 1.0)], 10);
        let clip = fixture
            .store
            .copy_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 3, 4)
            .expect("copy");
        assert_eq!(clip.span, 4);
        assert_eq!(clip.keys.len(), 1);
        assert_eq!(clip.keys[0].frame, 0);
        assert_eq!(clip.keys[0].shapes, fixture.doc.scenes[0].layers[0].keys[0].shapes);
        assert_eq!(
            fixture.store.undo(&fixture.doc.id).unwrap_err(),
            "nothing to undo"
        );
        assert_eq!(
            fixture.json(&fixture.store.get(&fixture.doc.id).expect("get")),
            fixture.json(&fixture.doc)
        );
    }

    #[test]
    fn copy_preserves_tween_and_label() {
        let mut start = key(0, 1.0);
        start.tween = true;
        start.label = Some("intro".to_string());
        let fixture = Fixture::new("copy-meta", vec![start, key(4, 2.0)], 8);
        let clip = fixture
            .store
            .copy_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 0, 5)
            .expect("copy");
        assert_eq!(clip.keys.len(), 2);
        assert_eq!(clip.keys[0].frame, 0);
        assert!(clip.keys[0].tween);
        assert_eq!(clip.keys[0].label.as_deref(), Some("intro"));
        assert_eq!(clip.keys[1].frame, 4);
    }

    #[test]
    fn paste_shifts_and_extends() {
        let fixture = Fixture::new("paste", vec![key(0, 1.0), key(5, 2.0)], 8);
        let clip = FrameClip {
            span: 3,
            keys: vec![key(0, 9.0), key(2, 8.0)],
        };
        let edited = fixture
            .store
            .paste_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 5, clip)
            .expect("paste");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 11);
        assert_eq!(
            target.keys.iter().map(|k| k.frame).collect::<Vec<_>>(),
            vec![0, 5, 7, 8]
        );
        assert_eq!(target.keys[1].shapes, vec![Shape::Stroke {
            points: vec![Point { x: 9.0, y: 0.0 }, Point { x: 9.0, y: 10.0 }],
            color: "#000000".to_string(),
            width: 2.0,
        }]);
        fixture.undo_restores(&fixture.doc);
    }

    #[test]
    fn paste_rejects_empty_and_invalid_clips() {
        let fixture = Fixture::new("paste-bad", vec![key(0, 1.0)], 8);
        let empty = FrameClip { span: 3, keys: Vec::new() };
        assert_eq!(
            fixture
                .store
                .paste_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 2, empty)
                .unwrap_err(),
            "clipboard is empty"
        );
        let unsorted = FrameClip { span: 4, keys: vec![key(2, 1.0), key(1, 2.0)] };
        assert_eq!(
            fixture
                .store
                .paste_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 2, unsorted)
                .unwrap_err(),
            "clipboard is invalid"
        );
        let duplicate = FrameClip { span: 4, keys: vec![key(1, 1.0), key(1, 2.0)] };
        assert_eq!(
            fixture
                .store
                .paste_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 2, duplicate)
                .unwrap_err(),
            "clipboard is invalid"
        );
        let oversized = FrameClip { span: 2, keys: vec![key(2, 1.0)] };
        assert_eq!(
            fixture
                .store
                .paste_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 2, oversized)
                .unwrap_err(),
            "clipboard is invalid"
        );
        assert_eq!(
            fixture.store.undo(&fixture.doc.id).unwrap_err(),
            "nothing to undo"
        );
    }

    #[test]
    fn duplicate_reproduces_content_in_one_undo() {
        let fixture = Fixture::new("duplicate", vec![key(0, 1.0), key(3, 2.0)], 6);
        let edited = fixture
            .store
            .duplicate_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 0, 3)
            .expect("duplicate");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 9);
        assert_eq!(
            target.keys.iter().map(|k| k.frame).collect::<Vec<_>>(),
            vec![0, 3, 6]
        );
        assert_eq!(target.keys[1].shapes, target.keys[0].shapes);
        assert_eq!(target.keys[2].shapes, fixture.doc.scenes[0].layers[0].keys[1].shapes);
        fixture.undo_restores(&fixture.doc);
    }

    #[test]
    fn duplicate_mid_hold_copies_held_content() {
        let fixture = Fixture::new("duplicate-hold", vec![key(0, 1.0)], 6);
        let edited = fixture
            .store
            .duplicate_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 2, 3)
            .expect("duplicate");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 9);
        assert_eq!(
            target.keys.iter().map(|k| k.frame).collect::<Vec<_>>(),
            vec![0, 5]
        );
        assert_eq!(target.keys[1].shapes, target.keys[0].shapes);
        fixture.undo_restores(&fixture.doc);
    }

    #[test]
    fn move_forward_shifts_both_directions() {
        let fixture = Fixture::new("move-fwd", vec![key(0, 1.0), key(2, 2.0), key(5, 3.0)], 8);
        let edited = fixture
            .store
            .move_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 2, 2, 6)
            .expect("move");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 8);
        assert_eq!(
            target.keys.iter().map(|k| k.frame).collect::<Vec<_>>(),
            vec![0, 3, 4]
        );
        assert_eq!(target.keys[1].shapes, fixture.doc.scenes[0].layers[0].keys[2].shapes);
        assert_eq!(target.keys[2].shapes, fixture.doc.scenes[0].layers[0].keys[1].shapes);
        fixture.undo_restores(&fixture.doc);
    }

    #[test]
    fn move_backward_lands_at_target() {
        let fixture = Fixture::new("move-back", vec![key(0, 1.0), key(2, 2.0), key(5, 3.0)], 8);
        let edited = fixture
            .store
            .move_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 5, 2, 1)
            .expect("move");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 8);
        assert_eq!(
            target.keys.iter().map(|k| k.frame).collect::<Vec<_>>(),
            vec![0, 1, 4]
        );
        assert_eq!(target.keys[1].shapes, fixture.doc.scenes[0].layers[0].keys[2].shapes);
        fixture.undo_restores(&fixture.doc);
    }

    #[test]
    fn move_onto_overlapping_range_keeps_keys_unique() {
        let fixture = Fixture::new(
            "move-overlap",
            vec![key(0, 1.0), key(2, 2.0), key(4, 3.0), key(6, 4.0)],
            10,
        );
        let edited = fixture
            .store
            .move_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 2, 3, 4)
            .expect("move");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 10);
        let frames: Vec<u32> = target.keys.iter().map(|k| k.frame).collect();
        assert_eq!(frames, vec![0, 1, 3, 6]);
        let mut sorted = frames.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), frames.len());
        fixture.undo_restores(&fixture.doc);
    }

    #[test]
    fn move_rejects_same_target_without_undo() {
        let fixture = Fixture::new("move-same", vec![key(0, 1.0), key(2, 2.0)], 6);
        assert_eq!(
            fixture
                .store
                .move_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 2, 2, 2)
                .unwrap_err(),
            "target equals source frame"
        );
        assert_eq!(
            fixture.store.undo(&fixture.doc.id).unwrap_err(),
            "nothing to undo"
        );
    }

    #[test]
    fn locked_layer_rejects_every_mutation() {
        let layer = Layer {
            id: new_id("l"),
            name: "Layer 1".to_string(),
            visible: true,
            locked: true,
            opacity: 1.0,
            blend: Blend::default(),
            effects: Vec::new(),
            masked: false,
            length: 8,
            keys: vec![key(0, 1.0), key(4, 2.0)],
            folder: false,
            children: Vec::new(),
        };
        let fixture = Fixture::with_layer("locked", layer);
        let id = &fixture.doc.id;
        let s = &fixture.scene;
        let l = &fixture.layer;
        assert_eq!(fixture.store.insert_frames(id, s, l, 1, 2).unwrap_err(), "layer is locked");
        assert_eq!(fixture.store.remove_frames(id, s, l, 1, 2).unwrap_err(), "layer is locked");
        assert_eq!(
            fixture
                .store
                .paste_frames(id, s, l, 1, FrameClip { span: 1, keys: vec![key(0, 9.0)] })
                .unwrap_err(),
            "layer is locked"
        );
        assert_eq!(fixture.store.duplicate_frames(id, s, l, 1, 2).unwrap_err(), "layer is locked");
        assert_eq!(fixture.store.move_frames(id, s, l, 1, 2, 4).unwrap_err(), "layer is locked");
        assert_eq!(
            fixture.json(&fixture.store.get(id).expect("get")),
            fixture.json(&fixture.doc)
        );
        assert_eq!(fixture.store.undo(id).unwrap_err(), "nothing to undo");
    }

    #[test]
    fn count_bounds_are_enforced() {
        let fixture = Fixture::new("counts", vec![key(0, 1.0)], 8);
        let id = &fixture.doc.id;
        let s = &fixture.scene;
        let l = &fixture.layer;
        let message = "frame count must be between 1 and 1000";
        assert_eq!(fixture.store.insert_frames(id, s, l, 0, 0).unwrap_err(), message);
        assert_eq!(fixture.store.insert_frames(id, s, l, 0, 1001).unwrap_err(), message);
        assert_eq!(fixture.store.remove_frames(id, s, l, 0, 0).unwrap_err(), message);
        assert_eq!(fixture.store.copy_frames(id, s, l, 0, 1001).unwrap_err(), message);
        assert_eq!(fixture.store.duplicate_frames(id, s, l, 0, 0).unwrap_err(), message);
        assert_eq!(fixture.store.move_frames(id, s, l, 0, 1001, 2).unwrap_err(), message);
        assert_eq!(
            fixture
                .store
                .paste_frames(id, s, l, 0, FrameClip { span: 0, keys: vec![key(0, 1.0)] })
                .unwrap_err(),
            message
        );
        assert_eq!(fixture.store.undo(id).unwrap_err(), "nothing to undo");
    }

    #[test]
    fn unknown_ids_are_rejected() {
        let fixture = Fixture::new("unknown", vec![key(0, 1.0)], 8);
        let id = &fixture.doc.id;
        assert_eq!(
            fixture.store.insert_frames(id, "missing", &fixture.layer, 0, 1).unwrap_err(),
            "unknown scene"
        );
        assert_eq!(
            fixture.store.insert_frames(id, &fixture.scene, "missing", 0, 1).unwrap_err(),
            "unknown layer"
        );
        assert_eq!(
            fixture.store.copy_frames(id, "missing", &fixture.layer, 0, 1).unwrap_err(),
            "unknown scene"
        );
        assert_eq!(
            fixture.store.copy_frames(id, &fixture.scene, "missing", 0, 1).unwrap_err(),
            "unknown layer"
        );
        assert_eq!(
            fixture.store.move_frames("missing", &fixture.scene, &fixture.layer, 0, 1, 2).unwrap_err(),
            "unknown document"
        );
    }

    #[test]
    fn frames_outside_the_layer_are_rejected() {
        let fixture = Fixture::new("bounds", vec![key(0, 1.0)], 5);
        let id = &fixture.doc.id;
        let s = &fixture.scene;
        let l = &fixture.layer;
        assert_eq!(fixture.store.insert_frames(id, s, l, 5, 1).unwrap_err(), "frame is out of range");
        assert_eq!(fixture.store.remove_frames(id, s, l, 5, 1).unwrap_err(), "frame is out of range");
        assert_eq!(fixture.store.copy_frames(id, s, l, 5, 1).unwrap_err(), "frame is out of range");
        assert_eq!(fixture.store.duplicate_frames(id, s, l, 5, 1).unwrap_err(), "frame is out of range");
        assert_eq!(fixture.store.move_frames(id, s, l, 0, 1, 5).unwrap_err(), "frame is out of range");
        assert_eq!(
            fixture
                .store
                .paste_frames(id, s, l, 5, FrameClip { span: 1, keys: vec![key(0, 1.0)] })
                .unwrap_err(),
            "frame is out of range"
        );
    }

    #[test]
    fn paste_at_zero_without_offset_key_keeps_frame_zero() {
        let fixture = Fixture::new("paste-zero", vec![key(0, 1.0)], 8);
        let clip = FrameClip { span: 2, keys: vec![key(1, 9.0)] };
        let edited = fixture
            .store
            .paste_frames(&fixture.doc.id, &fixture.scene, &fixture.layer, 0, clip)
            .expect("paste");
        let target = fixture.target(&edited);
        assert_eq!(target.length, 10);
        assert_eq!(
            target.keys.iter().map(|k| k.frame).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert!(target.keys[0].shapes.is_empty());
        fixture.undo_restores(&fixture.doc);
    }

    #[test]
    fn frame_operations_are_named_steps() {
        let fixture = Fixture::new("named", vec![key(0, 1.0), key(4, 2.0), key(7, 3.0)], 10);
        let id = &fixture.doc.id;
        let s = &fixture.scene;
        let l = &fixture.layer;
        let current_name = |store: &DocStore| {
            let steps = store.history(id).expect("history");
            steps.last().expect("step").name.clone()
        };
        fixture
            .store
            .insert_frames(id, s, l, 2, 2)
            .expect("insert");
        assert_eq!(current_name(&fixture.store), "insert_frames");
        fixture
            .store
            .remove_frames(id, s, l, 2, 2)
            .expect("remove");
        assert_eq!(current_name(&fixture.store), "remove_frames");
        fixture
            .store
            .paste_frames(id, s, l, 1, FrameClip { span: 2, keys: vec![key(0, 9.0)] })
            .expect("paste");
        assert_eq!(current_name(&fixture.store), "paste_frames");
        fixture
            .store
            .duplicate_frames(id, s, l, 0, 2)
            .expect("duplicate");
        assert_eq!(current_name(&fixture.store), "duplicate_frames");
        fixture
            .store
            .move_frames(id, s, l, 0, 2, 5)
            .expect("move");
        assert_eq!(current_name(&fixture.store), "move_frames");
        let steps = fixture.store.history(id).expect("history");
        assert_eq!(
            steps.iter().map(|step| step.name.as_str()).collect::<Vec<_>>(),
            vec![
                "recovered_document",
                "insert_frames",
                "remove_frames",
                "paste_frames",
                "duplicate_frames",
                "move_frames"
            ]
        );
    }
}