import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderMinus,
  FolderPlus,
  Plus,
  Scissors,
  Trash2
} from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/i18n";
import {
  blends,
  clampEasing,
  effectKinds,
  easingPresets,
  heldKey,
  leafCount,
  linearEasing,
  sameEasing,
  shapeGradient,
  textLayout,
  unionBounds,
  visibleRows
} from "@/lib/document";
import type {
  AlignMode,
  AlignReference,
  Blend,
  BoolOp,
  Effect,
  Easing,
  EasingPresetId,
  Gradient,
  GradientStop,
  Point,
  Shape,
  TextAlign
} from "@/lib/document";
import { cn } from "@/lib/utils";
import Picker from "@/components/color-field";
import NumberField from "./NumberField";
import { useWorkspace } from "./workspace";

const alignModes: Array<{
  mode: AlignMode;
  labelKey: string;
  icon: typeof AlignStartVertical;
  distribute: boolean;
}> = [
  { mode: "left", labelKey: "command.alignLeft", icon: AlignStartVertical, distribute: false },
  { mode: "center_h", labelKey: "command.alignCenterH", icon: AlignCenterVertical, distribute: false },
  { mode: "right", labelKey: "command.alignRight", icon: AlignEndVertical, distribute: false },
  { mode: "top", labelKey: "command.alignTop", icon: AlignStartHorizontal, distribute: false },
  { mode: "center_v", labelKey: "command.alignCenterV", icon: AlignCenterHorizontal, distribute: false },
  { mode: "bottom", labelKey: "command.alignBottom", icon: AlignEndHorizontal, distribute: false },
  { mode: "distribute_h", labelKey: "command.distributeH", icon: AlignHorizontalDistributeCenter, distribute: true },
  { mode: "distribute_v", labelKey: "command.distributeV", icon: AlignVerticalDistributeCenter, distribute: true }
];

const alignReferences: AlignReference[] = ["selection", "stage"];

const boolOps: Array<{ op: BoolOp; labelKey: string }> = [
  { op: "union", labelKey: "command.combine" },
  { op: "subtract", labelKey: "command.subtract" },
  { op: "intersect", labelKey: "command.intersect" },
  { op: "exclude", labelKey: "command.cut" }
];

const easingChoices: Array<{
  id: EasingPresetId | "custom";
  label: string;
  easing: Easing | null;
}> = [
  ...easingPresets.map((preset) => ({
    id: preset.id,
    label: `easing.${preset.id}`,
    easing: preset.easing
  })),
  { id: "custom", label: "easing.custom", easing: null }
];

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-border">
      <header className="flex h-8 items-center justify-between px-2">
        <h2 className="text-[10px] uppercase tracking-wide text-muted-foreground">{title}</h2>
        {action}
      </header>
      <div className="flex flex-col gap-2 px-2 pb-3">{children}</div>
    </section>
  );
}

function ColorField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <Picker value={value} onChange={onChange} label={label} square />
    </div>
  );
}

type FillShape = Extract<Shape, { fill: string }>;

const fillTypes: Array<"solid" | "linear" | "radial"> = ["solid", "linear", "radial"];

function gradientCss(gradient: Gradient): string {
  const stops = gradient.stops
    .map((stop) => `${stop.color} ${(stop.offset * 100).toFixed(0)}%`)
    .join(", ");
  return gradient.kind === "linear"
    ? `linear-gradient(${gradient.angle + 90}deg, ${stops})`
    : `radial-gradient(circle, ${stops})`;
}

function StopOffsetField({
  label,
  value,
  min,
  max,
  onCommit
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
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
    const bounded = Math.min(max, Math.max(min, parsed));
    setText(String(bounded));
    if (bounded !== value) {
      onCommit(bounded);
    }
  };

  return (
    <input
      type="number"
      aria-label={label}
      title={label}
      value={text}
      min={min}
      max={max}
      step={0.05}
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
      className="h-7 w-16 min-w-0 border border-border bg-transparent px-1 text-xs outline-none focus:border-ring"
    />
  );
}

function FillField({
  shape,
  index,
  onReplace
}: {
  shape: FillShape;
  index: number;
  onReplace: (index: number, shape: Shape) => void;
}) {
  const { t } = useI18n();
  const gradient = shapeGradient(shape);

  const commit = (next: Gradient | null) => {
    const fill = next === null ? gradient?.stops[0]?.color ?? shape.fill : shape.fill;
    onReplace(index, { ...shape, fill, gradient: next });
  };

  const setStops = (stops: GradientStop[]) => {
    if (gradient) {
      commit({ ...gradient, stops });
    }
  };

  const setKind = (kind: "solid" | "linear" | "radial") => {
    if (kind === "solid") {
      commit(null);
      return;
    }
    const stops =
      gradient?.stops ??
      [
        { offset: 0, color: shape.fill },
        { offset: 1, color: "#000000" }
      ];
    commit(
      kind === "linear"
        ? { kind, angle: gradient?.kind === "linear" ? gradient.angle : 0, stops }
        : { kind, stops }
    );
  };

  const addStop = () => {
    if (!gradient || gradient.stops.length >= 32) {
      return;
    }
    let gap = 0;
    let position = gradient.stops[gradient.stops.length - 1].offset;
    let color = gradient.stops[gradient.stops.length - 1].color;
    for (let index = 1; index < gradient.stops.length; index += 1) {
      const previous = gradient.stops[index - 1];
      const current = gradient.stops[index];
      if (current.offset - previous.offset > gap) {
        gap = current.offset - previous.offset;
        position = (previous.offset + current.offset) / 2;
        color = current.color;
      }
    }
    setStops([...gradient.stops, { offset: position, color }].sort((a, b) => a.offset - b.offset));
  };

  const removeStop = (stopIndex: number) => {
    if (!gradient || gradient.stops.length <= 2) {
      return;
    }
    setStops(gradient.stops.filter((_, position) => position !== stopIndex));
  };

  const stopButton =
    "flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40";

  return (
    <>
      <div className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t("editor.fillType")}</span>
        <div className="flex gap-1">
          {fillTypes.map((kind) => {
            const active = kind === "solid" ? gradient === null : gradient?.kind === kind;
            return (
              <button
                key={kind}
                type="button"
                aria-label={t(`editor.${kind}`)}
                aria-pressed={active}
                onClick={() => setKind(kind)}
                className={cn(
                  "h-7 border px-2 text-xs",
                  active
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {t(`editor.${kind}`)}
              </button>
            );
          })}
        </div>
      </div>
      {gradient === null ? (
        <ColorField
          label={t("editor.fill")}
          value={shape.fill}
          onChange={(fill) => onReplace(index, { ...shape, fill })}
        />
      ) : (
        <>
          {gradient.kind === "linear" && (
            <NumberField
              label={t("editor.gradientAngle")}
              value={Math.round(gradient.angle * 100) / 100}
              min={-360}
              max={360}
              step={15}
              onCommit={(angle) => commit({ ...gradient, angle })}
            />
          )}
          <div className="flex items-center gap-2 text-xs">
            <span className="w-20 shrink-0 text-muted-foreground">{t("editor.gradientStops")}</span>
            <div
              className="h-7 w-full min-w-0 border border-border"
              style={{ backgroundImage: gradientCss(gradient) }}
            />
          </div>
          {gradient.stops.map((stop, stopIndex) => (
            <div key={stopIndex} className="flex items-center gap-1">
              <Picker
                value={stop.color}
                label={`${t("editor.gradientStops")} ${stopIndex + 1}`}
                onChange={(color) =>
                  setStops(
                    gradient.stops.map((item, position) =>
                      position === stopIndex ? { ...item, color } : item
                    )
                  )
                }
                square
              />
              <StopOffsetField
                label={t("editor.stopOffset")}
                value={stop.offset}
                min={gradient.stops[stopIndex - 1]?.offset ?? 0}
                max={gradient.stops[stopIndex + 1]?.offset ?? 1}
                onCommit={(offset) =>
                  setStops(
                    gradient.stops.map((item, position) =>
                      position === stopIndex ? { ...item, offset } : item
                    )
                  )
                }
              />
              <button
                type="button"
                aria-label={t("editor.removeStop")}
                title={t("editor.removeStop")}
                disabled={gradient.stops.length <= 2}
                onClick={() => removeStop(stopIndex)}
                className={stopButton}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            aria-label={t("editor.addStop")}
            title={t("editor.addStop")}
            disabled={gradient.stops.length >= 32}
            onClick={addStop}
            className={stopButton}
          >
            <Plus className="h-4 w-4" />
          </button>
        </>
      )}
    </>
  );
}

function LabelField({
  label,
  value,
  required,
  onCommit
}: {
  label: string;
  value: string;
  required?: boolean;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(value);

  useEffect(() => {
    setText(value);
  }, [value]);

  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <input
        value={text}
        onChange={(event) => {
          if (required && event.target.value === "") {
            return;
          }
          setText(event.target.value);
        }}
        onBlur={() => onCommit(text)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onCommit(text);
            event.currentTarget.blur();
          }
        }}
        className="h-7 w-full min-w-0 border border-border bg-transparent px-1 text-xs outline-none focus:border-ring"
      />
    </label>
  );
}

function MultilineField({
  label,
  value,
  onCommit
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(value);

  useEffect(() => {
    setText(value);
  }, [value]);

  return (
    <label className="flex items-start gap-2 text-xs">
      <span className="w-20 shrink-0 pt-1 text-muted-foreground">{label}</span>
      <textarea
        value={text}
        rows={3}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text.trim() !== "") {
            onCommit(text.replace(/\r\n?/g, "\n"));
          }
        }}
        className="min-h-0 w-full resize-none border border-border bg-transparent px-1 py-1 text-xs outline-none focus:border-ring"
      />
    </label>
  );
}

const alignments: Array<{ mode: TextAlign; key: string }> = [
  { mode: "left", key: "editor.alignLeft" },
  { mode: "center", key: "editor.alignCenter" },
  { mode: "right", key: "editor.alignRight" }
];

function ParagraphField({
  label,
  value,
  onChange
}: {
  label: string;
  value: TextAlign;
  onChange: (align: TextAlign) => void;
}) {
  const { t } = useI18n();
  const icons = { left: AlignLeft, center: AlignCenter, right: AlignRight };
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex gap-1">
        {alignments.map(({ mode, key }) => {
          const Icon = icons[mode];
          return (
            <button
              key={mode}
              type="button"
              aria-label={t(key)}
              aria-pressed={value === mode}
              onClick={() => onChange(mode)}
              className={cn(
                "h-7 w-7 border border-border",
                value === mode
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BlendField({
  label,
  value,
  onChange
}: {
  label: string;
  value: Blend;
  onChange: (blend: Blend) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as Blend)}
        className="h-7 w-full min-w-0 border border-border bg-transparent px-1 text-xs outline-none focus:border-ring"
      >
        {blends.map((mode) => (
          <option key={mode} value={mode}>
            {t(`blend.${mode}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

const effectIcon =
  "flex h-7 w-7 items-center justify-center border border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground";

function EffectRow({
  effect,
  onChange,
  onRemove
}: {
  effect: Effect;
  onChange: (effect: Effect) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1 border border-border p-1">
      <div className="flex items-center gap-2">
        <select
          aria-label={t("editor.effectKind")}
          value={effect.kind}
          onChange={(event) =>
            onChange(
              event.target.value === "blur"
                ? { kind: "blur", radius: 8 }
                : { kind: "shadow", x: 4, y: 4, blur: 6, color: "#000000" }
            )
          }
          className="h-7 w-full min-w-0 border border-border bg-transparent px-1 text-xs outline-none focus:border-ring"
        >
          {effectKinds.map((kind) => (
            <option key={kind} value={kind}>
              {t(`effect.${kind}`)}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label={t("editor.removeEffect")}
          title={t("editor.removeEffect")}
          onClick={onRemove}
          className={effectIcon}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {effect.kind === "blur" ? (
        <NumberField
          label={t("editor.effectRadius")}
          value={effect.radius}
          min={0}
          max={500}
          onCommit={(radius) => onChange({ kind: "blur", radius })}
        />
      ) : (
        <>
          <NumberField
            label={t("editor.effectOffsetX")}
            value={effect.x}
            min={-500}
            max={500}
            onCommit={(x) => onChange({ ...effect, x })}
          />
          <NumberField
            label={t("editor.effectOffsetY")}
            value={effect.y}
            min={-500}
            max={500}
            onCommit={(y) => onChange({ ...effect, y })}
          />
          <NumberField
            label={t("editor.effectBlur")}
            value={effect.blur}
            min={0}
            max={500}
            onCommit={(blur) => onChange({ ...effect, blur })}
          />
          <ColorField
            label={t("editor.effectColor")}
            value={effect.color}
            onChange={(color) => onChange({ ...effect, color })}
          />
        </>
      )}
    </div>
  );
}

function HandleField({
  label,
  hook,
  value,
  min,
  max,
  disabled,
  onCommit
}: {
  label: string;
  hook: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(text);
    if (text.trim() === "" || !Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    const bounded = Math.min(max, Math.max(min, parsed));
    setText(String(bounded));
    if (bounded !== value) {
      onCommit(bounded);
    }
  };

  return (
    <label className="flex min-w-0 flex-1 items-center gap-1 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <input
        type="number"
        aria-label={label}
        data-easing-handle={hook}
        value={text}
        min={min}
        max={max}
        step={0.05}
        disabled={disabled}
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
        className="h-7 w-full min-w-0 border border-border bg-transparent px-1 text-xs outline-none focus:border-ring disabled:pointer-events-none disabled:opacity-40"
      />
    </label>
  );
}

function ShapeFields({
  shape,
  index,
  onPaint,
  onReplace
}: {
  shape: Shape;
  index: number;
  onPaint: (index: number, color: string) => void;
  onReplace: (index: number, shape: Shape) => void;
}) {
  const { t } = useI18n();
  const rounded = (value: number) => Number(value.toFixed(2));

  if (shape.kind === "Text") {
    const layout = textLayout(shape);
    return (
      <>
        <MultilineField
          label={t("editor.textContent")}
          value={shape.text}
          onCommit={(text) => onReplace(index, { ...shape, text })}
        />
        <NumberField
          label={t("editor.fontSize")}
          value={rounded(shape.size)}
          min={4}
          max={400}
          onCommit={(size) => onReplace(index, { ...shape, size })}
        />
        <LabelField
          label={t("editor.fontFamily")}
          value={shape.family}
          required
          onCommit={(family) => onReplace(index, { ...shape, family })}
        />
        <NumberField
          label={t("editor.letterSpacing")}
          value={rounded(layout.spacing)}
          min={-500}
          max={500}
          step={0.5}
          onCommit={(spacing) => onReplace(index, { ...shape, spacing })}
        />
        <NumberField
          label={t("editor.lineSpacing")}
          value={rounded(layout.leading)}
          min={0.2}
          max={10}
          step={0.1}
          onCommit={(leading) => onReplace(index, { ...shape, leading })}
        />
        <ParagraphField
          label={t("editor.paragraph")}
          value={layout.align}
          onChange={(align) => onReplace(index, { ...shape, align })}
        />
        <ColorField
          label={t("editor.stroke")}
          value={shape.color}
          onChange={(color) => onPaint(index, color)}
        />
      </>
    );
  }

  if (shape.kind === "Stroke") {
    return (
      <>
        <ColorField
          label={t("editor.stroke")}
          value={shape.color}
          onChange={(color) => onPaint(index, color)}
        />
        <NumberField
          label={t("editor.strokeWidth")}
          value={rounded(shape.width)}
          min={0.5}
          max={200}
          step={0.5}
          onCommit={(width) => onReplace(index, { ...shape, width })}
        />
      </>
    );
  }

  if (shape.kind === "Path") {
    return (
      <>
        <button
          type="button"
          aria-pressed={shape.closed}
          onClick={() => onReplace(index, { ...shape, closed: !shape.closed })}
          className={cn(
            "h-7 border px-2 text-xs",
            shape.closed
              ? "border-border bg-accent text-accent-foreground"
              : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          )}
        >
          {t("editor.closed")}
        </button>
        {shape.closed && <FillField shape={shape} index={index} onReplace={onReplace} />}
        <ColorField
          label={t("editor.stroke")}
          value={shape.stroke}
          onChange={(stroke) => onReplace(index, { ...shape, stroke })}
        />
        <NumberField
          label={t("editor.strokeWidth")}
          value={rounded(shape.width)}
          min={0.5}
          max={200}
          step={0.5}
          onCommit={(width) => onReplace(index, { ...shape, width })}
        />
      </>
    );
  }

  if (shape.kind === "Group") {
    return null;
  }

  return (
    <>
      <NumberField
        label={t("editor.x")}
        value={rounded(shape.x)}
        onCommit={(x) => onReplace(index, { ...shape, x })}
      />
      <NumberField
        label={t("editor.y")}
        value={rounded(shape.y)}
        onCommit={(y) => onReplace(index, { ...shape, y })}
      />
      <NumberField
        label={t("editor.width")}
        value={rounded(shape.w)}
        min={0.5}
        step={0.5}
        onCommit={(w) => onReplace(index, { ...shape, w })}
      />
      <NumberField
        label={t("editor.height")}
        value={rounded(shape.h)}
        min={0.5}
        step={0.5}
        onCommit={(h) => onReplace(index, { ...shape, h })}
      />
      {shape.kind === "Polygon" && (
        <NumberField
          label={t("editor.sides")}
          value={shape.sides}
          min={3}
          max={32}
          onCommit={(sides) => onReplace(index, { ...shape, sides })}
        />
      )}
      <FillField shape={shape} index={index} onReplace={onReplace} />
      <ColorField
        label={t("editor.stroke")}
        value={shape.stroke}
        onChange={(stroke) => onReplace(index, { ...shape, stroke })}
      />
      <NumberField
        label={t("editor.strokeWidth")}
        value={rounded(shape.width)}
        min={0.5}
        max={200}
        step={0.5}
        onCommit={(width) => onReplace(index, { ...shape, width })}
      />
    </>
  );
}

export default function SidePanel() {
  const { doc, scene, layer, tab, frame, transform, actions, setTab } = useWorkspace();
  const { t } = useI18n();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (!doc || !scene || !layer || !tab) {
    return null;
  }

  const key = heldKey(layer, frame);
  const collapsedIds = tab.collapsedFolders;
  const rows = visibleRows(scene.layers, collapsedIds);
  const activeRow = rows.find((row) => row.layer.id === layer.id) ?? null;
  const activeParent =
    activeRow === null ? null : activeRow.layer.folder ? activeRow.layer.id : activeRow.parentId;
  const rounded = (value: number) => Number(value.toFixed(2));
  const selectedIndex = tab.selected.length === 1 ? tab.selected[0] : null;
  const selectedShape =
    selectedIndex === null ? null : key?.shapes[selectedIndex] ?? null;
  const selBounds = unionBounds(key?.shapes ?? [], tab.selected);
  const pivot: Point =
    tab.pivot ??
    (selBounds
      ? { x: selBounds.x + selBounds.w / 2, y: selBounds.y + selBounds.h / 2 }
      : { x: 0, y: 0 });
  const nodeIndex = tab.selectedNode;
  const tweened = key?.tween ?? false;
  const easing = key?.easing ?? linearEasing;
  const easingChoice =
    easingChoices.find(
      (choice) => choice.easing !== null && sameEasing(choice.easing, easing)
    )?.id ?? "custom";
  const setEasingAxis = (axis: keyof Easing, value: number) => {
    actions.setEasing(clampEasing({ ...easing, [axis]: value }));
  };
  const pathNode =
    selectedShape?.kind === "Path" && nodeIndex !== null
      ? selectedShape.nodes[nodeIndex] ?? null
      : null;

  const commitRename = () => {
    if (renaming) {
      actions.renameLayer(renaming, draft);
    }
    setRenaming(null);
  };

  const iconButton =
    "flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40";

  const tool = tab.tool;
  const usesStroke =
    tool !== "select" &&
    tool !== "node" &&
    tool !== "eraser" &&
    tool !== "fill" &&
    tool !== "eyedropper";
  const usesFill =
    tool === "rect" ||
    tool === "ellipse" ||
    tool === "polygon" ||
    tool === "pen" ||
    tool === "fill";
  const usesWidth =
    tool === "pencil" ||
    tool === "brush" ||
    tool === "line" ||
    tool === "rect" ||
    tool === "ellipse" ||
    tool === "polygon" ||
    tool === "pen";
  const hasToolSettings = usesStroke || usesFill || usesWidth || tool === "eraser";

  return (
    <div className="flex w-full flex-col">
      {hasToolSettings && (
        <Section title={t("editor.toolSettings")}>
          {usesStroke && (
            <ColorField label={t("editor.stroke")} value={tab.stroke} onChange={(stroke) => setTab({ stroke })} />
          )}
          {usesFill && (
            <ColorField label={t("editor.fill")} value={tab.fill} onChange={(fill) => setTab({ fill })} />
          )}
          {usesWidth && (
            <NumberField
              label={t("editor.strokeWidth")}
              value={tab.strokeWidth}
              min={0.5}
              max={200}
              step={0.5}
              onCommit={(strokeWidth) => setTab({ strokeWidth })}
            />
          )}
          {tool === "brush" && (
            <NumberField
              label={t("editor.smoothing")}
              value={tab.smoothing}
              min={0}
              max={100}
              step={5}
              onCommit={(smoothing) => setTab({ smoothing })}
            />
          )}
          {tool === "polygon" && (
            <NumberField
              label={t("editor.sides")}
              value={tab.sides}
              min={3}
              max={32}
              onCommit={(sides) => setTab({ sides })}
            />
          )}
          {tool === "eraser" && (
            <NumberField
              label={t("editor.eraserWidth")}
              value={tab.eraserWidth}
              min={1}
              max={200}
              onCommit={(eraserWidth) => setTab({ eraserWidth })}
            />
          )}
          {tool === "text" && (
            <>
              <NumberField
                label={t("editor.fontSize")}
                value={tab.fontSize}
                min={4}
                max={400}
                onCommit={(fontSize) => setTab({ fontSize })}
              />
              <LabelField
                label={t("editor.fontFamily")}
                value={tab.fontFamily}
                required
                onCommit={(fontFamily) => setTab({ fontFamily })}
              />
            </>
          )}
        </Section>
      )}

      <Section title={t("editor.properties")}>
        <div className="flex items-center justify-between text-xs">
          <span className="truncate text-muted-foreground">{layer.name}</span>
          <span className="text-muted-foreground">
            {t("editor.frame")} {frame + 1}
          </span>
        </div>
        <NumberField label={t("editor.x")} value={rounded(transform.x)} step={1} onCommit={(x) => actions.setTransform({ x })} />
        <NumberField label={t("editor.y")} value={rounded(transform.y)} step={1} onCommit={(y) => actions.setTransform({ y })} />
        <NumberField
          label={t("editor.rotation")}
          value={rounded(transform.rotation)}
          step={1}
          onCommit={(rotation) => actions.setTransform({ rotation })}
        />
        <NumberField
          label={t("editor.scale")}
          value={rounded(transform.scale)}
          step={0.1}
          min={0.01}
          onCommit={(scale) => actions.setTransform({ scale })}
        />
        <NumberField
          label={t("editor.opacity")}
          value={rounded(transform.opacity * 100)}
          step={1}
          min={0}
          max={100}
          onCommit={(value) => actions.setTransform({ opacity: value / 100 })}
        />
        <NumberField
          label={t("editor.layerOpacity")}
          value={rounded(layer.opacity * 100)}
          step={1}
          min={0}
          max={100}
          onCommit={(value) => actions.setLayerFlags(layer.id, { opacity: value / 100 })}
        />
        <BlendField
          label={t("editor.layerBlend")}
          value={layer.blend}
          onChange={(blend) => actions.setLayerFlags(layer.id, { blend })}
        />
        <div className="flex flex-col gap-1">
          {layer.effects.map((effect, index) => (
            <EffectRow
              key={index}
              effect={effect}
              onChange={(next) =>
                actions.setLayerFlags(layer.id, {
                  effects: layer.effects.map((item, position) =>
                    position === index ? next : item
                  )
                })
              }
              onRemove={() =>
                actions.setLayerFlags(layer.id, {
                  effects: layer.effects.filter((_, position) => position !== index)
                })
              }
            />
          ))}
          <button
            type="button"
            onClick={() =>
              actions.setLayerFlags(layer.id, {
                effects: [...layer.effects, { kind: "blur", radius: 8 }]
              })
            }
            className="flex h-7 items-center gap-1 border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("editor.addEffect")}
          </button>
        </div>
        <LabelField label={t("editor.label")} value={key?.label ?? ""} onCommit={(label) => actions.setLabel(label)} />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={actions.toggleTween}
            aria-pressed={key?.tween ?? false}
            className={cn(
              "h-7 flex-1 border px-2 text-xs",
              key?.tween
                ? "border-border bg-accent text-accent-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            {t("editor.tween")}
          </button>
          <button
            type="button"
            disabled={tab.selected.length === 0}
            onClick={actions.deleteSelected}
            className="flex h-7 items-center gap-1 border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("editor.deleteShape")}
          </button>
        </div>
        <div className="flex flex-col gap-2 border-t border-border pt-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("editor.easing")}
          </span>
          <div className="flex flex-wrap gap-1">
            {easingChoices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                disabled={!tweened}
                data-easing-preset={choice.id}
                aria-pressed={tweened && easingChoice === choice.id}
                onClick={() => {
                  if (choice.easing) {
                    actions.setEasing(choice.easing);
                  }
                }}
                className={cn(
                  "h-7 border px-2 text-xs disabled:pointer-events-none disabled:opacity-40",
                  easingChoice === choice.id
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {t(choice.label)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <HandleField
              label={`${t("easing.handle1")} x`}
              hook="1x"
              value={easing.x1}
              min={0}
              max={1}
              disabled={!tweened}
              onCommit={(value) => setEasingAxis("x1", value)}
            />
            <HandleField
              label={`${t("easing.handle1")} y`}
              hook="1y"
              value={easing.y1}
              min={-1}
              max={2}
              disabled={!tweened}
              onCommit={(value) => setEasingAxis("y1", value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <HandleField
              label={`${t("easing.handle2")} x`}
              hook="2x"
              value={easing.x2}
              min={0}
              max={1}
              disabled={!tweened}
              onCommit={(value) => setEasingAxis("x2", value)}
            />
            <HandleField
              label={`${t("easing.handle2")} y`}
              hook="2y"
              value={easing.y2}
              min={-1}
              max={2}
              disabled={!tweened}
              onCommit={(value) => setEasingAxis("y2", value)}
            />
          </div>
        </div>
      </Section>

      {selBounds && tab.selected.length > 0 && (
        <Section title={t("editor.selection")}>
          <NumberField
            label={t("editor.selectionX")}
            value={rounded(selBounds.x)}
            step={1}
            onCommit={(x) => actions.transformShapes(pivot, x - selBounds.x, 0, 1, 1, 0)}
          />
          <NumberField
            label={t("editor.selectionY")}
            value={rounded(selBounds.y)}
            step={1}
            onCommit={(y) => actions.transformShapes(pivot, 0, y - selBounds.y, 1, 1, 0)}
          />
          <NumberField
            label={t("editor.selectionWidth")}
            value={rounded(selBounds.w)}
            step={0.5}
            min={0.5}
            onCommit={(w) => {
              if (selBounds.w > 0) {
                actions.transformShapes(pivot, 0, 0, w / selBounds.w, 1, 0);
              }
            }}
          />
          <NumberField
            label={t("editor.selectionHeight")}
            value={rounded(selBounds.h)}
            step={0.5}
            min={0.5}
            onCommit={(h) => {
              if (selBounds.h > 0) {
                actions.transformShapes(pivot, 0, 0, 1, h / selBounds.h, 0);
              }
            }}
          />
          <NumberField
            label={t("editor.pivotX")}
            value={rounded(pivot.x)}
            step={1}
            onCommit={(x) => setTab({ pivot: { x, y: pivot.y } })}
          />
          <NumberField
            label={t("editor.pivotY")}
            value={rounded(pivot.y)}
            step={1}
            onCommit={(y) => setTab({ pivot: { x: pivot.x, y } })}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => actions.reorderSelected(true)}
              className="h-7 flex-1 border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {t("editor.bringToFront")}
            </button>
            <button
              type="button"
              onClick={() => actions.reorderSelected(false)}
              className="h-7 flex-1 border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {t("editor.sendToBack")}
            </button>
          </div>
          <div className="flex items-center gap-1">
            {boolOps.map(({ op, labelKey }) => (
              <button
                key={op}
                type="button"
                disabled={tab.selected.length < 2}
                onClick={() => actions.shapeBool(op)}
                className="h-7 flex-1 border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title={t("align.panel")}>
        <div className="flex items-center gap-1">
          {alignModes.map(({ mode, labelKey, icon: Icon, distribute }) => (
            <button
              key={mode}
              type="button"
              title={t(labelKey)}
              aria-label={t(labelKey)}
              disabled={tab.selected.length === 0 || (distribute && tab.selected.length < 3)}
              onClick={() => actions.alignSelected(mode)}
              className={iconButton}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="shrink-0 text-muted-foreground">{t("align.target")}</span>
          <div className="flex gap-1">
            {alignReferences.map((reference) => (
              <button
                key={reference}
                type="button"
                aria-pressed={tab.alignReference === reference}
                onClick={() => setTab({ alignReference: reference })}
                className={cn(
                  "h-7 flex-1 border px-2 text-xs",
                  tab.alignReference === reference
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {t(`align.${reference}`)}
              </button>
            ))}
          </div>
        </div>
      </Section>

      {selectedShape !== null && selectedIndex !== null && (
        <Section title={t("editor.shape")}>
          <p className="text-xs text-muted-foreground">
            {selectedShape.kind === "Group"
              ? t("command.group")
              : t(`editor.shape.${selectedShape.kind}`)}{" "}
            {selectedIndex + 1}
          </p>
          <ShapeFields
            shape={selectedShape}
            index={selectedIndex}
            onPaint={actions.paintShape}
            onReplace={actions.replaceShape}
          />
          {selectedShape.kind === "Path" && pathNode && nodeIndex !== null && (
            <>
              <NumberField
                label={t("editor.nodeX")}
                value={rounded(pathNode.point.x)}
                onCommit={(x) => {
                  const dx = x - pathNode.point.x;
                  const nodes = selectedShape.nodes.map((node, index) =>
                    index === nodeIndex
                      ? {
                          point: { x, y: node.point.y },
                          handle_in: node.handle_in
                            ? { x: node.handle_in.x + dx, y: node.handle_in.y }
                            : null,
                          handle_out: node.handle_out
                            ? { x: node.handle_out.x + dx, y: node.handle_out.y }
                            : null
                        }
                      : node
                  );
                  actions.replaceShape(selectedIndex, { ...selectedShape, nodes });
                }}
              />
              <NumberField
                label={t("editor.nodeY")}
                value={rounded(pathNode.point.y)}
                onCommit={(y) => {
                  const dy = y - pathNode.point.y;
                  const nodes = selectedShape.nodes.map((node, index) =>
                    index === nodeIndex
                      ? {
                          point: { x: node.point.x, y },
                          handle_in: node.handle_in
                            ? { x: node.handle_in.x, y: node.handle_in.y + dy }
                            : null,
                          handle_out: node.handle_out
                            ? { x: node.handle_out.x, y: node.handle_out.y + dy }
                            : null
                        }
                      : node
                  );
                  actions.replaceShape(selectedIndex, { ...selectedShape, nodes });
                }}
              />
              <button
                type="button"
                onClick={() => {
                  const minimum = selectedShape.closed ? 3 : 2;
                  if (selectedShape.nodes.length <= minimum) {
                    toast.error(t("editor.nodeMinimum"));
                    return;
                  }
                  actions.replaceShape(selectedIndex, {
                    ...selectedShape,
                    nodes: selectedShape.nodes.filter((_, index) => index !== nodeIndex)
                  });
                  setTab({ selectedNode: null });
                }}
                className="flex h-7 items-center gap-1 border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("editor.removeNode")}
              </button>
            </>
          )}
        </Section>
      )}

      <Section
        title={t("editor.layers")}
        action={
          <div className="flex items-center gap-1">
            <button
              type="button"
              title={t("command.addLayer")}
              aria-label={t("command.addLayer")}
              onClick={() => actions.addLayer(activeParent)}
              className={iconButton}
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              title={t("command.addFolder")}
              aria-label={t("command.addFolder")}
              onClick={() => actions.addFolder(activeParent)}
              className={iconButton}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </div>
        }
      >
        <div className="flex flex-col">
          {rows.map((row) => {
            const item = row.layer;
            const folded = collapsedIds.includes(item.id);
            return (
              <div
                key={item.id}
                data-folder={item.folder}
                className={cn(
                  "flex items-center gap-1 border border-transparent px-1 py-0.5",
                  item.id === layer.id && "border-border bg-accent"
                )}
              >
                <div
                  className="flex min-w-0 flex-1 items-center gap-1"
                  style={{ paddingLeft: row.depth * 12 }}
                >
                  {item.folder ? (
                    <button
                      type="button"
                      aria-expanded={!folded}
                      title={folded ? t("editor.expandFolder") : t("editor.collapseFolder")}
                      aria-label={folded ? t("editor.expandFolder") : t("editor.collapseFolder")}
                      onClick={() => actions.toggleFolder(item.id)}
                      className="flex h-6 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                    >
                      {folded ? (
                        <ChevronRight className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : (
                    <span className="h-6 w-4 shrink-0" />
                  )}
                  {renaming === item.id ? (
                    <input
                      autoFocus
                      value={draft}
                      aria-label={t("editor.layerName")}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          commitRename();
                        }
                        if (event.key === "Escape") {
                          setRenaming(null);
                        }
                      }}
                      className="h-6 min-w-0 flex-1 border border-ring bg-background px-1 text-xs outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => actions.selectLayer(item.id)}
                      onDoubleClick={() => {
                        setRenaming(item.id);
                        setDraft(item.name);
                      }}
                      className="h-6 min-w-0 flex-1 truncate text-left text-xs"
                      title={item.name}
                    >
                      {item.name}
                    </button>
                  )}
                </div>
                {item.effects.length > 0 && (
                  <span className="shrink-0 text-xs text-muted-foreground">fx</span>
                )}
                {item.folder ? (
                  <button
                    type="button"
                    title={t("editor.unwrapFolder")}
                    aria-label={t("editor.unwrapFolder")}
                    onClick={() => actions.unwrapFolder(item.id)}
                    className={iconButton}
                  >
                    <FolderMinus className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={row.index === 0}
                    aria-pressed={item.masked}
                    title={t("editor.layerMask")}
                    aria-label={t("editor.layerMask")}
                    onClick={() => actions.setLayerFlags(item.id, { masked: !item.masked })}
                    className={cn(iconButton, item.masked && "text-foreground")}
                  >
                    <Scissors className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  disabled={row.index === 0}
                  title={t("editor.moveUp")}
                  aria-label={t("editor.moveUp")}
                  onClick={() => actions.moveLayer(item.id, row.index - 1, row.parentId)}
                  className={iconButton}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={row.index === row.total - 1}
                  title={t("editor.moveDown")}
                  aria-label={t("editor.moveDown")}
                  onClick={() => actions.moveLayer(item.id, row.index + 1, row.parentId)}
                  className={iconButton}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title={t("editor.duplicateLayer")}
                  aria-label={t("editor.duplicateLayer")}
                  onClick={() => actions.duplicateLayer(item.id)}
                  className={iconButton}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={leafCount(scene.layers) < 2}
                  title={t(item.folder ? "editor.deleteFolder" : "editor.deleteLayer")}
                  aria-label={t(item.folder ? "editor.deleteFolder" : "editor.deleteLayer")}
                  onClick={() => actions.removeLayer(item.id)}
                  className={cn(iconButton, "hover:text-destructive")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}