import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { toast } from "sonner";
import { entitlementRefreshKey } from "@/lib/entitlement";
import { authPoll, authStart, openUrl, tokenSave } from "@/lib/tauri";

type Phase = "idle" | "waiting" | "expired" | "error";

export default function SignIn({
  onSignedIn
}: {
  onSignedIn: (login: string | null) => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [userCode, setUserCode] = useState("");
  const timerRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    stoppedRef.current = false;
    return () => {
      stoppedRef.current = true;
      stopPolling();
    };
  }, [stopPolling]);

  const startSignIn = useCallback(async () => {
    stopPolling();
    setPhase("idle");
    try {
      const device = await authStart();
      setUserCode(device.user_code);
      setPhase("waiting");
      try {
        await openUrl(device.verification_uri);
      } catch {
        toast(t("auth.opening"));
      }
      const intervalMs = Math.max(1, device.interval || 5) * 1000;
      const deadline = Date.now() + (device.expires_in || 900) * 1000;

      const poll = async () => {
        if (stoppedRef.current) {
          return;
        }
        if (Date.now() > deadline) {
          setPhase("expired");
          return;
        }
        try {
          const result = await authPoll(device.device_code);
          if (stoppedRef.current) {
            return;
          }
          if (result.status === "ok") {
            if (result.access_token) {
              await tokenSave("access", result.access_token);
            }
            if (result.refresh_token) {
              await tokenSave("refresh", result.refresh_token);
            }
            if (result.offline_token) {
              await tokenSave("offline", result.offline_token);
            }
            await entitlementRefreshKey().catch(() => undefined);
            onSignedIn(result.account?.login ?? null);
            return;
          }
          if (result.status === "expired") {
            setPhase("expired");
            return;
          }
        } catch {
          if (!stoppedRef.current) {
            setPhase("error");
          }
          return;
        }
        timerRef.current = window.setTimeout(poll, intervalMs);
      };

      timerRef.current = window.setTimeout(poll, intervalMs);
    } catch {
      setPhase("error");
      toast.error(t("auth.error"));
    }
  }, [onSignedIn, stopPolling, t]);

  return (
    <div className="flex flex-1 items-center justify-center bg-[hsl(var(--background))] p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-8 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="text-lg font-semibold text-[hsl(var(--card-foreground))]">
            {t("auth.title")}
          </h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {t("auth.subtitle")}
          </p>
        </div>

        {phase === "waiting" && (
          <div className="flex w-full flex-col items-center gap-3">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              {t("auth.waiting")}
            </p>
            <p className="text-xs uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
              {t("auth.userCode")}
            </p>
            <div className="w-full border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-4 py-3 font-mono text-xl tracking-[0.3em] text-[hsl(var(--foreground))]">
              {userCode}
            </div>
          </div>
        )}

        {phase === "expired" && (
          <p className="text-sm text-[hsl(var(--destructive))]">
            {t("auth.expired")}
          </p>
        )}

        {phase === "error" && (
          <p className="text-sm text-[hsl(var(--destructive))]">
            {t("auth.error")}
          </p>
        )}

        <Button
          className="w-full"
          onClick={() => void startSignIn()}
          disabled={phase === "waiting"}
        >
          {phase === "expired" || phase === "error"
            ? t("auth.retry")
            : t("auth.signInGithub")}
        </Button>
      </div>
    </div>
  );
}
