import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n";
import { sceneLength } from "@/lib/document";
import { exportWeb, toExportOptions } from "@/lib/export";
import type { ExportFormat, ExportRangeKind, ExportResult, ExportSettings } from "@/lib/export";
import { usePrefs } from "@/lib/prefs";
import { useConfirm } from "@/lib/confirm";
import {
  defaultPresetName,
  defaultSettings,
  MAX_NAME_LENGTH,
  MAX_PRESETS,
  newPresetId,
  sanitizeSettings
} from "@/lib/export-presets";
import type { ExportPreset } from "@/lib/export-presets";
import { useWorkspace } from "./workspace";

const selectClass =
  "h-9 w-full rounded-none border border-input bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-ring";
const labelClass = "flex flex-col gap-1 text-xs text-muted-foreground";
const iconButton =
  "h-7 w-7 shrink-0 border border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground";

export default function ExportDialog({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const { prefs, update } = usePrefs();
  const { doc, tab } = useWorkspace();
  const [format, setFormat] = useState<ExportFormat>(defaultSettings.format);
  const [rangeKind, setRangeKind] = useState<ExportRangeKind>(defaultSettings.rangeKind);
  const [sceneId, setSceneId] = useState("");
  const [start, setStart] = useState(String(defaultSettings.start));
  const [end, setEnd] = useState(String(defaultSettings.end));
  const [scale, setScale] = useState(String(defaultSettings.scale));
  const [fps, setFps] = useState(String(defaultSettings.fps));
  const [loop, setLoop] = useState(defaultSettings.loop);
  const [transparent, setTransparent] = useState(defaultSettings.transparent);
  const [presetName, setPresetName] = useState("");
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
  const presets = [...prefs.exportPresets].sort((a, b) => a.name.localeCompare(b.name));

  const currentSettings = (): ExportSettings => ({
    format,
    rangeKind,
    sceneId: scene.id,
    start: Number(start),
    end: Number(end),
    scale: Number(scale),
    fps: Number(fps),
    loop,
    transparent
  });

  const pickRangeKind = (next: string) => {
    const kind = next as ExportRangeKind;
    setRangeKind(kind);
    if (kind === "frames") {
      setStart("0");
      setEnd(String(length - 1));
    }
  };

  const applyPreset = (preset: ExportPreset) => {
    const target = doc.scenes.find((item) => item.id === preset.settings.sceneId);
    setFormat(preset.settings.format);
    setRangeKind(preset.settings.rangeKind);
    setSceneId(target ? target.id : scene.id);
    setStart(String(preset.settings.start));
    setEnd(String(preset.settings.end));
    setScale(String(preset.settings.scale));
    setFps(String(preset.settings.fps));
    setLoop(preset.settings.loop);
    setTransparent(preset.settings.transparent);
    setResult(null);
    setError(null);
    toast.success(t("workspace.applied"));
  };

  const removePreset = async (preset: ExportPreset) => {
    const accepted = await confirm({
      title: t("export.deletePreset"),
      description: preset.name,
      confirmLabel: t("editor.delete"),
      cancelLabel: t("editor.cancel"),
      destructive: true
    });
    if (!accepted) {
      return;
    }
    await update({
      exportPresets: prefs.exportPresets.filter((item) => item.id !== preset.id)
    });
    toast.success(t("workspace.deleted"));
  };

  const savePreset = async () => {
    const trimmed = presetName.trim();
    const name = trimmed === "" ? defaultPresetName(currentSettings()) : trimmed;
    if (name === "" || name.length > MAX_NAME_LENGTH) {
      setError(t("workspace.error.name"));
      return;
    }
    if (presets.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      setError(t("workspace.error.name"));
      return;
    }
    const captured = sanitizeSettings(currentSettings());
    if (!captured) {
      setError(t("workspace.error.range"));
      return;
    }
    const preset: ExportPreset = {
      id: newPresetId(),
      name,
      updatedAt: Date.now(),
      settings: captured
    };
    await update({ exportPresets: [...prefs.exportPresets, preset] });
    setPresetName("");
    setError(null);
    toast.success(t("workspace.saved"));
  };

  const run = async () => {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const next = await exportWeb(doc.id, format, toExportOptions(currentSettings()));
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
        <div className="flex flex-col gap-2 border-t border-border pt-2">
          <span className="text-xs text-muted-foreground">{t("export.presets")}</span>
          <ScrollArea className="h-28 border border-border">
            {presets.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">{t("workspace.empty")}</p>
            )}
            {presets.map((preset) => (
              <div
                key={preset.id}
                className="flex items-center gap-2 border-b border-border px-2 py-1.5"
              >
                <button
                  type="button"
                  aria-label={`${t("export.applyPreset")} ${preset.name}`}
                  onClick={() => applyPreset(preset)}
                  className="h-7 min-w-0 flex-1 truncate px-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                >
                  {preset.name}
                </button>
                <button
                  type="button"
                  aria-label={`${t("export.deletePreset")} ${preset.name}`}
                  title={t("export.deletePreset")}
                  onClick={() => void removePreset(preset)}
                  className={`${iconButton} hover:text-destructive`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </ScrollArea>
          <div className="flex items-center gap-2">
            <Input
              aria-label={t("export.presetName")}
              placeholder={t("export.presetName")}
              className="h-8 min-w-0 flex-1 rounded-none text-xs"
              value={presetName}
              maxLength={MAX_NAME_LENGTH}
              onChange={(event) => setPresetName(event.target.value)}
            />
            <Button
              size="sm"
              className="shrink-0 rounded-none"
              disabled={presets.length >= MAX_PRESETS}
              onClick={() => void savePreset()}
            >
              {t("export.savePreset")}
            </Button>
          </div>
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