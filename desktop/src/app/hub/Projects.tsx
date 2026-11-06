import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { useToast } from "@/lib/toast";

export interface RecentProject {
  id: string;
  name: string;
  lastOpened: number;
  pinned: boolean;
}

const storageKey = "stickmate.projects";

function loadProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as RecentProject[];
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {
    return [];
  }
  return [];
}

function saveProjects(projects: RecentProject[]): void {
  localStorage.setItem(storageKey, JSON.stringify(projects));
}

function formatLastOpened(timestamp: number, language: string): string {
  try {
    return new Date(timestamp).toLocaleString(language === "mk" ? "mk-MK" : "en-US");
  } catch {
    return new Date(timestamp).toISOString();
  }
}

export default function Projects() {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const [projects, setProjects] = useState<RecentProject[]>([]);

  useEffect(() => {
    setProjects(loadProjects());
  }, []);

  const sorted = [...projects].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    return b.lastOpened - a.lastOpened;
  });

  const togglePin = (id: string) => {
    setProjects((prev) => {
      const next = prev.map((project) =>
        project.id === id ? { ...project, pinned: !project.pinned } : project
      );
      saveProjects(next);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <h1 className="text-base font-semibold">{t("projects.title")}</h1>

      {sorted.length === 0 ? (
        <div className="flex flex-1 items-center justify-center border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {t("projects.empty")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <div className="grid grid-cols-[1fr_180px_160px] gap-2 border-b border-[hsl(var(--border))] px-4 py-2 text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            <span>{t("projects.name")}</span>
            <span>{t("projects.lastOpened")}</span>
            <span />
          </div>
          {sorted.map((project) => (
            <div
              key={project.id}
              className="grid grid-cols-[1fr_180px_160px] items-center gap-2 border-b border-[hsl(var(--border))] px-4 py-3 last:border-b-0"
            >
              <span className="truncate text-sm">{project.name}</span>
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                {formatLastOpened(project.lastOpened, language)}
              </span>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => togglePin(project.id)}
                >
                  {project.pinned ? t("projects.unpin") : t("projects.pin")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    toast(t("projects.opened"));
                  }}
                >
                  {t("projects.open")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
