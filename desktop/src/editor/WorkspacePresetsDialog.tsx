import { useRef, useState } from "react";
import {
  Download,
  Film,
  Frame,
  Layers,
  LayoutGrid,
  Monitor,
  Pencil,
  Star,
  Table,
  Trash2
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import { useConfirm } from "@/lib/confirm";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { panelWindowBounds } from "@/lib/windows";
import {
  cloneLayout,
  MAX_PRESET_BYTES,
  newPresetId,
  PANEL_IDS,
  parsePresetFile,
  serializePreset,
  WORKSPACE_ICONS
} from "@/lib/workspace-presets";
import type {
  DockLayout,
  PanelId,
  WorkspaceIcon,
  WorkspacePreset
} from "@/lib/workspace-presets";
import { PANEL_TITLE_KEYS } from "./PanelFrame";

export const WORKSPACE_ICON_COMPONENTS: Record<
  WorkspaceIcon,
  typeof LayoutGrid
> = {
  layout: LayoutGrid,
  film: Film,
  layers: Layers,
  pencil: Pencil,
  monitor: Monitor,
  grid: Table,
  star: Star,
  frame: Frame
};

const iconButton =
  "flex h-7 w-7 shrink-0 items-center justify-center border border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground";

export function WorkspaceMenu({
  layout,
  onApply,
  onManage,
  onTogglePanel,
  onReset
}: {
  layout: DockLayout;
  onApply: (layout: DockLayout) => void;
  onManage: () => void;
  onTogglePanel: (panel: PanelId, visible: boolean) => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const { prefs } = usePrefs();
  const presets = Object.values(prefs.workspaces ?? {}).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("workspace.title")}
          title={t("workspace.title")}
          className="flex h-9 w-9 shrink-0 items-center justify-center border-b border-l border-border bg-muted/40 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <LayoutGrid className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52 rounded-none">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("workspace.title")}
        </DropdownMenuLabel>
        {presets.map((preset) => {
          const Icon = WORKSPACE_ICON_COMPONENTS[preset.icon] ?? LayoutGrid;
          return (
            <DropdownMenuItem
              key={preset.id}
              className="rounded-none text-xs"
              onSelect={() => onApply(preset.layout)}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="min-w-0 flex-1 truncate">{preset.name}</span>
            </DropdownMenuItem>
          );
        })}
        {presets.length === 0 && (
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {t("workspace.empty")}
          </DropdownMenuLabel>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="rounded-none text-xs" onSelect={onManage}>
          {t("workspace.manage")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("workspace.panels")}
        </DropdownMenuLabel>
        {PANEL_IDS.map((panel) => (
          <DropdownMenuCheckboxItem
            key={panel}
            className="rounded-none text-xs"
            checked={!layout.hidden.includes(panel)}
            onCheckedChange={(checked) => onTogglePanel(panel, checked)}
            onSelect={(event) => event.preventDefault()}
          >
            {t(PANEL_TITLE_KEYS[panel])}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="rounded-none text-xs" onSelect={onReset}>
          {t("workspace.reset")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function WorkspacePresetsDialog({
  open,
  onClose,
  layout,
  onApply
}: {
  open: boolean;
  onClose: () => void;
  layout: DockLayout;
  onApply: (layout: DockLayout) => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const { prefs, update } = usePrefs();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<WorkspaceIcon>("layout");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const presets = Object.values(prefs.workspaces ?? {}).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 60) {
      return;
    }
    const windows = { ...layout.windows };
    for (const panel of layout.detached) {
      const bounds = await panelWindowBounds(panel);
      if (bounds) {
        windows[panel] = bounds;
      }
    }
    const id = newPresetId();
    const preset: WorkspacePreset = {
      id,
      name: trimmed,
      icon,
      layout: { ...cloneLayout(layout), windows }
    };
    await update({ workspaces: { ...prefs.workspaces, [id]: preset } });
    setName("");
    toast.success(t("workspace.saved"));
  };

  const commitRename = async (preset: WorkspacePreset) => {
    const trimmed = draft.trim();
    setRenaming(null);
    if (!trimmed || trimmed.length > 60 || trimmed === preset.name) {
      return;
    }
    await update({
      workspaces: {
        ...prefs.workspaces,
        [preset.id]: { ...preset, name: trimmed }
      }
    });
    toast.success(t("workspace.renamed"));
  };

  const remove = async (preset: WorkspacePreset) => {
    const accepted = await confirm({
      title: t("workspace.delete"),
      description: preset.name,
      confirmLabel: t("editor.delete"),
      cancelLabel: t("editor.cancel"),
      destructive: true
    });
    if (!accepted) {
      return;
    }
    const next = { ...prefs.workspaces };
    delete next[preset.id];
    await update({ workspaces: next });
    toast.success(t("workspace.deleted"));
  };

  const exportPreset = (preset: WorkspacePreset) => {
    const blob = new Blob([serializePreset(preset)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "stickmate-workspace.json";
    link.click();
    URL.revokeObjectURL(url);
    toast.success(t("workspace.exported"));
  };

  const importFile = (file: File) => {
    if (file.size > MAX_PRESET_BYTES) {
      toast.error(t("workspace.error.size"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast.error(t("workspace.error.read"));
    reader.onload = () => {
      const result = parsePresetFile(String(reader.result));
      if (!result.ok) {
        toast.error(
          result.detail ? `${t(result.error)} ${result.detail}` : t(result.error)
        );
        return;
      }
      const id = newPresetId();
      const preset: WorkspacePreset = {
        id,
        name: result.name,
        icon: result.icon,
        layout: result.layout
      };
      void update({ workspaces: { ...prefs.workspaces, [id]: preset } }).then(() =>
        toast.success(t("workspace.imported"))
      );
    };
    reader.readAsText(file);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setRenaming(null);
          onClose();
        }
      }}
    >
      <DialogContent
        className="max-w-lg gap-3 sm:rounded-none"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{t("workspace.title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Input
            value={name}
            aria-label={t("workspace.name")}
            placeholder={t("workspace.name")}
            onChange={(event) => setName(event.target.value)}
            className="rounded-none"
          />
          <div className="flex items-center gap-1">
            {WORKSPACE_ICONS.map((id) => {
              const Icon = WORKSPACE_ICON_COMPONENTS[id];
              return (
                <button
                  key={id}
                  type="button"
                  aria-label={t(`workspace.icon.${id}`)}
                  aria-pressed={icon === id}
                  onClick={() => setIcon(id)}
                  className={cn(
                    iconButton,
                    icon === id && "border-border bg-accent text-accent-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
            <div className="flex-1" />
            <Button
              size="sm"
              className="rounded-none"
              disabled={name.trim() === ""}
              onClick={() => void save()}
            >
              {t("workspace.save")}
            </Button>
          </div>
        </div>
        <ScrollArea className="h-64 border border-border">
          {presets.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("workspace.empty")}
            </p>
          )}
          {presets.map((preset) => {
            const Icon = WORKSPACE_ICON_COMPONENTS[preset.icon] ?? LayoutGrid;
            return (
              <div
                key={preset.id}
                className="flex items-center gap-2 border-b border-border px-2 py-1.5"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                {renaming === preset.id ? (
                  <input
                    autoFocus
                    value={draft}
                    aria-label={t("workspace.rename")}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => void commitRename(preset)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void commitRename(preset);
                      }
                      if (event.key === "Escape") {
                        setRenaming(null);
                      }
                    }}
                    className="h-7 w-full min-w-0 border border-ring bg-background px-1 text-xs outline-none"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {preset.name}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`${t("workspace.apply")} ${preset.name}`}
                  onClick={() => {
                    onApply(preset.layout);
                    toast.success(t("workspace.applied"));
                    onClose();
                  }}
                  className="h-7 shrink-0 border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  {t("workspace.apply")}
                </button>
                <button
                  type="button"
                  aria-label={`${t("workspace.rename")} ${preset.name}`}
                  title={t("workspace.rename")}
                  onClick={() => {
                    setRenaming(preset.id);
                    setDraft(preset.name);
                  }}
                  className={iconButton}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`${t("workspace.export")} ${preset.name}`}
                  title={t("workspace.export")}
                  onClick={() => exportPreset(preset)}
                  className={iconButton}
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`${t("editor.delete")} ${preset.name}`}
                  title={t("editor.delete")}
                  onClick={() => void remove(preset)}
                  className={cn(iconButton, "hover:text-destructive")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </ScrollArea>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          data-testid="workspace-preset-file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) {
              importFile(file);
            }
          }}
        />
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button
            variant="outline"
            size="sm"
            className="rounded-none"
            onClick={() => fileRef.current?.click()}
          >
            {t("workspace.import")}
          </Button>
          <Button size="sm" className="rounded-none" onClick={onClose}>
            {t("workspace.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}