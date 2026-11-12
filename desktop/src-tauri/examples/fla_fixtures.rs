use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use stickmate_lib::fla;
use stickmate_lib::xfl;

const RAW_LIMIT: usize = 200_000;
const FILE_LIMIT: usize = 120_000;
const ZIP_LIMIT: usize = 300_000;
const PICK_LIMIT: usize = 6;

type Members = Vec<(String, Vec<u8>)>;

fn body(members: &Members, name: &str) -> Option<String> {
    let bytes = fla::member_bytes(members, name)?;
    String::from_utf8(bytes).ok()
}

fn xml_members(members: &Members) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (name, bytes) in members {
        if name.starts_with(xfl::LIBRARY_FOLDER) && name.ends_with(".xml") {
            if let Ok(text) = String::from_utf8(bytes.clone()) {
                out.insert(name.clone(), text);
            }
        }
    }
    out
}

fn pick_sorted(names: &[String], docs: &BTreeMap<String, String>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for name in names {
        if out.len() >= PICK_LIMIT {
            break;
        }
        let Some(text) = docs.get(name) else { continue };
        if text.len() > FILE_LIMIT {
            continue;
        }
        let used: usize = out.iter().map(|item| item.1.len()).sum();
        if used + text.len() > RAW_LIMIT {
            break;
        }
        if !out.iter().any(|(taken, _)| taken == name) {
            out.push((name.clone(), text.clone()));
        }
    }
    out
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn names_matching(docs: &BTreeMap<String, String>, needles: &[&str]) -> Vec<String> {
    docs.iter()
        .filter(|(_, text)| contains_any(text, needles))
        .map(|(name, _)| name.clone())
        .collect()
}

fn include_hrefs(xml: &str) -> Vec<String> {
    let mut seen = Vec::new();
    let mut rest = xml;
    while let Some(found) = rest.find("<Include href=\"") {
        rest = &rest[found + "<Include href=\"".len()..];
        let Some(end) = rest.find('"') else { break };
        let href = rest[..end].to_string();
        if !seen.contains(&href) {
            seen.push(href);
        }
        rest = &rest[end..];
    }
    seen
}

fn has_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && (bytes[0] as char).is_ascii_alphabetic() {
        return true;
    }
    let lower = value.to_lowercase();
    value.contains("\\\\") || value.contains(".fil") || lower.contains("appdata")
}

fn redact_guid(text: &str) -> String {
    let needle = "fileGUID=\"";
    let mut out = String::new();
    let mut rest = text;
    while let Some(found) = rest.find(needle) {
        let after = found + needle.len();
        out.push_str(&rest[..after]);
        match rest[after..].find('"') {
            Some(end) => {
                out.push_str("00000000000000000000000000000000");
                rest = &rest[after + end..];
            }
            None => rest = &rest[after..],
        }
    }
    out.push_str(rest);
    out
}

fn scrub(text: &str) -> String {
    let redacted = redact_guid(text);
    let mut rest: &str = &redacted;
    let mut out = String::new();
    loop {
        let Some(found) = rest.find("=\"") else { break };
        let after = found + 2;
        let Some(end) = rest[after..].find('"') else { break };
        let value = &rest[after..after + end];
        let take = after + end + 1;
        out.push_str(&rest[..after]);
        if has_path(value) {
            out.push_str("redacted\"");
            rest = &rest[take..];
        } else {
            out.push_str(&rest[after..take]);
            rest = &rest[take..];
        }
    }
    out.push_str(&rest);
    out
}

fn write_fixture(stem: &str, picked: &[(String, String)], doc: &str, out_dir: &PathBuf) {
    let mut members: Members = vec![
        (format!("{stem}.xfl"), b"PROXY-CS5".to_vec()),
        (xfl::LIBRARY_FOLDER.to_string(), Vec::new()),
        ("META-INF/".to_string(), Vec::new()),
        ("publishtemplates/".to_string(), Vec::new()),
        (xfl::METADATA.to_string(), Vec::new()),
    ];
    for (name, text) in picked {
        members.push((name.clone(), scrub(text).into_bytes()));
    }
    let redacted = scrub(doc);
    members.push((xfl::DOM_DOCUMENT.to_string(), redacted.into_bytes()));
    members.push((
        xfl::PUBLISH_SETTINGS.to_string(),
        xfl::publish_settings(stem).into_bytes(),
    ));
    let archive = fla::write_members(&members).expect("write archive");
    let raw: usize = members.iter().map(|(_, bytes)| bytes.len()).sum();
    let path = out_dir.join(format!("{stem}.fla"));
    fs::write(&path, &archive).expect("write fixture");
    println!(
        "{} members {} raw {raw} zip {}",
        path.display(),
        members.len(),
        archive.len()
    );
    if archive.len() > ZIP_LIMIT {
        println!("{stem}.fla exceeds the 300 KB fixture budget");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        panic!("usage: fla_fixtures <study.fla> <tut.fla> [out-dir]");
    }
    let study = fla::read_members(&fs::read(&args[0]).expect("read study")).expect("study members");
    let tut = fla::read_members(&fs::read(&args[1]).expect("read tut")).expect("tut members");
    let out_dir = args
        .get(2)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("tests/fixtures/fla"));
    fs::create_dir_all(&out_dir).expect("create fixtures dir");
    let study_doc = body(&study, xfl::DOM_DOCUMENT).expect("study document");
    let tut_doc = body(&tut, xfl::DOM_DOCUMENT).expect("tut document");
    let study_xml = xml_members(&study);
    let tut_xml = xml_members(&tut);
    println!("study members {}", study.len());
    println!("tut members {}", tut.len());

    let mut motion = Vec::new();
    let mut other = Vec::new();
    for href in include_hrefs(&study_doc) {
        let name = format!("{}{href}", xfl::LIBRARY_FOLDER);
        if !study_xml.contains_key(&name) {
            continue;
        }
        if study_xml[&name].contains("22017") {
            motion.push(name.clone());
            other.push(name);
        } else {
            other.push(name);
        }
    }
    motion.sort();
    motion.dedup();
    other.sort();
    other.dedup();
    let mut chosen = pick_sorted(&motion, &study_xml);
    if chosen.len() < 3 {
        let taken: Vec<String> = chosen.iter().map(|(name, _)| name.clone()).collect();
        for item in pick_sorted(&other, &study_xml) {
            if !taken.contains(&item.0) && chosen.len() < PICK_LIMIT {
                chosen.push(item);
            }
        }
    }
    write_fixture("characters", &chosen, &study_doc, &out_dir);

    let score = |text: &str| {
        text.matches("layerType=\"mask").count()
            + text.matches("layerType=\"guide").count()
            + text.matches("layerType=\"motion guide").count()
    };
    let host_doc = if score(&tut_doc) > score(&study_doc) { &tut_doc } else { &study_doc };
    let needles = ["layerType=\"mask", "layerType=\"guide", "layerType=\"motion guide"];
    let mut names = names_matching(&study_xml, &needles);
    names.extend(names_matching(&tut_xml, &needles));
    names.sort();
    names.dedup();
    let mut merged = BTreeMap::new();
    merged.extend(study_xml.clone());
    merged.extend(tut_xml.clone());
    let chosen = pick_sorted(&names, &merged);
    write_fixture("layers", &chosen, host_doc, &out_dir);

    let mut names = names_matching(&tut_xml, &["GlowFilter", "BlurFilter", "WidthMarker"]);
    names.extend(names_matching(&study_xml, &["GlowFilter", "BlurFilter", "WidthMarker"]));
    names.sort();
    names.dedup();
    let chosen = pick_sorted(&names, &merged);
    write_fixture("artwork", &chosen, &tut_doc, &out_dir);
}
