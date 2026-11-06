import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Titlebar from "@/app/Titlebar";
import { onEditorOpen, showHub } from "@/lib/windows";
import Editor from "./Editor";
import ProjectTabs from "./ProjectTabs";
import { useWorkspace } from "./workspace";

export default function EditorWindow() {
  const { ids, open } = useWorkspace();
  const previous = useRef(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onEditorOpen((id) => {
      void open(id);
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
        event.preventDefault();
        void showHub();
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
      void showHub();
    }
    previous.current = ids.length;
  }, [ids.length]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <Titlebar>
        <ProjectTabs onHome={() => void showHub()} />
      </Titlebar>
      <Editor />
    </div>
  );
}