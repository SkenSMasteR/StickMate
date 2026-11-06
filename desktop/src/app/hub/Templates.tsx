import { useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { useWorkspace } from "@/editor/workspace";
import { useI18n } from "@/i18n";
import {
  docAddLayer,
  docDraw,
  docKeyframe,
  docNew,
  docSetLayer,
  docSetTransform,
  docSetTween,
  identityTransform
} from "@/lib/document";
import type { Document } from "@/lib/document";

interface Template {
  id: string;
  width: number;
  height: number;
  fps: number;
  background: string;
  scaffold?: (doc: Document) => Promise<unknown>;
}

const templates: Template[] = [
  { id: "blank", width: 1920, height: 1080, fps: 30, background: "#ffffff" },
  {
    id: "ball",
    width: 1280,
    height: 720,
    fps: 24,
    background: "#ffffff",
    scaffold: async (doc) => {
      const scene = doc.scenes[0];
      const layer = scene.layers[0].id;
      await docSetLayer(doc.id, scene.id, layer, { name: "Ball" });
      await docDraw(doc.id, scene.id, layer, 0, {
        kind: "Ellipse",
        x: 560,
        y: 80,
        w: 160,
        h: 160,
        fill: "#3b82f6",
        stroke: "#000000",
        width: 3
      });
      await docKeyframe(doc.id, scene.id, layer, 12, false);
      await docSetTransform(doc.id, scene.id, layer, 12, {
        ...identityTransform,
        y: 400
      });
      await docSetTween(doc.id, scene.id, layer, 0, true);
      await docKeyframe(doc.id, scene.id, layer, 24, false);
      await docSetTransform(doc.id, scene.id, layer, 24, identityTransform);
      await docSetTween(doc.id, scene.id, layer, 12, true);
    }
  },
  {
    id: "walk",
    width: 1080,
    height: 1080,
    fps: 12,
    background: "#ffffff",
    scaffold: async (doc) => {
      const scene = doc.scenes[0];
      await docSetLayer(doc.id, scene.id, scene.layers[0].id, { name: "Head" });
      await docAddLayer(doc.id, scene.id, "Arms");
      await docAddLayer(doc.id, scene.id, "Body");
      await docAddLayer(doc.id, scene.id, "Legs");
    }
  }
];

export default function Templates({ onOpened }: { onOpened: () => void }) {
  const { t } = useI18n();
  const { open } = useWorkspace();
  const [busy, setBusy] = useState<string | null>(null);

  const use = async (template: Template) => {
    setBusy(template.id);
    try {
      const doc = await docNew(
        t(`templates.${template.id}`),
        template.width,
        template.height,
        template.fps,
        template.background
      );
      if (template.scaffold) {
        await template.scaffold(doc);
      }
      if (await open(doc.id)) {
        onOpened();
      }
    } catch (error) {
      toast.error(String(error));
    }
    setBusy(null);
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {templates.map((template) => (
          <Card
            key={template.id}
            onClick={() => {
              if (!busy) {
                void use(template);
              }
            }}
            className="flex cursor-pointer flex-col gap-2 p-4 transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <div className="text-sm font-medium">
              {t(`templates.${template.id}`)}
            </div>
            <p className="text-xs text-muted-foreground">
              {t(`templates.${template.id}Desc`)}
            </p>
            <div className="text-xs text-muted-foreground">
              {template.width} × {template.height} · {template.fps} fps
            </div>
            {busy === template.id && (
              <div className="text-xs text-muted-foreground">
                {t("new.creating")}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}