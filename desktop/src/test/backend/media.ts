import type { MediaInfo } from "@/lib/media";
import type { MockExtension } from "../backend";

const SOURCES: Record<string, string> = {
  png: "data:image/png;base64,iVBORw0KGgo=",
  jpg: "data:image/jpeg;base64,/9j/4AAQ",
  jpeg: "data:image/jpeg;base64,/9j/4AAQ",
  gif: "data:image/gif;base64,R0lGODdhAA==",
  svg: "data:image/svg+xml;base64,PHN2Zy8+"
};

interface Numbered {
  prefix: string;
  digits: string;
  extension: string;
}

let width = 24;
let height = 12;
let sequence: string[] = [];

export function reset(): void {
  width = 24;
  height = 12;
  sequence = [];
}

export function nextSize(w: number, h: number): void {
  width = w;
  height = h;
}

export function nextSequence(paths: string[]): void {
  sequence = paths;
}

function nameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function split(name: string): [string, string] {
  const at = name.lastIndexOf(".");
  return at < 0 ? [name, ""] : [name.slice(0, at), name.slice(at + 1)];
}

function numbered(name: string): Numbered | null {
  const [stem, extension] = split(name);
  const digits = /\d+$/.exec(stem)?.[0];
  return digits ? { prefix: stem.slice(0, -digits.length), digits, extension } : null;
}

function info(path: string, number = 0): MediaInfo {
  const extension = split(nameOf(path))[1].toLowerCase();
  const source = SOURCES[extension];
  if (!source) {
    throw new Error("the file is not a PNG, JPEG, GIF or SVG image");
  }
  return {
    source,
    width: width + number * 4,
    height: height + number * 4,
    kind: extension === "jpg" ? "jpeg" : extension
  };
}

function sibling(frame: Numbered, chosen: Numbered): boolean {
  return (
    frame.prefix === chosen.prefix &&
    frame.extension.toLowerCase() === chosen.extension.toLowerCase()
  );
}

export const handlers: MockExtension = () => ({
  media_read: (args): MediaInfo => info(String(args.path)),

  media_sequence: (args): MediaInfo[] => {
    const path = String(args.path);
    const chosen = numbered(nameOf(path));
    if (!chosen) {
      throw new Error("the file name does not end in a number");
    }
    const run: Array<{ number: number; path: string }> = [];
    for (const item of [...new Set([...sequence, path])]) {
      const frame = numbered(nameOf(item));
      if (frame && sibling(frame, chosen)) {
        run.push({ number: Number(frame.digits), path: item });
      }
    }
    if (run.length > 600) {
      throw new Error("a sequence can hold up to 600 images");
    }
    return run
      .sort((a, b) => a.number - b.number)
      .map((item) => info(item.path, item.number));
  }
});
