import {
  Brush,
  Circle,
  Download,
  Eraser,
  ImagePlus,
  Keyboard,
  MousePointer2,
  PaintBucket,
  PenTool,
  Pentagon,
  Pencil,
  Pipette,
  PersonStanding,
  Search,
  Slash,
  Square,
  Type,
  Waypoints
} from "lucide-react";
import { useI18n } from "@/i18n";
import { usePrefs } from "@/lib/prefs";
import { formatCombo } from "@/lib/shortcuts";
import { buildCommands } from "./commands";
import ToolButton from "./ToolButton";
import { useWorkspace } from "./workspace";
import type { Tool } from "./workspace";

const tools: Array<{ id: Tool; icon: typeof Pencil }> = [
  { id: "select", icon: MousePointer2 },
  { id: "pencil", icon: Pencil },
  { id: "brush", icon: Brush },
  { id: "eraser", icon: Eraser },
  { id: "line", icon: Slash },
  { id: "rect", icon: Square },
  { id: "ellipse", icon: Circle },
  { id: "polygon", icon: Pentagon },
  { id: "fill", icon: PaintBucket },
  { id: "eyedropper", icon: Pipette },
  { id: "text", icon: Type },
  { id: "pen", icon: PenTool },
  { id: "node", icon: Waypoints },
  { id: "figure", icon: PersonStanding }
];

export default function ToolsPanel({
  onShortcuts,
  onExport,
  onPalette
}: {
  onShortcuts: () => void;
  onExport: () => void;
  onPalette?: () => void;
}) {
  const { tab, actions } = useWorkspace();
  const { t } = useI18n();
  const { prefs } = usePrefs();
  const commands = buildCommands(actions, t, prefs.shortcuts, onShortcuts, onExport);
  const bottom = [
    { id: "media.importImage", icon: ImagePlus, run: actions.importImage },
    { id: "view.export", icon: Download, run: onExport },
    ...(onPalette ? [{ id: "view.palette", icon: Search, run: onPalette }] : []),
    { id: "view.shortcuts", icon: Keyboard, run: onShortcuts }
  ];

  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border bg-background py-1">
      {tools.map((tool) => {
        const command = commands.find((item) => item.id === `tool.${tool.id}`);
        const label = command?.label ?? tool.id;
        const keys = command?.keys ?? "";
        return (
          <ToolButton
            key={tool.id}
            icon={tool.icon}
            label={keys ? `${label} (${formatCombo(keys)})` : label}
            active={tab?.tool === tool.id}
            onClick={() => actions.setTool(tool.id)}
          />
        );
      })}
      <div className="mt-auto flex flex-col items-center gap-1">
        {bottom.map((item) => {
          const command = commands.find((entry) => entry.id === item.id);
          const label = command?.label ?? item.id;
          const keys = command?.keys ?? "";
          return (
            <ToolButton
              key={item.id}
              icon={item.icon}
              label={keys ? `${label} (${formatCombo(keys)})` : label}
              onClick={item.run}
            />
          );
        })}
      </div>
    </div>
  );
}