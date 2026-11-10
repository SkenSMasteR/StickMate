use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::document::{self, DocStore, Document};

const RAW_BASE: &str = "https://raw.githubusercontent.com/SkenSMasteR/StickMate/templates/";
const CATALOG_LIMIT: usize = 256 * 1024;
const PREVIEW_LIMIT: usize = 512 * 1024;
const PROJECT_LIMIT: usize = 8 * 1024 * 1024;
const FOLDER_LIMIT: usize = 64;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogFile {
    templates: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub description: String,
    pub preview: String,
    pub project: String,
    pub version: String,
    pub min_app_version: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

#[derive(Serialize)]
pub struct TemplateEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub min_app_version: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub supported: bool,
    pub project_cached: bool,
}

#[derive(Serialize)]
pub struct TemplateCatalog {
    pub cached: bool,
    pub templates: Vec<TemplateEntry>,
}

fn valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn safe_path(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 128
        || value.starts_with('/')
        || value.contains('\\')
        || value.contains(':')
    {
        return false;
    }
    value.split('/').all(|segment| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b'.')
    })
}

fn parse_version(value: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut numbers = [0u32; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || part.len() > 6 || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        numbers[index] = part.parse().ok()?;
    }
    Some((numbers[0], numbers[1], numbers[2]))
}

fn supported(min_app_version: &str) -> bool {
    match (
        parse_version(min_app_version),
        parse_version(env!("CARGO_PKG_VERSION")),
    ) {
        (Some(needed), Some(current)) => needed <= current,
        _ => false,
    }
}

fn check_size(size: usize, limit: usize) -> Result<(), String> {
    if size > limit {
        return Err("template file is too large".to_string());
    }
    Ok(())
}

fn raw_url(relative: &str) -> Result<String, String> {
    if !safe_path(relative) {
        return Err("template path is invalid".to_string());
    }
    let base = reqwest::Url::parse(RAW_BASE).map_err(|error| error.to_string())?;
    let url = base.join(relative).map_err(|error| error.to_string())?;
    if !url.as_str().starts_with(RAW_BASE) {
        return Err("template path is invalid".to_string());
    }
    Ok(url.to_string())
}

fn parse_catalog(bytes: &[u8]) -> Result<Vec<String>, String> {
    let file: CatalogFile =
        serde_json::from_slice(bytes).map_err(|_| "template catalog is invalid".to_string())?;
    if file.templates.len() > FOLDER_LIMIT {
        return Err("template catalog is invalid".to_string());
    }
    let mut folders: Vec<String> = Vec::new();
    for folder in file.templates {
        if !valid_id(&folder) || folders.contains(&folder) {
            return Err("template catalog is invalid".to_string());
        }
        folders.push(folder);
    }
    Ok(folders)
}

fn parse_manifest(folder: &str, bytes: &[u8]) -> Result<Manifest, String> {
    let invalid = format!("template {folder} is invalid");
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|_| invalid.clone())?;
    if manifest.id != folder || !valid_id(&manifest.id) {
        return Err(invalid);
    }
    if manifest.name.trim().is_empty() || manifest.description.trim().is_empty() {
        return Err(invalid);
    }
    if !safe_path(&manifest.preview) || !manifest.preview.ends_with(".svg") {
        return Err(invalid);
    }
    if !safe_path(&manifest.project) || !manifest.project.ends_with(".json") {
        return Err(invalid);
    }
    if parse_version(&manifest.version).is_none() || parse_version(&manifest.min_app_version).is_none()
    {
        return Err(invalid);
    }
    if manifest.width == 0
        || manifest.height == 0
        || manifest.width > 8192
        || manifest.height > 8192
        || manifest.fps == 0
        || manifest.fps > 60
    {
        return Err(invalid);
    }
    Ok(manifest)
}

fn validate_preview(text: &str) -> Result<(), String> {
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    let invalid = "template preview is invalid".to_string();
    if !trimmed.starts_with("<svg") || !trimmed.contains("http://www.w3.org/2000/svg") {
        return Err(invalid);
    }
    let lower = trimmed.to_lowercase();
    for token in [
        "<script",
        "href=",
        "url(",
        "<image",
        "<foreignobject",
        "<use",
        "data:",
    ] {
        if lower.contains(token) {
            return Err(invalid);
        }
    }
    Ok(())
}

fn preview_url(text: &str) -> String {
    let mut url = String::from("data:image/svg+xml;charset=utf-8,");
    for byte in text.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            url.push(*byte as char);
        } else {
            url.push_str(&format!("%{byte:02X}"));
        }
    }
    url
}

fn validate_layers(
    layers: &[document::Layer],
    ids: &mut Vec<String>,
    invalid: &str,
) -> Result<(), String> {
    for layer in layers {
        if layer.id.is_empty() || ids.contains(&layer.id) {
            return Err(invalid.to_string());
        }
        ids.push(layer.id.clone());
        if layer.folder {
            if !layer.keys.is_empty() {
                return Err(invalid.to_string());
            }
            validate_layers(&layer.children, ids, invalid)?;
            continue;
        }
        if layer.keys.is_empty() {
            return Err(invalid.to_string());
        }
        for (index, key) in layer.keys.iter().enumerate() {
            let ordered = if index == 0 {
                key.frame == 0
            } else {
                key.frame > layer.keys[index - 1].frame
            };
            if !ordered || key.frame >= layer.length {
                return Err(invalid.to_string());
            }
            let transform = &key.transform;
            if !transform.x.is_finite()
                || !transform.y.is_finite()
                || !transform.rotation.is_finite()
                || !transform.scale.is_finite()
                || transform.scale <= 0.0
                || !transform.opacity.is_finite()
                || !(0.0..=1.0).contains(&transform.opacity)
            {
                return Err("template project transform is invalid".to_string());
            }
            for shape in &key.shapes {
                document::validate(shape)?;
            }
        }
    }
    Ok(())
}

fn validate_document(doc: &Document) -> Result<(), String> {
    let invalid = "template project is invalid".to_string();
    if doc.width == 0 || doc.height == 0 || doc.width > 8192 || doc.height > 8192 {
        return Err("template project resolution is invalid".to_string());
    }
    if doc.fps == 0 || doc.fps > 60 {
        return Err("template project frame rate is invalid".to_string());
    }
    if doc.scenes.is_empty() {
        return Err(invalid);
    }
    let mut scenes: Vec<&str> = Vec::new();
    for scene in &doc.scenes {
        if scene.id.is_empty() || scenes.contains(&scene.id.as_str()) || scene.layers.is_empty() {
            return Err(invalid);
        }
        scenes.push(&scene.id);
        let mut ids: Vec<String> = Vec::new();
        validate_layers(&scene.layers, &mut ids, &invalid)?;
    }
    Ok(())
}

fn install(store: &DocStore, manifest: &Manifest, mut doc: Document) -> Result<String, String> {
    validate_document(&doc)?;
    if doc.width != manifest.width || doc.height != manifest.height || doc.fps != manifest.fps {
        return Err("template project does not match its manifest".to_string());
    }
    let created = store.create(
        manifest.name.clone(),
        doc.width,
        doc.height,
        doc.fps,
        doc.background.clone(),
    )?;
    doc.id = created.id.clone();
    doc.name = manifest.name.clone();
    store.edit(&created.id, move |target| {
        *target = doc;
        Ok(())
    })?;
    Ok(created.id)
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("templates");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

async fn template_bytes(
    app: &AppHandle,
    relative: &str,
    limit: usize,
) -> Result<(Vec<u8>, bool), String> {
    let url = raw_url(relative)?;
    let target = cache_dir(app)?.join(relative);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if let Ok(response) = reqwest::Client::new().get(url).send().await {
        if response.status().is_success() {
            if response
                .content_length()
                .map_or(false, |size| size > limit as u64)
            {
                return Err("template file is too large".to_string());
            }
            let bytes = response.bytes().await.map_err(|error| error.to_string())?;
            check_size(bytes.len(), limit)?;
            fs::write(&target, &bytes).map_err(|error| error.to_string())?;
            return Ok((bytes.to_vec(), false));
        }
    }
    let bytes = fs::read(&target).map_err(|_| "templates could not be loaded".to_string())?;
    check_size(bytes.len(), limit)?;
    Ok((bytes, true))
}

async fn load_manifest(app: &AppHandle, id: &str) -> Result<Manifest, String> {
    if !valid_id(id) {
        return Err("template id is invalid".to_string());
    }
    let relative = format!("{id}/manifest.json");
    let (bytes, _) = template_bytes(app, &relative, CATALOG_LIMIT).await?;
    parse_manifest(id, &bytes)
}

#[tauri::command]
pub async fn templates_catalog(app: AppHandle) -> Result<TemplateCatalog, String> {
    let (bytes, mut cached) = template_bytes(&app, "catalog.json", CATALOG_LIMIT).await?;
    let folders = parse_catalog(&bytes)?;
    let dir = cache_dir(&app)?;
    let mut templates = Vec::new();
    for folder in folders {
        let relative = format!("{folder}/manifest.json");
        let (manifest_bytes, from_cache) = template_bytes(&app, &relative, CATALOG_LIMIT).await?;
        cached = cached || from_cache;
        let manifest = parse_manifest(&folder, &manifest_bytes)?;
        let project_cached = dir.join(&folder).join(&manifest.project).exists();
        let supported = supported(&manifest.min_app_version);
        templates.push(TemplateEntry {
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            version: manifest.version,
            min_app_version: manifest.min_app_version,
            width: manifest.width,
            height: manifest.height,
            fps: manifest.fps,
            supported,
            project_cached,
        });
    }
    Ok(TemplateCatalog { cached, templates })
}

#[tauri::command]
pub async fn templates_preview(app: AppHandle, id: String) -> Result<String, String> {
    let manifest = load_manifest(&app, &id).await?;
    let relative = format!("{id}/{}", manifest.preview);
    let (bytes, _) = template_bytes(&app, &relative, PREVIEW_LIMIT).await?;
    let text = String::from_utf8(bytes).map_err(|_| "template preview is invalid".to_string())?;
    validate_preview(&text)?;
    Ok(preview_url(&text))
}

#[tauri::command]
pub async fn templates_open(
    app: AppHandle,
    store: State<'_, DocStore>,
    id: String,
) -> Result<String, String> {
    let manifest = load_manifest(&app, &id).await?;
    if !supported(&manifest.min_app_version) {
        return Err("template needs a newer app version".to_string());
    }
    let relative = format!("{id}/{}", manifest.project);
    let (bytes, _) = template_bytes(&app, &relative, PROJECT_LIMIT).await?;
    let doc: Document =
        serde_json::from_slice(&bytes).map_err(|_| "template project is invalid".to_string())?;
    install(&store, &manifest, doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLANK_PROJECT: &str = r##"{"id":"d0","name":"Blank stage","width":1920,"height":1080,"fps":30,"background":"#ffffff","scenes":[{"id":"s0","name":"Scene 1","layers":[{"id":"l0","name":"Layer 1","visible":true,"locked":false,"opacity":1,"length":1,"keys":[{"frame":0,"shapes":[],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]}]}]}"##;
    const BALL_PROJECT: &str = r##"{"id":"d0","name":"Bouncing ball","width":1280,"height":720,"fps":24,"background":"#ffffff","scenes":[{"id":"s0","name":"Scene 1","layers":[{"id":"l0","name":"Ball","visible":true,"locked":false,"opacity":1,"length":25,"keys":[{"frame":0,"shapes":[{"kind":"Ellipse","x":560,"y":80,"w":160,"h":160,"fill":"#3b82f6","stroke":"#000000","width":3}],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":true,"label":null},{"frame":12,"shapes":[{"kind":"Ellipse","x":560,"y":80,"w":160,"h":160,"fill":"#3b82f6","stroke":"#000000","width":3}],"transform":{"x":0,"y":400,"rotation":0,"scale":1,"opacity":1},"tween":true,"label":null},{"frame":24,"shapes":[{"kind":"Ellipse","x":560,"y":80,"w":160,"h":160,"fill":"#3b82f6","stroke":"#000000","width":3}],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]}]}]}"##;
    const WALK_PROJECT: &str = r##"{"id":"d0","name":"Walk cycle","width":1080,"height":1080,"fps":12,"background":"#ffffff","scenes":[{"id":"s0","name":"Scene 1","layers":[{"id":"l0","name":"Head","visible":true,"locked":false,"opacity":1,"length":1,"keys":[{"frame":0,"shapes":[],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]},{"id":"l1","name":"Arms","visible":true,"locked":false,"opacity":1,"length":1,"keys":[{"frame":0,"shapes":[],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]},{"id":"l2","name":"Body","visible":true,"locked":false,"opacity":1,"length":1,"keys":[{"frame":0,"shapes":[],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]},{"id":"l3","name":"Legs","visible":true,"locked":false,"opacity":1,"length":1,"keys":[{"frame":0,"shapes":[],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]}]}]}"##;
    const BALL_MANIFEST: &str = r##"{"id":"ball","name":"Bouncing ball","description":"A tweened ball you can play right away.","preview":"preview.svg","project":"project.json","version":"1.0.0","min_app_version":"0.1.0","width":1280,"height":720,"fps":24}"##;
    const PREVIEW: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#ffffff"/><circle cx="140" cy="128" r="22" fill="#3b82f6"/></svg>"##;

    fn manifest_value() -> serde_json::Value {
        serde_json::from_str(BALL_MANIFEST).expect("manifest")
    }

    fn bytes(value: &serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(value).expect("serialize")
    }

    fn project(value: &serde_json::Value) -> Document {
        serde_json::from_value(value.clone()).expect("document")
    }

    fn ball_value() -> serde_json::Value {
        serde_json::from_str(BALL_PROJECT).expect("project")
    }

    #[test]
    fn folder_ids_follow_the_pattern() {
        let longest = "b".repeat(64);
        let too_long = "b".repeat(65);
        for id in ["blank", "ball", "walk", "a", "0", "walk-cycle-2", longest.as_str()] {
            assert!(valid_id(id), "{id}");
        }
        for id in [
            "",
            "-ball",
            "Ball",
            "walk cycle",
            "walk_cycle",
            "../walk",
            "walk.svg",
            too_long.as_str(),
        ] {
            assert!(!valid_id(id), "{id}");
        }
    }

    #[test]
    fn paths_stay_inside_the_template_folder() {
        for path in ["preview.svg", "project.json", "art/preview.svg", "a-b_1.2.json"] {
            assert!(safe_path(path), "{path}");
        }
        for path in [
            "",
            "/project.json",
            "../project.json",
            "art/../../project.json",
            "./project.json",
            "art//preview.svg",
            "art/",
            "C:/project.json",
            "C:\\project.json",
            "art\\preview.svg",
            "https://example.com/project.json",
            "%2e%2e/project.json",
            "art/../preview.svg",
            "pro ject.json",
        ] {
            assert!(!safe_path(path), "{path}");
        }
    }

    #[test]
    fn catalog_lists_unique_folders() {
        let folders = parse_catalog(br#"{"templates":["blank","ball","walk"]}"#).expect("catalog");
        assert_eq!(folders, vec!["blank", "ball", "walk"]);
        assert!(parse_catalog(br#"{"templates":[]}"#).expect("empty").is_empty());
        for body in [
            r#"{"templates":["blank","blank"]}"#,
            r#"{"templates":["../blank"]}"#,
            r#"{"templates":["Blank"]}"#,
            r#"{"folders":["blank"]}"#,
            r#"{"templates":"blank"}"#,
            r#"not json"#,
        ] {
            assert_eq!(
                parse_catalog(body.as_bytes()).expect_err("catalog"),
                "template catalog is invalid"
            );
        }
        let many: Vec<String> = (0..FOLDER_LIMIT + 1).map(|index| format!("t{index}")).collect();
        let body = serde_json::to_vec(&serde_json::json!({ "templates": many })).expect("serialize");
        assert!(parse_catalog(&body).is_err());
    }

    #[test]
    fn manifest_must_match_its_folder() {
        let manifest = parse_manifest("ball", BALL_MANIFEST.as_bytes()).expect("manifest");
        assert_eq!(manifest.id, "ball");
        assert_eq!(manifest.width, 1280);
        assert_eq!(manifest.height, 720);
        assert_eq!(manifest.fps, 24);
        assert_eq!(manifest.preview, "preview.svg");
        assert_eq!(manifest.project, "project.json");
        assert!(parse_manifest("walk", BALL_MANIFEST.as_bytes()).is_err());
        let mut value = manifest_value();
        value["name"] = serde_json::json!("   ");
        assert!(parse_manifest("ball", &bytes(&value)).is_err());
        let mut value = manifest_value();
        value["extra"] = serde_json::json!(true);
        assert!(parse_manifest("ball", &bytes(&value)).is_err());
    }

    #[test]
    fn manifest_rejects_bad_paths_and_versions() {
        for field in ["preview", "project"] {
            for path in ["../evil.svg", "/etc/passwd", "https://example.com/a.svg", "a\\b.svg"] {
                let mut value = manifest_value();
                value[field] = serde_json::json!(path);
                assert_eq!(
                    parse_manifest("ball", &bytes(&value)).expect_err("path"),
                    "template ball is invalid"
                );
            }
        }
        let mut value = manifest_value();
        value["preview"] = serde_json::json!("preview.png");
        assert!(parse_manifest("ball", &bytes(&value)).is_err());
        let mut value = manifest_value();
        value["project"] = serde_json::json!("project.txt");
        assert!(parse_manifest("ball", &bytes(&value)).is_err());
        for field in ["version", "min_app_version"] {
            for version in ["1.0", "1.0.0.0", "a.b.c", "1.0.-1", ""] {
                let mut value = manifest_value();
                value[field] = serde_json::json!(version);
                assert!(parse_manifest("ball", &bytes(&value)).is_err(), "{field} {version}");
            }
        }
        for (field, number) in [("width", 0), ("height", 9000), ("fps", 0), ("fps", 61)] {
            let mut value = manifest_value();
            value[field] = serde_json::json!(number);
            assert!(parse_manifest("ball", &bytes(&value)).is_err(), "{field}");
        }
    }

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(parse_version("1.20.3"), Some((1, 20, 3)));
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("1.2.x"), None);
        assert_eq!(parse_version("1.2.9999999"), None);
        assert!(supported("0.0.1"));
        assert!(supported(env!("CARGO_PKG_VERSION")));
        assert!(!supported("99.0.0"));
        assert!(!supported("0.999.0"));
        assert!(!supported("nonsense"));
    }

    #[test]
    fn urls_stay_under_the_templates_branch() {
        assert_eq!(
            raw_url("ball/preview.svg").expect("url"),
            format!("{RAW_BASE}ball/preview.svg")
        );
        assert_eq!(raw_url("catalog.json").expect("url"), format!("{RAW_BASE}catalog.json"));
        for path in ["../secret.json", "/etc/passwd", "https://example.com/a.json", "a\\b.json"] {
            assert_eq!(raw_url(path).expect_err("url"), "template path is invalid");
        }
    }

    #[test]
    fn size_caps_are_enforced() {
        assert!(check_size(CATALOG_LIMIT, CATALOG_LIMIT).is_ok());
        assert!(check_size(PREVIEW_LIMIT, PREVIEW_LIMIT).is_ok());
        assert!(check_size(PROJECT_LIMIT, PROJECT_LIMIT).is_ok());
        for (size, limit) in [
            (CATALOG_LIMIT + 1, CATALOG_LIMIT),
            (PREVIEW_LIMIT + 1, PREVIEW_LIMIT),
            (PROJECT_LIMIT + 1, PROJECT_LIMIT),
        ] {
            assert_eq!(
                check_size(size, limit).expect_err("size"),
                "template file is too large"
            );
        }
        assert_eq!(CATALOG_LIMIT, 262144);
        assert_eq!(PREVIEW_LIMIT, 524288);
        assert_eq!(PROJECT_LIMIT, 8388608);
    }

    #[test]
    fn previews_must_be_safe_svg() {
        validate_preview(PREVIEW).expect("preview");
        let url = preview_url(PREVIEW);
        assert!(url.starts_with("data:image/svg+xml;charset=utf-8,%3Csvg%20"));
        assert!(!url.contains('<'));
        assert!(!url.contains('"'));
        for body in [
            "<html></html>",
            r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"><rect/></a></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AA"/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#g)"/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>hi</p></foreignObject></svg>"#,
        ] {
            assert_eq!(
                validate_preview(body).expect_err("preview"),
                "template preview is invalid"
            );
        }
    }

    #[test]
    fn published_projects_deserialize_into_documents() {
        let blank: Document = serde_json::from_str(BLANK_PROJECT).expect("blank");
        validate_document(&blank).expect("valid");
        assert_eq!((blank.width, blank.height, blank.fps), (1920, 1080, 30));
        assert_eq!(blank.background, "#ffffff");
        assert_eq!(blank.scenes.len(), 1);
        assert_eq!(blank.scenes[0].layers[0].name, "Layer 1");
        assert_eq!(blank.scenes[0].layers[0].length, 1);

        let ball: Document = serde_json::from_str(BALL_PROJECT).expect("ball");
        validate_document(&ball).expect("valid");
        assert_eq!((ball.width, ball.height, ball.fps), (1280, 720, 24));
        let layer = &ball.scenes[0].layers[0];
        assert_eq!(layer.name, "Ball");
        assert_eq!(layer.length, 25);
        assert_eq!(
            layer.keys.iter().map(|key| key.frame).collect::<Vec<_>>(),
            vec![0, 12, 24]
        );
        assert_eq!(
            layer.keys.iter().map(|key| key.tween).collect::<Vec<_>>(),
            vec![true, true, false]
        );
        assert_eq!(
            layer.keys.iter().map(|key| key.transform.y).collect::<Vec<_>>(),
            vec![0.0, 400.0, 0.0]
        );
        for key in &layer.keys {
            assert_eq!(key.shapes.len(), 1);
            assert!(matches!(
                &key.shapes[0],
                document::Shape::Ellipse { fill, x, y, w, h, width, .. }
                    if fill == "#3b82f6" && *x == 560.0 && *y == 80.0 && *w == 160.0 && *h == 160.0 && *width == 3.0
            ));
        }
        let middle = ball.evaluate("s0", 6).expect("evaluate");
        assert_eq!(middle.layers[0].transform.y, 200.0);

        let walk: Document = serde_json::from_str(WALK_PROJECT).expect("walk");
        validate_document(&walk).expect("valid");
        assert_eq!((walk.width, walk.height, walk.fps), (1080, 1080, 12));
        assert_eq!(
            walk.scenes[0]
                .layers
                .iter()
                .map(|layer| layer.name.clone())
                .collect::<Vec<_>>(),
            vec!["Head", "Arms", "Body", "Legs"]
        );
    }

    #[test]
    fn project_validation_rejects_invalid_documents() {
        let mut value = ball_value();
        value["scenes"] = serde_json::json!([]);
        assert!(validate_document(&project(&value)).is_err());

        let mut value = ball_value();
        value["width"] = serde_json::json!(0);
        assert!(validate_document(&project(&value)).is_err());

        let mut value = ball_value();
        value["fps"] = serde_json::json!(120);
        assert!(validate_document(&project(&value)).is_err());

        let mut value = ball_value();
        value["scenes"][0]["layers"][0]["keys"][1]["frame"] = serde_json::json!(0);
        assert!(validate_document(&project(&value)).is_err());

        let mut value = ball_value();
        value["scenes"][0]["layers"][0]["keys"][0]["frame"] = serde_json::json!(2);
        assert!(validate_document(&project(&value)).is_err());

        let mut value = ball_value();
        value["scenes"][0]["layers"][0]["length"] = serde_json::json!(12);
        assert!(validate_document(&project(&value)).is_err());

        let mut value = ball_value();
        value["scenes"][0]["layers"][0]["keys"] = serde_json::json!([]);
        assert!(validate_document(&project(&value)).is_err());

        let mut value = ball_value();
        value["scenes"][0]["layers"][0]["id"] = serde_json::json!("");
        assert!(validate_document(&project(&value)).is_err());

        let mut value = ball_value();
        value["scenes"][0]["layers"][0]["keys"][0]["transform"]["scale"] = serde_json::json!(0);
        assert!(validate_document(&project(&value)).is_err());

        let mut value = ball_value();
        value["scenes"][0]["layers"][0]["keys"][0]["transform"]["opacity"] = serde_json::json!(4);
        assert!(validate_document(&project(&value)).is_err());

        let mut value = ball_value();
        value["scenes"][0]["layers"][0]["keys"][0]["shapes"][0] =
            serde_json::json!({"kind":"Polygon","x":0,"y":0,"w":10,"h":10,"sides":2,"fill":"#ffffff","stroke":"#000000","width":1});
        assert_eq!(
            validate_document(&project(&value)).expect_err("polygon"),
            "polygon needs at least 3 sides"
        );

        let mut value = ball_value();
        value["scenes"][0]["layers"][0]["keys"][0]["shapes"][0]["kind"] = serde_json::json!("Blob");
        assert!(serde_json::from_value::<Document>(value).is_err());
    }

    #[test]
    fn import_creates_independent_documents() {
        let dir = std::env::temp_dir().join(format!("stickmate-templates-{}", document::new_id("t")));
        let store = DocStore::load(dir.clone());
        let manifest = parse_manifest("ball", BALL_MANIFEST.as_bytes()).expect("manifest");
        let source: Document = serde_json::from_str(BALL_PROJECT).expect("project");
        let first = install(&store, &manifest, source.clone()).expect("first");
        let second = install(&store, &manifest, source.clone()).expect("second");
        assert_ne!(first, second);
        assert_eq!(source.id, "d0");
        assert_eq!(store.list().expect("list").len(), 2);
        let opened = store.get(&first).expect("get");
        assert_eq!(opened.name, "Bouncing ball");
        assert_ne!(opened.id, "d0");
        assert_eq!(opened.scenes[0].layers[0].keys.len(), 3);
        store.rename(&first, "Mine".to_string()).expect("rename");
        assert_eq!(store.get(&first).expect("get").name, "Mine");
        assert_eq!(store.get(&second).expect("get").name, "Bouncing ball");
        assert_eq!(
            store.get(&second).expect("get").scenes[0].layers[0].keys[1].transform.y,
            400.0
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_rejects_a_project_that_disagrees_with_its_manifest() {
        let dir = std::env::temp_dir().join(format!("stickmate-mismatch-{}", document::new_id("t")));
        let store = DocStore::load(dir.clone());
        let manifest = parse_manifest("ball", BALL_MANIFEST.as_bytes()).expect("manifest");
        let mut value = ball_value();
        value["width"] = serde_json::json!(640);
        assert_eq!(
            install(&store, &manifest, project(&value)).expect_err("mismatch"),
            "template project does not match its manifest"
        );
        assert!(store.list().expect("list").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}