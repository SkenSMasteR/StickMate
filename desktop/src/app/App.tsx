import { useEffect, useState } from "react";
import { usePrefs } from "@/lib/prefs";
import { tokenLoad } from "@/lib/tauri";
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
          if (!cancelled) {
            setView("hub");
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
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[hsl(var(--background))]">
      <Titlebar />
      {view === "loading" && (
        <div className="flex-1 bg-[hsl(var(--background))]" />
      )}
      {view === "signin" && <SignIn onSignedIn={handleSignedIn} />}
      {view === "hub" && <Hub onSignInRequest={() => setView("signin")} />}
    </div>
  );
}
