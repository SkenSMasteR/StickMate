import { transformShape } from "../backend";
import type { MockExtension } from "../backend";
import { affineFrom } from "@/lib/document";
import type { Layer, Shape, Transform } from "@/lib/document";
import type { ShapeClip } from "@/lib/shapes";

function checkTransform(t: Transform): void {
  if (![t.x, t.y, t.rotation, t.scale, t.opacity].every(Number.isFinite)
    || t.scale <= 0 || t.opacity < 0 || t.opacity > 1) {
    throw new Error("invalid clipboard transform");
  }
}

function checkShape(shape: Shape): void {
  const finite = (value: unknown): boolean => {
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(finite);
    if (value && typeof value === "object") return Object.values(value).every(finite);
    return true;
  };
  if (shape.kind === "Group") {
    if (!shape.children.length) throw new Error("invalid clipboard shape");
    shape.children.forEach(checkShape);
    return;
  }
  if (!finite(shape) || ("width" in shape && shape.width < 0)
    || ("w" in shape && (shape.w < 0 || shape.h < 0))
    || (shape.kind === "Stroke" && (!shape.points.length || shape.points.length > 100_000))
    || (shape.kind === "Polygon" && (!Number.isInteger(shape.sides) || shape.sides < 3 || shape.sides > 1024))
    || (shape.kind === "Text" && (!shape.text.trim() || shape.size <= 0 || shape.text.length > 1_000_000))
    || (shape.kind === "Path" && (shape.nodes.length < (shape.closed ? 3 : 2) || shape.nodes.length > 100_000))) {
    throw new Error("invalid clipboard shape");
  }
}

function checkClip(clip: ShapeClip): void {
  if (!clip.shapes.length) throw new Error("clipboard is empty");
  if (clip.shapes.length > 10_000) throw new Error("clipboard has too many shapes");
  checkTransform(clip.transform);
  clip.shapes.forEach(checkShape);
}

export const handlers: MockExtension = ({ state, layer, edit, writable, keyAt, evaluateLayer }) => {
  const snapshot = (target: Layer, frame: number): ShapeClip => {
    if (!Number.isInteger(frame) || frame < 0 || frame >= target.length) {
      throw new Error("frame is out of range");
    }
    const evaluated = evaluateLayer({ ...target, visible: true }, frame);
    if (!evaluated) throw new Error("frame has no keyframe");
    return { shapes: evaluated.shapes, transform: evaluated.transform };
  };
  return {
    doc_copy_shapes: (args) => {
      const target = layer(state(args.id as string).doc, args.sceneId as string, args.layerId as string);
      const clip = snapshot(target, args.frame as number);
      clip.shapes = [...new Set(args.indices as number[])].sort((a, b) => a - b).map((i) => {
        if (!Number.isInteger(i) || i < 0 || i >= clip.shapes.length) {
          throw new Error("shape index is out of range");
        }
        return structuredClone(clip.shapes[i]);
      });
      checkClip(clip);
      return clip;
    },
    doc_paste_shapes: (args) => {
      const clip = structuredClone(args.clip as ShapeClip);
      checkClip(clip);
      let indices: number[] = [];
      const document = edit(args.id as string, (doc) => {
        const target = layer(doc, args.sceneId as string, args.layerId as string);
        writable(target);
        const current = snapshot(target, args.frame as number);
        const source = clip.transform;
        const dest = current.transform;
        checkTransform(dest);
        const angle = dest.rotation * Math.PI / 180;
        const dx = source.x - dest.x;
        const dy = source.y - dest.y;
        const scale = source.scale / dest.scale;
        const rotation = (source.rotation - dest.rotation) % 360;
        const matrix = affineFrom({ x: 0, y: 0 },
          (dx * Math.cos(angle) + dy * Math.sin(angle)) / dest.scale,
          (-dx * Math.sin(angle) + dy * Math.cos(angle)) / dest.scale,
          scale, scale, rotation);
        if (![...Object.values(matrix), scale, rotation].every(Number.isFinite) || scale <= 0) {
          throw new Error("invalid clipboard conversion");
        }
        const shapes = clip.shapes.map((shape) => {
          if (shape.kind === "Ellipse" && rotation % 90 !== 0) {
            const { x, y, w, h, fill, stroke, width } = shape;
            const step = Math.PI * 2 / 16;
            const k = 4 / 3 * Math.tan(step / 4);
            shape = {
              kind: "Path", closed: true, fill, stroke, width,
              nodes: Array.from({ length: 16 }, (_, i) => {
                const a = i * step;
                const point = { x: x + w / 2 + w / 2 * Math.cos(a), y: y + h / 2 + h / 2 * Math.sin(a) };
                const dx = -w / 2 * Math.sin(a) * k;
                const dy = h / 2 * Math.cos(a) * k;
                return { point, handle_in: { x: point.x - dx, y: point.y - dy }, handle_out: { x: point.x + dx, y: point.y + dy } };
              })
            };
          }
          const result = transformShape(shape, matrix, scale, scale, rotation);
          if ("width" in result) result.width *= scale;
          checkShape(result);
          return result;
        });
        const key = target.keys[keyAt(target, args.frame as number)];
        key.transform = current.transform;
        indices = shapes.map((_, i) => key.shapes.length + i);
        key.shapes.push(...shapes);
      });
      return { document, indices };
    }
  };
};
