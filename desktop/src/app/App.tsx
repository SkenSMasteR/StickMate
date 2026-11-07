import { useEffect, useState } from "react";
import { entitlementCheck } from "@/lib/entitlement";
import { usePrefs } from "@/lib/prefs";
import { tokenLoad } from "@/lib/tauri";
import { showEditor } from "@/lib/windows";
import Titlebar from "./Titlebar";
import SignIn from "./auth/SignIn";
import Hub from "./hub/Hub";

type View = "loading" | "signin" | "hub";

export default function Main() {
  const { update } = usePrefs();
  const [view, setView] = useState<View>("loading");

  useEffect(() => {
    let cancelled = false;

    async function checkSession() {
      try {
        const refresh = await tokenLoad("refresh");
        if (refresh) {
          if (!cancelled) {
            setView("hub");
          }
          return;
        }
        const offline = await tokenLoad("offline");
        if (offline) {
          const entitlement = await entitlementCheck();
          if (!cancelled) {
            setView(entitlement.valid ? "hub" : "signin");
          }
          return;
        }
        const access = await tokenLoad("access");
        if (!cancelled) {
          setView(access ? "hub" : "signin");
        }
      } catch {
        if (!cancelled) {
          setView("signin");
        }
      }
    }

    void checkSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignedIn = (login: string | null) => {
    void update({ login });
    setView("hub");
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      {view === "hub" ? (
        <Hub
          onSignInRequest={() => setView("signin")}
          onOpenEditor={(id) => void showEditor(id)}
        />
      ) : (
        <>
          <Titlebar />
          {view === "signin" ? (
            <SignIn onSignedIn={handleSignedIn} />
          ) : (
            <div className="flex-1" />
          )}
        </>
      )}
    </div>
  );
}