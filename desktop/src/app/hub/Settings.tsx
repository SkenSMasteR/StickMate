import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useI18n } from "@/i18n";
import type { Language } from "@/i18n";
import { usePrefs } from "@/lib/prefs";
import type { UpdateChannel } from "@/lib/prefs";
import { useToast } from "@/lib/toast";
import { authLogout, checkForUpdate, tokenClear, tokenLoad } from "@/lib/tauri";
import type { ThemeName } from "@/theme";

export default function Settings({
  onSignInRequest
}: {
  onSignInRequest: () => void;
}) {
  const { t, setLanguage } = useI18n();
  const { prefs, update } = usePrefs();
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);

  const signOut = async () => {
    try {
      const refreshToken = await tokenLoad("refresh");
      if (refreshToken) {
        try {
          await authLogout(refreshToken);
        } catch {
          await tokenClear();
        }
      }
      await tokenClear();
    } catch {
      return;
    }
    await update({ login: null });
    onSignInRequest();
  };

  const runUpdateCheck = async () => {
    setChecking(true);
    try {
      const result = await checkForUpdate();
      if (result) {
        toast(t("settings.updateFound"));
      } else {
        toast(t("settings.updateNone"));
      }
    } catch {
      toast(t("settings.updateError"));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-8 overflow-y-auto p-6">
      <h1 className="text-base font-semibold">{t("settings.title")}</h1>

      <section className="flex w-full max-w-md flex-col gap-3">
        <span className="text-sm text-[hsl(var(--muted-foreground))]">
          {t("settings.language")}
        </span>
        <Select
          value={prefs.language}
          onChange={(event) => {
            setLanguage(event.target.value as Language);
          }}
        >
          <option value="en">{t("lang.en")}</option>
          <option value="mk">{t("lang.mk")}</option>
        </Select>
      </section>

      <section className="flex w-full max-w-md flex-col gap-3">
        <span className="text-sm text-[hsl(var(--muted-foreground))]">
          {t("settings.theme")}
        </span>
        <Select
          value={prefs.theme}
          onChange={(event) => {
            void update({ theme: event.target.value as ThemeName });
          }}
        >
          <option value="dark">{t("settings.theme.dark")}</option>
          <option value="light">{t("settings.theme.light")}</option>
        </Select>
      </section>

      <section className="flex w-full max-w-md flex-col gap-3">
        <span className="text-sm text-[hsl(var(--muted-foreground))]">
          {t("settings.account")}
        </span>
        <div className="flex items-center justify-between border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-3">
          {prefs.login ? (
            <>
              <span className="text-sm font-medium">{prefs.login}</span>
              <Button variant="outline" size="sm" onClick={() => void signOut()}>
                {t("settings.signOut")}
              </Button>
            </>
          ) : (
            <>
              <span className="text-sm text-[hsl(var(--muted-foreground))]">
                {t("settings.signedOut")}
              </span>
              <Button size="sm" onClick={onSignInRequest}>
                {t("settings.signIn")}
              </Button>
            </>
          )}
        </div>
      </section>

      <section className="flex w-full max-w-md flex-col gap-3">
        <span className="text-sm text-[hsl(var(--muted-foreground))]">
          {t("settings.updateChannel")}
        </span>
        <Select
          value={prefs.channel}
          onChange={(event) => {
            void update({ channel: event.target.value as UpdateChannel });
          }}
        >
          <option value="stable">{t("settings.channel.stable")}</option>
          <option value="nightly">{t("settings.channel.nightly")}</option>
        </Select>
        <div>
          <Button
            variant="outline"
            disabled={checking}
            onClick={() => void runUpdateCheck()}
          >
            {checking ? t("settings.checking") : t("settings.checkUpdates")}
          </Button>
        </div>
      </section>
    </div>
  );
}
