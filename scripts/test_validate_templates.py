import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "validate-templates.py")
spec = importlib.util.spec_from_file_location("validate_templates", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

PREVIEW = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#ffffff"/></svg>'


def manifest_value(folder="ball", **over):
    value = {
        "id": folder,
        "name": "Bouncing ball",
        "description": "A tweened ball you can play right away.",
        "preview": "preview.svg",
        "project": "project.json",
        "version": "1.0.0",
        "min_app_version": "0.1.0",
        "width": 1280,
        "height": 720,
        "fps": 24,
    }
    value.update(over)
    return value


def transform_value(**over):
    value = {"x": 0, "y": 0, "rotation": 0, "scale": 1, "opacity": 1}
    value.update(over)
    return value


def shape_value(**over):
    value = {
        "kind": "Rect",
        "x": 10,
        "y": 20,
        "w": 30,
        "h": 40,
        "fill": "#3b82f6",
        "stroke": "#000000",
        "width": 3,
    }
    value.update(over)
    return value


def keyframe_value(**over):
    value = {
        "frame": 0,
        "shapes": [shape_value()],
        "transform": transform_value(),
        "tween": True,
        "label": None,
    }
    value.update(over)
    return value


def layer_value(**over):
    value = {
        "id": "l0",
        "name": "Ball",
        "visible": True,
        "locked": False,
        "opacity": 1,
        "length": 25,
        "keys": [keyframe_value()],
    }
    value.update(over)
    return value


def document_value(**over):
    value = {
        "id": "d0",
        "name": "Bouncing ball",
        "width": 1280,
        "height": 720,
        "fps": 24,
        "background": "#ffffff",
        "scenes": [{"id": "s0", "name": "Scene 1", "layers": [layer_value()]}],
    }
    value.update(over)
    return value


def scene(doc):
    return doc["scenes"][0]


def layer(doc):
    return scene(doc)["layers"][0]


def key(doc):
    return layer(doc)["keys"][0]


class Tree:
    def __init__(self, root):
        self.root = root

    def write(self, relative, data):
        path = os.path.join(self.root, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if isinstance(data, bytes):
            raw = data
        elif isinstance(data, str):
            raw = data.encode("utf-8")
        else:
            raw = json.dumps(data).encode("utf-8")
        with open(path, "wb") as handle:
            handle.write(raw)

    def catalog(self, names):
        self.write("catalog.json", {"templates": names})

    def template(self, name="ball", manifest=None, project=None, preview=PREVIEW):
        self.write(f"{name}/manifest.json", manifest_value(name) if manifest is None else manifest)
        self.write(f"{name}/project.json", document_value() if project is None else project)
        self.write(f"{name}/preview.svg", PREVIEW if preview is None else preview)

    def problems(self):
        module.problems.clear()
        names = module.validate_catalog(self.root)
        for name in names or []:
            module.validate_template(self.root, name)
        return list(module.problems)


class ValidatorTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.tree = Tree(self.root)
        self.tree.catalog(["ball"])
        self.tree.template()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def assertProblem(self, fragment):
        problems = self.tree.problems()
        self.assertTrue(
            any(fragment in problem for problem in problems),
            f"{fragment!r} not reported, got {problems}",
        )

    def assertValid(self):
        self.assertEqual(self.tree.problems(), [])


class CatalogTests(ValidatorTest):
    def test_valid_tree_passes(self):
        self.assertValid()

    def test_multiple_templates_pass(self):
        self.tree.catalog(["ball", "walk"])
        self.tree.template("walk")
        self.assertValid()

    def test_duplicate_entries(self):
        self.tree.catalog(["ball", "ball"])
        self.assertProblem("duplicate entries")

    def test_bad_folder_names(self):
        for name in ["Ball", "walk_cycle", "-ball", "", "b" * 65, "../ball", "ball.svg"]:
            self.tree.catalog([name])
            self.assertProblem("bad folder name")

    def test_too_many_entries(self):
        self.tree.catalog([f"t{index}" for index in range(module.FOLDER_LIMIT + 1)])
        self.assertProblem("too many templates")

    def test_listed_folder_missing(self):
        self.tree.catalog(["ball", "walk"])
        self.assertProblem("listed folder walk is missing")

    def test_unlisted_folder(self):
        self.tree.template("walk")
        self.assertProblem("folder walk is not listed")

    def test_unknown_catalog_field(self):
        self.tree.write("catalog.json", {"templates": ["ball"], "extra": True})
        self.assertProblem("catalog: fields")

    def test_templates_not_a_list(self):
        self.tree.write("catalog.json", {"templates": "ball"})
        self.assertProblem("templates is not a list")

    def test_entries_not_strings(self):
        self.tree.write("catalog.json", {"templates": [1]})
        self.assertProblem("entries are not strings")

    def test_duplicate_json_keys(self):
        self.tree.write("catalog.json", b'{"templates":["ball"],"templates":["ball"]}')
        self.assertProblem("catalog: catalog.json is not valid JSON")

    def test_non_finite_constants(self):
        for token in [b"NaN", b"Infinity", b"-Infinity"]:
            self.tree.write("catalog.json", b'{"templates":' + token + b"}")
            self.assertProblem("catalog: catalog.json is not valid JSON")

    def test_oversized_catalog(self):
        self.tree.write("catalog.json", b"x" * (module.CATALOG_LIMIT + 1))
        self.assertProblem("catalog.json is too large")

    def test_invalid_utf8_catalog(self):
        self.tree.write("catalog.json", b'{"templates":["\xff"]}')
        self.assertProblem("catalog: catalog.json is not valid JSON")

    def test_missing_catalog(self):
        os.remove(os.path.join(self.root, "catalog.json"))
        self.assertProblem("cannot read catalog.json")

    def test_hidden_folders_are_ignored(self):
        os.makedirs(os.path.join(self.root, ".git"))
        self.assertValid()


class ManifestTests(ValidatorTest):
    def test_id_must_match_folder(self):
        self.tree.template(manifest=manifest_value("walk"))
        self.assertProblem("ball: id mismatch")

    def test_bad_manifest_id(self):
        self.tree.template(manifest=manifest_value("ball", id="Ball"))
        self.assertProblem("ball: id mismatch")

    def test_unknown_field(self):
        self.tree.template(manifest=manifest_value(extra=True))
        self.assertProblem("ball manifest: fields")

    def test_missing_field(self):
        value = manifest_value()
        del value["description"]
        self.tree.template(manifest=value)
        self.assertProblem("ball manifest: fields")

    def test_empty_name_and_description(self):
        for field in ["name", "description"]:
            self.tree.template(manifest=manifest_value(**{field: "   "}))
            self.assertProblem(f"ball: empty {field}")

    def test_bad_versions(self):
        for field in ["version", "min_app_version"]:
            for version in ["1.0", "1.0.0.0", "v1.0.0", "1.0.0-rc1", "1.0.0000000", "", 1]:
                self.tree.template(manifest=manifest_value(**{field: version}))
                self.assertProblem(f"ball: bad {field}")

    def test_resolution_bounds(self):
        for field in ["width", "height"]:
            for value in [0, 8193, -1, 1.5, True, "1280"]:
                self.tree.template(manifest=manifest_value(**{field: value}))
                self.assertProblem(f"ball: bad {field}")

    def test_fps_bounds(self):
        for value in [0, 61, -1, 2.5, True]:
            self.tree.template(manifest=manifest_value(fps=value))
            self.assertProblem("ball: bad fps")

    def test_unsafe_paths(self):
        for field in ["preview", "project"]:
            suffix = ".svg" if field == "preview" else ".json"
            for path in ["../evil" + suffix, "/etc/passwd", "a\\b" + suffix, "C:/a" + suffix,
                         "./a" + suffix, "art//a" + suffix, "art/", "", "a" * 129]:
                self.tree.template(manifest=manifest_value(**{field: path}))
                self.assertProblem(f"ball: unsafe {field} path")

    def test_wrong_extensions(self):
        self.tree.template(manifest=manifest_value(preview="preview.png"))
        self.assertProblem("ball: preview is not .svg")
        self.tree.template(manifest=manifest_value(project="project.txt"))
        self.assertProblem("ball: project is not .json")

    def test_missing_files(self):
        os.remove(os.path.join(self.root, "ball", "preview.svg"))
        self.assertProblem("ball: missing preview")
        self.tree.template()
        os.remove(os.path.join(self.root, "ball", "project.json"))
        self.assertProblem("ball: missing project")

    def test_nested_project_path(self):
        self.tree.template(manifest=manifest_value(project="art/project.json"))
        self.tree.write("ball/art/project.json", document_value())
        self.assertValid()

    def test_duplicate_manifest_keys(self):
        self.tree.write("ball/manifest.json", b'{"id":"ball","id":"ball"}')
        self.assertProblem("ball: manifest.json is not valid JSON")

    def test_oversized_manifest(self):
        self.tree.write("ball/manifest.json", b"x" * (module.MANIFEST_LIMIT + 1))
        self.assertProblem("manifest.json is too large")


class PreviewTests(ValidatorTest):
    def test_bom_and_leading_whitespace(self):
        self.tree.template(preview="\ufeff\n  " + PREVIEW)
        self.assertValid()

    def test_missing_namespace(self):
        self.tree.template(preview='<svg viewBox="0 0 1 1"></svg>')
        self.assertProblem("preview namespace")

    def test_not_svg(self):
        self.tree.template(preview="<html></html>")
        self.assertProblem("preview does not start with <svg")

    def test_forbidden_tokens(self):
        for token in module.PREVIEW_TOKENS:
            self.tree.template(preview=PREVIEW.replace("<rect", token + "<rect"))
            self.assertProblem(f"preview contains {token}")

    def test_tokens_are_case_insensitive(self):
        self.tree.template(preview=PREVIEW.replace("<rect", "<SCRIPT></SCRIPT><rect"))
        self.assertProblem("preview contains <script")

    def test_invalid_utf8(self):
        self.tree.template(preview=b"<svg\xff")
        self.assertProblem("preview is not valid UTF-8")

    def test_oversized(self):
        self.tree.write("ball/preview.svg", b"x" * (module.PREVIEW_LIMIT + 1))
        self.assertProblem("preview.svg is too large")


class DocumentTests(ValidatorTest):
    def test_manifest_mismatch(self):
        for field, value in [("width", 1920), ("height", 1080), ("fps", 30)]:
            self.tree.template(project=document_value(**{field: value}))
            self.assertProblem(f"ball: {field} differs from manifest")

    def test_unknown_fields(self):
        doc = document_value(extra=True)
        self.tree.template(project=doc)
        self.assertProblem("ball document: fields")
        doc = document_value()
        scene(doc)["extra"] = True
        self.tree.template(project=doc)
        self.assertProblem("ball scene: fields")
        doc = document_value()
        layer(doc)["extra"] = True
        self.tree.template(project=doc)
        self.assertProblem("ball layer: fields")
        doc = document_value()
        key(doc)["extra"] = True
        self.tree.template(project=doc)
        self.assertProblem("ball keyframe: fields")
        doc = document_value()
        key(doc)["transform"]["extra"] = True
        self.tree.template(project=doc)
        self.assertProblem("ball transform: fields")

    def test_empty_collections(self):
        self.tree.template(project=document_value(scenes=[]))
        self.assertProblem("ball: no scenes")
        doc = document_value()
        scene(doc)["layers"] = []
        self.tree.template(project=doc)
        self.assertProblem("ball: no layers")
        doc = document_value()
        layer(doc)["keys"] = []
        self.tree.template(project=doc)
        self.assertProblem("ball: no keyframes")

    def test_duplicate_ids(self):
        doc = document_value()
        scene(doc)["layers"].append(layer_value())
        self.tree.template(project=doc)
        self.assertProblem("duplicate id 'l0'")
        doc = document_value()
        doc["scenes"].append({"id": "s0", "name": "Scene 2", "layers": [layer_value(id="l1")]})
        self.tree.template(project=doc)
        self.assertProblem("duplicate id 's0'")

    def test_empty_ids(self):
        doc = document_value()
        layer(doc)["id"] = ""
        self.tree.template(project=doc)
        self.assertProblem("empty id")

    def test_first_keyframe_must_be_zero(self):
        doc = document_value()
        key(doc)["frame"] = 1
        self.tree.template(project=doc)
        self.assertProblem("first keyframe is not 0")

    def test_keyframes_must_increase(self):
        doc = document_value()
        layer(doc)["keys"] = [keyframe_value(frame=0), keyframe_value(frame=12), keyframe_value(frame=6)]
        self.tree.template(project=doc)
        self.assertProblem("keyframes not increasing")

    def test_keyframe_outside_length(self):
        doc = document_value()
        layer(doc)["length"] = 12
        layer(doc)["keys"] = [keyframe_value(frame=0), keyframe_value(frame=12)]
        self.tree.template(project=doc)
        self.assertProblem("keyframe outside length")

    def test_held_frames_are_valid(self):
        doc = document_value()
        layer(doc)["length"] = 25
        layer(doc)["keys"] = [keyframe_value(frame=0), keyframe_value(frame=12, tween=False), keyframe_value(frame=24)]
        self.tree.template(project=doc)
        self.assertValid()

    def test_layer_length_bounds(self):
        for value in [0, -1, 1.5, True]:
            doc = document_value()
            layer(doc)["length"] = value
            self.tree.template(project=doc)
            self.assertProblem("layer length out of range")

    def test_layer_flags_and_opacity(self):
        doc = document_value()
        layer(doc)["visible"] = "yes"
        self.tree.template(project=doc)
        self.assertProblem("layer flags are not booleans")
        for value in [-0.1, 1.1, "1", None]:
            doc = document_value()
            layer(doc)["opacity"] = value
            self.tree.template(project=doc)
            self.assertProblem("layer opacity out of range")

    def test_transform_bounds(self):
        doc = document_value()
        key(doc)["transform"]["scale"] = 0
        self.tree.template(project=doc)
        self.assertProblem("scale must be positive")
        for value in [-0.1, 1.1]:
            doc = document_value()
            key(doc)["transform"]["opacity"] = value
            self.tree.template(project=doc)
            self.assertProblem("opacity out of range")

    def test_non_finite_transform(self):
        doc = document_value()
        key(doc)["transform"]["x"] = float("nan")
        self.tree.write("ball/project.json", json.dumps(doc).replace("NaN", "1e999"))
        self.assertProblem("x is not a finite number")

    def test_tween_and_label_types(self):
        doc = document_value()
        key(doc)["tween"] = "yes"
        self.tree.template(project=doc)
        self.assertProblem("tween is not a boolean")
        doc = document_value()
        key(doc)["label"] = 5
        self.tree.template(project=doc)
        self.assertProblem("label is not null or a string")
        doc = document_value()
        key(doc)["label"] = "intro"
        self.tree.template(project=doc)
        self.assertValid()

    def test_document_bounds(self):
        for field in ["width", "height"]:
            for value in [0, 8193, 1.5]:
                self.tree.template(project=document_value(**{field: value}), manifest=manifest_value(**{field: value}))
                self.assertProblem(f"document {field} out of range")
        for value in [0, 61]:
            self.tree.template(project=document_value(fps=value), manifest=manifest_value(fps=value))
            self.assertProblem("document fps out of range")

    def test_oversized_project(self):
        self.tree.write("ball/project.json", b"x" * (module.PROJECT_LIMIT + 1))
        self.assertProblem("project.json is too large")

    def test_duplicate_project_keys(self):
        self.tree.write("ball/project.json", b'{"id":"d0","id":"d0"}')
        self.assertProblem("ball: project.json is not valid JSON")


class ShapeTests(ValidatorTest):
    def withShape(self, value):
        doc = document_value()
        key(doc)["shapes"] = [value]
        self.tree.template(project=doc)

    def test_every_kind_passes(self):
        box = {"x": 0, "y": 0, "w": 10, "h": 10, "fill": "#ffffff", "stroke": "#000000", "width": 2}
        valid = [
            shape_value(),
            dict(box, kind="Ellipse"),
            dict(box, kind="Polygon", sides=5),
            {"kind": "Stroke", "points": [{"x": 0, "y": 0}, {"x": 5, "y": 5}], "color": "#000000", "width": 2},
            {"kind": "Text", "x": 0, "y": 0, "text": "Hi", "size": 24, "family": "Arial", "color": "#000000"},
            {"kind": "Path", "closed": False, "fill": "#ffffff", "stroke": "#000000", "width": 2,
             "nodes": [{"point": {"x": 0, "y": 0}, "handle_in": None, "handle_out": {"x": 10, "y": 0}},
                       {"point": {"x": 20, "y": 20}, "handle_in": {"x": 10, "y": 20}, "handle_out": None}]},
        ]
        for value in valid:
            self.withShape(value)
            self.assertEqual(self.tree.problems(), [], value["kind"])

    def test_empty_shapes_are_valid(self):
        doc = document_value()
        key(doc)["shapes"] = []
        self.tree.template(project=doc)
        self.assertValid()

    def test_unknown_kind(self):
        self.withShape(dict(shape_value(), kind="Line"))
        self.assertProblem("unknown shape kind 'Line'")

    def test_field_sets(self):
        self.withShape(dict(shape_value(), extra=1))
        self.assertProblem("ball shape Rect: fields")
        value = shape_value()
        del value["fill"]
        self.withShape(value)
        self.assertProblem("ball shape Rect: fields")

    def test_box_numbers(self):
        for field in ["x", "y", "w", "h", "width"]:
            self.withShape(dict(shape_value(), **{field: "1"}))
            self.assertProblem(f"{field} is not a finite number")

    def test_polygon_sides(self):
        for sides in [0, 2, -1]:
            self.withShape(dict(shape_value(), kind="Polygon", sides=sides))
            self.assertProblem("polygon needs at least 3 sides")
        self.withShape(dict(shape_value(), kind="Polygon", sides="5"))
        self.assertProblem("sides is not an integer")

    def test_text(self):
        base = {"kind": "Text", "x": 0, "y": 0, "text": "Hi", "size": 24, "family": "Arial", "color": "#000000"}
        self.withShape(dict(base, text="   "))
        self.assertProblem("text is empty")
        self.withShape(dict(base, size=0))
        self.assertProblem("text size must be positive")

    def test_stroke_points(self):
        base = {"kind": "Stroke", "points": [{"x": 0, "y": 0}], "color": "#000000", "width": 2}
        self.withShape(dict(base, points=[{"x": 0}]))
        self.assertProblem("ball shape Stroke point 0: fields")
        self.withShape(dict(base, points="no"))
        self.assertProblem("points is not a list")

    def test_path_node_counts(self):
        node = {"point": {"x": 0, "y": 0}, "handle_in": None, "handle_out": None}
        base = {"kind": "Path", "closed": False, "fill": "#ffffff", "stroke": "#000000", "width": 2}
        self.withShape(dict(base, nodes=[node]))
        self.assertProblem("path needs at least 2 nodes")
        self.withShape(dict(base, closed=True, nodes=[node, node]))
        self.assertProblem("closed path needs at least 3 nodes")

    def test_path_width_bounds(self):
        node = {"point": {"x": 0, "y": 0}, "handle_in": None, "handle_out": None}
        base = {"kind": "Path", "closed": False, "fill": "#ffffff", "stroke": "#000000", "nodes": [node, node]}
        for width in [0.4, 200.1]:
            self.withShape(dict(base, width=width))
            self.assertProblem("width must be between 0.5 and 200")
        for width in [0.5, 200]:
            self.withShape(dict(base, width=width))
            self.assertValid()

    def test_path_coordinates_must_be_finite(self):
        node = {"point": {"x": 0, "y": 0}, "handle_in": None, "handle_out": None}
        for target in ["point", "handle_in", "handle_out"]:
            path = {"kind": "Path", "closed": False, "fill": "#ffffff", "stroke": "#000000", "width": 2,
                    "nodes": [dict(node), dict(node)]}
            path["nodes"][1][target] = {"x": 0, "y": "@INF@"}
            doc = document_value()
            key(doc)["shapes"] = [path]
            self.tree.write("ball/project.json", json.dumps(doc).replace('"@INF@"', "1e999"))
            self.assertProblem("is not a finite number")

    def test_path_closed_must_be_boolean(self):
        node = {"point": {"x": 0, "y": 0}, "handle_in": None, "handle_out": None}
        self.withShape({"kind": "Path", "closed": "yes", "fill": "#ffffff", "stroke": "#000000",
                        "width": 2, "nodes": [node, node]})
        self.assertProblem("closed is not a boolean")

    def test_multiple_shapes(self):
        doc = document_value()
        key(doc)["shapes"] = [shape_value(), dict(shape_value(), kind="Ellipse", x=50)]
        self.tree.template(project=doc)
        self.assertValid()


class CliTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.tree = Tree(self.root)
        self.tree.catalog(["ball"])
        self.tree.template()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_script(self, *args):
        return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True)

    def test_valid_tree_exits_zero(self):
        result = self.run_script(self.root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.strip(), "1 templates valid")

    def test_problems_exit_one(self):
        self.tree.catalog(["ball", "walk"])
        result = self.run_script(self.root)
        self.assertEqual(result.returncode, 1)
        self.assertIn("listed folder walk is missing", result.stdout)

    def test_usage_exits_two(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr.strip(), "usage: python scripts/validate-templates.py <templates-dir>")

    def test_missing_directory_exits_two(self):
        result = self.run_script(os.path.join(self.root, "absent"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("is not a directory", result.stderr)


if __name__ == "__main__":
    unittest.main()