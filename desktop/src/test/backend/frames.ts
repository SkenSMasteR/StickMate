import type { MockExtension } from "../backend";
import type { FrameClip } from "@/lib/frames";
import type { Keyframe, Layer } from "@/lib/document";

function checkCount(count: number): void {
  if (count < 1 || count > 1000) {
    throw new Error("frame count must be between 1 and 1000");
  }
}

function checkFrame(target: Layer, frame: number): void {
  if (frame >= target.length) {
    throw new Error("frame is out of range");
  }
}

function checkClip(clip: FrameClip): void {
  checkCount(clip.span);
  if (clip.keys.length === 0) {
    throw new Error("clipboard is empty");
  }
  if (
    clip.keys.some((key) => key.frame >= clip.span) ||
    clip.keys.some((key, index) => index > 0 && clip.keys[index - 1].frame >= key.frame)
  ) {
    throw new Error("clipboard is invalid");
  }
}

export const handlers: MockExtension = (context) => {
  const { edit, state, layer, keyIndex, heldIndex, writable, identity } = context;

  const emptyKey = (frame: number): Keyframe => ({
    frame,
    shapes: [],
    transform: identity(),
    tween: false,
    label: null
  });

  const clipOf = (target: Layer, frame: number, count: number): FrameClip => {
    const keys: Keyframe[] = [];
    if (keyIndex(target, frame) < 0) {
      const held = heldIndex(target, frame);
      if (held >= 0) {
        keys.push({
          frame: 0,
          shapes: structuredClone(target.keys[held].shapes),
          transform: { ...target.keys[held].transform },
          tween: false,
          label: null
        });
      }
    }
    for (const key of target.keys) {
      if (key.frame >= frame && key.frame - frame < count) {
        keys.push({ ...structuredClone(key), frame: key.frame - frame });
      }
    }
    return { span: count, keys };
  };

  const pasteInto = (target: Layer, frame: number, clip: FrameClip): void => {
    target.keys.forEach((key) => {
      if (key.frame >= frame) {
        key.frame += clip.span;
      }
    });
    for (const key of clip.keys) {
      target.keys.push({ ...structuredClone(key), frame: key.frame + frame });
    }
    if (frame === 0 && keyIndex(target, 0) < 0) {
      target.keys.push(emptyKey(0));
    }
    target.keys.sort((a, b) => a.frame - b.frame);
    target.length += clip.span;
  };

  const removeRange = (target: Layer, frame: number, count: number): void => {
    const held = frame === 0 ? heldIndex(target, 0) : -1;
    const head = held >= 0 ? structuredClone(target.keys[held]) : null;
    target.keys = target.keys.filter(
      (key) => key.frame < frame || key.frame - frame >= count
    );
    target.keys.forEach((key) => {
      if (key.frame >= frame) {
        key.frame -= count;
      }
    });
    target.length = Math.max(1, target.length - count);
    if (keyIndex(target, 0) < 0) {
      const key = head ?? emptyKey(0);
      key.frame = 0;
      key.tween = false;
      key.label = null;
      target.keys.unshift(key);
    }
  };

  return {
    doc_insert_frames: (args) =>
      edit(args.id as string, (doc) => {
        const target = layer(doc, args.sceneId as string, args.layerId as string);
        writable(target);
        const frame = args.frame as number;
        const count = args.count as number;
        checkCount(count);
        checkFrame(target, frame);
        target.keys.forEach((key) => {
          if (key.frame >= frame) {
            key.frame += count;
          }
        });
        target.length += count;
      }),
    doc_remove_frames: (args) =>
      edit(args.id as string, (doc) => {
        const target = layer(doc, args.sceneId as string, args.layerId as string);
        writable(target);
        const frame = args.frame as number;
        const count = args.count as number;
        checkCount(count);
        checkFrame(target, frame);
        removeRange(target, frame, count);
      }),
    doc_copy_frames: (args) => {
      const current = state(args.id as string);
      const target = layer(current.doc, args.sceneId as string, args.layerId as string);
      const frame = args.frame as number;
      const count = args.count as number;
      checkCount(count);
      checkFrame(target, frame);
      return clipOf(target, frame, count);
    },
    doc_paste_frames: (args) => {
      const clip = structuredClone(args.clip as FrameClip);
      return edit(args.id as string, (doc) => {
        const target = layer(doc, args.sceneId as string, args.layerId as string);
        writable(target);
        checkClip(clip);
        checkFrame(target, args.frame as number);
        pasteInto(target, args.frame as number, clip);
      });
    },
    doc_duplicate_frames: (args) =>
      edit(args.id as string, (doc) => {
        const target = layer(doc, args.sceneId as string, args.layerId as string);
        writable(target);
        const frame = args.frame as number;
        const count = args.count as number;
        checkCount(count);
        checkFrame(target, frame);
        pasteInto(target, frame + count, clipOf(target, frame, count));
      }),
    doc_move_frames: (args) =>
      edit(args.id as string, (doc) => {
        const target = layer(doc, args.sceneId as string, args.layerId as string);
        writable(target);
        const frame = args.frame as number;
        const count = args.count as number;
        const destination = args.target as number;
        checkCount(count);
        checkFrame(target, frame);
        checkFrame(target, destination);
        if (destination === frame) {
          throw new Error("target equals source frame");
        }
        const clip = clipOf(target, frame, count);
        removeRange(target, frame, count);
        const at = destination > frame ? Math.max(0, destination - count) : destination;
        pasteInto(target, at, clip);
      })
  };
};