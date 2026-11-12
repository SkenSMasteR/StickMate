import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n";
import type { Command } from "./commands";

export default function FileMenu({ commands }: { commands: Command[] }) {
  const { t } = useI18n();
  const items = ["project.importAnimate", "project.exportAnimate"]
    .map((id) => commands.find((command) => command.id === id))
    .filter((command): command is Command => command !== undefined);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-9 shrink-0 items-center gap-1 border-b border-r border-border bg-muted/40 px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
        >
          {t("menu.file")}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52 rounded-none">
        {items.map((command) => (
          <DropdownMenuItem
            key={command.id}
            disabled={command.disabled}
            className="rounded-none text-xs"
            onSelect={() => command.run()}
          >
            <span className="min-w-0 flex-1 truncate">{command.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
