import { createContext, useCallback, useContext } from "react";
import type { ReactNode } from "react";
import en from "./en.json";
import mk from "./mk.json";

export type Language = "en" | "mk";

const catalogs: Record<Language, Record<string, string>> = { en, mk };

interface I18nValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  language,
  onLanguageChange,
  children
}: {
  language: Language;
  onLanguageChange: (language: Language) => void;
  children: ReactNode;
}) {
  const setLanguage = useCallback(
    (next: Language) => {
      onLanguageChange(next);
    },
    [onLanguageChange]
  );

  const t = useCallback(
    (key: string) => {
      const catalog = catalogs[language];
      return catalog[key] ?? catalogs.en[key] ?? key;
    },
    [language]
  );

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return context;
}
