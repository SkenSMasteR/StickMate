import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useI18n } from "@/i18n";
import { useToast } from "@/lib/toast";

const presets = [
  { label: "1920 x 1080", width: 1920, height: 1080 },
  { label: "1280 x 720", width: 1280, height: 720 },
  { label: "1080 x 1080", width: 1080, height: 1080 },
  { label: "3840 x 2160", width: 3840, height: 2160 }
];

const frameRates = [24, 30, 60];

export default function Blank() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [preset, setPreset] = useState(0);
  const [frameRate, setFrameRate] = useState(30);
  const [background, setBackground] = useState("#ffffff");
  const [name, setName] = useState("");

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <h1 className="text-base font-semibold">{t("blank.title")}</h1>

      <div className="flex flex-col gap-2">
        <span className="text-sm text-[hsl(var(--muted-foreground))]">
          {t("blank.resolution")}
        </span>
        <div className="grid max-w-2xl grid-cols-2 gap-3 lg:grid-cols-4">
          {presets.map((item, index) => (
            <button
              key={item.label}
              className={
                index === preset
                  ? "border border-[hsl(var(--foreground))] bg-[hsl(var(--accent))] p-4 text-left"
                  : "border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 text-left hover:bg-[hsl(var(--accent))]/60"
              }
              onClick={() => setPreset(index)}
            >
              <div className="text-sm font-medium">{item.label}</div>
              <div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                {(item.width / item.height).toFixed(2)}:1
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-6">
        <div className="flex w-40 flex-col gap-2">
          <span className="text-sm text-[hsl(var(--muted-foreground))]">
            {t("blank.frameRate")}
          </span>
          <Select
            value={frameRate}
            onChange={(event) => setFrameRate(Number(event.target.value))}
          >
            {frameRates.map((rate) => (
              <option key={rate} value={rate}>
                {rate} fps
              </option>
            ))}
          </Select>
        </div>

        <div className="flex w-48 flex-col gap-2">
          <span className="text-sm text-[hsl(var(--muted-foreground))]">
            {t("blank.background")}
          </span>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={background}
              onChange={(event) => setBackground(event.target.value)}
              className="h-9 w-12 cursor-pointer border border-[hsl(var(--input))] bg-transparent p-1"
            />
            <Input
              value={background}
              onChange={(event) => setBackground(event.target.value)}
              className="flex-1"
            />
          </div>
        </div>

        <div className="flex w-56 flex-col gap-2">
          <span className="text-sm text-[hsl(var(--muted-foreground))]">
            {t("projects.name")}
          </span>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
      </div>

      <div>
        <Button
          onClick={() => {
            toast(t("blank.created"));
          }}
        >
          {t("blank.create")}
        </Button>
      </div>
    </div>
  );
}
