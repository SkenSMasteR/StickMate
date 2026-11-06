import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { useToast } from "@/lib/toast";

const catalogUrl =
  "https://raw.githubusercontent.com/StickMate/templates/orphan/catalog.json";

interface Template {
  id: string;
  name: string;
}

export default function Templates() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    try {
      const response = await fetch(catalogUrl);
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      const data = (await response.json()) as Template[] | { templates?: Template[] };
      const list = Array.isArray(data) ? data : data.templates ?? [];
      setTemplates(list);
    } catch {
      setTemplates([]);
      toast(t("templates.unavailable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold">{t("templates.title")}</h1>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          {t("templates.refresh")}
        </Button>
      </div>

      {templates.length === 0 ? (
        <div className="flex flex-1 items-center justify-center border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {t("templates.empty")}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {templates.map((template) => (
            <div
              key={template.id}
              className="border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 text-sm"
            >
              {template.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
