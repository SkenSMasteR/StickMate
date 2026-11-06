import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ThemeProvider, useTheme } from "next-themes";
import Main from "@/app/App";
import { Toaster } from "@/components/ui/sonner";
import { I18nProvider } from "@/i18n";
import type { Language } from "@/i18n";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import Splash from "@/splash/Splash";

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

function ThemeSync() {
  const { prefs } = usePrefs();
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme(prefs.theme);
  }, [prefs.theme, setTheme]);

  return null;
}

function Routed() {
  if (windowLabel() === "splash") {
    return <Splash />;
  }
  return <MainWithI18n />;
}

function MainWithI18n() {
  const { prefs, update } = usePrefs();
  return (
    <I18nProvider
      language={prefs.language}
      onLanguageChange={(language: Language) => {
        void update({ language });
      }}
    >
      <Main />
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