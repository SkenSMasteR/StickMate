use std::collections::{HashMap, HashSet};

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use quick_xml::XmlVersion;

use crate::document::{
    apply_affine, new_id, Affine, Blend, Document, Easing, Keyframe, Layer, LoopMode, Point,
    Scene, Shape, Symbol, SymbolKind, TextAlign, Transform,
};
use crate::path::PathNode;
use crate::xfl;

const PROJECT_LIMIT: usize = 8 * 1024 * 1024;
const ELEMENT_LIMIT: usize = 300_000;
const SYMBOL_LIMIT: usize = 20_000;
const STAGE_LIMIT: u32 = 8192;
const TWIPS: f64 = 20.0;
const KEY_PLAIN: &str = "9728";
const KEY_MOTION: &str = "22017";
const KEY_SHAPE: &str = "17922";
const EASE_IN: Easing = Easing {
    x1: 0.42,
    y1: 0.0,
    x2: 1.0,
    y2: 1.0,
};
const EASE_OUT: Easing = Easing {
    x1: 0.0,
    y1: 0.0,
    x2: 0.58,
    y2: 1.0,
};
const EASE_IN_OUT: Easing = Easing {
    x1: 0.42,
    y1: 0.0,
    x2: 0.58,
    y2: 1.0,
};

#[derive(Debug)]
pub struct Import {
    pub doc: Document,
    pub notes: Vec<String>,
}

struct Element {
    name: String,
    attrs: Vec<(String, String)>,
    text: String,
    children: Vec<Element>,
}

struct Run {
    style: Option<usize>,
    nodes: Vec<PathNode>,
}

#[derive(Clone, Copy)]
enum Token {
    Marker(char),
    Number(f64),
}

struct EdgeRef<'a> {
    edge: &'a Element,
    group: Option<&'a Element>,
}

struct BitmapSource {
    href: String,
}

struct Media<'a> {
    items: HashMap<String, BitmapSource>,
    library: HashMap<String, String>,
    members: &'a [(String, Vec<u8>)],
}

impl Media<'_> {
    fn read(&self, name: &str) -> Option<Vec<u8>> {
        let href = self.items.get(name)?.href.as_str();
        if href.is_empty() {
            return None;
        }
        self.file(href)
    }

    fn file(&self, href: &str) -> Option<Vec<u8>> {
        crate::fla::member_bytes(self.members, &format!("{}{href}", xfl::LIBRARY_FOLDER))
    }
}

fn media_of<'a>(root: &Element, members: &'a [(String, Vec<u8>)]) -> Media<'a> {
    let mut items = HashMap::new();
    for holder in named(root, "media") {
        for item in named(holder, "DOMBitmapItem") {
            let Some(name) = item.attr("name").filter(|name| !name.is_empty()) else {
                continue;
            };
            items.insert(
                name.to_string(),
                BitmapSource {
                    href: item.attr("href").unwrap_or_default().to_string(),
                },
            );
        }
    }
    Media {
        items,
        library: HashMap::new(),
        members,
    }
}

struct Entry {
    id: String,
    href: String,
    stem: String,
}

fn entries_of(root: &Element) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    let Some(holder) = child(root, "symbols") else {
        return out;
    };
    for include in named(holder, "Include") {
        let Some(href) = include
            .attr("href")
            .filter(|value| value.ends_with(".xml") && !value.ends_with("/"))
        else {
            continue;
        };
        let stem = href.trim_end_matches(".xml").to_string();
        let id = match include.attr("itemID").filter(|value| !value.is_empty()) {
            Some(value) if !out.iter().any(|entry| entry.id == value) => value.to_string(),
            _ => new_id("y"),
        };
        out.push(Entry { id, href: href.to_string(), stem });
    }
    out
}

fn library_of(root: &Element, media: &mut Media, notes: &mut Notes) -> Vec<Symbol> {
    let entries = entries_of(root);
    let keep = SYMBOL_LIMIT.min(entries.len());
    notes.library += entries.len() - keep;
    for entry in entries.iter().take(keep) {
        media.library.insert(entry.stem.clone(), entry.id.clone());
    }
    let mut out = Vec::new();
    for entry in entries.iter().take(keep) {
        match symbol(&entry.id, &entry.stem, media.file(&entry.href), media, notes) {
            Some(symbol) => {
                media.library.insert(symbol.name.clone(), symbol.id.clone());
                out.push(symbol);
            }
            None => notes.library += 1,
        }
    }
    let landed: HashSet<String> = out.iter().map(|symbol| symbol.id.clone()).collect();
    media.library.retain(|_, id| landed.contains(id));
    out
}

fn symbol(
    id: &str,
    stem: &str,
    raw: Option<Vec<u8>>,
    media: &Media,
    notes: &mut Notes,
) -> Option<Symbol> {
    let text = String::from_utf8(raw?).ok()?;
    if text.len() > PROJECT_LIMIT {
        return None;
    }
    let root = build(&text).ok()?;
    if root.name != "DOMSymbolItem" {
        return None;
    }
    let layers = child(&root, "timeline")
        .and_then(|timeline| child(timeline, "DOMTimeline"))
        .and_then(|timeline| child(timeline, "layers"))
        .map(|holder| scene_layers(holder, media, notes))
        .unwrap_or_default();
    Some(Symbol {
        id: id.to_string(),
        name: root.attr("name").unwrap_or(stem).to_string(),
        kind: symbol_kind(root.attr("symbolType")),
        layers,
    })
}

fn symbol_kind(value: Option<&str>) -> SymbolKind {
    match value
        .unwrap_or_default()
        .replace(' ', "")
        .to_ascii_lowercase()
        .as_str()
    {
        "movieclip" | "clip" => SymbolKind::MovieClip,
        "button" => SymbolKind::Button,
        _ => SymbolKind::Graphic,
    }
}

fn loop_mode(value: Option<&str>) -> LoopMode {
    match value
        .unwrap_or_default()
        .replace(' ', "")
        .to_ascii_lowercase()
        .as_str()
    {
        "loop" => LoopMode::Loop,
        "playonce" => LoopMode::PlayOnce,
        _ => LoopMode::SingleFrame,
    }
}

fn instance(el: &Element, media: &Media) -> Option<Shape> {
    let id = media.library.get(el.attr("libraryItemName")?)?;
    let mut place = matrix(el);
    if el.flag("FlipX", false) {
        place.a = -place.a;
        place.c = -place.c;
    }
    if el.flag("FlipY", false) {
        place.b = -place.b;
        place.d = -place.d;
    }
    Some(Shape::Instance {
        symbol: id.clone(),
        name: el.attr("name").unwrap_or_default().to_string(),
        matrix: (place != Affine::default()).then_some(place),
        visible: el.flag("isVisible", true),
        first_frame: el.number("firstFrame", 0.0).max(0.0) as u32,
        looping: loop_mode(el.attr("loop")),
    })
}

#[derive(Default)]
struct Notes {
    fps: Option<u32>,
    stage: bool,
    gradient: bool,
    symbols: usize,
    library: usize,
    bitmaps: usize,
    unread: usize,
    sounds: usize,
    filters: usize,
    masks: usize,
    blend: usize,
    guides: usize,
    types: usize,
    camera: usize,
    morphs: usize,
    easing: usize,
    brush: usize,
    broken: usize,
}

impl Notes {
    fn messages(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(fps) = self.fps {
            out.push(format!(
                "the frame rate was changed to {fps} to fit the app range"
            ));
        }
        if self.stage {
            out.push("the stage size was reduced to fit the app range".to_string());
        }
        if self.gradient {
            out.push("gradient fills were imported as flat colours".to_string());
        }
        said(
            &mut out,
            self.symbols,
            "symbol instance was skipped",
            "symbol instances were skipped",
        );
        said(
            &mut out,
            self.library,
            "library symbol was not imported",
            "library symbols were not imported",
        );
        said(
            &mut out,
            self.bitmaps,
            "bitmap fill was skipped",
            "bitmap fills were skipped",
        );
        said(
            &mut out,
            self.unread,
            "placed image that could not be read is skipped",
            "placed images that could not be read are skipped",
        );
        said(
            &mut out,
            self.sounds,
            "frame sound was skipped",
            "frame sounds were skipped",
        );
        said(
            &mut out,
            self.filters,
            "layer filter was skipped",
            "layer filters were skipped",
        );
        said(
            &mut out,
            self.masks,
            "mask layer was imported as a plain layer",
            "mask layers were imported as plain layers",
        );
        said(
            &mut out,
            self.blend,
            "blend mode was imported as normal",
            "blend modes were imported as normal",
        );
        said(
            &mut out,
            self.guides,
            "guide layer was skipped",
            "guide layers were skipped",
        );
        said(
            &mut out,
            self.types,
            "layer type was imported as a normal layer",
            "layer types were imported as normal layers",
        );
        said(
            &mut out,
            self.camera,
            "camera layer was skipped",
            "camera layers were skipped",
        );
        said(
            &mut out,
            self.morphs,
            "shape tween was imported as a keyframe",
            "shape tweens were imported as keyframes",
        );
        said(
            &mut out,
            self.easing,
            "custom easing curve was imported as linear",
            "custom easing curves were imported as linear",
        );
        said(
            &mut out,
            self.brush,
            "brush stroke was imported as a plain stroke",
            "brush strokes were imported as plain strokes",
        );
        said(
            &mut out,
            self.broken,
            "shape used edge markup that could not be decoded",
            "shapes used edge markup that could not be decoded",
        );
        out
    }
}

fn said(out: &mut Vec<String>, value: usize, one: &str, many: &str) {
    if value > 0 {
        out.push(format!("{value} {}", if value == 1 { one } else { many }));
    }
}

pub fn parse(
    xml: &str,
    name: &str,
    members: &[(String, Vec<u8>)],
) -> Result<Import, String> {
    if xml.len() > PROJECT_LIMIT {
        return Err("the .xfl document is too large".to_string());
    }
    let invalid = "the .xfl document is not valid xml".to_string();
    let root = build(xml)?;
    if root.name != "DOMDocument" {
        return Err(invalid);
    }
    let mut notes = Notes::default();
    let mut media = media_of(&root, members);
    let symbols = library_of(&root, &mut media, &mut notes);
    let doc = document(&root, name, &media, &mut notes, symbols);
    let ids: HashSet<String> = doc.symbols.iter().map(|symbol| symbol.id.clone()).collect();
    for scene in &doc.scenes {
        strays(&scene.layers, &ids, &mut notes);
    }
    for symbol in &doc.symbols {
        strays(&symbol.layers, &ids, &mut notes);
    }
    Ok(Import {
        doc,
        notes: notes.messages(),
    })
}

fn strays(layers: &[Layer], ids: &HashSet<String>, notes: &mut Notes) {
    for layer in layers {
        for key in &layer.keys {
            stray_shapes(&key.shapes, ids, notes);
        }
        strays(&layer.children, ids, notes);
    }
}

fn stray_shapes(shapes: &[Shape], ids: &HashSet<String>, notes: &mut Notes) {
    for shape in shapes {
        match shape {
            Shape::Instance { symbol, .. } => {
                if !ids.contains(symbol) {
                    notes.symbols += 1;
                }
            }
            Shape::Group { children } => stray_shapes(children, ids, notes),
            _ => {}
        }
    }
}

fn build(xml: &str) -> Result<Element, String> {
    let invalid = "the .xfl document is not valid xml".to_string();
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<Element> = Vec::new();
    let mut root: Option<Element> = None;
    let mut opened = 0usize;
    loop {
        let event = reader
            .read_event()
            .map_err(|error| format!("the .xfl document is not valid xml: {error}"))?;
        match event {
            Event::Start(start) => {
                opened += 1;
                if opened > ELEMENT_LIMIT {
                    return Err("the .xfl document is too large".to_string());
                }
                stack.push(element(start.local_name().as_ref(), &start));
            }
            Event::Empty(start) => {
                opened += 1;
                if opened > ELEMENT_LIMIT {
                    return Err("the .xfl document is too large".to_string());
                }
                let item = element(start.local_name().as_ref(), &start);
                place(&mut stack, &mut root, item);
            }
            Event::End(end) => {
                let name = end.local_name();
                let closing = name.as_ref();
                match stack.pop() {
                    Some(done) if done.name == closing => place(&mut stack, &mut root, done),
                    Some(_) => {
                        return Err(format!(
                            "the .xfl document is not valid xml: </{closing}> does not match the open tag"
                        ))
                    }
                    None => return Err(invalid),
                }
            }
            Event::Text(value) => {
                let raw = value.into_inner();
                if !(raw.trim().is_empty() && raw.contains(['\n', '\r'])) {
                    push_text(&mut stack, &raw);
                }
            }
            Event::CData(value) => push_text(&mut stack, &value.into_inner()),
            Event::GeneralRef(value) => {
                push_text(&mut stack, &reference(value.into_inner().as_ref()))
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err(invalid);
    }
    root.ok_or(invalid)
}

fn element(name: &str, start: &BytesStart<'_>) -> Element {
    Element {
        name: name.to_string(),
        attrs: attributes(start),
        text: String::new(),
        children: Vec::new(),
    }
}

fn place(stack: &mut Vec<Element>, root: &mut Option<Element>, item: Element) {
    match stack.last_mut() {
        Some(parent) => parent.children.push(item),
        None => {
            if root.is_none() {
                *root = Some(item);
            }
        }
    }
}

fn push_text(stack: &mut Vec<Element>, value: &str) {
    if let Some(top) = stack.last_mut() {
        top.text.push_str(value);
    }
}

fn attributes(start: &BytesStart<'_>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for item in start.attributes() {
        if let Ok(attr) = item {
            let key = attr.key.local_name().as_ref().to_string();
            let value = match attr.normalized_value(XmlVersion::Implicit1_0) {
                Ok(value) => value.into_owned(),
                Err(_) => attr.value.into_owned(),
            };
            out.push((key, value));
        }
    }
    out
}

fn reference(value: &str) -> String {
    let hex = value
        .strip_prefix("#x")
        .or_else(|| value.strip_prefix("#X"))
        .and_then(|text| u32::from_str_radix(text, 16).ok());
    let code = match hex {
        Some(code) => Some(code),
        None => value.strip_prefix('#').and_then(|text| text.parse::<u32>().ok()),
    };
    if let Some(code) = code {
        return char::from_u32(code).map_or(String::new(), |ch| ch.to_string());
    }
    match value {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        _ => "",
    }
    .to_string()
}

impl Element {
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    fn number(&self, key: &str, default: f64) -> f64 {
        match self.attr(key).map(str::trim) {
            Some(value) if !value.is_empty() => value
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .unwrap_or(default),
            _ => default,
        }
    }

    fn flag(&self, key: &str, default: bool) -> bool {
        match self.attr(key) {
            Some(value) => value == "true",
            None => default,
        }
    }
}

fn child<'a>(el: &'a Element, name: &str) -> Option<&'a Element> {
    el.children.iter().find(|item| item.name == name)
}

fn named<'a>(el: &'a Element, name: &str) -> Vec<&'a Element> {
    el.children
        .iter()
        .filter(|item| item.name == name)
        .collect()
}

fn document(
    root: &Element,
    name: &str,
    media: &Media,
    notes: &mut Notes,
    symbols: Vec<Symbol>,
) -> Document {
    let mut scenes = Vec::new();
    if let Some(holder) = child(root, "timelines") {
        for timeline in named(holder, "DOMTimeline") {
            scenes.push(scene(timeline, scenes.len() + 1, media, notes));
        }
    }
    if scenes.is_empty() {
        scenes.push(Scene {
            id: new_id("s"),
            name: "Scene 1".to_string(),
            layers: vec![blank_layer("Layer 1")],
        });
    }
    Document {
        id: new_id("d"),
        name: name.to_string(),
        width: stage(root, "width", notes),
        height: stage(root, "height", notes),
        fps: frame_rate(root, notes),
        background: background(root),
        scenes,
        symbols,
    }
}

fn stage(root: &Element, key: &str, notes: &mut Notes) -> u32 {
    let value = root.number(key, 1.0).round().max(1.0);
    if value > STAGE_LIMIT as f64 {
        notes.stage = true;
        return STAGE_LIMIT;
    }
    value as u32
}

fn frame_rate(root: &Element, notes: &mut Notes) -> u32 {
    let value = root.number("frameRate", 24.0);
    let fps = value.round().clamp(1.0, 120.0) as u32;
    if (value - f64::from(fps)).abs() > 0.0001 {
        notes.fps = Some(fps);
    }
    fps
}

fn background(root: &Element) -> String {
    match root.attr("backgroundColor") {
        Some(value) => xfl::color_alpha(value).0,
        None => "#ffffff".to_string(),
    }
}

fn scene(timeline: &Element, index: usize, media: &Media, notes: &mut Notes) -> Scene {
    let mut layers = Vec::new();
    if let Some(holder) = child(timeline, "layers") {
        layers = scene_layers(holder, media, notes);
    }
    if layers.is_empty() {
        layers.push(blank_layer("Layer 1"));
    }
    let fallback = format!("Scene {index}");
    Scene {
        id: new_id("s"),
        name: timeline
            .attr("name")
            .unwrap_or(fallback.as_str())
            .to_string(),
        layers,
    }
}

fn blank_key(frame: u32) -> Keyframe {
    Keyframe {
        frame,
        shapes: Vec::new(),
        transform: Transform::default(),
        tween: false,
        easing: Easing::linear(),
        label: None,
    }
}

fn blank_layer(name: &str) -> Layer {
    Layer {
        id: new_id("l"),
        name: name.to_string(),
        visible: true,
        locked: false,
        opacity: 1.0,
        blend: Blend::Normal,
        effects: Vec::new(),
        masked: false,
        length: 1,
        keys: vec![blank_key(0)],
        folder: false,
        children: Vec::new(),
    }
}

struct Parsed {
    layer: Layer,
    parent: Option<usize>,
    mask: bool,
    masked: bool,
}

fn collect_layers(holder: &Element, media: &Media, notes: &mut Notes) -> Vec<Option<Parsed>> {
    let mut out = Vec::new();
    for item in &holder.children {
        match item.name.as_str() {
            "layers" => out.extend(collect_layers(item, media, notes)),
            "DOMLayer" => out.push(parsed(item, media, notes)),
            _ => {}
        }
    }
    out
}

fn scene_layers(holder: &Element, media: &Media, notes: &mut Notes) -> Vec<Layer> {
    let slots = collect_layers(holder, media, notes);
    let members: Vec<usize> = (0..slots.len()).filter(|index| slots[*index].is_some()).collect();
    let clipped = mask_groups(&slots, &members, notes);
    let mut kids: Vec<Vec<usize>> = vec![Vec::new(); slots.len()];
    let mut placed = vec![false; slots.len()];
    for index in members.iter().copied() {
        if let Some(at) = folder_parent(&slots, index) {
            placed[index] = true;
            kids[at].push(index);
        }
    }
    let roots: Vec<usize> = members.iter().copied().filter(|index| !placed[*index]).collect();
    assembled(&slots, &kids, &clipped, &roots, notes)
}

fn folder_parent(slots: &[Option<Parsed>], index: usize) -> Option<usize> {
    let at = slots[index].as_ref()?.parent?;
    if at >= index {
        return None;
    }
    slots[at].as_ref().filter(|entry| entry.layer.folder).map(|_| at)
}

fn mask_groups(slots: &[Option<Parsed>], members: &[usize], notes: &mut Notes) -> Vec<usize> {
    let mut out = vec![usize::MAX; slots.len()];
    let provider = |at: usize| {
        slots
            .get(at)
            .map_or(false, |entry| entry.as_ref().is_some_and(|parsed| parsed.mask))
    };
    for (position, index) in members.iter().copied().enumerate() {
        let Some(entry) = slots[index].as_ref() else {
            continue;
        };
        if entry.mask {
            continue;
        }
        let above = if position == 0 {
            None
        } else {
            Some(members[position - 1])
        };
        let claimed = above.filter(|at| provider(*at) && out[*at] == usize::MAX);
        let at = entry
            .parent
            .filter(|value| *value < index && provider(*value))
            .or(claimed);
        match at {
            Some(at) if out[at] == usize::MAX => out[at] = index,
            Some(_) => notes.masks += 1,
            None if entry.masked => notes.masks += 1,
            None => {}
        }
    }
    for index in members {
        if provider(*index) && out[*index] == usize::MAX {
            notes.masks += 1;
        }
    }
    out
}

fn assembled(
    slots: &[Option<Parsed>],
    kids: &[Vec<usize>],
    clipped: &[usize],
    members: &[usize],
    notes: &mut Notes,
) -> Vec<Layer> {
    let mut out = Vec::new();
    for (position, index) in members.iter().enumerate() {
        let Some(entry) = slots[*index].as_ref() else {
            continue;
        };
        let mut layer = entry.layer.clone();
        if layer.folder {
            layer.children = assembled(slots, kids, clipped, &kids[*index], notes);
            out.push(layer);
            continue;
        }
        layer.masked = position > 0 && clipped[members[position - 1]] == *index;
        out.push(layer);
    }
    out
}

fn parsed(el: &Element, media: &Media, notes: &mut Notes) -> Option<Parsed> {
    let kind = el
        .attr("layerType")
        .or_else(|| el.attr("type"))
        .unwrap_or("normal")
        .to_ascii_lowercase()
        .replace(' ', "");
    let parent = usize::try_from(el.number("parentLayerIndex", -1.0) as i64).ok();
    let mask = kind == "mask";
    let masked = kind == "masked" || el.flag("masked", false);
    if kind == "camera" {
        notes.camera += 1;
        return None;
    }
    if matches!(kind.as_str(), "guide" | "motionguide" | "guidedlayer") || el.flag("guide", false) {
        notes.guides += 1;
        return None;
    }
    if !matches!(kind.as_str(), "normal" | "mask" | "masked" | "folder") {
        notes.types += 1;
    }
    if kind == "folder" {
        return Some(Parsed {
            layer: Layer {
                id: new_id("l"),
                name: el.attr("name").unwrap_or("Folder").to_string(),
                visible: el.flag("visible", true),
                locked: el.flag("locked", false),
                opacity: 1.0,
                blend: Blend::Normal,
                effects: Vec::new(),
                masked: false,
                length: 1,
                keys: Vec::new(),
                folder: true,
                children: Vec::new(),
            },
            parent,
            mask: false,
            masked: false,
        });
    }
    if matches!(el.attr("blendMode"), Some(value) if value != "normal") {
        notes.blend += 1;
    }
    if child(el, "filters").is_some() {
        notes.filters += 1;
    }
    let mut keys = Vec::new();
    let mut length = 0u32;
    if let Some(holder) = child(el, "frames") {
        let (frames, frames_length) = frames(holder, media, notes);
        keys = frames;
        length = frames_length;
    }
    if keys.first().map_or(true, |key| key.frame > 0) {
        keys.insert(0, blank_key(0));
    }
    let last = keys.last().map_or(0, |key| key.frame);
    length = length.max(last.saturating_add(1)).max(1);
    Some(Parsed {
        layer: Layer {
            id: new_id("l"),
            name: el.attr("name").unwrap_or("Layer").to_string(),
            visible: el.flag("visible", true),
            locked: el.flag("locked", false),
            opacity: 1.0,
            blend: Blend::Normal,
            effects: Vec::new(),
            masked: false,
            length,
            keys,
            folder: false,
            children: Vec::new(),
        },
        parent,
        mask,
        masked,
    })
}

fn frames(holder: &Element, media: &Media, notes: &mut Notes) -> (Vec<Keyframe>, u32) {
    let mut keys: Vec<Keyframe> = Vec::new();
    let mut length = 0u32;
    let mut cursor = 0u32;
    for frame in named(holder, "DOMFrame") {
        let index = frame.number("index", f64::from(cursor)).round().max(0.0);
        let duration = frame.number("duration", 1.0).round().max(1.0);
        let index = index.min(u32::MAX as f64) as u32;
        cursor = index.saturating_add(duration.min(u32::MAX as f64) as u32);
        length = length.max(cursor);
        if frame.attr("soundName").is_some() || child(frame, "SoundEnvelope").is_some() {
            notes.sounds += 1;
        }
        if child(frame, "filters").is_some() {
            notes.filters += 1;
        }
        let mut shapes = Vec::new();
        for items in named(frame, "elements") {
            shapes.extend(elements(items, media, notes));
        }
        let mode = frame.attr("keyMode").unwrap_or("");
        let kind = frame.attr("tweenType").unwrap_or("none");
        let motion = kind == "motion" || mode == KEY_MOTION;
        let morph = kind == "shape" || mode == KEY_SHAPE;
        let classic = !kind.is_empty() && kind != "none";
        if mode != KEY_PLAIN && !motion && !morph && shapes.is_empty() {
            continue;
        }
        if keys.iter().any(|key| key.frame == index) {
            continue;
        }
        if morph {
            notes.morphs += 1;
        }
        keys.push(Keyframe {
            frame: index,
            shapes,
            transform: Transform::default(),
            tween: motion || morph || classic,
            easing: easing(frame, notes),
            label: child(frame, "FrameLabel")
                .and_then(|label| label.attr("name"))
                .map(|label| label.to_string()),
        });
    }
    keys.sort_by_key(|key| key.frame);
    (keys, length)
}

fn easing(frame: &Element, notes: &mut Notes) -> Easing {
    let method = child(frame, "tweens")
        .and_then(|tweens| child(tweens, "Ease"))
        .and_then(|ease| ease.attr("method"))
        .or_else(|| frame.attr("easeMethodName"));
    match method.map(preset) {
        Some(Some(value)) => value,
        Some(None) => {
            notes.easing += 1;
            Easing::linear()
        }
        None => Easing::linear(),
    }
}

fn preset(method: &str) -> Option<Easing> {
    if method.ends_with("InOut") {
        return Some(EASE_IN_OUT);
    }
    if method.ends_with("In") {
        return Some(EASE_IN);
    }
    if method.ends_with("Out") {
        return Some(EASE_OUT);
    }
    match method.to_ascii_lowercase().as_str() {
        "linear" | "none" => Some(Easing::linear()),
        _ => None,
    }
}

fn elements(holder: &Element, media: &Media, notes: &mut Notes) -> Vec<Shape> {
    let mut out = Vec::new();
    for item in &holder.children {
        match item.name.as_str() {
            "DOMShape" => out.extend(shape(item, notes)),
            "DOMStaticText" | "DOMDynamicText" | "DOMInputText" => out.extend(text(item)),
            "DOMBitmapInstance" => match bitmap(item, media) {
                Some(shape) => out.push(shape),
                None => notes.unread += 1,
            },
            "DOMSymbolInstance" | "DOMInstance" => match instance(item, media) {
                Some(shape) => out.push(shape),
                None => notes.symbols += 1,
            },
            "DOMElement" => out.extend(elements(item, media, notes)),
            _ => {}
        }
    }
    out
}

fn bitmap(el: &Element, media: &Media) -> Option<Shape> {
    let bytes = media.read(el.attr("libraryItemName")?)?;
    let info = crate::media::inspect(&bytes).ok()?;
    let place = matrix(el);
    let width = info.width as f64;
    let height = info.height as f64;
    let stretched = (width * place.a, height * place.d);
    if place.b == 0.0 && place.c == 0.0 && is_box(stretched.0, stretched.1) {
        return Some(Shape::Bitmap {
            x: place.e,
            y: place.f,
            w: stretched.0,
            h: stretched.1,
            source: info.source,
            matrix: None,
        });
    }
    Some(Shape::Bitmap {
        x: 0.0,
        y: 0.0,
        w: width,
        h: height,
        source: info.source,
        matrix: Some(place),
    })
}

fn is_box(w: f64, h: f64) -> bool {
    w > 0.0 && h > 0.0 && w <= 16384.0 && h <= 16384.0
}

fn matrix(el: &Element) -> Affine {
    match child(el, "matrix").and_then(|holder| child(holder, "Matrix")) {
        Some(value) => Affine {
            a: value.number("a", 1.0),
            b: value.number("b", 0.0),
            c: value.number("c", 0.0),
            d: value.number("d", 1.0),
            e: value.number("tx", 0.0),
            f: value.number("ty", 0.0),
        },
        None => Affine {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 0.0,
            f: 0.0,
        },
    }
}

fn shape(el: &Element, notes: &mut Notes) -> Vec<Shape> {
    if child(el, "filters").is_some() {
        notes.filters += 1;
    }
    let place = matrix(el);
    let fills = fills(el, notes);
    let strokes = strokes(el, notes);
    let mut out = Vec::new();
    for holder in named(el, "edges") {
        for edge in edges_of(holder) {
            let fill_index = style_index(
                edge_attr(&edge, "fillStyle1")
                    .or_else(|| edge_attr(&edge, "fillStyle0"))
                    .or_else(|| edge_attr(&edge, "fillStyle2")),
            );
            let stroke_index = style_index(edge_attr(&edge, "strokeStyle"));
            for run in runs(edge_attr(&edge, "edges").unwrap_or(""), notes) {
                let fill = run.style.or(fill_index).and_then(|index| ink_at(&fills, index));
                let stroke = run
                    .style
                    .or(stroke_index)
                    .and_then(|index| stroke_at(&strokes, index));
                let nodes = placed(run.nodes, &place);
                if nodes.len() < 2 || (fill.is_none() && stroke.is_none()) {
                    continue;
                }
                let ring = nodes.len() > 3 && same(&nodes[0].point, &nodes[nodes.len() - 1].point);
                let (nodes, closed) = if ring {
                    (nodes[..nodes.len() - 1].to_vec(), true)
                } else {
                    let sealed = fill.is_some() && nodes.len() > 2;
                    (nodes, sealed)
                };
                let (stroke_ink, width) = stroke.map_or(("none".to_string(), 0.0), |value| value);
                out.push(Shape::Path {
                    nodes,
                    closed,
                    fill: fill.unwrap_or_else(|| "none".to_string()),
                    stroke: stroke_ink,
                    width,
                    gradient: None,
                });
            }
        }
    }
    out
}

fn placed(nodes: Vec<PathNode>, place: &Affine) -> Vec<PathNode> {
    nodes
        .iter()
        .map(|node| PathNode {
            point: apply_affine(place, &node.point),
            handle_in: node.handle_in.as_ref().map(|value| apply_affine(place, value)),
            handle_out: node.handle_out.as_ref().map(|value| apply_affine(place, value)),
        })
        .collect()
}

fn edges_of(holder: &Element) -> Vec<EdgeRef<'_>> {
    let mut out = Vec::new();
    for item in &holder.children {
        match item.name.as_str() {
            "Edge" => out.push(EdgeRef {
                edge: item,
                group: None,
            }),
            "G" => {
                for edge in named(item, "Edge") {
                    out.push(EdgeRef {
                        edge,
                        group: Some(item),
                    });
                }
            }
            _ => {}
        }
    }
    out
}

fn edge_attr<'a>(edge: &EdgeRef<'a>, key: &str) -> Option<&'a str> {
    edge.edge
        .attr(key)
        .or(edge.group.and_then(|group| group.attr(key)))
}

fn style_index(value: Option<&str>) -> Option<usize> {
    let index = value?.trim().parse::<f64>().ok()?;
    if index <= 0.0 {
        return None;
    }
    Some(index as usize)
}

fn ink_at(styles: &[(usize, Option<String>)], index: usize) -> Option<String> {
    styles
        .iter()
        .find(|(position, _)| *position == index)
        .and_then(|(_, ink)| ink.clone())
}

fn stroke_at(styles: &[(usize, Option<(String, f64)>)], index: usize) -> Option<(String, f64)> {
    styles
        .iter()
        .find(|(position, _)| *position == index)
        .and_then(|(_, ink)| ink.clone())
}

fn fills(el: &Element, notes: &mut Notes) -> Vec<(usize, Option<String>)> {
    let mut out = Vec::new();
    for holder in named(el, "fills") {
        for style in named(holder, "FillStyle") {
            let index = style.number("index", 1.0).round().max(1.0) as usize;
            let ink = match style.children.first() {
                None => None,
                Some(value) if value.name == "SolidColor" => Some(ink_of(value)),
                Some(value) if value.name == "LinearGradientFill" || value.name == "RadialGradientFill" => {
                    notes.gradient = true;
                    dominant(value)
                }
                Some(value) if value.name == "DOMBitmapFill" => {
                    notes.bitmaps += 1;
                    None
                }
                Some(_) => None,
            };
            out.push((index, ink));
        }
    }
    out
}

fn dominant(value: &Element) -> Option<String> {
    let gradient = child(value, "Gradient")?;
    let stop = named(gradient, "GradientStop").into_iter().next()?;
    Some(color_ink(
        stop.attr("position").unwrap_or("#000000"),
        stop.number("alpha", 1.0),
    ))
}

fn color_ink(color: &str, alpha: f64) -> String {
    let (hex, channel) = xfl::color_alpha(color);
    let total = channel * alpha.clamp(0.0, 1.0);
    if total >= 0.999 {
        return hex;
    }
    format!("{hex}{:02x}", (total * 255.0).round() as u32)
}

fn ink_of(value: &Element) -> String {
    color_ink(
        value.attr("color").unwrap_or("#000000"),
        value.number("alpha", 1.0),
    )
}

fn strokes(el: &Element, notes: &mut Notes) -> Vec<(usize, Option<(String, f64)>)> {
    let mut out = Vec::new();
    for holder in named(el, "strokes") {
        for style in named(holder, "StrokeStyle") {
            let index = style.number("index", 1.0).round().max(1.0) as usize;
            let ink = match style.children.first() {
                None => None,
                Some(value) if value.name == "SolidStroke" => {
                    let color = child(value, "SolidColor")
                        .map(ink_of)
                        .unwrap_or_else(|| "#000000".to_string());
                    Some((color, value.number("w", 0.0) / TWIPS))
                }
                Some(value) if value.name == "PaintBrushStroke" => {
                    notes.brush += 1;
                    let color = child(value, "fill")
                        .and_then(|fill| child(fill, "SolidColor"))
                        .map(ink_of)
                        .unwrap_or_else(|| "#000000".to_string());
                    Some((color, value.number("weight", 0.0)))
                }
                Some(_) => None,
            };
            out.push((index, ink.map(|(color, width)| (color, width.max(0.5)))));
        }
    }
    out
}

fn tokens(text: &str) -> Vec<Token> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        if chars[at].is_ascii_whitespace() {
            at += 1;
            continue;
        }
        let radix = if chars[at] == '#' {
            at += 1;
            16
        } else {
            10
        };
        let Some(&head) = chars.get(at) else { break };
        if radix == 16 || head.is_ascii_digit() || head == '-' {
            let start = at;
            while at < chars.len() && numeral(chars[at], radix) {
                at += 1;
            }
            let text: String = chars[start..at].iter().collect();
            if let Some(value) = numeral_value(&text, radix) {
                out.push(Token::Number(value));
            }
        } else {
            out.push(Token::Marker(head));
            at += 1;
        }
    }
    out
}

fn numeral(ch: char, radix: u32) -> bool {
    ch.is_digit(radix) || ch == '.' || ch == '-'
}

fn numeral_value(text: &str, radix: u32) -> Option<f64> {
    if radix == 10 {
        return text
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite());
    }
    let (sign, rest) = match text.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, text),
    };
    let mut parts = rest.split('.');
    let whole = parts.next().unwrap_or_default();
    let bit = parts.next().unwrap_or_default();
    if whole.is_empty() || parts.next().is_some() {
        return None;
    }
    let mut value = 0.0;
    for ch in whole.chars() {
        value = value * 16.0 + ch.to_digit(16)? as f64;
    }
    let mut place = 1.0 / 16.0;
    for ch in bit.chars() {
        value += ch.to_digit(16)? as f64 * place;
        place /= 16.0;
    }
    Some(sign * value)
}

fn next_number(tokens: &[Token], at: &mut usize) -> Option<f64> {
    match tokens.get(*at) {
        Some(Token::Number(value)) => {
            *at += 1;
            Some(*value)
        }
        _ => None,
    }
}

fn next_point(tokens: &[Token], at: &mut usize) -> Option<Point> {
    Some(Point {
        x: next_number(tokens, at)? / TWIPS,
        y: next_number(tokens, at)? / TWIPS,
    })
}

fn runs(text: &str, notes: &mut Notes) -> Vec<Run> {
    let tokens = tokens(text);
    let mut out: Vec<Run> = Vec::new();
    let mut current: Vec<PathNode> = Vec::new();
    let mut pen: Option<Point> = None;
    let mut style: Option<usize> = None;
    let mut at = 0usize;
    while at < tokens.len() {
        let marker = match tokens[at] {
            Token::Marker(marker) => marker,
            Token::Number(_) => {
                notes.broken += 1;
                break;
            }
        };
        at += 1;
        let point = match marker {
            '!' | '|' | '[' => match next_point(&tokens, &mut at) {
                Some(point) => Some(point),
                None => {
                    notes.broken += 1;
                    break;
                }
            },
            _ => None,
        };
        match marker {
            '!' => {
                let value = point.unwrap_or_else(|| Point { x: 0.0, y: 0.0 });
                pen = Some(value.clone());
                if !current.last().is_some_and(|node| same(&node.point, &value)) {
                    close(&mut out, &mut current, style);
                    style = None;
                    current.push(anchor(&value));
                }
            }
            '|' => {
                let value = point.unwrap_or_else(|| Point { x: 0.0, y: 0.0 });
                pen = Some(value.clone());
                if current.is_empty() {
                    current.push(anchor(&value));
                }
                current.push(anchor(&value));
            }
            '[' => {
                let control = point.unwrap_or_else(|| Point { x: 0.0, y: 0.0 });
                let value = match next_point(&tokens, &mut at) {
                    Some(value) => value,
                    None => {
                        notes.broken += 1;
                        break;
                    }
                };
                pen = Some(value.clone());
                match current.last_mut() {
                    Some(last) => last.handle_out = Some(mix(&last.point, &control, 2.0 / 3.0)),
                    None => current.push(anchor(&control)),
                }
                let mut node = anchor(&value);
                node.handle_in = Some(mix(&value, &control, 2.0 / 3.0));
                current.push(node);
            }
            'S' => {
                let index = next_number(&tokens, &mut at);
                close(&mut out, &mut current, style);
                style = match index {
                    Some(value) if value > 0.0 => Some(value as usize),
                    _ => None,
                };
                if let Some(value) = &pen {
                    current.push(anchor(value));
                }
            }
            _ => {
                notes.broken += 1;
                break;
            }
        }
    }
    close(&mut out, &mut current, style);
    out
}

fn close(out: &mut Vec<Run>, current: &mut Vec<PathNode>, style: Option<usize>) {
    if current.len() >= 2 {
        out.push(Run {
            style,
            nodes: std::mem::take(current),
        });
    }
    current.clear();
}

fn anchor(point: &Point) -> PathNode {
    PathNode {
        point: point.clone(),
        handle_in: None,
        handle_out: None,
    }
}

fn mix(a: &Point, b: &Point, value: f64) -> Point {
    Point {
        x: a.x + (b.x - a.x) * value,
        y: a.y + (b.y - a.y) * value,
    }
}

fn same(a: &Point, b: &Point) -> bool {
    (a.x - b.x).abs() < 0.0001 && (a.y - b.y).abs() < 0.0001
}

fn text(el: &Element) -> Vec<Shape> {
    let mut value = String::new();
    let mut first: Option<&Element> = None;
    for run in runs_of_text(el) {
        for characters in named(run, "characters") {
            value.push_str(&breaks(&characters.text));
        }
        if first.is_none() {
            first = Some(run);
        }
    }
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let Some(run) = first else {
        return Vec::new();
    };
    let attrs = child(run, "textAttrs")
        .and_then(|holder| child(holder, "DOMTextAttrs"))
        .unwrap_or(run);
    let place = matrix(el);
    let size = attrs.number("size", 12.0).max(1.0);
    let line = attrs.number("lineHeight", size * crate::document::TEXT_LEADING);
    let spacing = attrs.number("letterSpacing", 0.0);
    let color = color_ink(
        attrs.attr("fillColor").unwrap_or("#000000"),
        attrs.number("alpha", 1.0),
    );
    let uniform = place.b == 0.0 && place.c == 0.0 && place.a == place.d;
    let scale = if uniform { place.a } else { 1.0 };
    vec![Shape::Text {
        x: place.e,
        y: place.f,
        text: trimmed.to_string(),
        size: (size * scale).max(1.0),
        family: xfl::family(attrs.attr("face").unwrap_or("Arial")),
        color,
        spacing: (spacing * scale).clamp(-500.0, 500.0),
        leading: (line / size).clamp(0.2, 10.0),
        align: align_of(attrs),
        matrix: if uniform { None } else { Some(place) },
    }]
}

fn runs_of_text(el: &Element) -> Vec<&Element> {
    let mut out: Vec<&Element> = Vec::new();
    for holder in named(el, "textRuns") {
        out.extend(named(holder, "DOMTextRun"));
    }
    if out.is_empty() {
        out.extend(named(el, "DOMTextRun"));
    }
    out
}

fn breaks(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn align_of(el: &Element) -> TextAlign {
    let value = el
        .attr("textAlign")
        .or_else(|| el.attr("fontJustification"))
        .unwrap_or("left")
        .to_ascii_lowercase();
    match value.as_str() {
        "center" | "centre" | "middle" => TextAlign::Center,
        "right" | "end" => TextAlign::Right,
        _ => TextAlign::Left,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{Blend, Layer, Scene};
    use crate::media::{png, svg};
    use crate::xfl;

    fn stage_xml(layers: &str) -> String {
        format!("<DOMDocument xmlns=\"http://ns.adobe.com/xfl/2008/\" backgroundColor=\"#999999\" width=\"640\" height=\"360\" frameRate=\"12.0000\" nextSceneIdentifier=\"2\"><timelines><DOMTimeline name=\"Scene 1\" currentFrame=\"0\"><layers>{layers}</layers></DOMTimeline></timelines></DOMDocument>")
    }

    fn art(frames: &str) -> String {
        format!("<DOMLayer name=\"Art\" color=\"#FF0000\" autoNamed=\"false\"><frames>{frames}</frames></DOMLayer>")
    }

    fn plain(index: u32, duration: u32, body: &str) -> String {
        format!("<DOMFrame index=\"{index}\" duration=\"{duration}\" keyMode=\"9728\"><elements>{body}</elements></DOMFrame>")
    }

    fn media_stage(items: &str, layers: &str) -> String {
        format!("<DOMDocument xmlns=\"http://ns.adobe.com/xfl/2008/\" backgroundColor=\"#999999\" width=\"640\" height=\"360\" frameRate=\"12.0000\"><media>{items}</media><timelines><DOMTimeline name=\"Scene 1\" currentFrame=\"0\"><layers>{layers}</layers></DOMTimeline></timelines></DOMDocument>")
    }

    fn image_book(x: f64, y: f64, w: f64, h: f64) -> Document {
        Document {
            id: "d1".to_string(),
            name: "Round trip".to_string(),
            width: 640,
            height: 360,
            fps: 24,
            background: "#ffffff".to_string(),
            scenes: vec![Scene {
                id: "s1".to_string(),
                name: "Scene 1".to_string(),
                layers: vec![Layer {
                    id: "l1".to_string(),
                    name: "Art".to_string(),
                    visible: true,
                    locked: false,
                    opacity: 1.0,
                    blend: Blend::Normal,
                    effects: Vec::new(),
                    masked: false,
                    length: 1,
                    keys: vec![Keyframe {
                        frame: 0,
                        shapes: vec![Shape::Bitmap {
                            x,
                            y,
                            w,
                            h,
                            source: crate::media::data_url("png", &png(40, 20)),
                            matrix: None,
                        }],
                        transform: Transform::default(),
                        tween: false,
                        easing: Easing::linear(),
                        label: None,
                    }],
                    folder: false,
                    children: Vec::new(),
                }],
            }],
            symbols: Vec::new(),
        }
    }

    fn placed(body: &str) -> Vec<Shape> {
        let item = "<DOMBitmapItem name=\"Bitmap 1\" allowSmoothing=\"true\" originalCompressionType=\"lossless\" quality=\"50\" href=\"Bitmap 1.png\" frameRight=\"800\" frameBottom=\"400\"/>";
        let members = vec![("LIBRARY/Bitmap 1.png".to_string(), png(40, 20))];
        parse(&media_stage(item, &art(&plain(0, 1, body))), "Imported", &members)
            .expect("parse")
            .doc
            .scenes[0]
            .layers[0]
            .keys[0]
            .shapes
            .clone()
    }

    fn square(x: f64) -> String {
        format!(
            "<DOMShape><fills><FillStyle index=\"1\"><SolidColor color=\"#ff0000\"/></FillStyle></fills><edges><Edge fillStyle1=\"1\" edges=\"!{} 0|40 0!40 0|40 40!40 40|0 40!0 40|0 0\"/></edges></DOMShape>",
            x * 20.0
        )
    }

    fn parsed(xml: &str) -> Document {
        parse(xml, "Imported", &[]).expect("parse").doc
    }

    fn path_of(key: &Keyframe) -> (Vec<PathNode>, bool, String) {
        match &key.shapes[0] {
            Shape::Path {
                nodes,
                closed,
                fill,
                ..
            } => (nodes.clone(), *closed, fill.clone()),
            other => panic!("expected a path, got {other:?}"),
        }
    }

    #[test]
    fn header_maps_rate_background_and_stage() {
        let doc = parsed(&stage_xml(""));
        assert_eq!((doc.width, doc.height, doc.fps), (640, 360, 12));
        assert_eq!(doc.background, "#999999");
        assert_eq!(doc.name, "Imported");
        assert_eq!(doc.scenes.len(), 1);
        assert_eq!(doc.scenes[0].name, "Scene 1");
        assert_eq!(doc.scenes[0].layers[0].name, "Layer 1");
    }

    #[test]
    fn frame_rate_is_clamped_and_reported() {
        let xml = stage_xml("").replace("frameRate=\"12.0000\"", "frameRate=\"300\"");
        let import = parse(&xml, "Imported", &[]).expect("parse");
        assert_eq!(import.doc.fps, 120);
        assert_eq!(
            import.notes,
            vec!["the frame rate was changed to 120 to fit the app range".to_string()]
        );
        let slow = stage_xml("").replace("frameRate=\"12.0000\"", "frameRate=\"23.976\"");
        let import = parse(&slow, "Imported", &[]).expect("parse");
        assert_eq!(import.doc.fps, 24);
        assert_eq!(
            import.notes,
            vec!["the frame rate was changed to 24 to fit the app range".to_string()]
        );
    }

    #[test]
    fn keyframes_hold_a_filled_square() {
        let xml = stage_xml(&art(&format!(
            "{}{}",
            plain(0, 3, &square(0.0)),
            plain(3, 2, &square(10.0))
        )));
        let doc = parsed(&xml);
        let layer = &doc.scenes[0].layers[0];
        assert_eq!(layer.name, "Art");
        assert_eq!(layer.length, 5);
        assert_eq!(layer.keys.len(), 2);
        assert_eq!(layer.keys[1].frame, 3);
        let (nodes, closed, fill) = path_of(&layer.keys[0]);
        assert!(closed);
        assert_eq!(fill, "#ff0000");
        assert_eq!(nodes.len(), 4);
        assert_eq!((nodes[0].point.x, nodes[0].point.y), (0.0, 0.0));
        assert_eq!((nodes[2].point.x, nodes[2].point.y), (2.0, 2.0));
        let (moved, _, _) = path_of(&layer.keys[1]);
        assert_eq!((moved[0].point.x, moved[0].point.y), (10.0, 0.0));
    }

    #[test]
    fn continuing_frames_add_nothing() {
        let xml = stage_xml(&art(&format!(
            "{}<DOMFrame index=\"4\" duration=\"2\" keyMode=\"256\"><elements/></DOMFrame>",
            plain(0, 4, "")
        )));
        let doc = parsed(&xml);
        let layer = &doc.scenes[0].layers[0];
        assert_eq!(layer.keys.len(), 1);
        assert!(layer.keys[0].shapes.is_empty());
        assert_eq!(layer.length, 6);
    }

    #[test]
    fn quadratic_edges_become_cubic_handles() {
        let body = "<DOMShape><fills><FillStyle index=\"1\"><SolidColor color=\"#00ff00\"/></FillStyle></fills><edges><Edge fillStyle1=\"1\" edges=\"!0 0[40 0 40 40!40 40|0 40!0 40|0 0\"/></edges></DOMShape>";
        let doc = parsed(&stage_xml(&art(&plain(0, 1, body))));
        let (nodes, closed, _) = path_of(&doc.scenes[0].layers[0].keys[0]);
        assert!(closed);
        assert_eq!(nodes.len(), 3);
        let out = nodes[0].handle_out.clone().expect("handle out");
        assert!((out.x - 1.3333333).abs() < 1e-5);
        assert!((out.y - 0.0).abs() < 1e-5);
        let held = nodes[1].handle_in.clone().expect("handle in");
        assert!((held.x - 2.0).abs() < 1e-5);
        assert!((held.y - 0.6666666).abs() < 1e-5);
        assert!(nodes[1].handle_out.is_none());
    }

    #[test]
    fn edge_markup_writes_control_points_in_hex() {
        let body = "<DOMShape><fills><FillStyle index=\"1\"><SolidColor color=\"#00ff00\"/></FillStyle></fills><edges><Edge fillStyle1=\"1\" edges=\"!0 0[#28.0 #0 40 40!40 40|0 40!0 40|0 0\"/></edges></DOMShape>";
        let import = parse(&stage_xml(&art(&plain(0, 1, body))), "Imported", &[]).expect("parse");
        assert_eq!(import.notes, Vec::<String>::new());
        let (nodes, closed, _) = path_of(&import.doc.scenes[0].layers[0].keys[0]);
        assert!(closed);
        assert_eq!(nodes.len(), 3);
        let out = nodes[0].handle_out.clone().expect("handle out");
        assert!((out.x - 1.3333333).abs() < 1e-5);
        assert!((out.y - 0.0).abs() < 1e-5);
        let held = nodes[1].handle_in.clone().expect("handle in");
        assert!((held.x - 2.0).abs() < 1e-5);
        assert!((held.y - 0.6666666).abs() < 1e-5);
        let fine = "<DOMShape><fills><FillStyle index=\"1\"><SolidColor color=\"#00ff00\"/></FillStyle></fills><edges><Edge fillStyle1=\"1\" edges=\"!0 0[#234.E5 #D8.1B 239 -366|478 -732!0 0\"/></edges></DOMShape>";
        let import = parse(&stage_xml(&art(&plain(0, 1, fine))), "Imported", &[]).expect("parse");
        assert_eq!(import.notes, Vec::<String>::new());
        let (nodes, _, _) = path_of(&import.doc.scenes[0].layers[0].keys[0]);
        assert!((nodes[1].point.x - 11.95).abs() < 1e-6);
        assert!((nodes[1].point.y + 18.3).abs() < 1e-6);
        let out = nodes[0].handle_out.clone().expect("handle out");
        assert!((out.x - 18.8298177).abs() < 1e-5);
        assert!((out.y - 7.2035156).abs() < 1e-5);
        let held = nodes[1].handle_in.clone().expect("handle in");
        assert!((held.x - 22.8131507).abs() < 1e-5);
        assert!((held.y - 1.1035156).abs() < 1e-5);
    }

    #[test]
    fn shape_matrix_is_baked_into_geometry() {
        let body = "<DOMShape><matrix><Matrix a=\"2\" d=\"2\" tx=\"20\" ty=\"10\"/></matrix><fills><FillStyle index=\"1\"><SolidColor color=\"#0000ff\"/></FillStyle></fills><edges><Edge fillStyle1=\"1\" edges=\"!0 0|40 0!40 0|40 40!40 40|0 40\"/></edges></DOMShape>";
        let doc = parsed(&stage_xml(&art(&plain(0, 1, body))));
        let (nodes, _, _) = path_of(&doc.scenes[0].layers[0].keys[0]);
        assert!((nodes[0].point.x - 20.0).abs() < 0.001);
        assert!((nodes[0].point.y - 10.0).abs() < 0.001);
        assert!((nodes[2].point.x - 24.0).abs() < 0.001);
        assert!((nodes[2].point.y - 14.0).abs() < 0.001);
    }

    #[test]
    fn stroke_width_comes_from_twips() {
        let body = "<DOMShape><strokes><StrokeStyle index=\"1\"><SolidStroke scaleMode=\"none\" caps=\"none\" w=\"40\"><SolidColor color=\"#000000\"/></SolidStroke></StrokeStyle></strokes><edges><Edge strokeStyle=\"1\" edges=\"!0 0|100 0\"/></edges></DOMShape>";
        let doc = parsed(&stage_xml(&art(&plain(0, 1, body))));
        match &doc.scenes[0].layers[0].keys[0].shapes[0] {
            Shape::Path {
                stroke, width, fill, ..
            } => {
                assert_eq!(stroke, "#000000");
                assert_eq!(fill, "none");
                assert!((width - 2.0).abs() < 0.001);
            }
            other => panic!("expected a path, got {other:?}"),
        }
    }

    #[test]
    fn hairline_strokes_land_on_the_editors_minimum() {
        let body = "<DOMShape><strokes><StrokeStyle index=\"1\"><SolidStroke scaleMode=\"none\" caps=\"none\" w=\"2\"><SolidColor color=\"#000000\"/></SolidStroke></StrokeStyle></strokes><edges><Edge strokeStyle=\"1\" edges=\"!0 0|100 0\"/></edges></DOMShape>";
        let doc = parsed(&stage_xml(&art(&plain(0, 1, body))));
        let shape = &doc.scenes[0].layers[0].keys[0].shapes[0];
        match shape {
            Shape::Path { width, .. } => assert_eq!(*width, 0.5),
            other => panic!("expected a path, got {other:?}"),
        }
        crate::document::validate(shape).expect("hairline");
    }

    #[test]
    fn filled_paths_without_a_stroke_stay_valid() {
        let doc = parsed(&stage_xml(&art(&plain(0, 1, &square(0.0)))));
        let shape = &doc.scenes[0].layers[0].keys[0].shapes[0];
        match shape {
            Shape::Path { stroke, width, .. } => {
                assert_eq!(stroke, "none");
                assert_eq!(*width, 0.0);
            }
            other => panic!("expected a path, got {other:?}"),
        }
        crate::document::validate(shape).expect("filled");
    }

    #[test]
    fn text_restores_breaks_and_font() {
        let body = "<DOMStaticText width=\"120\" height=\"30\" autoExpand=\"true\"><matrix><Matrix tx=\"4\" ty=\"6\"/></matrix><textRuns><DOMTextRun><characters>hi&#xd;there</characters><textAttrs><DOMTextAttrs aliasText=\"false\" lineHeight=\"21.6\" size=\"18\" face=\"ArialMT\" fillColor=\"#616161\" textAlign=\"center\" letterSpacing=\"1\" fontJustification=\"LEFT\"/></textAttrs></DOMTextRun></textRuns></DOMStaticText>";
        let doc = parsed(&stage_xml(&art(&plain(0, 1, body))));
        match &doc.scenes[0].layers[0].keys[0].shapes[0] {
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
            } => {
                assert_eq!(text, "hi\nthere");
                assert_eq!((*x, *y), (4.0, 6.0));
                assert!((size - 18.0).abs() < 0.001);
                assert_eq!(family, "Arial");
                assert_eq!(color, "#616161");
                assert!((spacing - 1.0).abs() < 0.001);
                assert!((leading - 1.2).abs() < 0.001);
                assert_eq!(*align, TextAlign::Center);
                assert!(matrix.is_none());
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn letter_spacing_stays_in_the_editors_range() {
        let body = "<DOMStaticText><textRuns><DOMTextRun><characters>go</characters><textAttrs><DOMTextAttrs size=\"12\" letterSpacing=\"900\"/></textAttrs></DOMTextRun></textRuns></DOMStaticText>";
        let doc = parsed(&stage_xml(&art(&plain(0, 1, body))));
        let shape = &doc.scenes[0].layers[0].keys[0].shapes[0];
        match shape {
            Shape::Text { spacing, .. } => assert_eq!(*spacing, 500.0),
            other => panic!("expected text, got {other:?}"),
        }
        crate::document::validate(shape).expect("spacing");
    }

    #[test]
    fn postscript_faces_become_family_names() {
        let body = "<DOMStaticText><textRuns><DOMTextRun><characters>go</characters><textAttrs><DOMTextAttrs size=\"12\" face=\"TimesNewRomanPSMT\"/></textAttrs></DOMTextRun></textRuns></DOMStaticText>";
        let doc = parsed(&stage_xml(&art(&plain(0, 1, body))));
        match &doc.scenes[0].layers[0].keys[0].shapes[0] {
            Shape::Text { family, .. } => assert_eq!(family, "Times New Roman"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn animate_face_names_decode_to_families() {
        for (face, want) in [
            ("TimesNewRomanPSMT", "Times New Roman"),
            ("Verdana", "Verdana"),
            ("MyOddFont", "MyOddFont"),
        ] {
            let body = format!(
                "<DOMStaticText><textRuns><DOMTextRun><characters>x</characters><textAttrs><DOMTextAttrs face=\"{face}\"/></textAttrs></DOMTextRun></textRuns></DOMStaticText>"
            );
            let doc = parsed(&stage_xml(&art(&plain(0, 1, &body))));
            let Shape::Text { family, .. } = &doc.scenes[0].layers[0].keys[0].shapes[0] else {
                panic!("expected text");
            };
            assert_eq!(family, want);
        }
    }

    #[test]
    fn motion_tween_sets_an_easing_preset() {
        let frame = "<DOMFrame index=\"0\" duration=\"12\" tweenType=\"motion\" motionTweenSnap=\"true\" keyMode=\"22017\"><tweens><Ease target=\"all\" method=\"circOut\"/></tweens><elements/></DOMFrame>";
        let doc = parsed(&stage_xml(&art(&format!(
            "{}{}",
            frame,
            plain(12, 1, "")
        ))));
        let layer = &doc.scenes[0].layers[0];
        assert!(layer.keys[0].tween);
        assert!(!layer.keys[1].tween);
        assert_eq!(layer.keys[0].easing, EASE_OUT);
        assert!(layer.keys[1].easing == Easing::linear());
    }

    #[test]
    fn unknown_easing_falls_back_to_linear() {
        let frame = "<DOMFrame index=\"0\" duration=\"12\" tweenType=\"motion\" keyMode=\"22017\"><tweens><Ease target=\"all\" method=\"wobble\"/></tweens><elements/></DOMFrame>";
        let import = parse(&stage_xml(&art(frame)), "Imported", &[]).expect("parse");
        assert_eq!(
            import.doc.scenes[0].layers[0].keys[0].easing,
            Easing::linear()
        );
        assert_eq!(
            import.notes,
            vec!["1 custom easing curve was imported as linear".to_string()]
        );
    }

    #[test]
    fn symbol_instances_are_reported() {
        let body = "<DOMSymbolInstance libraryItemName=\"Guy\" symbolType=\"graphic\"><matrix><Matrix tx=\"10\" ty=\"20\"/></matrix></DOMSymbolInstance><DOMSymbolInstance libraryItemName=\"Cat\"/>";
        let import = parse(&stage_xml(&art(&plain(0, 1, body))), "Imported", &[]).expect("parse");
        let layer = &import.doc.scenes[0].layers[0];
        assert_eq!(layer.keys.len(), 1);
        assert!(layer.keys[0].shapes.is_empty());
        assert_eq!(
            import.notes,
            vec!["2 symbol instances were skipped".to_string()]
        );
    }

    fn symbol_file_xml(name: &str, item_id: &str, kind: &str, layers: &str) -> String {
        format!("<DOMSymbolItem xmlns=\"http://ns.adobe.com/xfl/2008/\" name=\"{name}\" itemID=\"{item_id}\" symbolType=\"{kind}\"><timeline><DOMTimeline name=\"{name}\" currentFrame=\"0\"><layers>{layers}</layers></DOMTimeline></timeline></DOMSymbolItem>")
    }

    fn symbol_member(name: &str, item_id: &str, layers: &str) -> (String, Vec<u8>) {
        let xml = symbol_file_xml(name, item_id, "graphic", layers);
        (format!("LIBRARY/{name}.xml"), xml.into_bytes())
    }

    fn include(href: &str, item_id: &str) -> String {
        format!("<Include href=\"{href}\" itemID=\"{item_id}\" loadImmediate=\"false\"/>")
    }

    fn library_stage(includes: &str, layers: &str) -> String {
        format!("<DOMDocument xmlns=\"http://ns.adobe.com/xfl/2008/\" backgroundColor=\"#999999\" width=\"640\" height=\"360\" frameRate=\"12.0000\"><symbols>{includes}</symbols><timelines><DOMTimeline name=\"Scene 1\" currentFrame=\"0\"><layers>{layers}</layers></DOMTimeline></timelines></DOMDocument>")
    }

    fn placement(attrs: &str, matrix: &str) -> String {
        format!("<DOMSymbolInstance {attrs}>{matrix}</DOMSymbolInstance>")
    }

    fn placed_at(body: &str) -> Vec<Shape> {
        let members = vec![symbol_member(
            "Guy",
            "id-1",
            &art(&plain(0, 1, &square(0.0))),
        )];
        let xml = library_stage(
            &include("Guy.xml", "id-1"),
            &art(&plain(0, 1, body)),
        );
        let import = parse(&xml, "Imported", &members).expect("parse");
        assert_eq!(import.notes, Vec::<String>::new());
        import.doc.scenes[0].layers[0].keys[0].shapes.clone()
    }

    fn shape_of(body: &str) -> Shape {
        placed_at(body).remove(0)
    }

    #[test]
    fn a_library_symbol_keeps_its_own_timeline() {
        let members = vec![
            symbol_member("Guy", "id-1", &art(&plain(0, 1, &square(0.0)))),
            symbol_member("Girl", "id-2", &art(&plain(0, 2, &square(2.0)))),
        ];
        let xml = library_stage(
            &format!("{}{}", include("Guy.xml", "id-1"), include("Girl.xml", "id-2")),
            "",
        );
        let import = parse(&xml, "Imported", &members).expect("parse");
        assert_eq!(import.notes, Vec::<String>::new());
        assert_eq!(import.doc.symbols.len(), 2);
        assert_eq!(import.doc.symbols[0].id, "id-1");
        assert_eq!(import.doc.symbols[0].name, "Guy");
        assert_eq!(import.doc.symbols[0].kind, SymbolKind::Graphic);
        assert_eq!(import.doc.symbols[0].layers[0].name, "Art");
        assert_eq!(path_of(&import.doc.symbols[0].layers[0].keys[0]).2, "#ff0000");
        assert_eq!(import.doc.symbols[1].layers[0].keys.len(), 1);
        assert_eq!(import.doc.symbols[1].layers[0].length, 2);
    }

    #[test]
    fn a_symbol_file_kind_survives_the_import() {
        let members = vec![(
            "LIBRARY/Clip.xml".to_string(),
            symbol_file_xml("Clip", "id-9", "movie clip", &art(&plain(0, 1, &square(0.0))))
                .into_bytes(),
        )];
        let import = parse(
            &library_stage(&include("Clip.xml", "id-9"), ""),
            "Imported",
            &members,
        )
        .expect("parse");
        assert_eq!(import.doc.symbols[0].kind, SymbolKind::MovieClip);
    }

    #[test]
    fn a_placement_points_at_its_library_symbol() {
        let shape = shape_of(&placement(
            "libraryItemName=\"Guy\" symbolType=\"graphic\"",
            "<matrix><Matrix a=\"2\" d=\"3\" tx=\"10\" ty=\"20\"/></matrix>",
        ));
        match shape {
            Shape::Instance {
                symbol,
                name,
                matrix,
                visible,
                first_frame,
                looping,
            } => {
                assert_eq!(symbol, "id-1");
                assert_eq!(name, "");
                assert_eq!(
                    matrix.expect("matrix"),
                    Affine {
                        a: 2.0,
                        b: 0.0,
                        c: 0.0,
                        d: 3.0,
                        e: 10.0,
                        f: 20.0
                    }
                );
                assert!(visible);
                assert_eq!(first_frame, 0);
                assert_eq!(looping, LoopMode::SingleFrame);
            }
            other => panic!("expected a placement, got {other:?}"),
        }
    }

    #[test]
    fn a_placement_keeps_its_name_label_and_loop() {
        let shape = shape_of(&placement(
            "name=\"hero\" libraryItemName=\"Guy\" isVisible=\"false\" firstFrame=\"4\" loop=\"loop\"",
            "",
        ));
        match shape {
            Shape::Instance {
                symbol,
                name,
                matrix,
                visible,
                first_frame,
                looping,
            } => {
                assert_eq!(symbol, "id-1");
                assert_eq!(name, "hero");
                assert!(matrix.is_none());
                assert!(!visible);
                assert_eq!(first_frame, 4);
                assert_eq!(looping, LoopMode::Loop);
            }
            other => panic!("expected a placement, got {other:?}"),
        }
    }

    #[test]
    fn a_flipped_placement_mirrors_its_basis_vectors() {
        let shape = shape_of(&placement(
            "libraryItemName=\"Guy\" FlipX=\"true\" FlipY=\"true\"",
            "<matrix><Matrix a=\"2\" d=\"3\" tx=\"10\" ty=\"20\"/></matrix>",
        ));
        match shape {
            Shape::Instance {
                matrix: Some(place),
                ..
            } => {
                assert_eq!(place.a, -2.0);
                assert_eq!(place.d, -3.0);
                assert_eq!(place.e, 10.0);
            }
            other => panic!("expected a flipped placement, got {other:?}"),
        }
    }

    #[test]
    fn every_placement_of_one_symbol_shares_the_same_library_entry() {
        let body = format!(
            "{}{}",
            placement("libraryItemName=\"Guy\"", "<matrix><Matrix tx=\"5\" ty=\"5\"/></matrix>"),
            placement("libraryItemName=\"Guy\"", "")
        );
        let shapes = placed_at(&body);
        assert_eq!(shapes.len(), 2);
        for shape in &shapes {
            match shape {
                Shape::Instance { symbol, .. } => assert_eq!(symbol, "id-1"),
                other => panic!("expected a placement, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_symbol_without_its_file_is_reported_once_per_gap() {
        let xml = library_stage(
            &include("Guy.xml", "id-1"),
            &art(&plain(0, 1, &placement("libraryItemName=\"Guy\"", ""))),
        );
        let import = parse(&xml, "Imported", &[]).expect("parse");
        assert!(import.doc.symbols.is_empty());
        assert!(import.doc.scenes[0].layers[0].keys[0].shapes.is_empty());
        assert_eq!(
            import.notes,
            vec![
                "1 symbol instance was skipped".to_string(),
                "1 library symbol was not imported".to_string()
            ]
        );
    }

    #[test]
    fn a_broken_symbol_file_does_not_leave_a_dangling_placement() {
        let members = vec![(
            "LIBRARY/Guy.xml".to_string(),
            b"<DOMSymbolItem name=\"Guy\"".to_vec(),
        )];
        let xml = library_stage(
            &include("Guy.xml", "id-1"),
            &art(&plain(0, 1, &placement("libraryItemName=\"Guy\"", ""))),
        );
        let import = parse(&xml, "Imported", &members).expect("parse");
        assert!(import.doc.symbols.is_empty());
        assert_eq!(
            import.notes,
            vec![
                "1 symbol instance was skipped".to_string(),
                "1 library symbol was not imported".to_string()
            ]
        );
    }

    #[test]
    fn library_members_that_are_not_symbol_files_are_left_alone() {
        let xml = library_stage(
            &include("Guy.swf", "id-1"),
            &art(&plain(0, 1, &placement("libraryItemName=\"Guy\"", ""))),
        );
        let import = parse(&xml, "Imported", &[]).expect("parse");
        assert!(import.doc.symbols.is_empty());
        assert_eq!(
            import.notes,
            vec!["1 symbol instance was skipped".to_string()]
        );
    }

    #[test]
    fn a_symbol_that_is_never_placed_still_lands() {
        let members = vec![symbol_member("Guy", "id-1", &art(&plain(0, 1, &square(0.0))))];
        let import = parse(
            &library_stage(&include("Guy.xml", "id-1"), &art(&plain(0, 1, ""))),
            "Imported",
            &members,
        )
        .expect("parse");
        assert_eq!(import.doc.symbols.len(), 1);
        assert_eq!(import.notes, Vec::<String>::new());
    }

    #[test]
    fn nested_placements_cross_reference_whatever_order_the_files_land_in() {
        let solo = art(&plain(0, 1, &square(0.0)));
        let inside = art(&plain(
            0,
            1,
            &placement("libraryItemName=\"Girl\"", "<matrix><Matrix tx=\"8\" ty=\"9\"/></matrix>"),
        ));
        let members = vec![
            symbol_member("Guy", "id-1", &inside),
            symbol_member("Girl", "id-2", &solo),
        ];
        let xml = library_stage(
            &format!("{}{}", include("Guy.xml", "id-1"), include("Girl.xml", "id-2")),
            &art(&plain(0, 1, &placement("libraryItemName=\"Girl\"", ""))),
        );
        let import = parse(&xml, "Imported", &members).expect("parse");
        assert_eq!(import.notes, Vec::<String>::new());
        assert_eq!(import.doc.symbols.len(), 2);
        let Shape::Instance { symbol, .. } =
            import.doc.symbols[0].layers[0].keys[0].shapes[0].clone()
        else {
            panic!("expected a nested placement");
        };
        assert_eq!(symbol, "id-2");
    }

    #[test]
    fn gradient_fills_fall_back_to_a_flat_stop() {
        let body = "<DOMShape><fills><FillStyle index=\"1\"><LinearGradientFill focus=\"0\" angle=\"-90\"><Gradient interpolation=\"linear\" type=\"linear\" focus=\"0\"><GradientStop position=\"#ff0000FF\" ratio=\"0\"/><GradientStop position=\"#0000ff\" ratio=\"1\"/></Gradient></LinearGradientFill></FillStyle></fills><edges><Edge fillStyle1=\"1\" edges=\"!0 0|40 0!40 0|40 40!40 40|0 40\"/></edges></DOMShape>";
        let import = parse(&stage_xml(&art(&plain(0, 1, body))), "Imported", &[]).expect("parse");
        let (_, _, fill) = path_of(&import.doc.scenes[0].layers[0].keys[0]);
        assert_eq!(fill, "#ff0000");
        assert_eq!(
            import.notes,
            vec!["gradient fills were imported as flat colours".to_string()]
        );
    }

    #[test]
    fn unusual_layers_are_reported_not_guessed() {
        let layers = "<DOMLayer name=\"Guide\" layerType=\"guide\"><frames><DOMFrame index=\"0\" duration=\"1\" keyMode=\"9728\"><elements/></DOMFrame></frames></DOMLayer>\
            <DOMLayer name=\"Clip\" type=\"mask\"><frames><DOMFrame index=\"0\" duration=\"1\" keyMode=\"9728\"><elements/></DOMFrame></frames></DOMLayer>\
            <DOMLayer name=\"Music\" blendMode=\"multiply\"><frames><DOMFrame index=\"0\" duration=\"1\" keyMode=\"9728\" soundName=\"hit.wav\"><SoundEnvelope><SoundEnvelopePoint level0=\"32768\" level1=\"32768\"/></SoundEnvelope></DOMFrame></frames></DOMLayer>";
        let import = parse(&stage_xml(layers), "Imported", &[]).expect("parse");
        let names: Vec<&str> = import
            .doc
            .scenes[0]
            .layers
            .iter()
            .map(|layer| layer.name.as_str())
            .collect();
        assert_eq!(names, vec!["Clip", "Music"]);
        assert!(import.doc.scenes[0].layers[1].masked);
        assert!(import.notes.contains(&"1 guide layer was skipped".to_string()));
        assert!(!import
            .notes
            .iter()
            .any(|note| note.contains("mask layer")));
        assert!(import
            .notes
            .contains(&"1 blend mode was imported as normal".to_string()));
        assert!(import.notes.contains(&"1 frame sound was skipped".to_string()));
    }

    fn holder(name: &str, attrs: &str) -> String {
        format!("<DOMLayer name=\"{name}\" {attrs}><frames><DOMFrame index=\"0\" duration=\"1\" keyMode=\"9728\"><elements/></DOMFrame></frames></DOMLayer>")
    }

    #[test]
    fn a_mask_layer_clips_the_layer_below_it() {
        let layers = format!(
            "{}{}{}",
            holder("Clip", "layerType=\"mask\" parentLayerIndex=\"-1\""),
            holder("Art", "layerType=\"masked\" parentLayerIndex=\"0\""),
            holder("Back", "")
        );
        let import = parse(&stage_xml(&layers), "Imported", &[]).expect("parse");
        let scene = &import.doc.scenes[0];
        assert_eq!(
            scene.layers.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(),
            vec!["Clip", "Art", "Back"]
        );
        assert!(!scene.layers[0].masked);
        assert!(scene.layers[1].masked);
        assert!(!scene.layers[2].masked);
        assert!(import.notes.is_empty());
    }

    #[test]
    fn extra_layers_behind_one_mask_are_reported() {
        let layers = format!(
            "{}{}{}{}",
            holder("Clip", "layerType=\"mask\""),
            holder("Art", "parentLayerIndex=\"0\""),
            holder("More", "parentLayerIndex=\"0\""),
            holder("Back", "parentLayerIndex=\"-1\"")
        );
        let import = parse(&stage_xml(&layers), "Imported", &[]).expect("parse");
        let scene = &import.doc.scenes[0];
        assert!(scene.layers[1].masked);
        assert!(!scene.layers[2].masked);
        assert_eq!(
            import.notes,
            vec!["1 mask layer was imported as a plain layer".to_string()]
        );
    }

    #[test]
    fn a_mask_without_a_layer_to_clip_is_reported() {
        let layers = format!(
            "{}{}",
            holder("Art", ""),
            holder("Clip", "layerType=\"mask\" parentLayerIndex=\"-1\"")
        );
        let import = parse(&stage_xml(&layers), "Imported", &[]).expect("parse");
        assert_eq!(import.doc.scenes[0].layers.len(), 2);
        assert!(!import.doc.scenes[0].layers.iter().any(|l| l.masked));
        assert_eq!(
            import.notes,
            vec!["1 mask layer was imported as a plain layer".to_string()]
        );
    }

    #[test]
    fn a_folder_layer_keeps_the_layers_below_it() {
        let layers = format!(
            "{}{}{}{}{}",
            holder("Group", "layerType=\"folder\" parentLayerIndex=\"-1\""),
            holder("Art", "parentLayerIndex=\"0\""),
            holder("Inner", "layerType=\"folder\" parentLayerIndex=\"0\""),
            holder("Deep", "parentLayerIndex=\"2\""),
            holder("Back", "parentLayerIndex=\"-1\"")
        );
        let import = parse(&stage_xml(&layers), "Imported", &[]).expect("parse");
        let scene = &import.doc.scenes[0];
        assert_eq!(
            scene.layers.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(),
            vec!["Group", "Back"]
        );
        assert!(scene.layers[0].folder);
        assert_eq!(
            scene.layers[0]
                .children
                .iter()
                .map(|l| l.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Art", "Inner"]
        );
        assert_eq!(scene.layers[0].children[1].children[0].name, "Deep");
        assert!(import.notes.is_empty());
    }

    #[test]
    fn bitmap_fills_are_reported() {
        let body = "<DOMShape><fills><FillStyle index=\"1\"><DOMBitmapFill href=\"Face.png\"/></FillStyle></fills><edges><Edge fillStyle1=\"1\" edges=\"!0 0|40 0!40 0|40 40!40 40|0 40\"/></edges></DOMShape>";
        let import = parse(&stage_xml(&art(&plain(0, 1, body))), "Imported", &[]).expect("parse");
        assert!(import.doc.scenes[0].layers[0].keys[0].shapes.is_empty());
        assert_eq!(import.notes, vec!["1 bitmap fill was skipped".to_string()]);
    }

    #[test]
    fn undecodable_edge_markup_is_reported() {
        let body = "<DOMShape><fills><FillStyle index=\"1\"><SolidColor color=\"#ff0000\"/></FillStyle></fills><edges><Edge fillStyle1=\"1\" edges=\"!0 0:20 20\"/></edges></DOMShape>";
        let import = parse(&stage_xml(&art(&plain(0, 1, body))), "Imported", &[]).expect("parse");
        assert!(import.doc.scenes[0].layers[0].keys[0].shapes.is_empty());
        assert_eq!(
            import.notes,
            vec!["1 shape used edge markup that could not be decoded".to_string()]
        );
    }

    #[test]
    fn shape_tween_keeps_its_geometry() {
        let frame = "<DOMFrame index=\"0\" duration=\"6\" tweenType=\"shape\" keyMode=\"17922\"><MorphShape><morphSegments><MorphSegment startPointA=\"-15.4, -18\"/></morphSegments></MorphShape><elements>";
        let xml = stage_xml(&art(&format!(
            "{}{}</elements></DOMFrame>",
            frame,
            square(0.0)
        )));
        let import = parse(&xml, "Imported", &[]).expect("parse");
        let layer = &import.doc.scenes[0].layers[0];
        assert!(layer.keys[0].tween);
        let (nodes, closed, _) = path_of(&layer.keys[0]);
        assert!(closed);
        assert_eq!(nodes.len(), 4);
        assert!(import
            .notes
            .contains(&"1 shape tween was imported as a keyframe".to_string()));
    }

    #[test]
    fn malformed_xml_is_rejected() {
        for case in ["<DOMDocument width=\"640\"", "<DOMDocument></DOMWrong>", "<DOMDocument><timelines></DOMDocument>"] {
            let error = parse(case, "Imported", &[]).expect_err("malformed");
            assert!(
                error.starts_with("the .xfl document is not valid xml"),
                "{error}"
            );
        }
        assert_eq!(
            parse("<span></span>", "Imported", &[]).expect_err("not xfl"),
            "the .xfl document is not valid xml"
        );
        assert!(parse("<DOMDocument></DOMDocument>", "Imported", &[]).is_ok());
    }

    #[test]
    fn missing_attributes_default() {
        let doc = parsed("<DOMDocument></DOMDocument>");
        assert_eq!((doc.width, doc.height, doc.fps), (1, 1, 24));
        assert_eq!(doc.background, "#ffffff");
        assert_eq!(doc.scenes[0].layers[0].keys.len(), 1);
        let xml = "<DOMDocument><timelines><DOMTimeline><layers><DOMLayer><frames>\
            <DOMFrame><elements><DOMShape><fills><FillStyle><SolidColor color=\"#ff0000\"/></FillStyle></fills>\
            <edges><Edge fillStyle1=\"1\" edges=\"!0 0|20 0!20 0|20 20\"/></edges></DOMShape></elements></DOMFrame>\
            </frames></DOMLayer></layers></DOMTimeline></timelines></DOMDocument>";
        let doc = parsed(xml);
        let layer = &doc.scenes[0].layers[0];
        assert_eq!(layer.name, "Layer");
        assert_eq!(layer.length, 1);
        assert_eq!(layer.keys.len(), 1);
        let (nodes, closed, fill) = path_of(&layer.keys[0]);
        assert_eq!(fill, "#ff0000");
        assert!(closed);
        assert_eq!(nodes.len(), 3);
    }

    #[test]
    fn unpainted_edges_are_dropped() {
        let body = "<DOMShape><edges><Edge edges=\"!0 0|40 0\"/></edges></DOMShape>";
        let import = parse(&stage_xml(&art(&plain(0, 1, body))), "Imported", &[]).expect("parse");
        assert!(import.doc.scenes[0].layers[0].keys[0].shapes.is_empty());
        assert!(import.notes.is_empty(), "{:?}", import.notes);
    }

    #[test]
    fn writer_output_reads_back_with_matching_geometry() {
        let doc = fixture();
        let first = xfl::document_xml(&doc);
        let import = parse(&first, "Round trip", &[]).expect("parse");
        let read = &import.doc;
        assert_eq!((read.width, read.height, read.fps), (320, 240, 24));
        assert_eq!(read.background, "#ffffff");
        assert_eq!(read.scenes[0].layers[0].name, "Art");
        assert_eq!(read.scenes[0].layers[0].length, 6);
        assert_eq!(read.scenes[0].layers[0].keys.len(), 2);
        let corners = [(100.0, 50.0), (120.0, 50.0), (120.0, 70.0), (100.0, 70.0)];
        let (nodes, closed, fill) = path_of(&read.scenes[0].layers[0].keys[0]);
        assert!(closed);
        assert_eq!(fill, "#ff0000");
        assert_eq!(nodes.len(), 4);
        for (index, corner) in corners.iter().enumerate() {
            let dx = nodes[index].point.x - corner.0;
            let dy = nodes[index].point.y - corner.1;
            assert!(dx.hypot(dy) < 0.05, "node {index} drifted by {dx} {dy}");
        }
        let second = xfl::document_xml(read);
        assert_eq!(edges_of_xml(&first), edges_of_xml(&second));
        assert!(import.notes.is_empty(), "{:?}", import.notes);
    }

    #[test]
    fn a_placed_image_round_trips_through_the_library() {
        let doc = image_book(150.0, 60.0, 80.0, 40.0);
        let xml = xfl::document_xml(&doc);
        let members = xfl::library_members(&doc);
        assert_eq!(members[0].0, "LIBRARY/Bitmap 1.png".to_string());
        let import = parse(&xml, "Round trip", &members).expect("parse");
        assert!(import.notes.is_empty(), "{:?}", import.notes);
        assert_eq!(
            import.doc.scenes[0].layers[0].keys[0].shapes,
            doc.scenes[0].layers[0].keys[0].shapes
        );
    }

    #[test]
    fn a_placed_svg_round_trips_through_the_library() {
        let mut doc = image_book(0.0, 0.0, 80.0, 40.0);
        let Shape::Bitmap { source, .. } = &mut doc.scenes[0].layers[0].keys[0].shapes[0] else {
            panic!("expected a bitmap")
        };
        *source = crate::media::data_url("svg", &svg(40, 20));
        let members = xfl::library_members(&doc);
        assert_eq!(members[0].0, "LIBRARY/Bitmap 1.svg".to_string());
        let import = parse(&xfl::document_xml(&doc), "Round trip", &members).expect("parse");
        assert!(import.notes.is_empty(), "{:?}", import.notes);
        assert_eq!(
            import.doc.scenes[0].layers[0].keys[0].shapes,
            doc.scenes[0].layers[0].keys[0].shapes
        );
    }

    #[test]
    fn a_turned_image_round_trips_through_the_library() {
        let mut doc = image_book(0.0, 0.0, 40.0, 20.0);
        let shapes = &mut doc.scenes[0].layers[0].keys[0].shapes;
        let Shape::Bitmap { matrix, .. } = &mut shapes[0] else {
            panic!("expected a bitmap")
        };
        *matrix = Some(Affine {
            a: -2.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 100.0,
            f: 20.0,
        });
        let expected = shapes.clone();
        let import = parse(&xfl::document_xml(&doc), "Round trip", &xfl::library_members(&doc))
            .expect("parse");
        assert!(import.notes.is_empty(), "{:?}", import.notes);
        assert_eq!(import.doc.scenes[0].layers[0].keys[0].shapes, expected);
    }

    #[test]
    fn a_turned_image_keeps_its_matrix() {
        let body = "<DOMBitmapInstance libraryItemName=\"Bitmap 1\"><matrix><Matrix a=\"0\" b=\"1\" c=\"-1\" d=\"0\" tx=\"100\" ty=\"50\"/></matrix></DOMBitmapInstance>";
        let shapes = placed(body);
        match &shapes[0] {
            Shape::Bitmap {
                x,
                y,
                w,
                h,
                source,
                matrix,
            } => {
                assert_eq!((*x, *y), (0.0, 0.0));
                assert_eq!((*w, *h), (40.0, 20.0));
                assert_eq!(
                    *matrix,
                    Some(Affine {
                        a: 0.0,
                        b: 1.0,
                        c: -1.0,
                        d: 0.0,
                        e: 100.0,
                        f: 50.0
                    })
                );
                assert_eq!(*source, crate::media::data_url("png", &png(40, 20)));
            }
            other => panic!("expected a bitmap, got {other:?}"),
        }
    }

    #[test]
    fn a_stretched_image_bakes_its_scale_into_the_box() {
        let body = "<DOMBitmapInstance libraryItemName=\"Bitmap 1\"><matrix><Matrix a=\"2\" b=\"0\" c=\"0\" d=\"3\" tx=\"10\" ty=\"20\"/></matrix></DOMBitmapInstance>";
        let shapes = placed(body);
        match &shapes[0] {
            Shape::Bitmap {
                x,
                y,
                w,
                h,
                matrix,
                ..
            } => {
                assert_eq!((*x, *y, *w, *h), (10.0, 20.0, 80.0, 60.0));
                assert!(matrix.is_none());
            }
            other => panic!("expected a bitmap, got {other:?}"),
        }
    }

    #[test]
    fn a_flipped_image_keeps_the_flip_in_its_matrix() {
        let body = "<DOMBitmapInstance libraryItemName=\"Bitmap 1\"><matrix><Matrix a=\"-2\" b=\"0\" c=\"0\" d=\"1\" tx=\"100\" ty=\"20\"/></matrix></DOMBitmapInstance>";
        let shapes = placed(body);
        match &shapes[0] {
            Shape::Bitmap {
                x,
                y,
                w,
                h,
                matrix,
                ..
            } => {
                assert_eq!((*x, *y, *w, *h), (0.0, 0.0, 40.0, 20.0));
                let place = matrix.expect("matrix");
                assert_eq!((place.a, place.d, place.e, place.f), (-2.0, 1.0, 100.0, 20.0));
                crate::document::validate(&shapes[0]).expect("valid");
            }
            other => panic!("expected a bitmap, got {other:?}"),
        }
    }

    #[test]
    fn an_impossible_stretch_keeps_the_scale_in_its_matrix() {
        let body = "<DOMBitmapInstance libraryItemName=\"Bitmap 1\"><matrix><Matrix a=\"900\" b=\"0\" c=\"0\" d=\"1\" tx=\"10\" ty=\"20\"/></matrix></DOMBitmapInstance>";
        let shapes = placed(body);
        match &shapes[0] {
            Shape::Bitmap { w, h, matrix, .. } => {
                assert_eq!((*w, *h), (40.0, 20.0));
                assert_eq!(matrix.expect("matrix").a, 900.0);
                crate::document::validate(&shapes[0]).expect("valid");
            }
            other => panic!("expected a bitmap, got {other:?}"),
        }
    }

    #[test]
    fn placed_images_without_their_files_are_reported() {
        let body = "<DOMBitmapInstance libraryItemName=\"Bitmap 1\"><matrix><Matrix tx=\"10\" ty=\"20\"/></matrix></DOMBitmapInstance>\
            <DOMBitmapInstance libraryItemName=\"Gone\"><matrix><Matrix tx=\"30\" ty=\"40\"/></matrix></DOMBitmapInstance>";
        let item = "<DOMBitmapItem name=\"Bitmap 1\" href=\"Bitmap 1.png\" frameRight=\"800\" frameBottom=\"400\"/>";
        let import = parse(&media_stage(item, &art(&plain(0, 1, body))), "Imported", &[])
            .expect("parse");
        assert!(import.doc.scenes[0].layers[0].keys[0].shapes.is_empty());
        assert_eq!(
            import.notes,
            vec!["2 placed images that could not be read are skipped".to_string()]
        );
    }

    #[test]
    fn archive_member_selects_the_document() {
        let doc = fixture();
        let members = crate::fla::archive_members(&doc);
        let body = crate::fla::member_bytes(&members, xfl::DOM_DOCUMENT).expect("member");
        let text = String::from_utf8(body).expect("utf8");
        let import = parse(&text, "Round trip", &members).expect("parse");
        assert_eq!(import.doc.width, 320);
        assert_eq!(import.doc.scenes[0].layers[0].keys[0].shapes.len(), 1);
        assert!(crate::fla::member_bytes(&members, "Missing.xml").is_none());
    }

    #[test]
    fn oversized_documents_are_refused() {
        let huge = format!(
            "<DOMDocument width=\"{}\"></DOMDocument>",
            "1".repeat(PROJECT_LIMIT + 1)
        );
        assert_eq!(
            parse(&huge, "Imported", &[]).expect_err("size"),
            "the .xfl document is too large"
        );
    }

    #[test]
    fn grouped_edges_inherit_their_style() {
        let body = "<DOMShape><fills><FillStyle index=\"2\"><SolidColor color=\"#00ff00\"/></FillStyle></fills><edges><G fillStyle2=\"2\"><Edge edges=\"!0 0|40 0!40 0|40 40!40 40|0 40\"/></G></edges></DOMShape>";
        let doc = parsed(&stage_xml(&art(&plain(0, 1, body))));
        let (nodes, closed, fill) = path_of(&doc.scenes[0].layers[0].keys[0]);
        assert_eq!(fill, "#00ff00");
        assert!(closed);
        assert_eq!(nodes.len(), 4);
    }

    fn edges_of_xml(xml: &str) -> Vec<String> {
        xml.split("edges=\"")
            .skip(1)
            .map(|rest| rest.split('"').next().unwrap_or_default().to_string())
            .collect()
    }

    fn fixture() -> Document {
        Document {
            id: "d1".to_string(),
            name: "Round trip".to_string(),
            width: 320,
            height: 240,
            fps: 24,
            background: "#ffffff".to_string(),
            scenes: vec![Scene {
                id: "s1".to_string(),
                name: "Scene 1".to_string(),
                layers: vec![Layer {
                    id: "l1".to_string(),
                    name: "Art".to_string(),
                    visible: true,
                    locked: false,
                    opacity: 1.0,
                    blend: Blend::Normal,
                    effects: Vec::new(),
                    masked: false,
                    length: 6,
                    keys: vec![
                        Keyframe {
                            frame: 0,
                            shapes: vec![Shape::Rect {
                                x: 100.0,
                                y: 50.0,
                                w: 20.0,
                                h: 20.0,
                                fill: "#ff0000".to_string(),
                                stroke: "none".to_string(),
                                width: 0.0,
                                gradient: None,
                            }],
                            transform: Transform::default(),
                            tween: false,
                            easing: Easing::linear(),
                            label: None,
                        },
                        Keyframe {
                            frame: 3,
                            shapes: Vec::new(),
                            transform: Transform::default(),
                            tween: false,
                            easing: Easing::linear(),
                            label: None,
                        },
                    ],
                    folder: false,
                    children: Vec::new(),
                }],
            }],
            symbols: Vec::new(),
        }
    }
}
