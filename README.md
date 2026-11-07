# StickMate templates branch

This directory is the content of the public orphan branch `templates` of
`SkenSMasteR/StickMate`. It is published on its own and never merged into `main`.

Raw base URL used by the app:

```
https://raw.githubusercontent.com/SkenSMasteR/StickMate/templates/
```

## Layout

```
catalog.json
blank/manifest.json
blank/preview.svg
blank/project.json
ball/manifest.json
ball/preview.svg
ball/project.json
walk/manifest.json
walk/preview.svg
walk/project.json
```

`catalog.json` lists folder names:

```json
{ "templates": ["blank", "ball", "walk"] }
```

Each folder holds one template. `manifest.json` fields:

| Field | Rule |
| --- | --- |
| `id` | Equals the folder name, matches `^[a-z0-9][a-z0-9-]{0,63}$` |
| `name` | Short display name, English, not empty |
| `description` | One sentence, English, not empty |
| `preview` | Relative path inside the folder, ends with `.svg` |
| `project` | Relative path inside the folder, ends with `.json` |
| `version` | Template version, `X.Y.Z` |
| `min_app_version` | Oldest app version that can open it, `X.Y.Z` |
| `width` | Stage width, 1 to 8192, equals the project width |
| `height` | Stage height, 1 to 8192, equals the project height |
| `fps` | Frame rate, 1 to 60, equals the project fps |

`project.json` is a StickMate `Document` exactly as serialized by
`desktop/src-tauri/src/document.rs`: `id`, `name`, `width`, `height`, `fps`,
`background`, `scenes[]` with `id`, `name`, `layers[]`. Each layer has `id`,
`name`, `visible`, `locked`, `opacity`, `length`, `keys[]`. Each keyframe has
`frame`, `shapes[]`, `transform` (`x`, `y`, `rotation`, `scale`, `opacity`),
`tween`, `label`. Shapes are tagged with `kind`: `Stroke`, `Rect`, `Ellipse`,
`Polygon`, `Text`, `Path`.

The app replaces the document `id` on import, so the `id` stored here is a
placeholder. Layer and scene ids must be unique inside the document. Keyframes
must start at frame 0, increase strictly, and stay below `length`.

## Publication validation

Run these checks on every folder before pushing the branch. The app repeats all
of them at download time and refuses anything that fails.

1. Every folder listed in `catalog.json` exists and contains `manifest.json`,
   its preview and its project. No folder is missing from the catalog.
2. Folder names are unique and match `^[a-z0-9][a-z0-9-]{0,63}$`. At most 64
   folders are listed.
3. `manifest.json` parses, has exactly the fields above, and `id` equals the
   folder name.
4. `preview` and `project` are relative paths inside the folder: no leading `/`,
   no drive letter, no `:` anywhere, no `\`, no `..` or `.` segment, no empty
   segment, and only letters, digits, `-`, `_`, `.` in each segment.
5. `version` and `min_app_version` are `X.Y.Z`. A template whose
   `min_app_version` is newer than the released app is listed as unsupported and
   cannot be installed.
6. Sizes stay under the caps: catalog 256 KiB, manifest 256 KiB, preview 512 KiB,
   project 8 MiB.
7. `preview.svg` is hand written SVG with the standard SVG namespace, no script,
   no `href`, no `url(...)`, no embedded raster data, no external reference.
8. `project.json` deserializes into `Document`, passes the document shape
   validation, and its `width`, `height` and `fps` equal the manifest values.
9. Content is generic teaching material only. No user project, no credential, no
   token, no private path, no personal data.

## Templates in this branch

- `blank`: 1920x1080 at 30 fps, white stage, one empty layer.
- `ball`: 1280x720 at 24 fps, blue ellipse on a `Ball` layer, keyframes 0, 12 and
  24, transform y 0 to 400 and back, tweens on frames 0 and 12, length 25.
- `walk`: 1080x1080 at 12 fps, empty `Head`, `Arms`, `Body` and `Legs` layers.