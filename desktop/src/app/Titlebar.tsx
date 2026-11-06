import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

export default function Titlebar({
  children,
  sidebar = false
}: {
  children?: ReactNode;
  sidebar?: boolean;
}) {
  const { t } = useI18n();
  const win = getCurrentWindow();

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-10 shrink-0 items-center pl-2",
        sidebar ? "bg-sidebar" : "bg-background"
      )}
    >
      {children ?? (
        <span className="px-1 text-sm font-semibold">{t("app.name")}</span>
      )}
      <div data-tauri-drag-region className="h-full min-w-4 flex-1" />
      <div className="flex h-full">
        <button
          className="flex h-full w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => void win.minimize()}
          aria-label={t("titlebar.minimize")}
          title={t("titlebar.minimize")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect y="4.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className="flex h-full w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={async () => {
            const maximized = await win.isMaximized();
            if (maximized) {
              await win.unmaximize();
            } else {
              await win.maximize();
            }
          }}
          aria-label={t("titlebar.maximize")}
          title={t("titlebar.maximize")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect
              x="0.5"
              y="0.5"
              width="9"
              height="9"
              fill="none"
              stroke="currentColor"
            />
          </svg>
        </button>
        <button
          className="flex h-full w-11 items-center justify-center text-muted-foreground hover:bg-[#c42b1c] hover:text-white"
          onClick={() => void win.close()}
          aria-label={t("titlebar.close")}
          title={t("titlebar.close")}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M0 0 L10 10 M10 0 L0 10"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
