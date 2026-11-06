import { useState } from "react";
import { Home, X } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./workspace";

export default function ProjectTabs({ onHome }: { onHome: () => void }) {
  const { ids, docs, activeId, activate, close, actions } = useWorkspace();
  const { t } = useI18n();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commitRename = () => {
    if (renaming && draft.trim() !== "") {
      actions.renameDoc(draft);
    }
    setRenaming(null);
  };

  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-1">
      <button
        type="button"
        title={t("editor.home")}
        aria-label={t("editor.home")}
        onClick={onHome}
        className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Home className="h-4 w-4" />
      </button>
      <span className="mx-1 h-5 w-px shrink-0 bg-border" />
      <div className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {ids.map((id) => {
          const item = docs[id];
          if (!item) {
            return null;
          }
          const active = id === activeId;
          return (
            <div
              key={id}
              className={cn(
                "flex h-7 shrink-0 items-center border",
                active
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-transparent text-muted-foreground hover:bg-accent/50"
              )}
            >
              {renaming === id ? (
                <input
                  autoFocus
                  value={draft}
                  aria-label={t("editor.projectName")}
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
                  className="h-full w-32 border-0 bg-background px-1 text-xs outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => activate(id)}
                  onDoubleClick={() => {
                    activate(id);
                    setRenaming(id);
                    setDraft(item.name);
                  }}
                  title={item.name}
                  aria-label={item.name}
                  className="h-full max-w-48 truncate px-2 text-xs"
                >
                  {item.name}
                </button>
              )}
              <button
                type="button"
                title={t("editor.closeTab")}
                aria-label={t("editor.closeTab")}
                onClick={() => void close(id)}
                className="flex h-full w-5 items-center justify-center hover:bg-background"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}