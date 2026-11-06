import { useEffect, useState } from "react";
import Editor from "@/editor/Editor";
import ProjectTabs from "@/editor/ProjectTabs";
import { useWorkspace } from "@/editor/workspace";
import { usePrefs } from "@/lib/prefs";
import { tokenLoad } from "@/lib/tauri";
import Titlebar from "./Titlebar";
import SignIn from "./auth/SignIn";
import Hub from "./hub/Hub";

type View = "loading" | "signin" | "hub" | "editor";

export default function Main() {
  const { update } = usePrefs();
  const { activeId } = useWorkspace();
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

  useEffect(() => {
    if (view === "editor" && !activeId) {
      setView("hub");
    }
  }, [view, activeId]);

  const handleSignedIn = (login: string | null) => {
    void update({ login });
    setView("hub");
  };

  const openEditor = () => setView("editor");

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      {view === "editor" && activeId ? (
        <>
          <Titlebar>
            <ProjectTabs onHome={() => setView("hub")} />
          </Titlebar>
          <Editor />
        </>
      ) : view === "hub" ? (
        <Hub
          onSignInRequest={() => setView("signin")}
          onOpenEditor={openEditor}
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