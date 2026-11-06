import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import ColorField from "@/components/color-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { useWorkspace } from "@/editor/workspace";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

const presets = [
  { label: "1920 x 1080", width: 1920, height: 1080 },
  { label: "1280 x 720", width: 1280, height: 720 },
  { label: "1080 x 1080", width: 1080, height: 1080 },
  { label: "3840 x 2160", width: 3840, height: 2160 }
];

const frameRates = [24, 30, 60];

export default function New({ onOpened }: { onOpened: (id: string) => void }) {
  const { t } = useI18n();
  const { create } = useWorkspace();
  const [preset, setPreset] = useState<number | null>(0);
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [frameRate, setFrameRate] = useState("30");
  const [background, setBackground] = useState("#ffffff");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const submit = async () => {
    setCreating(true);
    const id = await create({
      name,
      width,
      height,
      fps: Number(frameRate),
      background
    });
    setCreating(false);
    if (id) {
      onOpened(id);
    }
  };

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto">
      <div className="flex flex-col gap-2">
        <Label>{t("new.resolution")}</Label>
        <div className="grid max-w-2xl grid-cols-2 gap-3 lg:grid-cols-4">
          {presets.map((item, index) => (
            <Card
              key={item.label}
              onClick={() => {
                setPreset(index);
                setWidth(item.width);
                setHeight(item.height);
              }}
              className={cn(
                "cursor-pointer p-4 transition-colors hover:bg-accent hover:text-accent-foreground",
                index === preset && "border-primary ring-1 ring-primary"
              )}
            >
              <div className="text-sm font-medium">{item.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {(item.width / item.height).toFixed(2)}:1
              </div>
            </Card>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-6">
          <div className="flex w-32 flex-col gap-2">
            <Label>{t("new.width")}</Label>
            <Input
              type="number"
              min={1}
              max={8192}
              value={width}
              onChange={(event) => {
                setPreset(null);
                setWidth(Number(event.target.value));
              }}
            />
          </div>
          <div className="flex w-32 flex-col gap-2">
            <Label>{t("new.height")}</Label>
            <Input
              type="number"
              min={1}
              max={8192}
              value={height}
              onChange={(event) => {
                setPreset(null);
                setHeight(Number(event.target.value));
              }}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-6">
        <div className="flex w-40 flex-col gap-2">
          <Label>{t("new.frameRate")}</Label>
          <Select value={frameRate} onValueChange={setFrameRate}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {frameRates.map((rate) => (
                <SelectItem key={rate} value={String(rate)}>
                  {rate} fps
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex w-48 flex-col gap-2">
          <Label>{t("new.background")}</Label>
          <div className="flex items-center gap-2">
            <ColorField
              value={background}
              onChange={setBackground}
              label={t("new.background")}
            />
            <Input
              value={background}
              onChange={(event) => setBackground(event.target.value)}
              className="flex-1"
            />
          </div>
        </div>

        <div className="flex w-56 flex-col gap-2">
          <Label>{t("projects.name")}</Label>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
      </div>

      <div>
        <Button disabled={creating} onClick={() => void submit()}>
          {creating ? t("new.creating") : t("new.create")}
        </Button>
      </div>
    </div>
  );
}