import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import ProjectPreview from "@/app/hub/ProjectPreview";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/editor/workspace";
import { useI18n } from "@/i18n";
import { docList, docRecoveryReport } from "@/lib/document";
import type { ProjectSummary } from "@/lib/document";
import { exportAnimate, importAnimate } from "@/lib/fla";

const pinKey = "stickmate.pins";

function loadPins(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(pinKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    }
  } catch {
    return {};
  }
  return {};
}

function formatUpdated(timestamp: number, language: string): string {
  try {
    return new Date(timestamp).toLocaleString(
      language === "mk" ? "mk-MK" : "en-US"
    );
  } catch {
    return new Date(timestamp).toISOString();
  }
}

export default function Projects({
  onOpened,
  onReport
}: {
  onOpened: (id: string) => void;
  onReport: () => void;
}) {
  const { t, language } = useI18n();
  const { open, remove } = useWorkspace();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [pins, setPins] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await docList();
      setProjects(list);
      const problems = await docRecoveryReport();
      for (const problem of problems) {
        toast.error(problem);
      }
    } catch (error) {
      toast.error(String(error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    setPins(loadPins());
    void refresh();
  }, [refresh]);

  const togglePin = (id: string) => {
    setPins((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      localStorage.setItem(pinKey, JSON.stringify(next));
      return next;
    });
  };

  const openProject = async (id: string) => {
    if (await open(id)) {
      onOpened(id);
    }
  };

  const announce = (name: string, lines: string[]) => {
    if (lines.length === 0) {
      toast.success(name);
      return;
    }
    toast.warning(name, {
      action: { label: t("report.open"), onClick: onReport }
    });
  };

  const exportProject = async (project: ProjectSummary) => {
    try {
      const result = await exportAnimate(project.id, project.name);
      if (result) {
        announce(result.path, result.warnings);
      }
    } catch (error) {
      toast.error(String(error));
    }
  };

  const importProject = async () => {
    try {
      const result = await importAnimate();
      if (!result) {
        return;
      }
      await refresh();
      announce(result.name, result.notes);
    } catch (error) {
      toast.error(String(error));
    }
  };

  const sorted = [...projects].sort((a, b) => {
    const pinnedA = pins[a.id] ? 1 : 0;
    const pinnedB = pins[b.id] ? 1 : 0;
    if (pinnedA !== pinnedB) {
      return pinnedB - pinnedA;
    }
    return b.updated_at - a.updated_at;
  });

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => void importProject()}>
          {t("projects.import")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          {t("projects.refresh")}
        </Button>
      </div>

      {loading ? (
        <Card className="flex flex-col gap-3 p-4">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-32" />
        </Card>
      ) : sorted.length === 0 ? (
        <Card className="flex flex-1 items-center justify-center p-12">
          <p className="text-sm text-muted-foreground">{t("projects.empty")}</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((project) => (
            <Card
              key={project.id}
              onClick={() => void openProject(project.id)}
              className="flex cursor-pointer items-center gap-4 p-4 transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <ProjectPreview project={project} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {project.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {project.width} × {project.height} · {project.fps} fps ·{" "}
                  {formatUpdated(project.updated_at, language)}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  togglePin(project.id);
                }}
              >
                {pins[project.id] ? t("projects.unpin") : t("projects.pin")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  void openProject(project.id);
                }}
              >
                {t("projects.open")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  void exportProject(project);
                }}
              >
                {t("projects.export")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("projects.delete")}
                title={t("projects.delete")}
                onClick={(event) => {
                  event.stopPropagation();
                  void remove(project.id).then(refresh);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}