import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Titlebar from "@/app/Titlebar";
import SignIn from "@/app/auth/SignIn";
import Hub from "@/app/hub/Hub";
import { usePrefs } from "@/lib/prefs";
import { onEditorOpen } from "@/lib/windows";
import Editor from "./Editor";
import ProjectTabs from "./ProjectTabs";
import { useWorkspace } from "./workspace";

type EditorView = "editor" | "hub" | "signin";

export default function EditorWindow() {
  const { ids, open } = useWorkspace();
  const { update } = usePrefs();
  const [view, setView] = useState<EditorView>("editor");
  const viewRef = useRef(view);
  viewRef.current = view;
  const previous = useRef(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onEditorOpen((id) => {
      void open(id);
      setView("editor");
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (viewRef.current === "editor") {
          event.preventDefault();
          setView("hub");
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (previous.current > 0 && ids.length === 0) {
      setView("hub");
    }
    previous.current = ids.length;
  }, [ids.length]);

  const openProject = (id?: string) => {
    if (id) {
      void open(id);
    }
    setView("editor");
  };

  if (view === "signin") {
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
        <Titlebar />
        <SignIn
          onSignedIn={(login) => {
            void update({ login });
            setView("hub");
          }}
        />
      </div>
    );
  }

  if (view === "hub") {
    return (
      <div className="h-screen w-screen overflow-hidden bg-background">
        <Hub
          flat
          onSignInRequest={() => setView("signin")}
          onOpenEditor={openProject}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <Titlebar>
        <ProjectTabs onHome={() => setView("hub")} />
      </Titlebar>
      <Editor />
    </div>
  );
}