import { invoke } from "@tauri-apps/api/core";
import {
  CanvasSource,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget
} from "mediabunny";
import "../export/runtime.js";
import type { Document as Project } from "./document";
import type { ExportOptions, ExportResult } from "./export";

interface VideoProject extends Project {
  scale: number;
  startFrame: number;
  endFrame: number | null;
}

interface VideoPlayer {
  frameCount: number;
  ready(): Promise<void>;
  mount(canvas: HTMLCanvasElement): void;
  seek(frame: number): void;
}

export async function exportVideo(id: string, options: ExportOptions): Promise<ExportResult> {
  const { token, project } = await invoke<{ token: string; project: VideoProject }>(
    "video_start", { id, options }
  );
  let output: Output | undefined;
  try {
    const { width, height, fps } = project;
    const codec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1"], {
      width, height, frameRate: fps, quality: QUALITY_HIGH
    });
    if (!codec) {
      throw new Error("No MP4 encoder is available for this resolution and frame rate in the system webview.");
    }
    const runtime = (globalThis as typeof globalThis & {
      StickMate: { load(project: VideoProject): VideoPlayer };
    }).StickMate;
    const player = runtime.load(project);
    await player.ready();
    const canvas = document.createElement("canvas");
    player.mount(canvas);
    const target = new StreamTarget(new WritableStream({
      write: ({ data, position }) => invoke<void>("video_write", data, {
        headers: { "video-token": token, "video-offset": String(position) }
      })
    }), { chunked: true, chunkSize: 1024 * 1024 });
    output = new Output({ format: new Mp4OutputFormat({ fastStart: "fragmented" }), target });
    const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    for (let frame = 0; frame < player.frameCount; frame++) {
      player.seek(frame);
      await source.add(frame / fps, 1 / fps);
    }
    await output.finalize();
    const destination = await invoke<string>("video_close", { token, publish: true });
    const split = Math.max(destination.lastIndexOf("/"), destination.lastIndexOf("\\"));
    return {
      path: destination.slice(0, split), files: [destination.slice(split + 1)],
      width, height, fps, frames: player.frameCount
    };
  } catch (error) {
    if (output?.state === "started") {
      await output.cancel().catch(() => {});
    }
    await invoke("video_close", { token, publish: false }).catch(() => {});
    throw error;
  }
}
