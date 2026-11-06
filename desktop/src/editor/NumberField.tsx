import { useEffect, useState } from "react";

export default function NumberField({
  label,
  value,
  onCommit,
  step = 1,
  min,
  max
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || text.trim() === "") {
      setText(String(value));
      return;
    }
    const bounded = Math.min(
      max === undefined ? parsed : Math.min(parsed, max),
      min === undefined ? parsed : Math.max(parsed, min)
    );
    setText(String(bounded));
    if (bounded !== value) {
      onCommit(bounded);
    }
  };

  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <input
        type="number"
        value={text}
        step={step}
        min={min}
        max={max}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setText(String(value));
            event.currentTarget.blur();
          }
        }}
        className="h-7 w-full min-w-0 border border-border bg-transparent px-1 text-xs outline-none focus:border-ring"
      />
    </label>
  );
}