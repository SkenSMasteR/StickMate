import type { Document, Shape } from "@/lib/document";
import type { MockExtension } from "../backend";

const CATALOG_LIMIT = 256 * 1024;
const PREVIEW_LIMIT = 512 * 1024;
const PROJECT_LIMIT = 8 * 1024 * 1024;
const FOLDER_LIMIT = 64;
const APP_VERSION = "0.1.5";

const blankProject =
  '{"id":"d0","name":"Blank stage","width":1920,"height":1080,"fps":30,"background":"#ffffff","scenes":[{"id":"s0","name":"Scene 1","layers":[{"id":"l0","name":"Layer 1","visible":true,"locked":false,"opacity":1,"length":1,"keys":[{"frame":0,"shapes":[],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]}]}]}';

const ballProject =
  '{"id":"d0","name":"Bouncing ball","width":1280,"height":720,"fps":24,"background":"#ffffff","scenes":[{"id":"s0","name":"Scene 1","layers":[{"id":"l0","name":"Ball","visible":true,"locked":false,"opacity":1,"length":25,"keys":[{"frame":0,"shapes":[{"kind":"Ellipse","x":560,"y":80,"w":160,"h":160,"fill":"#3b82f6","stroke":"#000000","width":3}],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":true,"label":null},{"frame":12,"shapes":[{"kind":"Ellipse","x":560,"y":80,"w":160,"h":160,"fill":"#3b82f6","stroke":"#000000","width":3}],"transform":{"x":0,"y":400,"rotation":0,"scale":1,"opacity":1},"tween":true,"label":null},{"frame":24,"shapes":[{"kind":"Ellipse","x":560,"y":80,"w":160,"h":160,"fill":"#3b82f6","stroke":"#000000","width":3}],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]}]}]}';

const walkProject =
  '{"id":"d0","name":"Walk cycle","width":1080,"height":1080,"fps":12,"background":"#ffffff","scenes":[{"id":"s0","name":"Scene 1","layers":[{"id":"l0","name":"Head","visible":true,"locked":false,"opacity":1,"length":1,"keys":[{"frame":0,"shapes":[],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]},{"id":"l1","name":"Arms","visible":true,"locked":false,"opacity":1,"length":1,"keys":[{"frame":0,"shapes":[],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]},{"id":"l2","name":"Body","visible":true,"locked":false,"opacity":1,"length":1,"keys":[{"frame":0,"shapes":[],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]},{"id":"l3","name":"Legs","visible":true,"locked":false,"opacity":1,"length":1,"keys":[{"frame":0,"shapes":[],"transform":{"x":0,"y":0,"rotation":0,"scale":1,"opacity":1},"tween":false,"label":null}]}]}]}';

const blankPreview = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180">
  <rect width="320" height="180" fill="#ffffff"/>
  <rect x="10" y="10" width="300" height="160" fill="none" stroke="#d4d4d8" stroke-width="2"/>
</svg>
`;

const ballPreview = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180">
  <rect width="320" height="180" fill="#ffffff"/>
  <line x1="20" y1="150" x2="300" y2="150" stroke="#a1a1aa" stroke-width="3"/>
  <path d="M40 40 Q100 150 140 150 Q180 150 250 50" fill="none" stroke="#d4d4d8" stroke-width="3" stroke-dasharray="6 6"/>
  <circle cx="140" cy="128" r="22" fill="#3b82f6" stroke="#000000" stroke-width="3"/>
</svg>
`;

const walkPreview = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" width="180" height="180">
  <rect width="180" height="180" fill="#ffffff"/>
  <circle cx="90" cy="40" r="18" fill="none" stroke="#000000" stroke-width="4"/>
  <line x1="90" y1="58" x2="90" y2="105" stroke="#000000" stroke-width="4"/>
  <line x1="90" y1="72" x2="58" y2="94" stroke="#000000" stroke-width="4"/>
  <line x1="90" y1="72" x2="124" y2="88" stroke="#000000" stroke-width="4"/>
  <line x1="90" y1="105" x2="64" y2="152" stroke="#000000" stroke-width="4"/>
  <line x1="90" y1="105" x2="118" y2="148" stroke="#000000" stroke-width="4"/>
</svg>
`;

interface Manifest {
  id: string;
  name: string;
  description: string;
  preview: string;
  project: string;
  version: string;
  min_app_version: string;
  width: number;
  height: number;
  fps: number;
}

const textFields = [
  "id",
  "name",
  "description",
  "preview",
  "project",
  "version",
  "min_app_version"
] as const;

const numberFields = ["width", "height", "fps"] as const;

function manifest(
  id: string,
  name: string,
  description: string,
  width: number,
  height: number,
  fps: number
): string {
  return JSON.stringify({
    id,
    name,
    description,
    preview: "preview.svg",
    project: "project.json",
    version: "1.0.0",
    min_app_version: "0.1.0",
    width,
    height,
    fps
  });
}

function initialFiles(): Record<string, string> {
  return {
    "catalog.json": JSON.stringify({ templates: ["blank", "ball", "walk"] }),
    "blank/manifest.json": manifest(
      "blank",
      "Blank stage",
      "One empty layer at full HD.",
      1920,
      1080,
      30
    ),
    "blank/preview.svg": blankPreview,
    "blank/project.json": blankProject,
    "ball/manifest.json": manifest(
      "ball",
      "Bouncing ball",
      "A tweened ball you can play right away.",
      1280,
      720,
      24
    ),
    "ball/preview.svg": ballPreview,
    "ball/project.json": ballProject,
    "walk/manifest.json": manifest(
      "walk",
      "Walk cycle",
      "Head, arms, body and legs layers ready to pose.",
      1080,
      1080,
      12
    ),
    "walk/preview.svg": walkPreview,
    "walk/project.json": walkProject
  };
}

export const server = {
  online: true,
  files: initialFiles(),
  requests: [] as string[]
};

export const cache = new Map<string, string>();

export function reset(): void {
  server.online = true;
  server.files = initialFiles();
  server.requests = [];
  cache.clear();
}

function validId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function safePath(value: string): boolean {
  if (
    !value ||
    value.length > 128 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(":")
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._-]+$/.test(segment)
    );
}

function parseVersion(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[0-9]{1,6}$/.test(part))) {
    return null;
  }
  return parts.map(Number);
}

function supported(min: string): boolean {
  const needed = parseVersion(min);
  const current = parseVersion(APP_VERSION);
  if (!needed || !current) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (needed[index] !== current[index]) {
      return needed[index] < current[index];
    }
  }
  return true;
}

function fetchBytes(path: string, limit: number): { body: string; cached: boolean } {
  server.requests.push(path);
  if (server.online) {
    const body = server.files[path];
    if (body === undefined) {
      throw new Error("templates could not be loaded");
    }
    if (body.length > limit) {
      throw new Error("template file is too large");
    }
    cache.set(path, body);
    return { body, cached: false };
  }
  const body = cache.get(path);
  if (body === undefined) {
    throw new Error("templates could not be loaded");
  }
  if (body.length > limit) {
    throw new Error("template file is too large");
  }
  return { body, cached: true };
}

function parseCatalog(body: string): string[] {
  const invalid = "template catalog is invalid";
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error(invalid);
  }
  const folders = (value as { templates?: unknown }).templates;
  if (!Array.isArray(folders) || folders.length > FOLDER_LIMIT) {
    throw new Error(invalid);
  }
  const seen: string[] = [];
  for (const folder of folders) {
    if (typeof folder !== "string" || !validId(folder) || seen.includes(folder)) {
      throw new Error(invalid);
    }
    seen.push(folder);
  }
  return seen;
}

function parseManifest(folder: string, body: string): Manifest {
  const invalid = `template ${folder} is invalid`;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error(invalid);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(invalid);
  }
  const record = value as Record<string, unknown>;
  const fields: string[] = [...textFields, ...numberFields];
  if (Object.keys(record).some((key) => !fields.includes(key))) {
    throw new Error(invalid);
  }
  for (const field of textFields) {
    if (typeof record[field] !== "string") {
      throw new Error(invalid);
    }
  }
  for (const field of numberFields) {
    if (!Number.isInteger(record[field])) {
      throw new Error(invalid);
    }
  }
  const parsed = record as unknown as Manifest;
  if (parsed.id !== folder || !validId(parsed.id)) {
    throw new Error(invalid);
  }
  if (!parsed.name.trim() || !parsed.description.trim()) {
    throw new Error(invalid);
  }
  if (!safePath(parsed.preview) || !parsed.preview.endsWith(".svg")) {
    throw new Error(invalid);
  }
  if (!safePath(parsed.project) || !parsed.project.endsWith(".json")) {
    throw new Error(invalid);
  }
  if (!parseVersion(parsed.version) || !parseVersion(parsed.min_app_version)) {
    throw new Error(invalid);
  }
  if (
    parsed.width < 1 ||
    parsed.height < 1 ||
    parsed.width > 8192 ||
    parsed.height > 8192 ||
    parsed.fps < 1 ||
    parsed.fps > 60
  ) {
    throw new Error(invalid);
  }
  return parsed;
}

function loadManifest(id: string): Manifest {
  if (!validId(id)) {
    throw new Error("template id is invalid");
  }
  return parseManifest(id, fetchBytes(`${id}/manifest.json`, CATALOG_LIMIT).body);
}

function validatePreview(body: string): void {
  const invalid = "template preview is invalid";
  const text = body.replace(/^\uFEFF/, "").trimStart();
  if (!text.startsWith("<svg") || !text.includes("http://www.w3.org/2000/svg")) {
    throw new Error(invalid);
  }
  const lower = text.toLowerCase();
  for (const token of [
    "<script",
    "href=",
    "url(",
    "<image",
    "<foreignobject",
    "<use",
    "data:"
  ]) {
    if (lower.includes(token)) {
      throw new Error(invalid);
    }
  }
}

function validateShape(shape: Shape): void {
  const invalid = "template project is invalid";
  if (!shape || typeof shape !== "object") {
    throw new Error(invalid);
  }
  if (shape.kind === "Polygon") {
    if (shape.sides < 3) {
      throw new Error("polygon needs at least 3 sides");
    }
    return;
  }
  if (shape.kind === "Text") {
    if (!shape.text.trim()) {
      throw new Error("text is empty");
    }
    if (shape.size <= 0) {
      throw new Error("text size must be positive");
    }
    return;
  }
  if (shape.kind === "Path") {
    if (shape.closed && shape.nodes.length < 3) {
      throw new Error("closed path needs at least 3 nodes");
    }
    if (shape.nodes.length < 2) {
      throw new Error("path needs at least 2 nodes");
    }
    if (shape.width < 0.5 || shape.width > 200) {
      throw new Error("width must be between 0.5 and 200");
    }
    return;
  }
  if (shape.kind !== "Stroke" && shape.kind !== "Rect" && shape.kind !== "Ellipse") {
    throw new Error(invalid);
  }
}

function parseProject(body: string, expected: Manifest): Document {
  const invalid = "template project is invalid";
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error(invalid);
  }
  const doc = value as Document;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(invalid);
  }
  if (
    typeof doc.id !== "string" ||
    typeof doc.name !== "string" ||
    typeof doc.background !== "string" ||
    !Array.isArray(doc.scenes)
  ) {
    throw new Error(invalid);
  }
  if (
    !Number.isInteger(doc.width) ||
    !Number.isInteger(doc.height) ||
    doc.width < 1 ||
    doc.height < 1 ||
    doc.width > 8192 ||
    doc.height > 8192
  ) {
    throw new Error("template project resolution is invalid");
  }
  if (!Number.isInteger(doc.fps) || doc.fps < 1 || doc.fps > 60) {
    throw new Error("template project frame rate is invalid");
  }
  if (doc.scenes.length === 0) {
    throw new Error(invalid);
  }
  const scenes = new Set<string>();
  for (const scene of doc.scenes) {
    if (
      !scene ||
      typeof scene.id !== "string" ||
      !scene.id ||
      scenes.has(scene.id) ||
      !Array.isArray(scene.layers) ||
      scene.layers.length === 0
    ) {
      throw new Error(invalid);
    }
    scenes.add(scene.id);
    const layers = new Set<string>();
    for (const layer of scene.layers) {
      if (
        !layer ||
        typeof layer.id !== "string" ||
        !layer.id ||
        layers.has(layer.id) ||
        !Array.isArray(layer.keys) ||
        layer.keys.length === 0 ||
        !Number.isInteger(layer.length)
      ) {
        throw new Error(invalid);
      }
      layers.add(layer.id);
      layer.keys.forEach((key, index) => {
        if (!key || !Number.isInteger(key.frame)) {
          throw new Error(invalid);
        }
        const ordered =
          index === 0 ? key.frame === 0 : key.frame > layer.keys[index - 1].frame;
        if (!ordered || key.frame >= layer.length) {
          throw new Error(invalid);
        }
        const transform = key.transform;
        if (
          !transform ||
          ![
            transform.x,
            transform.y,
            transform.rotation,
            transform.scale,
            transform.opacity
          ].every((number) => Number.isFinite(number)) ||
          transform.scale <= 0 ||
          transform.opacity < 0 ||
          transform.opacity > 1
        ) {
          throw new Error("template project transform is invalid");
        }
        if (!Array.isArray(key.shapes) || typeof key.tween !== "boolean") {
          throw new Error(invalid);
        }
        key.shapes.forEach(validateShape);
      });
    }
  }
  if (
    doc.width !== expected.width ||
    doc.height !== expected.height ||
    doc.fps !== expected.fps
  ) {
    throw new Error("template project does not match its manifest");
  }
  return doc;
}

export const handlers: MockExtension = (context) => ({
  templates_catalog: () => {
    const catalog = fetchBytes("catalog.json", CATALOG_LIMIT);
    let cached = catalog.cached;
    const templates = parseCatalog(catalog.body).map((folder) => {
      const file = fetchBytes(`${folder}/manifest.json`, CATALOG_LIMIT);
      cached = cached || file.cached;
      const parsed = parseManifest(folder, file.body);
      return {
        id: parsed.id,
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        min_app_version: parsed.min_app_version,
        width: parsed.width,
        height: parsed.height,
        fps: parsed.fps,
        supported: supported(parsed.min_app_version),
        project_cached: cache.has(`${folder}/${parsed.project}`)
      };
    });
    return { cached, templates };
  },
  templates_preview: (args) => {
    const id = args.id as string;
    const parsed = loadManifest(id);
    const file = fetchBytes(`${id}/${parsed.preview}`, PREVIEW_LIMIT);
    validatePreview(file.body);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.body)}`;
  },
  templates_open: (args) => {
    const id = args.id as string;
    const parsed = loadManifest(id);
    if (!supported(parsed.min_app_version)) {
      throw new Error("template needs a newer app version");
    }
    const file = fetchBytes(`${id}/${parsed.project}`, PROJECT_LIMIT);
    const source = parseProject(file.body, parsed);
    const doc: Document = {
      ...structuredClone(source),
      id: context.id("d"),
      name: parsed.name
    };
    context.store.set(doc.id, {
      doc,
      undo: [],
      redo: [],
      updated_at: Date.now()
    });
    return doc.id;
  }
});