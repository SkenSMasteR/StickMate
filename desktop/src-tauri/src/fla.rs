use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::document::{Blend, Document, DocStore, Layer, Shape};
use crate::xfl;
use crate::xfl_read;

const EOCD_SIG: [u8; 4] = *b"PK\x05\x06";
const CENTRAL_SIG: [u8; 4] = *b"PK\x01\x02";
const ZIP64_RECORD_SIG: [u8; 4] = *b"PK\x06\x06";
const ZIP64_LOCATOR_SIG: [u8; 4] = *b"PK\x06\x07";

#[derive(Serialize)]
pub struct FlaExportResult {
    pub path: String,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
pub struct FlaImportResult {
    pub id: String,
    pub name: String,
    pub notes: Vec<String>,
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    match bytes.get(at..at + 2) {
        Some(slice) => u16::from_le_bytes([slice[0], slice[1]]),
        None => 0,
    }
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    match bytes.get(at..at + 4) {
        Some(slice) => u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]),
        None => 0,
    }
}

fn u64_at(bytes: &[u8], at: usize) -> Option<u64> {
    let mut buf = [0u8; 8];
    buf.copy_from_slice(bytes.get(at..at + 8)?);
    Some(u64::from_le_bytes(buf))
}

pub fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
}

fn eocd_start(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 22 {
        return None;
    }
    let mut at = bytes.len() - 22;
    loop {
        if bytes[at..at + 4] == EOCD_SIG {
            let comment = u16_at(bytes, at + 20) as usize;
            if at + 22 + comment == bytes.len() {
                return Some(at);
            }
        }
        if at == 0 {
            return None;
        }
        at -= 1;
    }
}

fn offsets(bytes: &[u8], eocd: usize) -> Option<(u64, u64)> {
    let claimed_size = u32_at(bytes, eocd + 12) as u64;
    let claimed_offset = u32_at(bytes, eocd + 16) as u64;
    if claimed_size != 0xFFFF_FFFF && claimed_offset != 0xFFFF_FFFF {
        return Some((claimed_size, claimed_offset));
    }
    let locator = eocd.checked_sub(20)?;
    if bytes.get(locator..locator + 4) != Some(&ZIP64_LOCATOR_SIG) {
        return None;
    }
    let record = u32_at(bytes, locator + 8) as usize;
    if bytes.get(record..record + 4) != Some(&ZIP64_RECORD_SIG) {
        return None;
    }
    Some((u64_at(bytes, record + 40)?, u64_at(bytes, record + 48)?))
}

fn repair_index(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let eocd = eocd_start(bytes).ok_or_else(|| "the archive index is missing".to_string())?;
    let comment = u16_at(bytes, eocd + 20) as u64;
    let (size, offset) = offsets(bytes, eocd).ok_or_else(|| "the archive index is missing".to_string())?;
    if offset == 0
        || offset >= eocd as u64
        || bytes.get(offset as usize..offset as usize + 4) != Some(&CENTRAL_SIG)
    {
        return Err("the archive index is damaged".to_string());
    }
    if size >= u64::from(u32::MAX) {
        return Err("zip64 archives are not supported".to_string());
    }
    let mut out = bytes.to_vec();
    let true_size = (eocd as u64) - offset - comment;
    out[eocd + 12..eocd + 16].copy_from_slice(&(true_size as u32).to_le_bytes());
    Ok(out)
}

pub fn read_members(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    if !is_zip(bytes) {
        return Err("the file is not a .fla or .xfl archive".to_string());
    }
    let data = repair_index(bytes)?;
    let mut archive = ZipArchive::new(Cursor::new(data))
        .map_err(|error| format!("the archive could not be opened: {error}"))?;
    let mut out = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("the archive could not be read: {error}"))?;
        let name = entry
            .name()
            .map_err(|error| format!("entry {index} could not be named: {error}"))?
            .to_string();
        let mut body = Vec::new();
        entry
            .read_to_end(&mut body)
            .map_err(|error| format!("{name} could not be read: {error}"))?;
        out.push((name, body));
    }
    Ok(out)
}

pub fn member_bytes(members: &[(String, Vec<u8>)], name: &str) -> Option<Vec<u8>> {
    members
        .iter()
        .find(|(member, _)| member == name)
        .map(|(_, body)| body.clone())
}

pub fn write_members(members: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let deflated: FileOptions<'_, '_, ()> =
        FileOptions::default().compression_method(CompressionMethod::Deflated);
    let stored: FileOptions<'_, '_, ()> =
        FileOptions::default().compression_method(CompressionMethod::Stored);
    for (name, body) in members {
        let folder = name.ends_with('/');
        let options = if folder || body.is_empty() {
            stored
        } else {
            deflated
        };
        if folder {
            writer
                .add_directory(name.as_str(), options)
                .map_err(|error| format!("{name} could not be added: {error}"))?;
            continue;
        }
        writer
            .start_file(name.as_str(), options)
            .map_err(|error| format!("{name} could not be added: {error}"))?;
        writer
            .write_all(body)
            .map_err(|error| format!("{name} could not be written: {error}"))?;
    }
    writer
        .finish()
        .map(Cursor::into_inner)
        .map_err(|error| format!("the archive could not be closed: {error}"))
}

pub fn archive_stem(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars().take(48) {
        if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return "StickMate".to_string();
    }
    trimmed.to_string()
}

pub fn archive_members(doc: &Document) -> Vec<(String, Vec<u8>)> {
    let stem = archive_stem(&doc.name);
    let mut members = vec![
        (format!("{stem}.xfl"), b"PROXY-CS5".to_vec()),
        (xfl::LIBRARY_FOLDER.to_string(), Vec::new()),
        ("META-INF/".to_string(), Vec::new()),
        ("publishtemplates/".to_string(), Vec::new()),
        (xfl::METADATA.to_string(), Vec::new()),
        (
            xfl::DOM_DOCUMENT.to_string(),
            xfl::document_xml(doc).into_bytes(),
        ),
        (
            xfl::PUBLISH_SETTINGS.to_string(),
            xfl::publish_settings(&stem).into_bytes(),
        ),
    ];
    members.extend(xfl::library_members(doc));
    members
}

#[derive(Default)]
struct Gaps {
    gradient: bool,
    blend: bool,
    effect: bool,
    mask: bool,
    folder: bool,
    opacity: bool,
    tween: bool,
    figure: bool,
}

fn scan_layers(layers: &[Layer], gaps: &mut Gaps) {
    for layer in layers {
        gaps.folder |= layer.folder;
        gaps.mask |= layer.masked;
        gaps.blend |= layer.blend != Blend::Normal;
        gaps.effect |= !layer.effects.is_empty();
        gaps.opacity |= layer.opacity < 0.999;
        for key in &layer.keys {
            gaps.tween |= key.tween;
            gaps.opacity |= key.transform.opacity < 0.999;
            for shape in &key.shapes {
                gaps.gradient |= has_gradient(shape);
                gaps.figure |= has_figure(shape);
            }
        }
        scan_layers(&layer.children, gaps);
    }
}

fn has_gradient(shape: &Shape) -> bool {
    match shape {
        Shape::Rect { gradient, .. }
        | Shape::Ellipse { gradient, .. }
        | Shape::Polygon { gradient, .. }
        | Shape::Path { gradient, .. } => gradient.is_some(),
        Shape::Group { children } => children.iter().any(has_gradient),
        _ => false,
    }
}

fn has_figure(shape: &Shape) -> bool {
    match shape {
        Shape::Figure { .. } => true,
        Shape::Group { children } => children.iter().any(has_figure),
        _ => false,
    }
}

pub fn export_warnings(doc: &Document) -> Vec<String> {
    let mut gaps = Gaps::default();
    for scene in &doc.scenes {
        scan_layers(&scene.layers, &mut gaps);
    }
    let mut warnings = Vec::new();
    if gaps.gradient {
        warnings.push("gradient fills are exported as flat colours".to_string());
    }
    if gaps.blend {
        warnings.push("blend modes are not exported".to_string());
    }
    if gaps.effect {
        warnings.push("layer effects are not exported".to_string());
    }
    if gaps.mask {
        warnings.push("layer masks are not exported".to_string());
    }
    if gaps.folder {
        warnings.push("layer folders are exported as plain layers".to_string());
    }
    if gaps.opacity {
        warnings.push("layer and keyframe opacity are exported as shape transparency".to_string());
    }
    if gaps.tween {
        warnings.push("tweens are exported as keyframes that hold until the next key".to_string());
    }
    if gaps.figure {
        warnings.push("stick figures are exported as the lines they draw, without the rig".to_string());
    }
    warnings
}

#[tauri::command]
pub fn project_export_fla(
    store: State<'_, DocStore>,
    id: String,
    path: String,
) -> Result<FlaExportResult, String> {
    let doc = store.get(&id)?;
    let warnings = export_warnings(&doc);
    let archive = write_members(&archive_members(&doc))?;
    let target = PathBuf::from(&path);
    write_replacing(&target, &archive)?;
    Ok(FlaExportResult {
        path: target.to_string_lossy().into_owned(),
        warnings,
    })
}

pub(crate) fn write_replacing(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if target.is_dir() {
        return Err("the output path is a folder".to_string());
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
    }
    let temp = beside(target, "tmp");
    let written = replace(target, bytes, &temp);
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

fn replace(target: &Path, bytes: &[u8], temp: &Path) -> Result<(), String> {
    fs::write(temp, bytes).map_err(|error| error.to_string())?;
    if !target.exists() {
        return fs::rename(temp, target).map_err(|error| error.to_string());
    }
    let previous = beside(target, "previous");
    fs::rename(target, &previous).map_err(|error| error.to_string())?;
    match fs::rename(temp, target) {
        Ok(()) => {
            let _ = fs::remove_file(&previous);
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(&previous, target);
            Err(error.to_string())
        }
    }
}

fn beside(target: &Path, tag: &str) -> PathBuf {
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("stickmate");
    target.with_file_name(format!(".{name}.stickmate-{tag}"))
}

#[tauri::command]
pub fn project_import_fla(store: State<'_, DocStore>, path: String) -> Result<FlaImportResult, String> {
    let source = PathBuf::from(&path);
    let bytes = fs::read(&source).map_err(|error| error.to_string())?;
    let (body, members) = if is_zip(&bytes) {
        let members = read_members(&bytes)?;
        let body = member_bytes(&members, xfl::DOM_DOCUMENT)
            .ok_or_else(|| "DOMDocument.xml is missing from the file".to_string())?;
        (body, members)
    } else {
        (bytes, Vec::new())
    };
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported project");
    import_members(&store, stem, &body, &members)
}

fn import_members(
    store: &DocStore,
    stem: &str,
    body: &[u8],
    members: &[(String, Vec<u8>)],
) -> Result<FlaImportResult, String> {
    let text = String::from_utf8(body.to_vec())
        .map_err(|_| "DOMDocument.xml is not readable text".to_string())?;
    let import = xfl_read::parse(&text, &archive_stem(stem), members)?;
    let mut doc = import.doc;
    validate_import(&doc)?;
    let created = store.create(
        doc.name.clone(),
        doc.width,
        doc.height,
        doc.fps,
        doc.background.clone(),
    )?;
    doc.id = created.id.clone();
    store.edit_named(&created.id, "import_fla", move |target| {
        *target = doc;
        Ok(())
    })?;
    Ok(FlaImportResult {
        id: created.id,
        name: created.name,
        notes: import.notes,
    })
}

fn validate_import(doc: &Document) -> Result<(), String> {
    for scene in &doc.scenes {
        validate_import_layers(&scene.layers)?;
    }
    Ok(())
}

fn validate_import_layers(layers: &[Layer]) -> Result<(), String> {
    for layer in layers {
        for key in &layer.keys {
            for shape in &key.shapes {
                crate::document::validate(shape)?;
            }
        }
        validate_import_layers(&layer.children)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{Scene, Transform};

    fn sample_members() -> Vec<(String, Vec<u8>)> {
        vec![
            ("project.xfl".to_string(), b"PROXY-CS5".to_vec()),
            ("LIBRARY/".to_string(), Vec::new()),
            (
                "DOMDocument.xml".to_string(),
                b"<DOMDocument xmlns=\"http://ns.adobe.com/xfl/2008/\" width=\"640\"/>".to_vec(),
            ),
        ]
    }

    fn document(name: &str) -> Document {
        Document {
            id: "d1".to_string(),
            name: name.to_string(),
            width: 640,
            height: 360,
            fps: 30,
            background: "#ffffff".to_string(),
            scenes: vec![Scene {
                id: "s1".to_string(),
                name: "Scene 1".to_string(),
                layers: Vec::new(),
            }],
        }
    }

    fn bump_size(bytes: &mut [u8], extra: u32) {
        let eocd = eocd_start(bytes).expect("eocd");
        let size = u32_at(bytes, eocd + 12);
        bytes[eocd + 12..eocd + 16].copy_from_slice(&(size + extra).to_le_bytes());
    }

    #[test]
    fn members_round_trip() {
        let archive = write_members(&sample_members()).expect("write");
        assert_eq!(read_members(&archive).expect("read"), sample_members());
    }

    #[test]
    fn repairs_overstated_index_length() {
        let mut archive = write_members(&sample_members()).expect("write");
        bump_size(&mut archive, 54);
        assert_eq!(read_members(&archive).expect("read"), sample_members());
        let eocd = eocd_start(&archive).expect("eocd");
        let repaired = repair_index(&archive).expect("repair");
        assert_eq!(u32_at(&archive, eocd + 12) - u32_at(&repaired, eocd + 12), 54);
    }

    #[test]
    fn rejects_non_archive_bytes() {
        assert_eq!(
            read_members(b"plain text file").expect_err("should fail"),
            "the file is not a .fla or .xfl archive"
        );
    }

    #[test]
    fn finds_named_member() {
        let members = sample_members();
        assert_eq!(
            member_bytes(&members, "project.xfl"),
            Some(b"PROXY-CS5".to_vec())
        );
        assert_eq!(member_bytes(&members, "Missing.xml"), None);
    }

    #[test]
    fn archive_holds_document_and_markers() {
        let members = archive_members(&document("Balloon Game"));
        let names: Vec<&str> = members.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Balloon Game.xfl",
                "LIBRARY/",
                "META-INF/",
                "publishtemplates/",
                "META-INF/metadata.xml",
                "DOMDocument.xml",
                "PublishSettings.xml"
            ]
        );
        let xml = String::from_utf8(member_bytes(&members, "DOMDocument.xml").expect("xml"))
            .expect("utf8");
        assert!(xml.contains("width=\"640\" height=\"360\""));
        assert!(xml.contains("frameRate=\"30.0000\""));
        assert!(xml.contains("backgroundColor=\"#ffffff\""));
    }

    #[test]
    fn archive_stem_sanitises_names() {
        assert_eq!(archive_stem("A/B:*?\"<>|"), "A_B_______");
        assert_eq!(archive_stem("   "), "StickMate");
    }

    #[test]
    fn export_reads_back_as_same_members() {
        let doc = document("Round Trip");
        let archive = write_members(&archive_members(&doc)).expect("write");
        let read = read_members(&archive).expect("read");
        assert_eq!(read, archive_members(&doc));
    }

    #[test]
    fn import_picks_the_document_member() {
        let doc = document("Import Me");
        let archive = write_members(&archive_members(&doc)).expect("write");
        let members = read_members(&archive).expect("members");
        let body = member_bytes(&members, xfl::DOM_DOCUMENT).expect("document");
        let packed = String::from_utf8(body).expect("utf8");
        let import = crate::xfl_read::parse(&packed, "Import Me", &members).expect("archive parse");
        assert_eq!(
            (import.doc.width, import.doc.height, import.doc.fps),
            (640, 360, 30)
        );
        assert_eq!(import.doc.name, "Import Me");
        assert!(import.notes.is_empty(), "{:?}", import.notes);
        let loose = xfl::document_xml(&doc);
        assert!(!is_zip(loose.as_bytes()));
        assert_eq!(
            crate::xfl_read::parse(&loose, "Loose", &[]).expect("loose parse").doc.name,
            "Loose"
        );
    }

    #[test]
    fn import_lands_the_document_under_its_own_history_step() {
        let dir = scratch("ingest");
        let store = DocStore::load(dir.clone());
        let members = archive_members(&document("Study"));
        let body = member_bytes(&members, xfl::DOM_DOCUMENT).expect("body");
        let import = import_members(&store, "Study", &body, &members).expect("import");
        assert_eq!(store.get(&import.id).expect("stored").name, "Study");
        let steps = store.history(&import.id).expect("history");
        let last = steps.last().expect("step");
        assert_eq!(last.name, "import_fla");
        assert_eq!(last.kind, "current");
        fs::remove_dir_all(&dir).expect("clean");
    }

    #[test]
    fn import_refuses_shapes_the_editor_cannot_hold() {
        let dir = scratch("refuse");
        let store = DocStore::load(dir.clone());
        let body = "<DOMDocument xmlns=\"http://ns.adobe.com/xfl/2008/\" width=\"640\" height=\"360\" frameRate=\"12.0000\"><timelines><DOMTimeline name=\"Scene 1\"><layers><DOMLayer name=\"Art\"><frames><DOMFrame index=\"0\" duration=\"1\" keyMode=\"9728\"><elements><DOMShape><fills><FillStyle index=\"1\"><SolidColor color=\"#ff0000\"/></FillStyle></fills><edges><Edge fillStyle1=\"1\" edges=\"!0 0|100 0\"/></edges></DOMShape></elements></DOMFrame></frames></DOMLayer></layers></DOMTimeline></timelines></DOMDocument>";
        let outcome = import_members(&store, "Broken", body.as_bytes(), &[]);
        match outcome {
            Ok(_) => panic!("a document the editor cannot hold must not import"),
            Err(error) => assert_eq!(error, "closed path needs at least 3 nodes"),
        }
        assert_eq!(store.list().expect("list").len(), 0);
        fs::remove_dir_all(&dir).expect("clean");
    }

    fn plain_layer() -> Layer {
        Layer {
            id: "l1".to_string(),
            name: "Art".to_string(),
            visible: true,
            locked: false,
            opacity: 1.0,
            blend: Blend::Normal,
            effects: Vec::new(),
            masked: false,
            length: 10,
            keys: Vec::new(),
            folder: false,
            children: Vec::new(),
        }
    }

    fn gradient_key() -> crate::document::Keyframe {
        crate::document::Keyframe {
            frame: 0,
            shapes: vec![Shape::Rect {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
                fill: "#ff000080".to_string(),
                stroke: "none".to_string(),
                width: 2.0,
                gradient: Some(crate::document::Gradient::Radial { stops: Vec::new() }),
            }],
            transform: Transform::default(),
            tween: true,
            easing: crate::document::Easing::linear(),
            label: None,
        }
    }

    fn image_key() -> crate::document::Keyframe {
        crate::document::Keyframe {
            frame: 0,
            shapes: vec![Shape::Bitmap {
                x: 0.0,
                y: 0.0,
                w: 40.0,
                h: 20.0,
                source: crate::media::data_url("png", &crate::media::png(40, 20)),
                matrix: None,
            }],
            transform: Transform::default(),
            tween: false,
            easing: crate::document::Easing::linear(),
            label: None,
        }
    }

    #[test]
    fn warnings_list_only_used_features() {
        let mut doc = document("Plain");
        doc.scenes[0].layers = vec![plain_layer()];
        assert!(export_warnings(&doc).is_empty());
        doc.scenes[0].layers[0].blend = Blend::Multiply;
        doc.scenes[0].layers[0].keys.push(gradient_key());
        let warnings = export_warnings(&doc);
        assert!(warnings.contains(&"blend modes are not exported".to_string()));
        assert!(warnings.iter().any(|text| text.starts_with("gradient fills")));
        assert!(warnings.iter().any(|text| text.starts_with("tweens are exported")));
        assert!(!warnings.iter().any(|text| text.starts_with("layer masks")));
        assert!(!warnings.iter().any(|text| text.starts_with("placed images")));
        doc.scenes[0].layers[0].keys.push(image_key());
        let warnings = export_warnings(&doc);
        assert!(!warnings.iter().any(|text| text.starts_with("placed images")));
        assert!(!warnings.iter().any(|text| text.starts_with("stick figures")));
        let members = archive_members(&doc);
        assert_eq!(
            member_bytes(&members, "LIBRARY/Bitmap 1.png"),
            Some(crate::media::png(40, 20))
        );
        let xml = String::from_utf8(member_bytes(&members, xfl::DOM_DOCUMENT).expect("xml"))
            .expect("utf8");
        assert!(xml.contains("<DOMBitmapItem name=\"Bitmap 1\""));
        assert!(xml.contains("<DOMBitmapInstance libraryItemName=\"Bitmap 1\">"));
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("stickmate-fla-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .expect("listing")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("stickmate-"))
            .collect()
    }

    const OLD: &[u8] = b"the saved project";
    const NEW: &[u8] = b"a newer archive";

    #[test]
    fn a_replacement_writes_the_whole_new_file() {
        let dir = scratch("replace");
        let target = dir.join("movie.fla");
        fs::write(&target, OLD).expect("old");
        write_replacing(&target, NEW).expect("write");
        assert_eq!(fs::read(&target).expect("read"), NEW.to_vec());
        assert_eq!(leftovers(&dir), Vec::<String>::new());
        fs::remove_dir_all(&dir).expect("clean");
    }

    #[test]
    fn a_folder_target_is_refused() {
        let dir = scratch("folder");
        let target = dir.join("movie.fla");
        fs::create_dir(&target).expect("folder");
        let keeper = target.join("keep.txt");
        fs::write(&keeper, b"keep").expect("keep");
        assert_eq!(
            write_replacing(&target, NEW).unwrap_err(),
            "the output path is a folder"
        );
        assert_eq!(fs::read(&keeper).expect("keeper"), b"keep".to_vec());
        assert_eq!(leftovers(&dir), Vec::<String>::new());
        fs::remove_dir_all(&dir).expect("clean");
    }

    #[test]
    fn a_blocked_replacement_leaves_one_whole_file() {
        let dir = scratch("blocked");
        let target = dir.join("movie.fla");
        fs::write(&target, OLD).expect("old");
        let mut frozen = fs::metadata(&target).expect("metadata").permissions();
        frozen.set_readonly(true);
        fs::set_permissions(&target, frozen).expect("read only");
        let outcome = write_replacing(&target, NEW);
        let saved = fs::read(&target).expect("read");
        assert!(
            saved == OLD.to_vec() || saved == NEW.to_vec(),
            "the file holds neither generation"
        );
        if outcome.is_err() {
            assert_eq!(saved, OLD.to_vec());
        }
        assert_eq!(leftovers(&dir), Vec::<String>::new());
        let mut thawed = fs::metadata(&target).expect("metadata").permissions();
        thawed.set_readonly(false);
        fs::set_permissions(&target, thawed).expect("writable");
        fs::remove_dir_all(&dir).expect("clean");
    }

    #[test]
    fn a_missing_folder_is_created_for_the_file() {
        let dir = scratch("nested");
        let target = dir.join("deep").join("deeper").join("movie.fla");
        write_replacing(&target, NEW).expect("write");
        assert_eq!(fs::read(&target).expect("read"), NEW.to_vec());
        fs::remove_dir_all(&dir).expect("clean");
    }
}
