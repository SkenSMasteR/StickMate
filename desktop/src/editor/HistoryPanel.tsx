import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import { useConfirm } from "@/lib/confirm";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  docCheckpointDelete,
  docCheckpointList,
  docCheckpointRestore,
  docCheckpointSave,
  docHistory,
  docHistoryJump
} from "@/lib/history";
import type { CheckpointInfo, HistoryStep } from "@/lib/history";
import { useWorkspace } from "./workspace";

function message(cause: unknown): string {
  if (typeof cause === "string") {
    return cause;
  }
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString();
}

export default function HistoryPanel() {
  const { t } = useI18n();
  const confirm = useConfirm();
  const { doc, open } = useWorkspace();
  const [steps, setSteps] = useState<HistoryStep[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const docId = doc?.id ?? null;

  const refresh = useCallback(async () => {
    if (!docId) {
      setSteps([]);
      setCheckpoints([]);
      return;
    }
    try {
      const [nextSteps, nextCheckpoints] = await Promise.all([
        docHistory(docId),
        docCheckpointList(docId)
      ]);
      setSteps(nextSteps);
      setCheckpoints(nextCheckpoints);
    } catch (cause) {
      setError(message(cause));
    }
  }, [docId]);

  useEffect(() => {
    void refresh();
  }, [refresh, doc]);

  const jump = async (index: number) => {
    if (!docId || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await docHistoryJump(docId, index);
      await open(docId);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!docId || busy || name.trim().length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await docCheckpointSave(docId, name);
      setName("");
      await refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (checkpoint: CheckpointInfo) => {
    if (!docId || busy) {
      return;
    }
    const accepted = await confirm({
      title: t("history.restoreTitle"),
      description: checkpoint.name,
      confirmLabel: t("history.restore"),
      cancelLabel: t("editor.cancel"),
      destructive: true
    });
    if (!accepted) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await docCheckpointRestore(docId, checkpoint.id);
      await open(docId);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (checkpoint: CheckpointInfo) => {
    if (!docId || busy) {
      return;
    }
    const accepted = await confirm({
      title: t("history.deleteTitle"),
      description: checkpoint.name,
      confirmLabel: t("history.delete"),
      cancelLabel: t("editor.cancel"),
      destructive: true
    });
    if (!accepted) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await docCheckpointDelete(docId, checkpoint.id);
      await refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!doc) {
    return null;
  }

  return (
    <div className="flex flex-col">
      <section className="border-b border-border">
        <header className="flex h-8 items-center px-2">
          <h2 className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("history.title")}
          </h2>
        </header>
        <div className="max-h-48 overflow-y-auto px-2 pb-3">
          <ol className="flex flex-col">
            {steps.map((step) => {
              const current = step.kind === "current";
              return (
                <li key={step.index}>
                  <button
                    type="button"
                    disabled={busy}
                    aria-current={current ? "step" : undefined}
                    aria-label={t(`history.step.${step.name}`)}
                    onClick={() => void jump(step.index)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 border border-border px-2 py-1 text-left text-xs",
                      current
                        ? "bg-accent text-accent-foreground"
                        : "bg-transparent hover:bg-accent",
                      busy && "cursor-not-allowed opacity-50"
                    )}
                  >
                    <span className="truncate">
                      {t(`history.step.${step.name}`)}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {current ? t("history.current") : clock(step.at)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </section>
      <section className="border-b border-border">
        <header className="flex h-8 items-center px-2">
          <h2 className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("history.checkpoints")}
          </h2>
        </header>
        <div className="flex flex-col gap-2 px-2 pb-3">
          <div className="flex items-center gap-2">
            <Input
              value={name}
              maxLength={64}
              placeholder={t("history.checkpointName")}
              aria-label={t("history.checkpointName")}
              onChange={(event) => setName(event.target.value)}
              className="h-7 rounded-none border-border px-1 text-xs shadow-none focus-visible:ring-0"
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy || name.trim().length === 0}
              onClick={() => void save()}
              className="h-7 shrink-0 rounded-none px-2 text-xs"
            >
              {t("history.save")}
            </Button>
          </div>
          {checkpoints.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("history.none")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {checkpoints.map((checkpoint) => (
                <li
                  key={checkpoint.id}
                  className="flex items-center justify-between gap-2 border border-border px-2 py-1"
                >
                  <span className="truncate text-xs">{checkpoint.name}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void restore(checkpoint)}
                      className="h-6 rounded-none px-1 text-[10px]"
                    >
                      {t("history.restore")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void remove(checkpoint)}
                      className="h-6 rounded-none px-1 text-[10px] text-destructive"
                    >
                      {t("history.delete")}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}