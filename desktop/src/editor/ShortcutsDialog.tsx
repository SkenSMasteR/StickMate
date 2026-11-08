import { useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import { useConfirm } from "@/lib/confirm";
import {
  comboFromEvent,
  conflictsFor,
  formatCombo,
  validateProfile
} from "@/lib/shortcuts";
import type { ShortcutOverrides } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import type { Command } from "./commands";

const groups = ["tool", "playback", "edit", "frame", "view", "layer", "scene", "project"];

const maxProfileBytes = 65536;

const iconButton =
  "flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40";

interface Pending {
  id: string;
  combo: string;
  others: string[];
}

export default function ShortcutsDialog({
  open,
  commands,
  overrides,
  onChange,
  onClose
}: {
  open: boolean;
  commands: Command[];
  overrides: ShortcutOverrides;
  onChange: (next: ShortcutOverrides) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [capturing, setCapturing] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const search = query.trim().toLowerCase();
  const visible = commands.filter(
    (item) =>
      search === "" ||
      item.label.toLowerCase().includes(search) ||
      (item.keys ?? "").includes(search)
  );

  const stop = () => {
    setCapturing(null);
    setPending(null);
  };

  const importProfile = (file: File) => {
    if (file.size > maxProfileBytes) {
      toast.error(t("shortcuts.error.size"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast.error(t("shortcuts.error.read"));
    reader.onload = () => {
      const result = validateProfile(
        String(reader.result),
        commands.map((item) => ({ id: item.id, keys: item.defaultKeys }))
      );
      if (!result.ok) {
        toast.error(
          result.detail ? `${t(result.error)} ${result.detail}` : t(result.error)
        );
        return;
      }
      stop();
      onChange(result.overrides);
      toast.success(t("shortcuts.imported"));
    };
    reader.readAsText(file);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          stop();
          onClose();
        }
      }}
    >
      <DialogContent
        className="max-w-2xl gap-3 sm:rounded-none"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
        </DialogHeader>
        <Input
          value={query}
          aria-label={t("shortcuts.search")}
          placeholder={t("shortcuts.search")}
          onChange={(event) => setQuery(event.target.value)}
          className="rounded-none"
        />
        <ScrollArea className="h-96 border border-border">
          {groups.map((group) => {
            const rows = visible.filter((item) => item.id.startsWith(`${group}.`));
            if (rows.length === 0) {
              return null;
            }
            return (
              <section key={group}>
                <h3 className="border-b border-border bg-muted px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t(`shortcuts.group.${group}`)}
                </h3>
                {rows.map((command) => (
                  <div key={command.id} className="border-b border-border">
                    <div className="flex items-center gap-2 px-2 py-1">
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {command.label}
                      </span>
                      <button
                        type="button"
                        aria-label={command.label}
                        onClick={(event) => {
                          event.currentTarget.focus();
                          setCapturing(command.id);
                          setPending(null);
                        }}
                        onBlur={() => setCapturing(null)}
                        onKeyDown={(event) => {
                          if (capturing !== command.id) {
                            return;
                          }
                          event.preventDefault();
                          event.stopPropagation();
                          if (event.key === "Escape") {
                            setCapturing(null);
                            return;
                          }
                          const combo = comboFromEvent(event.nativeEvent);
                          if (combo === null) {
                            return;
                          }
                          setCapturing(null);
                          const others = conflictsFor(commands, combo, command.id);
                          if (others.length > 0) {
                            setPending({ id: command.id, combo, others });
                            return;
                          }
                          setPending(null);
                          onChange({ ...overrides, [command.id]: combo });
                        }}
                        className={cn(
                          "h-7 w-36 shrink-0 border px-2 text-xs",
                          capturing === command.id
                            ? "border-ring bg-accent text-accent-foreground"
                            : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                        )}
                      >
                        {capturing === command.id
                          ? t("shortcuts.recording")
                          : command.keys
                            ? formatCombo(command.keys)
                            : t("shortcuts.unbound")}
                      </button>
                      <button
                        type="button"
                        title={`${t("shortcuts.clear")} ${command.label}`}
                        aria-label={`${t("shortcuts.clear")} ${command.label}`}
                        disabled={overrides[command.id] === null}
                        onClick={() => {
                          stop();
                          onChange({ ...overrides, [command.id]: null });
                        }}
                        className={iconButton}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title={`${t("shortcuts.reset")} ${command.label}`}
                        aria-label={`${t("shortcuts.reset")} ${command.label}`}
                        disabled={overrides[command.id] === undefined}
                        onClick={() => {
                          const next = { ...overrides };
                          delete next[command.id];
                          stop();
                          onChange(next);
                        }}
                        className={iconButton}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {pending && pending.id === command.id && (
                      <div className="flex items-center gap-2 px-2 pb-2">
                        <span className="min-w-0 flex-1 text-xs text-destructive">
                          {formatCombo(pending.combo)} {t("shortcuts.usedBy")}{" "}
                          {pending.others
                            .map(
                              (id) =>
                                commands.find((item) => item.id === id)?.label ?? id
                            )
                            .join(", ")}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-none"
                          onClick={() => {
                            const next = {
                              ...overrides,
                              [pending.id]: pending.combo
                            };
                            for (const id of pending.others) {
                              next[id] = null;
                            }
                            setPending(null);
                            onChange(next);
                          }}
                        >
                          {t("shortcuts.reassign")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="rounded-none"
                          onClick={() => setPending(null)}
                        >
                          {t("editor.cancel")}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </section>
            );
          })}
          {visible.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("shortcuts.empty")}
            </p>
          )}
        </ScrollArea>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          data-testid="shortcut-profile-file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) {
              importProfile(file);
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
            {t("shortcuts.import")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-none"
            onClick={() => {
              const blob = new Blob(
                [JSON.stringify({ version: 1, overrides }, null, 2)],
                { type: "application/json" }
              );
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = "stickmate-shortcuts.json";
              link.click();
              URL.revokeObjectURL(url);
              toast.success(t("shortcuts.exported"));
            }}
          >
            {t("shortcuts.export")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-none"
            disabled={Object.keys(overrides).length === 0}
            onClick={() => {
              void confirm({
                title: t("shortcuts.resetAllTitle"),
                confirmLabel: t("shortcuts.reset"),
                cancelLabel: t("editor.cancel"),
                destructive: true
              }).then((accepted) => {
                if (accepted) {
                  stop();
                  onChange({});
                }
              });
            }}
          >
            {t("shortcuts.resetAll")}
          </Button>
          <Button size="sm" className="rounded-none" onClick={onClose}>
            {t("shortcuts.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}