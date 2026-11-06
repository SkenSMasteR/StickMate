import { useEffect, useRef } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { authRefresh, tokenLoad } from "@/lib/tauri";
import logoDark from "@/assets/logo-dark.png";
import "./splash.css";

export default function Splash() {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;

    async function restoreAndHandoff() {
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
        if (main) {
          await main.show();
          await main.setFocus();
        }
        await getCurrentWindow().hide();
      } catch {
        return;
      }
    }

    void restoreAndHandoff();
  }, []);

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
      <span className="loader" />
    </div>
  );
}
