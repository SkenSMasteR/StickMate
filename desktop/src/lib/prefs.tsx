import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from "react";
import type { ReactNode } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { prefsGet, prefsPut, setUpdateChannel } from "@/lib/tauri";
import type { ShortcutOverrides } from "@/lib/shortcuts";
import type { ThemeName } from "@/theme";
import type { Language } from "@/i18n";
import en from "@/i18n/en.json";
import mk from "@/i18n/mk.json";

export type UpdateChannel = "stable" | "nightly";

export interface PrefsData {
  language: Language;
  theme: ThemeName;
  channel: UpdateChannel;
  login: string | null;
  shortcuts: ShortcutOverrides;
}

const defaultPrefs: PrefsData = {
  language: "en",
  theme: "dark",
  channel: "stable",
  login: null,
  shortcuts: {}
};

const fallbackKey = "stickmate.prefs";

const PREFS_EVENT = "prefs-changed";

interface PrefsBroadcast {
  revision: number;
  data: PrefsData;
}

interface PrefsValue {
  prefs: PrefsData;
  loaded: boolean;
  update: (patch: Partial<PrefsData>) => Promise<void>;
}

const PrefsContext = createContext<PrefsValue | null>(null);

type PrefsRecord = Record<string, unknown>;

function asRecord(data: PrefsData): PrefsRecord {
  return data as unknown as PrefsRecord;
}

type PrefsKey = "prefs.conflict" | "prefs.keepMine" | "prefs.useTheirs";

function text(language: Language, key: PrefsKey): string {
  const catalog = language === "mk" ? mk : en;
  return catalog[key];
}

function readFallback(): { base_revision: number; data: Partial<PrefsData> } {
  try {
    const raw = localStorage.getItem(fallbackKey);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        base_revision?: number;
        data?: Partial<PrefsData>;
      };
      return {
        base_revision: parsed.base_revision ?? 0,
        data: parsed.data ?? {}
      };
    }
  } catch {
    return { base_revision: 0, data: {} };
  }
  return { base_revision: 0, data: {} };
}

function saveFallback(revision: number, data: PrefsData): void {
  localStorage.setItem(
    fallbackKey,
    JSON.stringify({ base_revision: revision, data })
  );
}

function mergeShortcuts(
  ours: ShortcutOverrides,
  theirs: ShortcutOverrides,
  base: ShortcutOverrides
): { data: ShortcutOverrides; contested: boolean } {
  const merged: ShortcutOverrides = { ...ours };
  let contested = false;
  const ids = new Set([
    ...Object.keys(ours),
    ...Object.keys(theirs),
    ...Object.keys(base)
  ]);
  for (const id of ids) {
    const a = ours[id];
    const b = theirs[id];
    const start = base[id];
    if (a === b) {
      continue;
    }
    if (a === start) {
      if (b === undefined) {
        delete merged[id];
      } else {
        merged[id] = b;
      }
    } else if (b !== start) {
      contested = true;
    }
  }
  return { data: merged, contested };
}

function mergePrefs(
  ours: PrefsData,
  theirs: PrefsData,
  base: PrefsData
): { data: PrefsData; contested: boolean } {
  const mine = asRecord(ours);
  const other = asRecord(theirs);
  const origin = asRecord(base);
  const merged: PrefsRecord = { ...mine };
  let contested = false;
  for (const key of Object.keys(defaultPrefs)) {
    if (key === "shortcuts") {
      const part = mergeShortcuts(ours.shortcuts, theirs.shortcuts, base.shortcuts);
      merged.shortcuts = part.data;
      contested = contested || part.contested;
      continue;
    }
    const a = JSON.stringify(mine[key]);
    const b = JSON.stringify(other[key]);
    const start = JSON.stringify(origin[key]);
    if (a === b) {
      continue;
    }
    if (a === start) {
      merged[key] = other[key];
    } else if (b !== start) {
      contested = true;
    }
  }
  return { data: merged as unknown as PrefsData, contested };
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<PrefsData>(defaultPrefs);
  const [loaded, setLoaded] = useState(false);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const baseRef = useRef<{ revision: number; data: PrefsData }>({
    revision: 0,
    data: defaultPrefs
  });

  const commit = useCallback((revision: number, data: PrefsData) => {
    baseRef.current = { revision, data };
    setPrefs(data);
    const payload: PrefsBroadcast = { revision, data };
    void emit(PREFS_EVENT, payload);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      let revision = 0;
      let data: Partial<PrefsData> = {};
      try {
        const envelope = await prefsGet();
        revision = envelope.revision;
        if (envelope.data && typeof envelope.data === "object") {
          data = envelope.data as Partial<PrefsData>;
        }
      } catch {
        const fallback = readFallback();
        revision = fallback.base_revision;
        data = fallback.data;
      }
      if (cancelled) {
        return;
      }
      const merged = { ...defaultPrefs, ...data };
      baseRef.current = { revision, data: merged };
      setPrefs(merged);
      setLoaded(true);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    void listen<PrefsBroadcast>(PREFS_EVENT, (event) => {
      baseRef.current = {
        revision: event.payload.revision,
        data: event.payload.data
      };
      setPrefs(event.payload.data);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!loaded) {
      return;
    }
    setUpdateChannel(prefs.channel).catch((error) => {
      toast.error(String(error));
    });
  }, [loaded, prefs.channel]);

  const push = useCallback(
    async (revision: number, data: PrefsData) => {
      try {
        const result = await prefsPut(revision, asRecord(data));
        if (result.conflict) {
          baseRef.current = { revision: result.revision, data };
          setPrefs(data);
          toast.error(text(data.language, "prefs.conflict"));
          return;
        }
        commit(result.revision, data);
      } catch {
        saveFallback(revision, data);
        setPrefs(data);
        const payload: PrefsBroadcast = { revision, data };
        void emit(PREFS_EVENT, payload);
      }
    },
    [commit]
  );

  const offerChoice = useCallback(
    (language: Language, ours: PrefsData, theirs: PrefsData, revision: number) => {
      toast.warning(text(language, "prefs.conflict"), {
        id: "prefs-conflict",
        duration: Infinity,
        action: {
          label: text(language, "prefs.keepMine"),
          onClick: () => {
            void push(revision, ours);
          }
        },
        cancel: {
          label: text(language, "prefs.useTheirs"),
          onClick: () => {
            void push(revision, theirs);
          }
        }
      });
    },
    [push]
  );

  const update = useCallback(
    async (patch: Partial<PrefsData>) => {
      const next = { ...prefsRef.current, ...patch };
      setPrefs(next);
      const base = baseRef.current;
      let result;
      try {
        result = await prefsPut(base.revision, asRecord(next));
      } catch {
        saveFallback(base.revision, next);
        const payload: PrefsBroadcast = { revision: base.revision, data: next };
        void emit(PREFS_EVENT, payload);
        return;
      }
      if (!result.conflict) {
        commit(result.revision, next);
        return;
      }
      let remote;
      try {
        remote = await prefsGet();
      } catch {
        saveFallback(base.revision, next);
        return;
      }
      const theirs: PrefsData = {
        ...defaultPrefs,
        ...(remote.data as Partial<PrefsData>)
      };
      const merged = mergePrefs(next, theirs, base.data);
      if (!merged.contested) {
        await push(remote.revision, merged.data);
        return;
      }
      baseRef.current = { revision: remote.revision, data: theirs };
      setPrefs(merged.data);
      offerChoice(next.language, merged.data, theirs, remote.revision);
    },
    [commit, offerChoice, push]
  );

  return (
    <PrefsContext.Provider value={{ prefs, loaded, update }}>
      {children}
    </PrefsContext.Provider>
  );
}

export function usePrefs(): PrefsValue {
  const context = useContext(PrefsContext);
  if (!context) {
    throw new Error("usePrefs must be used inside PrefsProvider");
  }
  return context;
}