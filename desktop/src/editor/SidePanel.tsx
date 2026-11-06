import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/i18n";
import { heldKey } from "@/lib/document";
import { cn } from "@/lib/utils";
import NumberField from "./NumberField";
import { useWorkspace } from "./workspace";

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
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
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 w-9 shrink-0 cursor-pointer border border-border bg-transparent p-0.5"
      />
      <input
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 w-full min-w-0 border border-border bg-transparent px-1 text-xs outline-none focus:border-ring"
      />
    </label>
  );
}

function LabelField({
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
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
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

export default function SidePanel() {
  const { doc, scene, layer, tab, frame, transform, actions, setTab } = useWorkspace();
  const { t } = useI18n();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (!doc || !scene || !layer || !tab) {
    return null;
  }

  const key = heldKey(layer, frame);
  const rounded = (value: number) => Number(value.toFixed(2));
  const selectedIndex = tab.selected;
  const selectedShape =
    selectedIndex === null ? null : key?.shapes[selectedIndex] ?? null;

  const commitRename = () => {
    if (renaming) {
      actions.renameLayer(renaming, draft);
    }
    setRenaming(null);
  };

  const iconButton =
    "flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40";

  return (
    <div className="flex w-full flex-col">
      <Section title={t("editor.toolSettings")}>
        <ColorField label={t("editor.stroke")} value={tab.stroke} onChange={(stroke) => setTab({ stroke })} />
        <ColorField label={t("editor.fill")} value={tab.fill} onChange={(fill) => setTab({ fill })} />
        <NumberField
          label={t("editor.strokeWidth")}
          value={tab.strokeWidth}
          min={0.5}
          max={200}
          step={0.5}
          onCommit={(strokeWidth) => setTab({ strokeWidth })}
        />
      </Section>

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
            disabled={selectedShape === null}
            onClick={actions.deleteSelected}
            className="flex h-7 items-center gap-1 border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("editor.deleteShape")}
          </button>
        </div>
        {selectedShape !== null && selectedIndex !== null && (
          <p className="text-xs text-muted-foreground">
            {t(`editor.shape.${selectedShape.kind}`)} {selectedIndex + 1}
          </p>
        )}
      </Section>

      <Section
        title={t("editor.layers")}
        action={
          <button
            type="button"
            title={t("command.addLayer")}
            aria-label={t("command.addLayer")}
            onClick={actions.addLayer}
            className={iconButton}
          >
            <Plus className="h-4 w-4" />
          </button>
        }
      >
        <div className="flex flex-col">
          {scene.layers.map((item, index) => (
            <div
              key={item.id}
              className={cn(
                "flex items-center gap-1 border border-transparent px-1 py-0.5",
                item.id === layer.id && "border-border bg-accent"
              )}
            >
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
                  className="h-6 w-full min-w-0 border border-ring bg-background px-1 text-xs outline-none"
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
              <button
                type="button"
                disabled={index === 0}
                title={t("editor.moveUp")}
                aria-label={t("editor.moveUp")}
                onClick={() => actions.moveLayer(item.id, index - 1)}
                className={iconButton}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={index === scene.layers.length - 1}
                title={t("editor.moveDown")}
                aria-label={t("editor.moveDown")}
                onClick={() => actions.moveLayer(item.id, index + 1)}
                className={iconButton}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={scene.layers.length < 2}
                title={t("editor.deleteLayer")}
                aria-label={t("editor.deleteLayer")}
                onClick={() => actions.removeLayer(item.id)}
                className={cn(iconButton, "hover:text-destructive")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}