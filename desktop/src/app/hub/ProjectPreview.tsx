import { useEffect, useRef, useState } from "react";
import "@/export/runtime.js";
import { useI18n } from "@/i18n";
import { docGet } from "@/lib/document";
import type { ProjectSummary } from "@/lib/document";

interface Player {
  mount(canvas: HTMLCanvasElement): void;
  pause(): void;
}

interface Runtime {
  load(project: unknown): Player;
}

export default function ProjectPreview({ project }: { project: ProjectSummary }) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let player: Player | null = null;
    setFailed(false);
    const show = async () => {
      try {
        const doc = await docGet(project.id);
        if (cancelled) {
          return;
        }
        const canvas = canvasRef.current;
        const runtime = (globalThis as unknown as { StickMate?: Runtime }).StickMate;
        if (!canvas || !runtime || doc.scenes.length === 0) {
          setFailed(true);
          return;
        }
        player = runtime.load({
          ...doc,
          loop: false,
          scale: 1,
          startFrame: 0,
          endFrame: null
        });
        player.mount(canvas);
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    };
    void show();
    return () => {
      cancelled = true;
      player?.pause();
      player = null;
    };
  }, [project.id, project.updated_at]);

  return (
    <div
      role="img"
      aria-label={failed ? t("projects.preview.empty") : t("projects.preview.alt")}
      className="flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted"
    >
      <canvas ref={canvasRef} className="max-h-full max-w-full" />
    </div>
  );
}