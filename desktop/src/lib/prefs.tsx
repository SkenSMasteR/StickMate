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
import { prefsGet, prefsPut } from "@/lib/tauri";
import type { ThemeName } from "@/theme";
import type { Language } from "@/i18n";

export type UpdateChannel = "stable" | "nightly";

export interface PrefsData {
  language: Language;
  theme: ThemeName;
  channel: UpdateChannel;
  login: string | null;
}

const defaultPrefs: PrefsData = {
  language: "en",
  theme: "dark",
  channel: "stable",
  login: null
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

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<PrefsData>(defaultPrefs);
  const [loaded, setLoaded] = useState(false);
  const [baseRevision, setBaseRevision] = useState(0);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

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
      setBaseRevision(revision);
      setPrefs({ ...defaultPrefs, ...data });
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
      setPrefs(event.payload.data);
      setBaseRevision(event.payload.revision);
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

  const update = useCallback(
    async (patch: Partial<PrefsData>) => {
      const next = { ...prefsRef.current, ...patch };
      setPrefs(next);
      let revision = baseRevision;
      try {
        const result = await prefsPut(
          baseRevision,
          next as unknown as Record<string, unknown>
        );
        revision = result.revision;
        setBaseRevision(revision);
      } catch {
        localStorage.setItem(
          fallbackKey,
          JSON.stringify({ base_revision: baseRevision, data: next })
        );
      }
      const payload: PrefsBroadcast = { revision, data: next };
      void emit(PREFS_EVENT, payload);
    },
    [baseRevision]
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
