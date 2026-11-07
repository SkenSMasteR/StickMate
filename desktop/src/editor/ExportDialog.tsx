import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n";
import { sceneLength } from "@/lib/document";
import { exportWeb } from "@/lib/export";
import type { ExportFormat, ExportRange, ExportResult } from "@/lib/export";
import { useWorkspace } from "./workspace";

const selectClass =
  "h-9 w-full rounded-none border border-input bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-ring";
const labelClass = "flex flex-col gap-1 text-xs text-muted-foreground";

export default function ExportDialog({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { doc, tab } = useWorkspace();
  const [format, setFormat] = useState<ExportFormat>("html5");
  const [rangeKind, setRangeKind] = useState<"whole" | "scene" | "frames">("whole");
  const [sceneId, setSceneId] = useState("");
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("0");
  const [scale, setScale] = useState("1");
  const [fps, setFps] = useState("24");
  const [loop, setLoop] = useState(true);
  const [transparent, setTransparent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const docId = doc?.id;
  useEffect(() => {
    if (!doc) {
      return;
    }
    setFps(String(doc.fps));
    setSceneId(tab?.sceneId ?? doc.scenes[0].id);
    setResult(null);
    setError(null);
  }, [docId]);

  if (!doc) {
    return null;
  }

  const scene = doc.scenes.find((item) => item.id === sceneId) ?? doc.scenes[0];
  const length = sceneLength(scene);

  const pickRangeKind = (next: string) => {
    const kind = next as "whole" | "scene" | "frames";
    setRangeKind(kind);
    if (kind === "frames") {
      setStart("0");
      setEnd(String(length - 1));
    }
  };

  const run = async () => {
    const range: ExportRange =
      rangeKind === "whole"
        ? { kind: "whole" }
        : rangeKind === "scene"
          ? { kind: "scene", sceneId: scene.id }
          : { kind: "frames", sceneId: scene.id, start: Number(start), end: Number(end) };
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const next = await exportWeb(doc.id, format, {
        range,
        scale: Number(scale),
        fps: Number(fps),
        loop,
        transparent
      });
      setResult(next);
      toast.success(t("export.done"));
    } catch (failure) {
      setError(String(failure));
      toast.error(String(failure));
    }
    setBusy(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md gap-3 sm:rounded-none" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("export.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <label className={labelClass}>
            {t("export.format")}
            <select
              aria-label={t("export.format")}
              className={selectClass}
              value={format}
              onChange={(event) => setFormat(event.target.value as ExportFormat)}
            >
              <option value="html5">{t("export.html5")}</option>
              <option value="canvasjs">{t("export.canvasjs")}</option>
            </select>
          </label>
          <label className={labelClass}>
            {t("export.range")}
            <select
              aria-label={t("export.range")}
              className={selectClass}
              value={rangeKind}
              onChange={(event) => pickRangeKind(event.target.value)}
            >
              <option value="whole">{t("export.whole")}</option>
              <option value="scene">{t("export.scene")}</option>
              <option value="frames">{t("export.frameRange")}</option>
            </select>
          </label>
          {rangeKind !== "whole" && (
            <label className={labelClass}>
              {t("export.scene")}
              <select
                aria-label={t("export.scenePick")}
                className={selectClass}
                value={scene.id}
                onChange={(event) => {
                  setSceneId(event.target.value);
                  const next = doc.scenes.find((item) => item.id === event.target.value);
                  if (next && rangeKind === "frames") {
                    setStart("0");
                    setEnd(String(sceneLength(next) - 1));
                  }
                }}
              >
                {doc.scenes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className={labelClass}>
            {t("export.scale")}
            <select
              aria-label={t("export.scale")}
              className={selectClass}
              value={scale}
              onChange={(event) => setScale(event.target.value)}
            >
              <option value="0.5">50%</option>
              <option value="1">100%</option>
              <option value="2">200%</option>
            </select>
          </label>
          {rangeKind === "frames" && (
            <>
              <label className={labelClass}>
                {t("export.start")}
                <Input
                  type="number"
                  aria-label={t("export.start")}
                  className="rounded-none"
                  min={0}
                  max={length - 1}
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                />
              </label>
              <label className={labelClass}>
                {t("export.end")}
                <Input
                  type="number"
                  aria-label={t("export.end")}
                  className="rounded-none"
                  min={0}
                  max={length - 1}
                  value={end}
                  onChange={(event) => setEnd(event.target.value)}
                />
              </label>
            </>
          )}
          <label className={labelClass}>
            {t("export.fps")}
            <Input
              type="number"
              aria-label={t("export.fps")}
              className="rounded-none"
              min={1}
              max={60}
              value={fps}
              onChange={(event) => setFps(event.target.value)}
            />
          </label>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span>{t("export.loop")}</span>
          <Switch aria-label={t("export.loop")} checked={loop} onCheckedChange={setLoop} />
        </div>
        <div className="flex items-center justify-between text-xs">
          <span>{t("export.transparent")}</span>
          <Switch
            aria-label={t("export.transparent")}
            checked={transparent}
            onCheckedChange={setTransparent}
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {result && (
          <div className="flex flex-col gap-1 border border-border p-2 text-xs">
            <span className="font-medium">{t("export.done")}</span>
            <span className="text-muted-foreground">
              {result.width} × {result.height} · {result.fps} fps · {result.frames}{" "}
              {t("export.frames")}
            </span>
            <span className="break-all text-muted-foreground">{result.path}</span>
            <span className="break-all text-muted-foreground">{result.files.join(", ")}</span>
          </div>
        )}
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button variant="outline" size="sm" className="rounded-none" onClick={onClose}>
            {t("export.close")}
          </Button>
          <Button size="sm" className="rounded-none" disabled={busy} onClick={() => void run()}>
            {busy ? t("export.busy") : t("export.run")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}