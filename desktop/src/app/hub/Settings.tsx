import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { LanguageFlag } from "@/components/flags";
import { useI18n } from "@/i18n";
import type { Language } from "@/i18n";
import { usePrefs } from "@/lib/prefs";
import type { UpdateChannel } from "@/lib/prefs";
import { useToast } from "@/lib/toast";
import {
  appVersion,
  authLogout,
  checkForUpdate,
  installUpdate,
  onUpdateProgress,
  tokenClear,
  tokenLoad
} from "@/lib/tauri";
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
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);

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
        setError(null);
        setPercent(0);
        setPendingVersion(result);
      } else {
        toast(t("settings.updateNone"));
      }
    } catch {
      toast(t("settings.updateError"));
    } finally {
      setChecking(false);
    }
  };

  const installNow = async () => {
    setInstalling(true);
    setPercent(0);
    setError(null);
    const unlisten = await onUpdateProgress(setPercent);
    try {
      await installUpdate();
    } catch (cause) {
      unlisten();
      setError(String(cause));
      setInstalling(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-8 overflow-y-auto">
      <h1 className="text-lg font-semibold">{t("settings.title")}</h1>

      <section className="flex w-full max-w-md flex-col gap-3">
        <Label>{t("settings.language")}</Label>
        <Select
          value={prefs.language}
          onValueChange={(value) => setLanguage(value as Language)}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en">
              <span className="flex items-center gap-2">
                <LanguageFlag language="en" />
                {t("lang.en")}
              </span>
            </SelectItem>
            <SelectItem value="mk">
              <span className="flex items-center gap-2">
                <LanguageFlag language="mk" />
                {t("lang.mk")}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </section>

      <section className="flex w-full max-w-md flex-col gap-3">
        <Label>{t("settings.theme")}</Label>
        <Select
          value={prefs.theme}
          onValueChange={(value) => void update({ theme: value as ThemeName })}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dark">{t("settings.theme.dark")}</SelectItem>
            <SelectItem value="light">{t("settings.theme.light")}</SelectItem>
          </SelectContent>
        </Select>
      </section>

      <section className="flex w-full max-w-md flex-col gap-3">
        <Label>{t("settings.account")}</Label>
        <Card className="flex items-center justify-between p-4">
          {prefs.login ? (
            <>
              <span className="text-sm font-medium">{prefs.login}</span>
              <Button variant="outline" size="sm" onClick={() => void signOut()}>
                {t("settings.signOut")}
              </Button>
            </>
          ) : (
            <>
              <span className="text-sm text-muted-foreground">
                {t("settings.signedOut")}
              </span>
              <Button size="sm" onClick={onSignInRequest}>
                {t("settings.signIn")}
              </Button>
            </>
          )}
        </Card>
      </section>

      <Separator className="max-w-md" />

      <section className="flex w-full max-w-md flex-col gap-3">
        <Label>{t("settings.updateChannel")}</Label>
        <Select
          value={prefs.channel}
          onValueChange={(value) =>
            void update({ channel: value as UpdateChannel })
          }
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">{t("settings.channel.stable")}</SelectItem>
            <SelectItem value="nightly">
              {t("settings.channel.nightly")}
            </SelectItem>
          </SelectContent>
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
        <p className="text-sm text-muted-foreground">
          {t("settings.version")} {version}
        </p>
      </section>

      <Dialog
        open={pendingVersion !== null}
        onOpenChange={(open) => {
          if (!open && !installing) {
            setPendingVersion(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.updateAvailable")}</DialogTitle>
            <DialogDescription>
              {t("settings.updatePrompt")} {pendingVersion}
            </DialogDescription>
          </DialogHeader>
          {installing && (
            <p className="text-sm text-muted-foreground">
              {percent < 100
                ? `${t("settings.downloading")} ${percent}%`
                : t("settings.installing")}
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={installing}
              onClick={() => setPendingVersion(null)}
            >
              {t("settings.updateLater")}
            </Button>
            <Button disabled={installing} onClick={() => void installNow()}>
              {t("settings.updateInstall")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
