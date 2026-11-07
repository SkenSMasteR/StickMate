import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/editor/workspace";
import { useI18n } from "@/i18n";
import {
  templatesCatalog,
  templatesOpen,
  templatesPreview
} from "@/lib/templates";
import type { TemplateEntry } from "@/lib/templates";

export default function Templates({ onOpened }: { onOpened: (id: string) => void }) {
  const { t } = useI18n();
  const { open } = useWorkspace();
  const [entries, setEntries] = useState<TemplateEntry[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [cached, setCached] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const catalog = await templatesCatalog();
      setEntries(catalog.templates);
      setCached(catalog.cached);
      const images = await Promise.all(
        catalog.templates.map(async (entry) => {
          try {
            return [entry.id, await templatesPreview(entry.id)] as const;
          } catch {
            return [entry.id, ""] as const;
          }
        })
      );
      setPreviews(Object.fromEntries(images));
    } catch (error) {
      setEntries([]);
      setFailed(true);
      toast.error(String(error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const use = async (entry: TemplateEntry) => {
    if (!entry.supported) {
      toast.error(t("templates.tooNew"));
      return;
    }
    setBusy(entry.id);
    try {
      const id = await templatesOpen(entry.id);
      if (await open(id)) {
        onOpened(id);
      }
    } catch (error) {
      toast.error(String(error));
    }
    setBusy(null);
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      {cached && !loading && !failed && (
        <p className="text-xs text-muted-foreground">{t("templates.offline")}</p>
      )}

      {loading ? (
        <Card className="flex flex-col gap-3 p-4">
          <p className="text-sm text-muted-foreground">{t("templates.loading")}</p>
          <Skeleton className="h-4 w-48" />
        </Card>
      ) : failed ? (
        <Card className="flex flex-1 flex-col items-center justify-center gap-3 p-12">
          <p className="text-sm text-muted-foreground">{t("templates.failed")}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t("templates.retry")}
          </Button>
        </Card>
      ) : entries.length === 0 ? (
        <Card className="flex flex-1 items-center justify-center p-12">
          <p className="text-sm text-muted-foreground">{t("templates.empty")}</p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {entries.map((entry) => (
            <Card
              key={entry.id}
              onClick={() => {
                if (!busy) {
                  void use(entry);
                }
              }}
              className="flex cursor-pointer flex-col gap-2 p-4 transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {previews[entry.id] ? (
                <img
                  src={previews[entry.id]}
                  alt=""
                  draggable={false}
                  className="aspect-video w-full rounded-md border bg-white object-contain"
                />
              ) : (
                <div className="aspect-video w-full rounded-md border bg-muted" />
              )}
              <div className="text-sm font-medium">{entry.name}</div>
              <p className="text-xs text-muted-foreground">{entry.description}</p>
              <div className="text-xs text-muted-foreground">
                {entry.width} × {entry.height} · {entry.fps} fps · v{entry.version}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={busy !== null || !entry.supported}
                onClick={(event) => {
                  event.stopPropagation();
                  void use(entry);
                }}
              >
                {t("templates.use")}
              </Button>
              {busy === entry.id && (
                <div className="text-xs text-muted-foreground">
                  {t("templates.download")}
                </div>
              )}
              {!entry.supported && (
                <div className="text-xs text-muted-foreground">
                  {t("templates.tooNew")}
                </div>
              )}
              {entry.supported && entry.project_cached && busy !== entry.id && (
                <div className="text-xs text-muted-foreground">
                  {t("templates.cached")}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}