import type { Document, Keyframe, Layer } from "@/lib/document";
import type { FlaExportResult, FlaImportResult } from "@/lib/fla";
import type { MockExtension } from "../backend";

export const written = new Map<string, string>();

let savePath: string | null = null;
let importResult: FlaImportResult | null = null;

export function reset(): void {
  written.clear();
  savePath = null;
  importResult = null;
}

export function nextSavePath(path: string | null): void {
  savePath = path;
}

export function nextImportResult(result: FlaImportResult | null): void {
  importResult = result;
}

function gap(flags: Set<string>, layer: Layer) {
  if (layer.blend !== "normal") {
    flags.add("blend");
  }
  if (layer.effects.length > 0) {
    flags.add("effect");
  }
  if (layer.masked) {
    flags.add("mask");
  }
  if (layer.folder) {
    flags.add("folder");
  }
  if (layer.opacity !== 1) {
    flags.add("opacity");
  }
  for (const key of layer.keys) {
    if (key.tween) {
      flags.add("tween");
    }
    if (key.transform.opacity !== 1) {
      flags.add("opacity");
    }
    if (hasGradient(key)) {
      flags.add("gradient");
    }
  }
  for (const child of layer.children) {
    gap(flags, child);
  }
}

function hasGradient(key: Keyframe): boolean {
  return key.shapes.some((shape) =>
    "gradient" in shape && shape.gradient !== undefined && shape.gradient !== null
  );
}

const TEXTS: Record<string, string> = {
  gradient: "gradient fills are exported as flat colours",
  blend: "blend modes are not exported",
  effect: "layer effects are not exported",
  mask: "layer masks are not exported",
  folder: "layer folders are exported as plain layers",
  opacity: "layer and keyframe opacity are exported as shape transparency",
  tween: "tweens are exported as keyframes that hold until the next key"
};

const ORDER = ["gradient", "blend", "effect", "mask", "folder", "opacity", "tween"];

export const handlers: MockExtension = (context) => ({
  "plugin:dialog|save": () => savePath,

  "plugin:dialog|open": () => savePath,

  project_export_fla: (args): FlaExportResult => {
    const doc = context.state(args.id as string).doc as Document;
    const flags = new Set<string>();
    for (const scene of doc.scenes) {
      for (const layer of scene.layers) {
        gap(flags, layer);
      }
    }
    written.set(args.path as string, doc.name);
    return {
      path: args.path as string,
      warnings: ORDER.filter((key) => flags.has(key)).map((key) => TEXTS[key])
    };
  },

  project_import_fla: (): FlaImportResult => {
    if (!importResult) {
      throw new Error("no .fla was chosen");
    }
    return importResult;
  }
});
