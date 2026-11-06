import { useEffect, useState } from "react";
import {
  ColorPicker,
  ColorPickerArea,
  ColorPickerAreaThumb,
  ColorPickerContent,
  ColorPickerInput,
  ColorPickerSlider,
  ColorPickerTrigger,
  ColorPickerValueSwatch
} from "@/components/ui/color-picker";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function ColorField({
  value,
  onChange,
  label,
  square = false,
  className
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  square?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <ColorPicker
      value={draft}
      onValueChange={(details) => setDraft(details.value.toString("hex"))}
      onValueChangeEnd={(details) => onChange(details.value.toString("hex"))}
    >
      <ColorPickerTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={label}
          title={label}
          className={cn(
            "h-9 w-12 shrink-0 p-1",
            square && "h-7 w-9 rounded-none border-border p-0.5",
            className
          )}
        >
          <ColorPickerValueSwatch
            className={cn("size-full", square ? "rounded-none" : "rounded-sm")}
          />
        </Button>
      </ColorPickerTrigger>
      <ColorPickerContent className={cn(square && "rounded-none")}>
        <ColorPickerArea className={cn(square && "rounded-none")}>
          <ColorPickerAreaThumb />
        </ColorPickerArea>
        <ColorPickerSlider channel="hue" />
        <ColorPickerInput
          aria-label={label}
          className={cn(
            "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
            square && "h-7 rounded-none border-border px-1 text-xs focus-visible:ring-0 focus-visible:border-ring"
          )}
        />
      </ColorPickerContent>
    </ColorPicker>
  );
}