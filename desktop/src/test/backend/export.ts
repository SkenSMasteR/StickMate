import runtimeSource from "@/export/runtime.js?raw";
import { layerLength } from "@/lib/document";
import type { Document, Scene } from "@/lib/document";
import type { ExportOptions, ExportResult } from "@/lib/export";
import type { MockExtension } from "../backend";

const PROJECT_LIMIT = 8 * 1024 * 1024;
const ROOT = "C:/Users/Test/Downloads/StickMate";

export const disk = new Map<string, string>();

export function reset(): void {
  disk.clear();
}

function sceneLength(scene: Scene): number {
  return Math.max(1, ...scene.layers.map(layerLength));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeFolder(value: string): string {
  const mapped = [...value]
    .slice(0, 64)
    .map((ch) => (/[.<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/.test(ch) ? "-" : ch))
    .join("");
  const trimmed = mapped.replace(/[- ]+$/, "");
  return trimmed === "" ? "stickmate" : trimmed;
}

function htmlPage(name: string, json: string, width: number, height: number): string {
  const title = escapeHtml(name);
  const embedded = json.replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>body{margin:0;display:flex;flex-direction:column;align-items:center;gap:12px;background:#18181b;color:#fafafa;font-family:system-ui,sans-serif}h1{font-size:16px;font-weight:600;margin:12px 0 0}canvas{border:1px solid #3f3f46;max-width:100%}</style>
</head>
<body>
<h1>${title}</h1>
<canvas id="stage" width="${width}" height="${height}"></canvas>
<script id="stickmate-project" type="application/json">${embedded}</script>
<script src="stickmate.js"></script>
<script>
const player = StickMate.load(JSON.parse(document.getElementById("stickmate-project").textContent));
player.mount(document.getElementById("stage"));
player.play();
</script>
</body>
</html>
`;
}

interface Payload {
  json: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
}

function buildPayload(doc: Document, options: ExportOptions): Payload {
  if (!Number.isInteger(options.fps) || options.fps < 1 || options.fps > 60) {
    throw new Error("frame rate must be between 1 and 60");
  }
  if (!Number.isFinite(options.scale) || options.scale < 0.25 || options.scale > 4) {
    throw new Error("resolution scale must be between 0.25 and 4");
  }
  const width = Math.max(1, Math.round(doc.width * options.scale));
  const height = Math.max(1, Math.round(doc.height * options.scale));
  if (width > 16384 || height > 16384) {
    throw new Error("export resolution is too large");
  }
  const exportDoc: Document = structuredClone(doc);
  exportDoc.width = width;
  exportDoc.height = height;
  exportDoc.fps = options.fps;
  if (options.transparent) {
    exportDoc.background = "";
  }
  let startFrame = 0;
  let endFrame: number | null = null;
  let frames: number;
  const range = options.range;
  if (range.kind === "whole") {
    frames = Math.max(1, exportDoc.scenes.reduce((sum, scene) => sum + sceneLength(scene), 0));
  } else {
    const index = exportDoc.scenes.findIndex((scene) => scene.id === range.sceneId);
    if (index < 0) {
      throw new Error("unknown scene");
    }
    const scene = exportDoc.scenes[index];
    if (range.kind === "scene") {
      exportDoc.scenes = [scene];
      frames = sceneLength(scene);
    } else {
      if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.end < range.start ||
        range.end >= sceneLength(scene)
      ) {
        throw new Error("frame range is invalid");
      }
      exportDoc.scenes = [scene];
      startFrame = range.start;
      endFrame = range.end;
      frames = range.end - range.start + 1;
    }
  }
  const json = JSON.stringify({
    ...exportDoc,
    loop: options.loop,
    scale: options.scale,
    startFrame,
    endFrame
  });
  if (json.length > PROJECT_LIMIT) {
    throw new Error("project is too large to export");
  }
  return { json, width, height, fps: options.fps, frames };
}

export const handlers: MockExtension = (context) => ({
  export_web: (args): ExportResult => {
    const id = args.id as string;
    const format = args.format as string;
    const options = args.options as ExportOptions;
    if (format !== "html5" && format !== "canvasjs") {
      throw new Error("unknown export format");
    }
    const doc = context.state(id).doc;
    const payload = buildPayload(doc, options);
    const folder = `${sanitizeFolder(doc.name)}-${format}`;
    const dir = `${ROOT}/${folder}`;
    const files = ["stickmate.js", "project.json"];
    disk.set(`${dir}/stickmate.js`, runtimeSource);
    disk.set(`${dir}/project.json`, payload.json);
    if (format === "html5") {
      disk.set(`${dir}/index.html`, htmlPage(doc.name, payload.json, payload.width, payload.height));
      files.push("index.html");
    }
    return {
      path: dir,
      files,
      width: payload.width,
      height: payload.height,
      fps: payload.fps,
      frames: payload.frames
    };
  }
});