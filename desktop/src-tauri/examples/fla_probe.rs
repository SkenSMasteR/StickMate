use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use stickmate_lib::document::{Document, Easing, Keyframe, Layer, Shape};
use stickmate_lib::fla;
use stickmate_lib::xfl;
use stickmate_lib::xfl_read;

const SHAPE_KINDS: [&str; 9] = [
    "Stroke", "Rect", "Ellipse", "Polygon", "Bitmap", "Text", "Path", "Group", "Figure",
];

#[derive(Default)]
struct Metrics {
    scenes: usize,
    layers: usize,
    keys: usize,
    tweens: usize,
    eased: usize,
    labels: usize,
    masks: usize,
    folders: usize,
    effects: usize,
    edge_nodes: usize,
    shapes: BTreeMap<String, usize>,
}

impl Metrics {
    fn of(doc: &Document) -> Metrics {
        let mut out = Metrics::default();
        out.scenes = doc.scenes.len();
        for scene in &doc.scenes {
            out.layers_of(&scene.layers);
        }
        out
    }

    fn layers_of(&mut self, layers: &[Layer]) {
        for layer in layers {
            self.layers += 1;
            self.effects += layer.effects.len();
            self.masks += usize::from(layer.masked);
            self.folders += usize::from(layer.folder);
            self.keys_of(&layer.keys);
            self.layers_of(&layer.children);
        }
    }

    fn keys_of(&mut self, keys: &[Keyframe]) {
        for key in keys {
            self.keys += 1;
            self.tweens += usize::from(key.tween);
            self.eased += usize::from(key.easing != Easing::linear());
            self.labels += usize::from(key.label.is_some());
            for shape in &key.shapes {
                self.shape(shape);
            }
        }
    }

    fn shape(&mut self, shape: &Shape) {
        match shape {
            Shape::Path { nodes, .. } => self.edge_nodes += nodes.len(),
            Shape::Group { children } => {
                for child in children {
                    self.shape(child);
                }
            }
            _ => {}
        }
        for kind in SHAPE_KINDS {
            let hit = match (kind, shape) {
                ("Stroke", Shape::Stroke { .. }) => true,
                ("Rect", Shape::Rect { .. }) => true,
                ("Ellipse", Shape::Ellipse { .. }) => true,
                ("Polygon", Shape::Polygon { .. }) => true,
                ("Bitmap", Shape::Bitmap { .. }) => true,
                ("Text", Shape::Text { .. }) => true,
                ("Path", Shape::Path { .. }) => true,
                ("Group", Shape::Group { .. }) => true,
                ("Figure", Shape::Figure { .. }) => true,
                _ => false,
            };
            if hit {
                *self.shapes.entry(kind.to_string()).or_insert(0) += 1;
            }
        }
    }

    fn push_rows(&self, out: &mut Vec<String>, prefix: &str) {
        out.push(format!("{prefix} scenes {}", self.scenes));
        out.push(format!("{prefix} layers {}", self.layers));
        out.push(format!("{prefix} keyframes {}", self.keys));
        out.push(format!("{prefix} tweens {}", self.tweens));
        out.push(format!("{prefix} eased {}", self.eased));
        out.push(format!("{prefix} labels {}", self.labels));
        out.push(format!("{prefix} masks {}", self.masks));
        out.push(format!("{prefix} folders {}", self.folders));
        out.push(format!("{prefix} effects {}", self.effects));
        out.push(format!("{prefix} edge_nodes {}", self.edge_nodes));
        for kind in SHAPE_KINDS {
            out.push(format!(
                "{prefix} shapes {kind} {}",
                self.shapes.get(kind).copied().unwrap_or(0)
            ));
        }
    }

    fn diff_rows(&self, other: &Metrics) -> Vec<String> {
        let mut mine = Vec::new();
        let mut theirs = Vec::new();
        self.push_rows(&mut mine, "");
        other.push_rows(&mut theirs, "");
        let mut out = Vec::new();
        for (before, after) in mine.iter().zip(theirs.iter()) {
            if before != after {
                out.push(format!("ROUNDTRIP{before} ->{after}"));
            }
        }
        out
    }
}

fn count_tag(text: &str, tag: &str) -> usize {
    let needle = format!("<{tag}");
    let mut out = 0;
    let mut at = 0;
    while let Some(found) = text[at..].find(&needle) {
        let next = text[at + found + needle.len()..].chars().next();
        if matches!(next, Some(' ') | Some('>') | Some('/')) {
            out += 1;
        }
        at += found + needle.len();
    }
    out
}

fn count_tag_with(text: &str, tag: &str, marker: &str) -> usize {
    let needle = format!("<{tag}");
    let mut out = 0;
    let mut at = 0;
    while let Some(found) = text[at..].find(&needle) {
        let start = at + found;
        let end = text[start..]
            .find('>')
            .map(|offset| start + offset)
            .unwrap_or(text.len());
        if text[start..end].contains(marker) {
            out += 1;
        }
        at = start + needle.len();
    }
    out
}

fn count_attr(text: &str, pair: &str) -> usize {
    let mut out = 0;
    let mut at = 0;
    while let Some(found) = text[at..].find(pair) {
        out += 1;
        at += found + pair.len();
    }
    out
}

fn census_text(members: &[(String, Vec<u8>)]) -> String {
    let mut out = String::new();
    for (name, body) in members {
        let keeps = name == xfl::DOM_DOCUMENT
            || (name.starts_with(xfl::LIBRARY_FOLDER) && name.ends_with(".xml"));
        if keeps {
            if let Ok(text) = String::from_utf8(body.clone()) {
                out.push_str(&text);
            }
        }
    }
    out
}

struct Census {
    values: BTreeMap<String, usize>,
}

impl Census {
    fn of(text: &str) -> Census {
        let mut values = BTreeMap::new();
        let mut put = |name: &str, value: usize| {
            values.insert(name.to_string(), value);
        };
        put("DOMSymbolItem", count_tag(text, "DOMSymbolItem"));
        put("Include", count_tag(text, "Include"));
        put("DOMSymbolInstance", count_tag(text, "DOMSymbolInstance"));
        put("DOMLayer", count_tag(text, "DOMLayer"));
        put("DOMLayerFolder", count_tag(text, "DOMLayerFolder"));
        put("DOMFrame", count_tag(text, "DOMFrame"));
        put("Edge", count_tag(text, "Edge"));
        put("EdgeCubics", count_tag_with(text, "Edge", "cubics=\""));
        put("FrameLabel", count_tag(text, "FrameLabel"));
        put("DOMStaticText", count_tag(text, "DOMStaticText"));
        put("DOMBitmapItem", count_tag(text, "DOMBitmapItem"));
        put("DOMSoundItem", count_tag(text, "DOMSoundItem"));
        put("SoundEnvelope", count_tag(text, "SoundEnvelope"));
        put("GlowFilter", count_tag(text, "GlowFilter"));
        put("BlurFilter", count_tag(text, "BlurFilter"));
        put("DropShadowFilter", count_tag(text, "DropShadowFilter"));
        put("WidthMarker", count_tag(text, "WidthMarker"));
        put("Ease", count_tag(text, "Ease"));
        put("MorphShape", count_tag(text, "MorphShape"));
        put("mask_layers", count_attr(text, "layerType=\"mask\""));
        put("masked_layers", count_attr(text, "layerType=\"masked\""));
        put("guide_layers", count_attr(text, "layerType=\"guide\""));
        put("motion_guide_layers", count_attr(text, "layerType=\"motion guide\""));
        put("depth_layers", count_attr(text, "layerType=\"depth\""));
        put("camera_layers", count_attr(text, "layerType=\"camera\""));
        put("key_mode_motion_22017", count_attr(text, "keyMode=\"22017\""));
        put("key_mode_motion_24065", count_attr(text, "keyMode=\"24065\""));
        put("key_mode_motion_17921", count_attr(text, "keyMode=\"17921\""));
        put("key_mode_shape_17922", count_attr(text, "keyMode=\"17922\""));
        put("key_mode_plain_9728", count_attr(text, "keyMode=\"9728\""));
        put("key_mode_other_8192", count_attr(text, "keyMode=\"8192\""));
        Census { values }
    }

    fn total(&self, keys: &[&str]) -> usize {
        keys.iter().map(|key| self.values.get(*key).copied().unwrap_or(0)).sum()
    }

    fn push_rows(&self, out: &mut Vec<String>) {
        for name in [
            "DOMSymbolItem",
            "Include",
            "DOMSymbolInstance",
            "DOMLayer",
            "DOMLayerFolder",
            "DOMFrame",
            "Edge",
            "EdgeCubics",
            "FrameLabel",
            "DOMStaticText",
            "DOMBitmapItem",
            "DOMSoundItem",
            "SoundEnvelope",
            "GlowFilter",
            "BlurFilter",
            "DropShadowFilter",
            "WidthMarker",
            "Ease",
            "MorphShape",
            "mask_layers",
            "masked_layers",
            "guide_layers",
            "motion_guide_layers",
            "depth_layers",
            "camera_layers",
            "key_mode_motion_22017",
            "key_mode_motion_24065",
            "key_mode_motion_17921",
            "key_mode_shape_17922",
            "key_mode_plain_9728",
            "key_mode_other_8192",
        ] {
            out.push(format!("CENSUS {name} {}", self.values.get(name).copied().unwrap_or(0)));
        }
    }
}

fn coverage_rows(census: &Census, metrics: &Metrics) -> Vec<(&'static str, usize, usize, usize)> {
    let texts = metrics.shapes.get("Text").copied().unwrap_or(0);
    vec![
        ("library_symbols", census.total(&["DOMSymbolItem", "Include"]), 0, 2),
        ("placements", census.total(&["DOMSymbolInstance"]), 0, 3),
        ("layers", census.total(&["DOMLayer"]), metrics.layers, 2),
        ("frames", census.total(&["DOMFrame"]), metrics.keys, 1),
        ("static_texts", census.total(&["DOMStaticText"]), texts, 3),
        ("edges", census.total(&["Edge"]), metrics.edge_nodes, 1),
        ("cubic_edges", census.total(&["EdgeCubics"]), 0, 1),
        ("frame_labels", census.total(&["FrameLabel"]), metrics.labels, 3),
        (
            "mask_layers",
            census.total(&["mask_layers", "masked_layers"]),
            metrics.masks,
            3,
        ),
        ("guide_layers", census.total(&["guide_layers", "motion_guide_layers"]), 0, 1),
        ("folder_layers", census.total(&["DOMLayerFolder"]), metrics.folders, 2),
        ("depth_layers", census.total(&["depth_layers"]), 0, 1),
        ("camera_layers", census.total(&["camera_layers"]), 0, 1),
        ("sounds", census.total(&["DOMSoundItem", "SoundEnvelope"]), 0, 1),
        (
            "filters",
            census.total(&["GlowFilter", "BlurFilter", "DropShadowFilter"]),
            metrics.effects,
            2,
        ),
        ("brush_widths", census.total(&["WidthMarker"]), 0, 2),
        (
            "motion_keys",
            census.total(&[
                "key_mode_motion_22017",
                "key_mode_motion_24065",
                "key_mode_motion_17921",
            ]),
            metrics.tweens,
            2,
        ),
        ("shape_keys", census.total(&["key_mode_shape_17922", "MorphShape"]), 0, 1),
        ("custom_easing", census.total(&["Ease"]), metrics.eased, 2),
    ]
}

fn score(rows: &[(&str, usize, usize, usize)]) -> f64 {
    let mut weight = 0.0;
    let mut carried = 0.0;
    for (_, total, landed, row_weight) in rows {
        if *total == 0 {
            continue;
        }
        let share = (*landed as f64 / *total as f64).min(1.0);
        carried += share * *row_weight as f64;
        weight += *row_weight as f64;
    }
    if weight == 0.0 {
        return 0.0;
    }
    carried / weight * 100.0
}

fn report(path: &Path) -> Vec<String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("input")
        .to_string();
    let bytes = fs::read(path).unwrap_or_else(|error| panic!("{path:?}: {error}"));
    let mut out = vec![format!("FILE {name}")];
    let members = if fla::is_zip(&bytes) {
        match fla::read_members(&bytes) {
            Ok(items) => items,
            Err(error) => {
                out.push(format!("ERROR {error}"));
                return out;
            }
        }
    } else {
        vec![(xfl::DOM_DOCUMENT.to_string(), bytes.clone())]
    };
    let text = census_text(&members);
    let census = Census::of(&text);
    census.push_rows(&mut out);
    let body = match fla::member_bytes(&members, xfl::DOM_DOCUMENT) {
        Some(body) => body,
        None => {
            out.push("ERROR DOMDocument.xml is missing".to_string());
            return out;
        }
    };
    let xml = match String::from_utf8(body) {
        Ok(text) => text,
        Err(error) => {
            out.push(format!("ERROR DOMDocument.xml is not readable text: {error}"));
            return out;
        }
    };
    let stem = Path::new(&name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("fixture")
        .to_string();
    let import = match xfl_read::parse(&xml, &stem, &members) {
        Ok(value) => value,
        Err(error) => {
            out.push(format!("ERROR import failed: {error}"));
            return out;
        }
    };
    let metrics = Metrics::of(&import.doc);
    out.push(format!("IMPORT members {}", members.len()));
    metrics.push_rows(&mut out, "IMPORT");
    out.push(format!("IMPORT notes {}", import.notes.len()));
    for note in &import.notes {
        out.push(format!("NOTE {note}"));
    }
    match fla::validate_import(&import.doc) {
        Ok(()) => out.push("VALID imported ok".to_string()),
        Err(error) => out.push(format!("VALID imported rejected {error}")),
    }
    let rows = coverage_rows(&census, &metrics);
    for (row, total, landed, weight) in &rows {
        out.push(format!("COVERAGE {row} {total} {landed} {weight}"));
    }
    out.push(format!("SCORE {:.2}", score(&rows)));
    let exported = xfl::document_xml(&import.doc);
    match xfl_read::parse(&exported, &stem, &[]) {
        Ok(again) => {
            let after = Metrics::of(&again.doc);
            let diffs = metrics.diff_rows(&after);
            if diffs.is_empty() {
                out.push("ROUNDTRIP same".to_string());
            } else {
                out.extend(diffs);
            }
        }
        Err(error) => out.push(format!("ROUNDTRIP ERROR {error}")),
    }
    out
}

fn fixture_paths(dir: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("fla"))
        .collect();
    entries.sort();
    entries
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut check: Option<PathBuf> = None;
    let mut write: Option<PathBuf> = None;
    let mut at = 0;
    while at < args.len() {
        match args[at].as_str() {
            "--check" => {
                at += 1;
                check = Some(PathBuf::from(&args[at]));
            }
            "--write" => {
                at += 1;
                write = Some(PathBuf::from(&args[at]));
            }
            other => paths.push(PathBuf::from(other)),
        }
        at += 1;
    }
    if paths.is_empty() {
        paths = fixture_paths(Path::new("tests/fixtures/fla"));
    }
    let mut lines = Vec::new();
    for path in &paths {
        lines.extend(report(path));
        lines.push(String::new());
    }
    lines.pop();
    let text = format!("{}\n", lines.join("\n"));
    if let Some(golden) = write {
        fs::create_dir_all(golden.parent().unwrap_or_else(|| Path::new(".")))
            .unwrap_or_else(|error| panic!("{}: {error}", golden.display()));
        fs::write(&golden, &text).unwrap_or_else(|error| panic!("{}: {error}", golden.display()));
        println!("wrote {}", golden.display());
        return;
    }
    print!("{text}");
    if let Some(golden) = check {
        let want = fs::read_to_string(&golden)
            .unwrap_or_else(|error| panic!("{}: {error}", golden.display()));
        if want != text {
            let want_lines: Vec<&str> = want.lines().collect();
            let got_lines: Vec<&str> = text.lines().collect();
            let shown = want_lines.len().max(got_lines.len()).min(12);
            for line in 0..shown {
                let left = want_lines.get(line).copied().unwrap_or("<end>");
                let right = got_lines.get(line).copied().unwrap_or("<end>");
                if left != right {
                    println!("DIFF line {}: want {left} got {right}", line + 1);
                }
            }
            println!("parity regression: output does not match {}", golden.display());
            std::process::exit(1);
        }
        println!("parity ok");
    }
}
