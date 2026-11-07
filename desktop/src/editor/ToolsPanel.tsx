import {
  Brush,
  Circle,
  Eraser,
  MousePointer2,
  PaintBucket,
  PenTool,
  Pentagon,
  Pencil,
  Pipette,
  Slash,
  Square,
  Type,
  Waypoints
} from "lucide-react";
import { useI18n } from "@/i18n";
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
  { id: "node", icon: Waypoints }
];

export default function ToolsPanel() {
  const { tab, actions } = useWorkspace();
  const { t } = useI18n();
  const commands = buildCommands(actions, t);

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
            label={keys ? `${label} (${keys.toUpperCase()})` : label}
            active={tab?.tool === tool.id}
            onClick={() => actions.setTool(tool.id)}
          />
        );
      })}
    </div>
  );
}