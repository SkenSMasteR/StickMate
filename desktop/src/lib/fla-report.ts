import { useSyncExternalStore } from "react";

export type FlaReportKind = "import" | "export";

export interface FlaReportEntry {
  id: string;
  kind: FlaReportKind;
  name: string;
  at: number;
  lines: string[];
}

export const REPORT_LIMIT = 20;

const storageKey = "stickmate.fla.report";

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sane(value: unknown): FlaReportEntry | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const kind = raw.kind === "import" || raw.kind === "export" ? raw.kind : null;
  const name = text(raw.name);
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : null;
  if (!kind || name === null || at === null) {
    return null;
  }
  const lines = Array.isArray(raw.lines)
    ? raw.lines.filter((line): line is string => typeof line === "string")
    : [];
  return { id: text(raw.id) ?? `r${at}`, kind, name, at, lines };
}

function load(): FlaReportEntry[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(sane)
      .filter((entry): entry is FlaReportEntry => entry !== null)
      .slice(0, REPORT_LIMIT);
  } catch {
    return [];
  }
}

let entries: FlaReportEntry[] = load();
const listeners = new Set<() => void>();

function persist(): void {
  localStorage.setItem(storageKey, JSON.stringify(entries));
}

function publish(next: FlaReportEntry[]): void {
  entries = next;
  persist();
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFlaReport(): FlaReportEntry[] {
  return entries;
}

export function useFlaReport(): FlaReportEntry[] {
  return useSyncExternalStore(subscribe, getFlaReport, getFlaReport);
}

export function recordFlaReport(
  kind: FlaReportKind,
  name: string,
  lines: string[]
): FlaReportEntry | null {
  if (lines.length === 0) {
    return null;
  }
  const entry: FlaReportEntry = {
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    kind,
    name,
    at: Date.now(),
    lines: [...lines]
  };
  publish([entry, ...entries].slice(0, REPORT_LIMIT));
  return entry;
}

export function clearFlaReport(): void {
  publish([]);
}

export function flaReportText(list: FlaReportEntry[]): string {
  return list
    .map((entry) =>
      [
        `${entry.kind === "import" ? "Import" : "Export"} ${entry.name}`,
        ...entry.lines.map((line) => `- ${line}`)
      ].join("\n")
    )
    .join("\n\n");
}

export function flaReportLine(line: string): { count: string | null; text: string } {
  const found = /^(\d[\d,.]*)\s(.*)$/s.exec(line);
  if (!found) {
    return { count: null, text: line };
  }
  return { count: found[1], text: found[2] };
}
