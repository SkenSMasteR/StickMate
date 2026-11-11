use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

const LIMIT: usize = 4 * 1024 * 1024;
const SEQUENCE_LIMIT: usize = 600;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub source: String,
    pub width: u32,
    pub height: u32,
    pub kind: &'static str,
}

pub fn kind_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else {
        None
    }
}

fn be16(bytes: &[u8], at: usize) -> Option<u32> {
    let mut buf = [0u8; 2];
    buf.copy_from_slice(bytes.get(at..at + 2)?);
    Some(u32::from_be_bytes([0, 0, buf[0], buf[1]]))
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    let mut buf = [0u8; 4];
    buf.copy_from_slice(bytes.get(at..at + 4)?);
    Some(u32::from_be_bytes(buf))
}

fn le16(bytes: &[u8], at: usize) -> Option<u32> {
    let mut buf = [0u8; 2];
    buf.copy_from_slice(bytes.get(at..at + 2)?);
    Some(u32::from_le_bytes([buf[0], buf[1], 0, 0]))
}

fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let width = be32(bytes, 16)?;
    let height = be32(bytes, 20)?;
    if bytes.get(12..16)? == b"IHDR" {
        return box_size(width, height);
    }
    None
}

fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    while at + 1 < bytes.len() {
        if bytes[at] != 0xff {
            at += 1;
            continue;
        }
        let marker = bytes[at + 1];
        if marker == 0xff {
            at += 1;
            continue;
        }
        if marker == 0x01 || (0xd0..=0xd9).contains(&marker) {
            at += 2;
            continue;
        }
        let length = be16(bytes, at + 2)? as usize;
        if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            return box_size(be16(bytes, at + 7)?, be16(bytes, at + 5)?);
        }
        if length < 2 {
            return None;
        }
        at += 2 + length;
    }
    None
}

fn box_size(width: u32, height: u32) -> Option<(u32, u32)> {
    if width == 0 || height == 0 || width > 16384 || height > 16384 {
        return None;
    }
    Some((width, height))
}

fn gif_size(bytes: &[u8]) -> Option<(u32, u32)> {
    box_size(le16(bytes, 6)?, le16(bytes, 8)?)
}

pub fn size_of(kind: &str, bytes: &[u8]) -> Option<(u32, u32)> {
    match kind {
        "png" => png_size(bytes),
        "jpeg" => jpeg_size(bytes),
        "gif" => gif_size(bytes),
        _ => None,
    }
}

pub fn inspect(bytes: &[u8]) -> Result<MediaInfo, String> {
    if bytes.is_empty() {
        return Err("the file is empty".to_string());
    }
    if bytes.len() > LIMIT {
        return Err("the image is larger than 4 MB".to_string());
    }
    let kind = kind_of(bytes).ok_or_else(|| "the file is not a PNG, JPEG or GIF image".to_string())?;
    let (width, height) = size_of(kind, bytes)
        .ok_or_else(|| "the image size could not be read".to_string())?;
    Ok(MediaInfo {
        source: data_url(kind, bytes),
        width,
        height,
        kind,
    })
}

pub fn looks_like_image(source: &str) -> bool {
    if source.len() > LIMIT * 2 {
        return false;
    }
    let Some(rest) = source.strip_prefix("data:image/") else {
        return false;
    };
    match rest.split_once(";base64,") {
        Some((kind, payload)) => !payload.is_empty() && matches!(kind, "png" | "jpeg" | "gif"),
        None => false,
    }
}

pub fn kind_of_source(source: &str) -> Option<&'static str> {
    let rest = source.strip_prefix("data:image/")?;
    let (kind, _) = rest.split_once(";base64,")?;
    match kind {
        "png" => Some("png"),
        "jpeg" => Some("jpeg"),
        "gif" => Some("gif"),
        _ => None,
    }
}

pub fn payload(source: &str) -> Option<Vec<u8>> {
    let rest = source.strip_prefix("data:image/")?;
    let (_, body) = rest.split_once(";base64,")?;
    STANDARD.decode(body).ok()
}

pub fn data_url(kind: &str, bytes: &[u8]) -> String {
    format!("data:image/{};base64,{}", kind, STANDARD.encode(bytes))
}

#[tauri::command]
pub fn media_read(path: String) -> Result<MediaInfo, String> {
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    inspect(&bytes)
}

fn split_extension(name: &str) -> (&str, &str) {
    match name.rsplit_once('.') {
        Some((stem, extension)) => (stem, extension),
        None => (name, ""),
    }
}

fn split_numbered(name: &str) -> Option<(&str, &str)> {
    let (stem, extension) = split_extension(name);
    let head = stem.trim_end_matches(|digit: char| digit.is_ascii_digit());
    let digits = &stem[head.len()..];
    if digits.is_empty() {
        return None;
    }
    Some((head, extension))
}

fn frame_number(name: &str, prefix: &str, extension: &str) -> Option<u32> {
    let (stem, tail) = split_extension(name);
    if !tail.eq_ignore_ascii_case(extension) {
        return None;
    }
    let digits = stem.strip_prefix(prefix)?;
    if digits.is_empty() || !digits.bytes().all(|digit| digit.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u32>().ok()
}

#[tauri::command]
pub fn media_sequence(path: String) -> Result<Vec<MediaInfo>, String> {
    let chosen = std::path::Path::new(&path);
    let name = chosen
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let (prefix, extension) =
        split_numbered(name).ok_or_else(|| "the file name does not end in a number".to_string())?;
    let mut found: Vec<(u32, std::path::PathBuf)> = Vec::new();
    let entries = std::fs::read_dir(chosen.parent().unwrap_or_else(|| std::path::Path::new(".")))
        .map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let file = entry.path();
        if let Some(number) = file
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(|name| frame_number(name, prefix, extension))
        {
            found.push((number, file));
        }
    }
    if found.len() > SEQUENCE_LIMIT {
        return Err("a sequence can hold up to 600 images".to_string());
    }
    found.sort_by_key(|(number, _)| *number);
    let mut run = Vec::with_capacity(found.len());
    for (_, file) in found {
        let name = file.file_name().and_then(|value| value.to_str()).unwrap_or_default();
        let unreadable = || format!("{name} is not a readable image");
        let bytes = std::fs::read(&file).map_err(|_| unreadable())?;
        run.push(inspect(&bytes).map_err(|_| unreadable())?);
    }
    Ok(run)
}

#[cfg(test)]
pub(crate) fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(&13u32.to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
    bytes.extend_from_slice(&0u32.to_be_bytes());
    bytes.extend_from_slice(b"IEND");
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xe0];
        bytes.extend_from_slice(&16u16.to_be_bytes());
        bytes.extend_from_slice(b"JFIF\x00");
        bytes.extend_from_slice(&[1, 1, 0, 0, 1, 0, 1, 0, 0]);
        bytes.extend_from_slice(&[0xff, 0xc0]);
        bytes.extend_from_slice(&17u16.to_be_bytes());
        bytes.push(8);
        bytes.extend_from_slice(&height.to_be_bytes()[2..]);
        bytes.extend_from_slice(&width.to_be_bytes()[2..]);
        bytes.extend_from_slice(&[3, 1, 0x11, 0]);
        bytes
    }

    fn gif(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 0]);
        bytes
    }

    #[test]
    fn reads_the_header_of_each_supported_format() {
        assert_eq!(size_of("png", &png(120, 60)), Some((120, 60)));
        assert_eq!(size_of("jpeg", &jpeg(320, 240)), Some((320, 240)));
        assert_eq!(size_of("gif", &gif(7, 9)), Some((7, 9)));
        assert_eq!(kind_of(&png(1, 1)), Some("png"));
        assert_eq!(kind_of(&jpeg(1, 1)), Some("jpeg"));
        assert_eq!(kind_of(&gif(1, 1)), Some("gif"));
        assert_eq!(kind_of(b"GIF87a"), Some("gif"));
    }

    #[test]
    fn a_media_info_carries_a_data_url_and_the_natural_size() {
        let info = inspect(&png(64, 32)).expect("inspect");
        assert_eq!((info.width, info.height, info.kind), (64, 32, "png"));
        assert_eq!(
            info.source,
            format!("data:image/png;base64,{}", STANDARD.encode(png(64, 32)))
        );
        assert!(looks_like_image(&info.source));
    }

    #[test]
    fn refuses_files_it_cannot_place() {
        assert_eq!(inspect(b"").unwrap_err(), "the file is empty");
        assert_eq!(
            inspect(b"not an image at all").unwrap_err(),
            "the file is not a PNG, JPEG or GIF image"
        );
        assert_eq!(
            inspect(&png(0, 10)).unwrap_err(),
            "the image size could not be read"
        );
        assert_eq!(
            inspect(&png(20_000, 10)).unwrap_err(),
            "the image size could not be read"
        );
        assert_eq!(
            inspect(&vec![0u8; LIMIT + 1]).unwrap_err(),
            "the image is larger than 4 MB"
        );
    }

    #[test]
    fn only_a_supported_embedded_image_passes_the_shape_check() {
        assert!(looks_like_image("data:image/gif;base64,R0lGOD=="));
        assert!(!looks_like_image("data:image/tiff;base64,R0lGOD=="));
        assert!(!looks_like_image("https://example.com/a.png"));
        assert!(!looks_like_image("data:image/png;base64,"));
        assert!(!looks_like_image(&format!(
            "data:image/png;base64,{}",
            "A".repeat(LIMIT * 2)
        )));
    }

    #[test]
    fn a_source_remembers_its_kind_and_holds_its_bytes() {
        let bytes = png(20, 10);
        let source = data_url("png", &bytes);
        assert_eq!(kind_of_source(&source), Some("png"));
        assert_eq!(payload(&source), Some(bytes.clone()));
        let other = data_url("jpeg", &jpeg(4, 3));
        assert_eq!(kind_of_source(&other), Some("jpeg"));
        assert_eq!(payload(&other), Some(jpeg(4, 3)));
        assert_eq!(payload(&data_url("gif", &gif(2, 2))), Some(gif(2, 2)));
    }

    #[test]
    fn source_helpers_refuse_what_they_cannot_read() {
        assert_eq!(kind_of_source("https://example.com/a.png"), None);
        assert_eq!(kind_of_source("data:image/tiff;base64,AAAA"), None);
        assert_eq!(kind_of_source("data:image/png"), None);
        assert_eq!(payload("data:image/png;base64,!!!!"), None);
        assert_eq!(payload("data:image/png"), None);
        assert_eq!(payload(""), None);
    }

    #[test]
    fn reads_an_image_from_disk() {
        let dir = std::env::temp_dir().join(format!("stickmate-media-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let file = dir.join("board.png");
        std::fs::write(&file, png(18, 9)).expect("write");
        let info = media_read(file.to_string_lossy().into_owned()).expect("read");
        assert_eq!((info.width, info.height, info.kind), (18, 9, "png"));
        let missing = media_read(dir.join("missing.png").to_string_lossy().into_owned());
        assert!(missing.unwrap_err().contains("os error 2"));
        std::fs::remove_dir_all(&dir).expect("clean");
    }

    fn sequence_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "stickmate-sequence-{}-{}",
            tag,
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    #[test]
    fn a_sequence_gathers_its_numbered_siblings_in_order() {
        let dir = sequence_dir("order");
        for (name, size) in [
            ("walk_0001.png", (10u32, 4u32)),
            ("walk_0002.png", (20, 8)),
            ("walk_010.png", (30, 12)),
        ] {
            std::fs::write(dir.join(name), png(size.0, size.1)).expect("write");
        }
        std::fs::write(dir.join("walk_notes.png"), b"not an image").expect("write");
        std::fs::write(dir.join("walk_0003.jpg"), png(40, 16)).expect("write");
        let run =
            media_sequence(dir.join("walk_0002.png").to_string_lossy().into_owned()).expect("run");
        assert_eq!(
            run.iter()
                .map(|info| (info.width, info.height, info.kind))
                .collect::<Vec<_>>(),
            vec![(10, 4, "png"), (20, 8, "png"), (30, 12, "png")]
        );
        std::fs::remove_dir_all(&dir).expect("clean");
    }

    #[test]
    fn a_sequence_needs_a_numbered_file_name() {
        let dir = sequence_dir("unnumbered");
        std::fs::write(dir.join("walk.png"), png(6, 3)).expect("write");
        assert_eq!(
            media_sequence(dir.join("walk.png").to_string_lossy().into_owned())
                .expect_err("unnumbered"),
            "the file name does not end in a number"
        );
        std::fs::remove_dir_all(&dir).expect("clean");
    }

    #[test]
    fn a_sequence_stops_at_six_hundred_images() {
        let dir = sequence_dir("length");
        for number in 0..601 {
            std::fs::write(dir.join(format!("run_{number:04}.png")), png(2, 2)).expect("write");
        }
        assert_eq!(
            media_sequence(dir.join("run_0000.png").to_string_lossy().into_owned())
                .expect_err("too long"),
            "a sequence can hold up to 600 images"
        );
        std::fs::remove_dir_all(&dir).expect("clean");
    }

    #[test]
    fn a_sequence_names_a_frame_it_cannot_read() {
        let dir = sequence_dir("unreadable");
        std::fs::write(dir.join("run_0001.png"), png(2, 2)).expect("write");
        std::fs::write(dir.join("run_0002.png"), b"broken").expect("write");
        assert_eq!(
            media_sequence(dir.join("run_0001.png").to_string_lossy().into_owned())
                .expect_err("broken frame"),
            "run_0002.png is not a readable image"
        );
        let outside = dir.join("absent").join("run_0001.png");
        let missing = media_sequence(outside.to_string_lossy().into_owned()).expect_err("missing");
        assert!(missing.contains("os error"));
        std::fs::remove_dir_all(&dir).expect("clean");
    }

    #[test]
    fn jpeg_scanning_survives_truncated_segments() {
        let mut bytes = jpeg(16, 9);
        bytes.truncate(9);
        assert_eq!(size_of("jpeg", &bytes), None);
        let mut without_marker = vec![0xff, 0xd8, 0xff];
        without_marker.extend_from_slice(&[0, 0, 0, 0]);
        assert_eq!(size_of("jpeg", &without_marker), None);
    }
}
