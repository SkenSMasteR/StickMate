import json
import math
import os
import re
import sys

ID = re.compile(rb"[a-z0-9][a-z0-9-]{0,63}")
SEGMENT = re.compile(rb"[A-Za-z0-9_.-]+")
VERSION = re.compile(r"[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}")

CATALOG_LIMIT = 256 * 1024
MANIFEST_LIMIT = 256 * 1024
PREVIEW_LIMIT = 512 * 1024
PROJECT_LIMIT = 8 * 1024 * 1024
FOLDER_LIMIT = 64

MANIFEST_FIELDS = {
    "id", "name", "description", "preview", "project",
    "version", "min_app_version", "width", "height", "fps",
}
DOC_FIELDS = {"id", "name", "width", "height", "fps", "background", "scenes"}
SCENE_FIELDS = {"id", "name", "layers"}
LAYER_FIELDS = {"id", "name", "visible", "locked", "opacity", "length", "keys"}
KEY_FIELDS = {"frame", "shapes", "transform", "tween", "label"}
TRANSFORM_FIELDS = {"x", "y", "rotation", "scale", "opacity"}
POINT_FIELDS = {"x", "y"}
NODE_FIELDS = {"point", "handle_in", "handle_out"}
BOX_FIELDS = {"x", "y", "w", "h", "fill", "stroke", "width"}
SHAPE_FIELDS = {
    "Stroke": {"points", "color", "width"},
    "Rect": set(BOX_FIELDS),
    "Ellipse": set(BOX_FIELDS),
    "Polygon": BOX_FIELDS | {"sides"},
    "Text": {"x", "y", "text", "size", "family", "color"},
    "Path": {"nodes", "closed", "fill", "stroke", "width"},
}
PREVIEW_TOKENS = ("<script", "href=", "url(", "<image", "<foreignobject", "<use", "data:")
PREVIEW_NAMESPACE = "http://www.w3.org/2000/svg"

problems = []


def check(condition, message):
    if not condition:
        problems.append(message)
    return bool(condition)


def reject_constant(value):
    raise ValueError(value)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(key)
        result[key] = value
    return result


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def is_number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def valid_id(value):
    return isinstance(value, str) and ID.fullmatch(value.encode("utf-8")) is not None


def safe_path(value):
    if not isinstance(value, str) or not value:
        return False
    raw = value.encode("utf-8")
    if len(raw) > 128 or value.startswith("/") or "\\" in value or ":" in value:
        return False
    return all(
        segment not in (b"", b".", b"..") and SEGMENT.fullmatch(segment) is not None
        for segment in raw.split(b"/")
    )


def valid_version(value):
    return isinstance(value, str) and VERSION.fullmatch(value) is not None


def fields(value, expected, label):
    if not isinstance(value, dict):
        return check(False, f"{label}: expected an object")
    return check(set(value) == expected, f"{label}: fields {sorted(set(value) ^ expected)}")


def read_bytes(path, limit, label):
    name = os.path.basename(path)
    try:
        with open(path, "rb") as handle:
            raw = handle.read(limit + 1)
    except OSError:
        problems.append(f"{label}: cannot read {name}")
        return None
    if not check(len(raw) <= limit, f"{label}: {name} is too large"):
        return None
    return raw


def load_json(path, limit, label):
    raw = read_bytes(path, limit, label)
    if raw is None:
        return None
    try:
        return json.loads(
            raw.decode("utf-8"),
            parse_constant=reject_constant,
            object_pairs_hook=unique_object,
        )
    except (ValueError, UnicodeDecodeError):
        problems.append(f"{label}: {os.path.basename(path)} is not valid JSON")
        return None


def validate_preview(path, label):
    raw = read_bytes(path, PREVIEW_LIMIT, label)
    if raw is None:
        return
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        problems.append(f"{label}: preview is not valid UTF-8")
        return
    trimmed = text.lstrip("\ufeff").lstrip()
    if not check(trimmed.startswith("<svg"), f"{label}: preview does not start with <svg"):
        return
    if not check(PREVIEW_NAMESPACE in trimmed, f"{label}: preview namespace"):
        return
    lower = trimmed.lower()
    for token in PREVIEW_TOKENS:
        check(token not in lower, f"{label}: preview contains {token}")


def validate_point(value, label):
    if not fields(value, POINT_FIELDS, label):
        return
    for axis in ("x", "y"):
        check(is_number(value[axis]), f"{label}: {axis} is not a finite number")


def validate_shape(shape, label):
    if not isinstance(shape, dict):
        check(False, f"{label}: shape is not an object")
        return
    kind = shape.get("kind")
    if not isinstance(kind, str) or kind not in SHAPE_FIELDS:
        check(False, f"{label}: unknown shape kind {kind!r}")
        return
    if not fields(shape, SHAPE_FIELDS[kind] | {"kind"}, f"{label} {kind}"):
        return
    if kind in ("Rect", "Ellipse", "Polygon"):
        for field in ("x", "y", "w", "h", "width"):
            check(is_number(shape[field]), f"{label} {kind}: {field} is not a finite number")
        for field in ("fill", "stroke"):
            check(isinstance(shape[field], str), f"{label} {kind}: {field} is not a string")
        if kind == "Polygon" and check(is_int(shape["sides"]), f"{label} Polygon: sides is not an integer"):
            check(shape["sides"] >= 3, f"{label} Polygon: polygon needs at least 3 sides")
    elif kind == "Stroke":
        check(isinstance(shape["color"], str), f"{label} Stroke: color is not a string")
        check(is_number(shape["width"]), f"{label} Stroke: width is not a finite number")
        if check(isinstance(shape["points"], list), f"{label} Stroke: points is not a list"):
            for index, point in enumerate(shape["points"]):
                validate_point(point, f"{label} Stroke point {index}")
    elif kind == "Text":
        for field in ("x", "y", "size"):
            check(is_number(shape[field]), f"{label} Text: {field} is not a finite number")
        for field in ("text", "family", "color"):
            check(isinstance(shape[field], str), f"{label} Text: {field} is not a string")
        check(isinstance(shape["text"], str) and shape["text"].strip(), f"{label} Text: text is empty")
        check(is_number(shape["size"]) and shape["size"] > 0, f"{label} Text: text size must be positive")
    elif kind == "Path":
        for field in ("fill", "stroke"):
            check(isinstance(shape[field], str), f"{label} Path: {field} is not a string")
        check(isinstance(shape["closed"], bool), f"{label} Path: closed is not a boolean")
        check(is_number(shape["width"]), f"{label} Path: width is not a finite number")
        nodes = shape["nodes"]
        if not check(isinstance(nodes, list), f"{label} Path: nodes is not a list"):
            return
        for index, node in enumerate(nodes):
            node_label = f"{label} Path node {index}"
            if not fields(node, NODE_FIELDS, node_label):
                continue
            validate_point(node["point"], f"{node_label} point")
            for handle in ("handle_in", "handle_out"):
                if node[handle] is not None:
                    validate_point(node[handle], f"{node_label} {handle}")
        if shape["closed"] is True:
            check(len(nodes) >= 3, f"{label} Path: closed path needs at least 3 nodes")
        check(len(nodes) >= 2, f"{label} Path: path needs at least 2 nodes")
        check(is_number(shape["width"]) and 0.5 <= shape["width"] <= 200, f"{label} Path: width must be between 0.5 and 200")


def check_id(value, seen, label):
    if not check(isinstance(value, str) and value, f"{label}: empty id"):
        return
    check(value not in seen, f"{label}: duplicate id {value!r}")
    seen.add(value)


def validate_transform(value, label):
    if not fields(value, TRANSFORM_FIELDS, label):
        return
    for field in sorted(TRANSFORM_FIELDS):
        check(is_number(value[field]), f"{label}: {field} is not a finite number")
    check(is_number(value["scale"]) and value["scale"] > 0, f"{label}: scale must be positive")
    check(is_number(value["opacity"]) and 0 <= value["opacity"] <= 1, f"{label}: opacity out of range")


def validate_document(doc, manifest, label):
    if not fields(doc, DOC_FIELDS, f"{label} document"):
        return
    for field in ("width", "height"):
        check(is_int(doc[field]) and 1 <= doc[field] <= 8192, f"{label}: document {field} out of range")
    check(is_int(doc["fps"]) and 1 <= doc["fps"] <= 60, f"{label}: document fps out of range")
    for field in ("id", "name", "background"):
        check(isinstance(doc[field], str), f"{label}: document {field} is not a string")
    if isinstance(manifest, dict):
        for field in ("width", "height", "fps"):
            check(doc.get(field) == manifest.get(field), f"{label}: {field} differs from manifest")
    scenes = doc["scenes"]
    if not check(isinstance(scenes, list) and scenes, f"{label}: no scenes"):
        return
    ids = set()
    for scene in scenes:
        if not fields(scene, SCENE_FIELDS, f"{label} scene"):
            continue
        check_id(scene["id"], ids, f"{label} scene")
        check(isinstance(scene["name"], str), f"{label}: scene name is not a string")
        layers = scene["layers"]
        if not check(isinstance(layers, list) and layers, f"{label}: no layers"):
            continue
        for layer in layers:
            if not fields(layer, LAYER_FIELDS, f"{label} layer"):
                continue
            check_id(layer["id"], ids, f"{label} layer")
            check(isinstance(layer["name"], str), f"{label}: layer name is not a string")
            check(isinstance(layer["visible"], bool) and isinstance(layer["locked"], bool), f"{label}: layer flags are not booleans")
            check(is_number(layer["opacity"]) and 0 <= layer["opacity"] <= 1, f"{label}: layer opacity out of range")
            length_ok = check(is_int(layer["length"]) and layer["length"] >= 1, f"{label}: layer length out of range")
            keys = layer["keys"]
            if not check(isinstance(keys, list) and keys, f"{label}: no keyframes"):
                continue
            previous = -1
            for index, key in enumerate(keys):
                if not fields(key, KEY_FIELDS, f"{label} keyframe"):
                    continue
                frame_ok = check(is_int(key["frame"]) and key["frame"] >= 0, f"{label}: keyframe frame is not an unsigned integer")
                if frame_ok:
                    if index == 0:
                        check(key["frame"] == 0, f"{label}: first keyframe is not 0")
                    else:
                        check(key["frame"] > previous, f"{label}: keyframes not increasing")
                    if length_ok:
                        check(key["frame"] < layer["length"], f"{label}: keyframe outside length")
                    previous = key["frame"]
                check(isinstance(key["tween"], bool), f"{label}: tween is not a boolean")
                check(key["label"] is None or isinstance(key["label"], str), f"{label}: label is not null or a string")
                validate_transform(key["transform"], f"{label} transform")
                shapes = key["shapes"]
                if check(isinstance(shapes, list), f"{label}: shapes is not a list"):
                    for shape in shapes:
                        validate_shape(shape, f"{label} shape")


def validate_template(root, name):
    folder = os.path.join(root, name)
    manifest = load_json(os.path.join(folder, "manifest.json"), MANIFEST_LIMIT, name)
    if manifest is None:
        return
    if not fields(manifest, MANIFEST_FIELDS, f"{name} manifest"):
        return
    check(manifest["id"] == name and valid_id(manifest["id"]), f"{name}: id mismatch")
    for field in ("name", "description"):
        check(isinstance(manifest[field], str) and manifest[field].strip(), f"{name}: empty {field}")
    for field in ("version", "min_app_version"):
        check(valid_version(manifest[field]), f"{name}: bad {field}")
    for field in ("width", "height"):
        check(is_int(manifest[field]) and 1 <= manifest[field] <= 8192, f"{name}: bad {field}")
    check(is_int(manifest["fps"]) and 1 <= manifest["fps"] <= 60, f"{name}: bad fps")
    for field, suffix, limit in (("preview", ".svg", PREVIEW_LIMIT), ("project", ".json", PROJECT_LIMIT)):
        value = manifest[field]
        if not check(safe_path(value), f"{name}: unsafe {field} path"):
            continue
        if not check(value.endswith(suffix), f"{name}: {field} is not {suffix}"):
            continue
        path = os.path.join(folder, *value.split("/"))
        if not check(os.path.isfile(path), f"{name}: missing {field}"):
            continue
        if field == "preview":
            validate_preview(path, name)
        else:
            doc = load_json(path, limit, name)
            if doc is not None:
                validate_document(doc, manifest, name)


def validate_catalog(root):
    catalog = load_json(os.path.join(root, "catalog.json"), CATALOG_LIMIT, "catalog")
    if catalog is None:
        return None
    if not fields(catalog, {"templates"}, "catalog"):
        return None
    names = catalog["templates"]
    if not check(isinstance(names, list), "catalog: templates is not a list"):
        return None
    if not check(all(isinstance(name, str) for name in names), "catalog: entries are not strings"):
        return None
    check(len(names) <= FOLDER_LIMIT, "catalog: too many templates")
    check(len(set(names)) == len(names), "catalog: duplicate entries")
    for name in names:
        check(valid_id(name), f"catalog: bad folder name {name!r}")
    listed = {name for name in names if isinstance(name, str)}
    present = {
        entry for entry in os.listdir(root)
        if not entry.startswith(".") and os.path.isdir(os.path.join(root, entry))
    }
    for name in sorted(listed - present):
        problems.append(f"catalog: listed folder {name} is missing")
    for name in sorted(present - listed):
        problems.append(f"catalog: folder {name} is not listed")
    return [name for name in names if valid_id(name) and name in present]


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: python scripts/validate-templates.py <templates-dir>\n")
        return 2
    root = sys.argv[1]
    if not os.path.isdir(root):
        sys.stderr.write(f"{root} is not a directory\n")
        return 2
    names = validate_catalog(root)
    if names is not None:
        for name in names:
            validate_template(root, name)
    if problems:
        print("\n".join(problems))
        return 1
    print(f"{len(names or [])} templates valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())