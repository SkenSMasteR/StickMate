import { getCurrentWindow } from "@tauri-apps/api/window";
import Main from "@/app/App";
import { I18nProvider } from "@/i18n";
import type { Language } from "@/i18n";
import { PrefsProvider, usePrefs } from "@/lib/prefs";
import { ToastProvider } from "@/lib/toast";
import Splash from "@/splash/Splash";

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
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
    <ToastProvider>
      <PrefsProvider>
        <Routed />
      </PrefsProvider>
    </ToastProvider>
  );
}
