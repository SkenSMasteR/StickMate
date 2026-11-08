import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { formatCombo } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import type { Command, CommandArg, CommandArgs } from "./commands";

const listId = "command-palette-list";

function initialValues(args: CommandArg[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const arg of args) {
    values[arg.name] = String(arg.initial);
  }
  return values;
}

export default function CommandPalette({
  open,
  commands,
  initialCommand,
  onClose
}: {
  open: boolean;
  commands: Command[];
  initialCommand?: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [form, setForm] = useState<Command | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setActive(0);
    setError(null);
    const target = initialCommand
      ? commands.find((item) => item.id === initialCommand) ?? null
      : null;
    if (target && target.args && target.runArgs && !target.disabled) {
      setForm(target);
      setValues(initialValues(target.args));
    } else {
      setForm(null);
    }
  }, [open, initialCommand]);

  const search = query.trim().toLowerCase();
  const matches = commands.filter(
    (item) =>
      search === "" ||
      item.label.toLowerCase().includes(search) ||
      item.id.toLowerCase().includes(search)
  );
  const visible =
    search === ""
      ? matches
      : [
          ...matches.filter(
            (item) =>
              item.label.toLowerCase().startsWith(search) ||
              item.id.toLowerCase().startsWith(search)
          ),
          ...matches.filter(
            (item) =>
              !item.label.toLowerCase().startsWith(search) &&
              !item.id.toLowerCase().startsWith(search)
          )
        ];

  useEffect(() => {
    if (form) {
      return;
    }
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, form]);

  const choose = (command: Command) => {
    if (command.disabled) {
      return;
    }
    if (command.args && command.runArgs) {
      setForm(command);
      setValues(initialValues(command.args));
      setError(null);
      return;
    }
    onClose();
    command.run();
  };

  const back = () => {
    setForm(null);
    setError(null);
  };

  const submit = () => {
    if (!form || !form.args || !form.runArgs) {
      return;
    }
    const typed: CommandArgs = {};
    for (const arg of form.args) {
      const raw = values[arg.name] ?? "";
      if (arg.kind === "text") {
        if (!arg.allowEmpty && raw.trim() === "") {
          setError(`${arg.label}: ${t("palette.error.required")}`);
          return;
        }
        typed[arg.name] = raw;
      } else if (arg.kind === "int") {
        const value = Number(raw);
        if (
          raw.trim() === "" ||
          !Number.isInteger(value) ||
          (arg.min !== undefined && value < arg.min) ||
          (arg.max !== undefined && value > arg.max)
        ) {
          setError(`${arg.label}: ${t("palette.error.range")}`);
          return;
        }
        typed[arg.name] = value;
      } else {
        if (!(arg.options ?? []).some((option) => option.value === raw)) {
          setError(`${arg.label}: ${t("palette.error.required")}`);
          return;
        }
        typed[arg.name] = raw;
      }
    }
    const command = form;
    setError(null);
    setForm(null);
    onClose();
    command.runArgs?.(typed);
  };

  const fieldClass =
    "h-8 w-full rounded-none border border-border bg-background px-2 text-xs outline-none focus:border-ring";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogContent
        className="max-w-lg gap-3 sm:rounded-none"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (form) {
            event.preventDefault();
            back();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">
            {form ? form.label : t("palette.title")}
          </DialogTitle>
        </DialogHeader>
        {form && form.args ? (
          <form
            className="flex flex-col gap-3"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {form.args.map((arg, index) => (
              <label key={arg.name} className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">{arg.label}</span>
                {arg.kind === "choice" ? (
                  <select
                    aria-label={arg.label}
                    value={values[arg.name] ?? ""}
                    autoFocus={index === 0}
                    onChange={(event) =>
                      setValues((prev) => ({ ...prev, [arg.name]: event.target.value }))
                    }
                    className={fieldClass}
                  >
                    {(arg.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={arg.kind === "int" ? "number" : "text"}
                    aria-label={arg.label}
                    value={values[arg.name] ?? ""}
                    min={arg.min}
                    max={arg.max}
                    step={arg.step}
                    autoFocus={index === 0}
                    onChange={(event) =>
                      setValues((prev) => ({ ...prev, [arg.name]: event.target.value }))
                    }
                    className="rounded-none"
                  />
                )}
              </label>
            ))}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <DialogFooter className="gap-2 sm:space-x-0">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-none"
                onClick={back}
              >
                {t("palette.back")}
              </Button>
              <Button type="submit" size="sm" className="rounded-none">
                {t("palette.run")}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <Input
              role="combobox"
              aria-label={t("palette.search")}
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                visible.length > 0 ? `${listId}-option-${active}` : undefined
              }
              placeholder={t("palette.search")}
              value={query}
              autoFocus
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((current) =>
                    visible.length === 0 ? 0 : Math.min(current + 1, visible.length - 1)
                  );
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((current) => Math.max(current - 1, 0));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const command = visible[active];
                  if (command) {
                    choose(command);
                  }
                }
              }}
              className="rounded-none"
            />
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={t("palette.title")}
              className="h-80 overflow-y-auto border border-border"
            >
              {visible.map((command, index) => (
                <div
                  key={command.id}
                  id={`${listId}-option-${index}`}
                  role="option"
                  data-index={index}
                  aria-selected={index === active}
                  aria-disabled={command.disabled || undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setActive(index);
                    choose(command);
                  }}
                  className={cn(
                    "flex items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-xs",
                    index === active
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent hover:text-accent-foreground",
                    command.disabled && "pointer-events-none opacity-40"
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{command.label}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {command.keys ? formatCombo(command.keys) : t("shortcuts.unbound")}
                  </span>
                </div>
              ))}
              {visible.length === 0 && (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  {t("palette.empty")}
                </p>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}