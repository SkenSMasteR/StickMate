import { MK, US } from "country-flag-icons/react/3x2";
import type { Language } from "@/i18n";
import { cn } from "@/lib/utils";

const flags: Record<Language, typeof US> = {
  en: US,
  mk: MK
};

export function LanguageFlag({
  language,
  className
}: {
  language: Language;
  className?: string;
}) {
  const Flag = flags[language];
  return (
    <Flag
      className={cn("h-4 w-6 shrink-0 rounded-[2px]", className)}
      title={language === "en" ? "English" : "Македонски"}
    />
  );
}
