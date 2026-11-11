import { useEffect, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import en from "@/i18n/en.json";
import mk from "@/i18n/mk.json";
import { usePrefs } from "@/lib/prefs";
import { authRefresh, checkForUpdate, installUpdate, onUpdateProgress, tokenLoad } from "@/lib/tauri";
import logoDark from "@/assets/logo-dark.png";
import "./splash.css";

export default function Splash() {
  const started = useRef(false);
  const { prefs } = usePrefs();
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [percent, setPercent] = useState<number | null>(null);
  const catalog = prefs.language === "mk" ? mk : en;

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;

    async function startup() {
      try {
        const version = await checkForUpdate();
        if (version) {
          setPercent(0);
          const unlisten = await onUpdateProgress(setPercent);
          try {
            await installUpdate();
          } finally {
            unlisten();
            setPercent(null);
          }
        }
      } catch {
        void 0;
      }
      try {
        const refreshToken = await tokenLoad("refresh");
        if (refreshToken) {
          await authRefresh(refreshToken);
        }
      } catch {
        void 0;
      }
      try {
        const main = await WebviewWindow.getByLabel("main");
        if (!main) {
          throw new Error("main window is unavailable");
        }
        await main.show();
        await main.setFocus();
        await getCurrentWindow().hide();
      } catch (error) {
        started.current = false;
        setFailure(String(error));
      }
    }

    void startup();
  }, [attempt]);

  const retry = () => {
    setFailure(null);
    setPercent(null);
    setAttempt((value) => value + 1);
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-[#111111]">
      <div className="flex flex-1 items-center justify-center overflow-hidden">
        <img
          src={logoDark}
          alt="StickMate"
          className="max-h-40 max-w-64 object-contain"
          draggable={false}
        />
      </div>
      {failure === null ? (
        percent === null ? (
          <span className="loader" />
        ) : (
          <span
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className="progress-value" style={{ width: `${percent}%` }} />
          </span>
        )
      ) : (
        <div className="flex flex-col items-center gap-2 px-4 pb-4 text-center">
          <p className="text-xs text-white">{catalog["splash.failed"]}</p>
          <p className="max-w-full truncate text-xs text-white/60">{failure}</p>
          <button
            type="button"
            onClick={retry}
            className="border border-white/30 px-3 py-1 text-xs text-white hover:bg-white/10"
          >
            {catalog["splash.retry"]}
          </button>
        </div>
      )}
    </div>
  );
}