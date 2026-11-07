import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/i18n";
import { heldKey } from "@/lib/document";
import type { Shape } from "@/lib/document";
import { cn } from "@/lib/utils";
import Picker from "@/components/color-field";
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
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <Picker value={value} onChange={onChange} label={label} square />
    </div>
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
    return (
      <>
        <LabelField
          label={t("editor.textContent")}
          value={shape.text}
          required
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
        <ColorField
          label={t("editor.fill")}
          value={shape.fill}
          onChange={(fill) => onPaint(index, fill)}
        />
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
      <ColorField
        label={t("editor.fill")}
        value={shape.fill}
        onChange={(fill) => onPaint(index, fill)}
      />
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
  const rounded = (value: number) => Number(value.toFixed(2));
  const selectedIndex = tab.selected;
  const selectedShape =
    selectedIndex === null ? null : key?.shapes[selectedIndex] ?? null;
  const nodeIndex = tab.selectedNode;
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
      </Section>

      {selectedShape !== null && selectedIndex !== null && (
        <Section title={t("editor.shape")}>
          <p className="text-xs text-muted-foreground">
            {t(`editor.shape.${selectedShape.kind}`)} {selectedIndex + 1}
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