use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::document::{DocStore, Document, Scene};

const RUNTIME: &str = include_str!("../../src/export/runtime.js");
const PROJECT_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Html5,
    Canvasjs,
}

impl ExportFormat {
    fn suffix(self) -> &'static str {
        match self {
            Self::Html5 => "html5",
            Self::Canvasjs => "canvasjs",
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum ExportRange {
    Whole,
    Scene {
        scene_id: String,
    },
    Frames {
        scene_id: String,
        start: u32,
        end: u32,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportOptions {
    range: ExportRange,
    scale: f64,
    fps: u32,
    #[serde(rename = "loop")]
    looping: bool,
    transparent: bool,
}

#[derive(Serialize)]
pub struct ExportResult {
    pub path: String,
    pub files: Vec<String>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frames: u32,
}

#[derive(Debug)]
struct Package {
    json: String,
    width: u32,
    height: u32,
    fps: u32,
    frames: u32,
}

fn scene_length(scene: &Scene) -> u32 {
    scene
        .layers
        .iter()
        .map(|layer| layer.length)
        .max()
        .unwrap_or(1)
        .max(1)
}

fn build_package(doc: &Document, options: &ExportOptions) -> Result<Package, String> {
    if options.fps == 0 || options.fps > 60 {
        return Err("frame rate must be between 1 and 60".to_string());
    }
    if !options.scale.is_finite() || !(0.25..=4.0).contains(&options.scale) {
        return Err("resolution scale must be between 0.25 and 4".to_string());
    }
    let width = (doc.width as f64 * options.scale).round().max(1.0) as u32;
    let height = (doc.height as f64 * options.scale).round().max(1.0) as u32;
    if width > 16384 || height > 16384 {
        return Err("export resolution is too large".to_string());
    }
    let mut export = doc.clone();
    export.width = width;
    export.height = height;
    export.fps = options.fps;
    if options.transparent {
        export.background = String::new();
    }
    let mut start_frame = 0;
    let mut end_frame: Option<u32> = None;
    let frames;
    match &options.range {
        ExportRange::Whole => {
            frames = export.scenes.iter().map(scene_length).sum::<u32>().max(1);
        }
        ExportRange::Scene { scene_id } => {
            let index = export.scene_index(scene_id)?;
            export.scenes = vec![export.scenes[index].clone()];
            frames = scene_length(&export.scenes[0]);
        }
        ExportRange::Frames { scene_id, start, end } => {
            let index = export.scene_index(scene_id)?;
            let scene = export.scenes[index].clone();
            if end < start || *end >= scene_length(&scene) {
                return Err("frame range is invalid".to_string());
            }
            export.scenes = vec![scene];
            start_frame = *start;
            end_frame = Some(*end);
            frames = end - start + 1;
        }
    }
    let mut value = serde_json::to_value(&export).map_err(|error| error.to_string())?;
    let object = value.as_object_mut().expect("document is an object");
    object.insert("loop".to_string(), serde_json::json!(options.looping));
    object.insert("scale".to_string(), serde_json::json!(options.scale));
    object.insert("startFrame".to_string(), serde_json::json!(start_frame));
    object.insert("endFrame".to_string(), serde_json::json!(end_frame));
    let json = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    if json.len() > PROJECT_LIMIT {
        return Err("project is too large to export".to_string());
    }
    Ok(Package {
        json,
        width,
        height,
        fps: options.fps,
        frames,
    })
}

fn escape_html(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

fn sanitize_folder(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars().take(64) {
        if ch.is_control() || matches!(ch, '.' | '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('-');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim_end_matches(['-', ' ']);
    if trimmed.is_empty() {
        return "stickmate".to_string();
    }
    trimmed.to_string()
}

fn html_page(name: &str, json: &str, width: u32, height: u32) -> String {
    let title = escape_html(name);
    let embedded = json.replace('<', "\\u003c");
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>{title}</title>\n<style>body{{margin:0;display:flex;flex-direction:column;align-items:center;gap:12px;background:#18181b;color:#fafafa;font-family:system-ui,sans-serif}}h1{{font-size:16px;font-weight:600;margin:12px 0 0}}canvas{{border:1px solid #3f3f46;max-width:100%}}</style>\n</head>\n<body>\n<h1>{title}</h1>\n<canvas id=\"stage\" width=\"{width}\" height=\"{height}\"></canvas>\n<script id=\"stickmate-project\" type=\"application/json\">{embedded}</script>\n<script src=\"stickmate.js\"></script>\n<script>\nconst player = StickMate.load(JSON.parse(document.getElementById(\"stickmate-project\").textContent));\nplayer.mount(document.getElementById(\"stage\"));\nplayer.play();\n</script>\n</body>\n</html>\n"
    )
}

fn write_package(
    root: &Path,
    folder: &str,
    format: ExportFormat,
    package: &Package,
    name: &str,
) -> Result<(PathBuf, Vec<String>), String> {
    let dir = root.join(folder);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    fs::write(dir.join("stickmate.js"), RUNTIME).map_err(|error| error.to_string())?;
    fs::write(dir.join("project.json"), &package.json).map_err(|error| error.to_string())?;
    let mut files = vec!["stickmate.js".to_string(), "project.json".to_string()];
    if format == ExportFormat::Html5 {
        let page = html_page(name, &package.json, package.width, package.height);
        fs::write(dir.join("index.html"), page).map_err(|error| error.to_string())?;
        files.push("index.html".to_string());
    }
    Ok((dir, files))
}

#[tauri::command]
pub fn export_web(
    app: AppHandle,
    store: State<'_, DocStore>,
    id: String,
    format: ExportFormat,
    options: ExportOptions,
) -> Result<ExportResult, String> {
    let doc = store.get(&id)?;
    let package = build_package(&doc, &options)?;
    let root = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?
        .join("StickMate");
    let folder = format!("{}-{}", sanitize_folder(&doc.name), format.suffix());
    let (dir, files) = write_package(&root, &folder, format, &package, &doc.name)?;
    let path = dir.to_string_lossy().into_owned();
    app.opener()
        .open_path(path.clone(), None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(ExportResult {
        path,
        files,
        width: package.width,
        height: package.height,
        fps: package.fps,
        frames: package.frames,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::new_id;

    const PROJECT: &str = r##"{"id":"d0","name":"Export test","width":1280,"height":720,"fps":24,"background":"#ffffff","scenes":[{"id":"s0","name":"Scene 1","layers":[{"id":"l0","name":"Ball","visible":true,"locked":false,"opacity":1,"length":25,"keys":[{"frame":0,"shapes":[{"kind":"Ellipse","x":560,"y":80,"w":160,"h":160,"fill":"#3b82f6","stroke":"#000000","width":3}],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":true,"label":null},{"frame":12,"shapes":[{"kind":"Ellipse","x":560,"y":80,"w":160,"h":160,"fill":"#3b82f6","stroke":"#000000","width":3}],"transform":{"x":0,"y":400,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":"bottom"}]}]},{"id":"s1","name":"Scene 2","layers":[{"id":"l1","name":"Box","visible":true,"locked":false,"opacity":1,"length":5,"keys":[{"frame":0,"shapes":[{"kind":"Rect","x":10,"y":10,"w":50,"h":40,"fill":"#ff0000","stroke":"#000000","width":2}],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]}]}]}"##;

    fn doc() -> Document {
        serde_json::from_str(PROJECT).expect("project")
    }

    fn options(range: ExportRange) -> ExportOptions {
        ExportOptions {
            range,
            scale: 1.0,
            fps: 24,
            looping: true,
            transparent: false,
        }
    }

    fn value(package: &Package) -> serde_json::Value {
        serde_json::from_str(&package.json).expect("json")
    }

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("stickmate-export-{}", new_id("t")));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn html_escaping_blocks_script_injection() {
        let name = "<script>alert(1)</script>";
        let escaped = escape_html(name);
        assert_eq!(escaped, "&lt;script&gt;alert(1)&lt;/script&gt;");
        assert!(!escaped.contains('<'));
        assert!(!escaped.contains('>'));
        assert_eq!(escape_html("a&b\"c'd"), "a&amp;b&quot;c&#39;d");
        let package = build_package(&doc(), &options(ExportRange::Whole)).expect("package");
        let page = html_page(name, &package.json, 1280, 720);
        assert!(page.contains("<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>"));
        assert!(page.contains("<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>"));
        assert!(!page.contains("<script>alert(1)"));
    }

    #[test]
    fn embedded_json_cannot_break_out_of_the_script_tag() {
        let mut hostile = doc();
        hostile.name = "</script><script>alert(1)</script>".to_string();
        let package = build_package(&hostile, &options(ExportRange::Whole)).expect("package");
        let page = html_page(&hostile.name, &package.json, 1280, 720);
        assert!(!page.contains("</script><script>alert(1)"));
        let start = page.find("type=\"application/json\">").expect("json tag") + 24;
        let end = page[start..].find("</script>").expect("close tag") + start;
        let embedded = &page[start..end];
        assert!(!embedded.contains('<'));
        let parsed: serde_json::Value = serde_json::from_str(embedded).expect("valid json");
        assert_eq!(parsed["name"], hostile.name);
    }

    #[test]
    fn folder_names_are_safe_and_keep_spaces_and_unicode() {
        assert_eq!(sanitize_folder("my film"), "my film");
        assert_eq!(sanitize_folder("Животна 2"), "Животна 2");
        assert_eq!(sanitize_folder("a/b\\c:d*e?f\"g<h>i|j"), "a-b-c-d-e-f-g-h-i-j");
        assert_eq!(sanitize_folder("../.."), "stickmate");
        assert_eq!(sanitize_folder(".."), "stickmate");
        assert_eq!(sanitize_folder("   "), "stickmate");
        assert_eq!(sanitize_folder("name."), "name");
        assert_eq!(sanitize_folder("name. "), "name");
        assert_eq!(sanitize_folder("a\u{0}b"), "a-b");
        assert_eq!(sanitize_folder(&"x".repeat(200)).chars().count(), 64);
        for name in ["../../etc", "C:\\Windows", "a/../b", "..\\..\\x"] {
            let folder = format!("{}-html5", sanitize_folder(name));
            assert!(!folder.contains('/'));
            assert!(!folder.contains('\\'));
            assert!(!folder.contains(".."));
            assert!(!folder.contains(':'));
        }
    }

    #[test]
    fn whole_project_keeps_every_scene() {
        let package = build_package(&doc(), &options(ExportRange::Whole)).expect("package");
        assert_eq!(package.frames, 30);
        let json = value(&package);
        assert_eq!(json["scenes"].as_array().expect("scenes").len(), 2);
        assert_eq!(json["startFrame"], 0);
        assert_eq!(json["endFrame"], serde_json::Value::Null);
        assert_eq!(json["loop"], true);
        assert_eq!(json["scale"], 1.0);
    }

    #[test]
    fn scene_range_keeps_only_that_scene() {
        let package = build_package(
            &doc(),
            &options(ExportRange::Scene { scene_id: "s1".to_string() }),
        )
        .expect("package");
        assert_eq!(package.frames, 5);
        let json = value(&package);
        let scenes = json["scenes"].as_array().expect("scenes");
        assert_eq!(scenes.len(), 1);
        assert_eq!(scenes[0]["id"], "s1");
        assert!(build_package(
            &doc(),
            &options(ExportRange::Scene { scene_id: "nope".to_string() })
        )
        .is_err());
    }

    #[test]
    fn frame_range_records_its_bounds() {
        let package = build_package(
            &doc(),
            &options(ExportRange::Frames {
                scene_id: "s0".to_string(),
                start: 4,
                end: 16,
            }),
        )
        .expect("package");
        assert_eq!(package.frames, 13);
        let json = value(&package);
        assert_eq!(json["startFrame"], 4);
        assert_eq!(json["endFrame"], 16);
        assert_eq!(json["scenes"].as_array().expect("scenes").len(), 1);
        assert_eq!(
            json["scenes"][0]["layers"][0]["keys"],
            serde_json::to_value(&doc().scenes[0].layers[0].keys).expect("keys")
        );
        for (start, end) in [(16, 4), (0, 25), (0, 99)] {
            assert_eq!(
                build_package(
                    &doc(),
                    &options(ExportRange::Frames {
                        scene_id: "s0".to_string(),
                        start,
                        end
                    })
                )
                .expect_err("range"),
                "frame range is invalid"
            );
        }
    }

    #[test]
    fn scale_fps_loop_and_transparency_change_the_output() {
        let base = build_package(&doc(), &options(ExportRange::Whole)).expect("base");
        let mut scaled_options = options(ExportRange::Whole);
        scaled_options.scale = 0.5;
        let scaled = build_package(&doc(), &scaled_options).expect("scaled");
        assert_eq!((scaled.width, scaled.height), (640, 360));
        assert_eq!(value(&scaled)["scale"], 0.5);
        assert_ne!(base.json, scaled.json);
        scaled_options.scale = 2.0;
        let doubled = build_package(&doc(), &scaled_options).expect("doubled");
        assert_eq!((doubled.width, doubled.height), (2560, 1440));
        let mut fast = options(ExportRange::Whole);
        fast.fps = 60;
        let fast = build_package(&doc(), &fast).expect("fast");
        assert_eq!(fast.fps, 60);
        assert_eq!(value(&fast)["fps"], 60);
        let mut once = options(ExportRange::Whole);
        once.looping = false;
        assert_eq!(value(&build_package(&doc(), &once).expect("once"))["loop"], false);
        let mut clear = options(ExportRange::Whole);
        clear.transparent = true;
        assert_eq!(
            value(&build_package(&doc(), &clear).expect("clear"))["background"],
            ""
        );
        assert_eq!(value(&base)["background"], "#ffffff");
    }

    #[test]
    fn invalid_scale_and_fps_are_rejected() {
        for scale in [0.0, 0.1, 5.0, f64::NAN, f64::INFINITY] {
            let mut bad = options(ExportRange::Whole);
            bad.scale = scale;
            assert_eq!(
                build_package(&doc(), &bad).expect_err("scale"),
                "resolution scale must be between 0.25 and 4"
            );
        }
        for fps in [0, 61] {
            let mut bad = options(ExportRange::Whole);
            bad.fps = fps;
            assert_eq!(
                build_package(&doc(), &bad).expect_err("fps"),
                "frame rate must be between 1 and 60"
            );
        }
        let mut huge = options(ExportRange::Whole);
        huge.scale = 4.0;
        let mut wide = doc();
        wide.width = 8192;
        assert_eq!(
            build_package(&wide, &huge).expect_err("resolution"),
            "export resolution is too large"
        );
    }

    #[test]
    fn oversized_projects_are_capped() {
        let mut heavy = doc();
        heavy.scenes[0].layers[0].keys[0].shapes = vec![crate::document::Shape::Text {
            x: 0.0,
            y: 0.0,
            text: "x".repeat(PROJECT_LIMIT + 1),
            size: 12.0,
            family: "Segoe UI".to_string(),
            color: "#000000".to_string(),
            spacing: 0.0,
            leading: crate::document::TEXT_LEADING,
            align: crate::document::TextAlign::Left,
            matrix: None,
        }];
        assert_eq!(
            build_package(&heavy, &options(ExportRange::Whole)).expect_err("size"),
            "project is too large to export"
        );
    }

    #[test]
    fn html5_package_contains_a_runnable_page() {
        let root = temp_root();
        let package = build_package(&doc(), &options(ExportRange::Whole)).expect("package");
        let (dir, files) =
            write_package(&root, "Export test-html5", ExportFormat::Html5, &package, "Export test")
                .expect("write");
        assert_eq!(files, vec!["stickmate.js", "project.json", "index.html"]);
        assert!(dir.starts_with(&root));
        assert_eq!(
            fs::read_to_string(dir.join("stickmate.js")).expect("runtime"),
            RUNTIME
        );
        assert_eq!(
            fs::read_to_string(dir.join("project.json")).expect("json"),
            package.json
        );
        let page = fs::read_to_string(dir.join("index.html")).expect("page");
        assert!(page.contains("<title>Export test</title>"));
        assert!(page.contains("width=\"1280\" height=\"720\""));
        assert!(page.contains("src=\"stickmate.js\""));
        assert!(page.contains("player.play();"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn canvasjs_package_has_no_page() {
        let root = temp_root();
        let package = build_package(&doc(), &options(ExportRange::Whole)).expect("package");
        let (dir, files) = write_package(
            &root,
            "Export test-canvasjs",
            ExportFormat::Canvasjs,
            &package,
            "Export test",
        )
        .expect("write");
        assert_eq!(files, vec!["stickmate.js", "project.json"]);
        assert!(!dir.join("index.html").exists());
        assert_eq!(
            fs::read_to_string(dir.join("stickmate.js")).expect("runtime"),
            RUNTIME
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reexport_replaces_only_package_files_and_stays_inside_the_root() {
        let root = temp_root();
        let folder = format!("{}-html5", sanitize_folder("../../my film"));
        let dir = root.join(&folder);
        fs::create_dir_all(&dir).expect("existing folder");
        fs::write(dir.join("keep.txt"), "unrelated").expect("unrelated file");
        fs::write(dir.join("index.html"), "stale page").expect("stale page");
        let package = build_package(&doc(), &options(ExportRange::Whole)).expect("package");
        let (written, files) =
            write_package(&root, &folder, ExportFormat::Html5, &package, "../../my film")
                .expect("write");
        assert_eq!(written, dir);
        assert!(written.starts_with(&root));
        assert_eq!(files.len(), 3);
        assert_eq!(
            fs::read_to_string(dir.join("keep.txt")).expect("kept"),
            "unrelated"
        );
        assert!(fs::read_to_string(dir.join("index.html"))
            .expect("page")
            .contains("<!doctype html>"));
        let entries: Vec<String> = fs::read_dir(&dir)
            .expect("entries")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries.len(), 4);
        let outside = root.parent().expect("parent").join(format!("{folder}-leak"));
        assert!(!outside.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn options_deserialize_from_the_frontend_shape() {
        let options: ExportOptions = serde_json::from_str(
            r#"{"range":{"kind":"frames","sceneId":"s0","start":1,"end":9},"scale":2,"fps":30,"loop":false,"transparent":true}"#,
        )
        .expect("options");
        assert!(matches!(options.range, ExportRange::Frames { .. }));
        assert_eq!(options.fps, 30);
        assert!(!options.looping);
        assert!(options.transparent);
        let format: ExportFormat = serde_json::from_str("\"html5\"").expect("format");
        assert_eq!(format, ExportFormat::Html5);
        assert!(serde_json::from_str::<ExportFormat>("\"mp4\"").is_err());
        assert!(serde_json::from_str::<ExportOptions>(
            r#"{"range":{"kind":"whole"},"scale":1,"fps":24,"loop":true,"transparent":false,"codec":"h264"}"#
        )
        .is_err());
    }
}