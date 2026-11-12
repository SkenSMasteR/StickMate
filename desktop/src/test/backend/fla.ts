import type { Document, Keyframe, Layer } from "@/lib/document";
import type { FlaExportResult, FlaImportResult } from "@/lib/fla";
import type { MockExtension } from "../backend";

export const written = new Map<string, string>();

let plan: { name: string; notes: string[] } | null = null;

export function reset(): void {
  written.clear();
  plan = { name: "Imported", notes: [] };
}

export function nextImport(value: { name: string; notes: string[] } | null): void {
  plan = value;
}

function gaps(flags: Set<string>, layer: Layer) {
  if (layer.blend !== "normal") {
    flags.add("blend");
  }
  if (layer.effects.length > 0) {
    flags.add("effect");
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
    gaps(flags, child);
  }
}

function hasGradient(key: Keyframe): boolean {
  return key.shapes.some(
    (shape) => "gradient" in shape && shape.gradient !== undefined && shape.gradient !== null
  );
}

const TEXTS: Record<string, string> = {
  gradient: "gradient fills are exported as flat colours",
  blend: "blend modes are not exported",
  effect: "layer effects are not exported",
  opacity: "layer and keyframe opacity are exported as shape transparency",
  tween: "tweens are exported as keyframes that hold until the next key"
};

const ORDER = ["gradient", "blend", "effect", "opacity", "tween"];

export const handlers: MockExtension = (context) => ({
  project_export_fla: (args): FlaExportResult => {
    const doc = context.state(args.id as string).doc;
    const flags = new Set<string>();
    for (const scene of doc.scenes) {
      for (const layer of scene.layers) {
        gaps(flags, layer);
      }
    }
    written.set(args.path as string, doc.name);
    return {
      path: args.path as string,
      warnings: ORDER.filter((key) => flags.has(key)).map((key) => TEXTS[key])
    };
  },

  project_import_fla: (): FlaImportResult => {
    if (!plan) {
      throw new Error("no animate file was chosen");
    }
    const doc: Document = {
      id: context.id("d"),
      name: plan.name,
      width: 640,
      height: 360,
      fps: 24,
      background: "#ffffff",
      scenes: [context.newScene("Scene 1")]
    };
    context.store.set(doc.id, { doc, undo: [], redo: [], updated_at: Date.now() });
    return { id: doc.id, name: doc.name, notes: plan.notes };
  }
});
