import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
    return new Date(timestamp).toLocaleString(
      language === "mk" ? "mk-MK" : "en-US"
    );
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
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <h1 className="text-lg font-semibold">{t("projects.title")}</h1>

      {sorted.length === 0 ? (
        <Card className="flex flex-1 items-center justify-center p-12">
          <p className="text-sm text-muted-foreground">{t("projects.empty")}</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((project) => (
            <Card key={project.id} className="flex items-center gap-4 p-4">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {project.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatLastOpened(project.lastOpened, language)}
                </div>
              </div>
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
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
