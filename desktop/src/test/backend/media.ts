import type { MediaInfo } from "@/lib/media";
import type { MockExtension } from "../backend";

const SOURCES: Record<string, string> = {
  png: "data:image/png;base64,iVBORw0KGgo=",
  jpg: "data:image/jpeg;base64,/9j/4AAQ",
  jpeg: "data:image/jpeg;base64,/9j/4AAQ",
  gif: "data:image/gif;base64,R0lGODdhAA=="
};

let width = 24;
let height = 12;

export function reset(): void {
  width = 24;
  height = 12;
}

export function nextSize(w: number, h: number): void {
  width = w;
  height = h;
}

export const handlers: MockExtension = () => ({
  media_read: (args): MediaInfo => {
    const path = String(args.path);
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const source = SOURCES[extension];
    if (!source) {
      throw new Error("the file is not a PNG, JPEG or GIF image");
    }
    return {
      source,
      width,
      height,
      kind: extension === "jpg" ? "jpeg" : extension
    };
  }
});
