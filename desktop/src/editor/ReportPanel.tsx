import { ClipboardCopy, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import {
  clearFlaReport,
  flaReportLine,
  flaReportText,
  useFlaReport
} from "@/lib/fla-report";
import type { FlaReportEntry } from "@/lib/fla-report";

function when(at: number, language: string): string {
  try {
    return new Date(at).toLocaleString(language === "mk" ? "mk-MK" : "en-US");
  } catch {
    return new Date(at).toISOString();
  }
}

function Entry({ entry }: { entry: FlaReportEntry }) {
  const { t, language } = useI18n();
  return (
    <li className="flex flex-col gap-1 border-b border-border px-2 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          {t(`report.kind.${entry.kind}`)}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {when(entry.at, language)}
        </span>
      </div>
      <span className="truncate text-xs font-medium" title={entry.name}>
        {entry.name}
      </span>
      <ol className="flex flex-col">
        {entry.lines.map((line, index) => {
          const parts = flaReportLine(line);
          return (
            <li key={index} className="flex items-start gap-2 py-0.5 text-xs">
              {parts.count !== null && (
                <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                  {parts.count}
                </span>
              )}
              <span className="min-w-0 flex-1 leading-snug">{parts.text}</span>
            </li>
          );
        })}
      </ol>
    </li>
  );
}

export default function ReportPanel() {
  const { t } = useI18n();
  const entries = useFlaReport();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(flaReportText(entries));
      toast.success(t("report.copied"));
    } catch {
      toast.error(t("report.copyFailed"));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <h2 className="min-w-0 flex-1 truncate text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("report.entries")} · {entries.length}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={entries.length === 0}
          aria-label={t("report.copy")}
          title={t("report.copy")}
          onClick={() => void copy()}
        >
          <ClipboardCopy className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={entries.length === 0}
          aria-label={t("report.clear")}
          title={t("report.clear")}
          onClick={() => clearFlaReport()}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </header>
      {entries.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">{t("report.empty")}</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {entries.map((entry) => (
            <Entry key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}
