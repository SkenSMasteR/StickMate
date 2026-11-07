import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { sceneLength } from "@/lib/document";
import { useWorkspace } from "./workspace";

export default function ScenesBar() {
  const { doc, scene, actions } = useWorkspace();
  const { t } = useI18n();
  const barRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!menu) {
      return;
    }
    const onDown = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node)) {
        setMenu(null);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  if (!doc || !scene) {
    return null;
  }

  const startEditing = (id: string, name: string) => {
    setMenu(null);
    setEditing(id);
    setDraft(name);
  };

  const commitEditing = () => {
    if (editing && draft.trim() !== "") {
      actions.renameScene(editing, draft);
    }
    setEditing(null);
  };

  const itemClass =
    "flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40";

  return (
    <div
      ref={barRef}
      className="relative z-30 flex h-9 shrink-0 items-center gap-1 border-b border-border bg-muted/40 px-1"
    >
      {doc.scenes.map((item, index) => {
        const active = item.id === scene.id;
        return (
          <div key={item.id} className="relative flex items-center">
            {editing === item.id ? (
              <input
                autoFocus
                value={draft}
                aria-label={t("editor.sceneName")}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitEditing}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitEditing();
                  }
                  if (event.key === "Escape") {
                    setEditing(null);
                  }
                }}
                className="h-7 w-32 border border-ring bg-background px-1 text-xs outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setMenu(null);
                  actions.selectScene(item.id);
                }}
                onDoubleClick={() => startEditing(item.id, item.name)}
                title={`${item.name} (${sceneLength(item)})`}
                aria-label={`${item.name} (${sceneLength(item)})`}
                className={cn(
                  "flex h-7 items-center gap-2 border px-2 text-xs",
                  active
                    ? "border-border bg-background text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <span className="max-w-40 truncate">{item.name}</span>
                <span className="text-[10px] text-muted-foreground">{sceneLength(item)}</span>
              </button>
            )}
            {active && (
              <button
                type="button"
                title={t("editor.sceneActions")}
                aria-label={t("editor.sceneActions")}
                onClick={() => setMenu(menu === item.id ? null : item.id)}
                className="flex h-7 w-6 items-center justify-center border border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            )}
            {active && menu === item.id && (
              <div className="absolute left-0 top-8 z-40 w-44 border border-border bg-background py-1 shadow-lg">
                <button type="button" className={itemClass} onClick={() => startEditing(item.id, item.name)}>
                  {t("editor.rename")}
                </button>
                <button
                  type="button"
                  className={itemClass}
                  onClick={() => {
                    setMenu(null);
                    actions.duplicateScene(item.id);
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("editor.duplicate")}
                </button>
                <button
                  type="button"
                  disabled={index === 0}
                  className={itemClass}
                  onClick={() => {
                    setMenu(null);
                    actions.moveScene(item.id, index - 1);
                  }}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  {t("editor.moveLeft")}
                </button>
                <button
                  type="button"
                  disabled={index === doc.scenes.length - 1}
                  className={itemClass}
                  onClick={() => {
                    setMenu(null);
                    actions.moveScene(item.id, index + 1);
                  }}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                  {t("editor.moveRight")}
                </button>
                <button
                  type="button"
                  disabled={doc.scenes.length < 2}
                  className={cn(itemClass, "text-destructive")}
                  onClick={() => {
                    setMenu(null);
                    actions.removeScene(item.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("editor.delete")}
                </button>
              </div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        title={t("command.addScene")}
        aria-label={t("command.addScene")}
        onClick={actions.addScene}
        className="flex h-7 w-7 items-center justify-center border border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}