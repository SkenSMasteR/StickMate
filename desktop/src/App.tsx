import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ThemeProvider, useTheme } from "next-themes";
import Main from "@/app/App";
import { Toaster } from "@/components/ui/sonner";
import EditorWindow from "@/editor/EditorWindow";
import { WorkspaceProvider } from "@/editor/workspace";
import { I18nProvider } from "@/i18n";
import type { Language } from "@/i18n";
import { ConfirmProvider } from "@/lib/confirm";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import Splash from "@/splash/Splash";
import type { ThemeName } from "@/theme";

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

function ThemeSync() {
  const { prefs, loaded } = usePrefs();
  const { setTheme } = useTheme();
  const applied = useRef<ThemeName | null>(null);

  useEffect(() => {
    if (!loaded || applied.current === prefs.theme) {
      return;
    }
    applied.current = prefs.theme;
    setTheme(prefs.theme);
  }, [loaded, prefs.theme, setTheme]);

  return null;
}

function Routed() {
  const label = windowLabel();
  if (label === "splash") {
    return <Splash />;
  }
  if (label === "editor") {
    return (
      <AppProviders>
        <EditorWindow />
      </AppProviders>
    );
  }
  return (
    <AppProviders>
      <Main />
    </AppProviders>
  );
}

function AppProviders({ children }: { children: ReactNode }) {
  const { prefs, update } = usePrefs();
  return (
    <I18nProvider
      language={prefs.language}
      onLanguageChange={(language: Language) => {
        void update({ language });
      }}
    >
      <ConfirmProvider>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </ConfirmProvider>
    </I18nProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      <PrefsProvider>
        <ThemeSync />
        <Routed />
      </PrefsProvider>
      <Toaster />
    </ThemeProvider>
  );
}