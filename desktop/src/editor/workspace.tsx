import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState
} from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useI18n } from "@/i18n";
import { useConfirm } from "@/lib/confirm";
import {
  docAddLayer,
  docAddScene,
  docClose,
  docDelete,
  docDeleteShape,
  docDraw,
  docDuplicateScene,
  docEvaluate,
  docGet,
  docInsertFrame,
  docKeyframe,
  docMoveLayer,
  docMoveScene,
  docNew,
  docRemoveFrame,
  docRemoveLayer,
  docRemoveScene,
  docRename,
  docRenameScene,
  docSetLabel,
  docSetLayer,
  docSetTransform,
  docSetTween,
  docUndo,
  docRedo,
  heldKey,
  identityTransform,
  sceneLength
} from "@/lib/document";
import type {
  Document,
  EvalFrame,
  Layer,
  Scene,
  Shape,
  Transform
} from "@/lib/document";

export type Tool = "select" | "pencil" | "line" | "rect" | "ellipse";

export interface TabState {
  sceneId: string;
  layerId: string;
  frame: number;
  tool: Tool;
  playing: boolean;
  loop: boolean;
  onion: boolean;
  onionRange: number;
  selected: number | null;
  stroke: string;
  fill: string;
  strokeWidth: number;
  zoom: number;
}

export interface NewDocument {
  name: string;
  width: number;
  height: number;
  fps: number;
  background: string;
}

function firstTab(doc: Document): TabState {
  const scene = doc.scenes[0];
  return {
    sceneId: scene.id,
    layerId: scene.layers[0].id,
    frame: 0,
    tool: "pencil",
    playing: false,
    loop: true,
    onion: false,
    onionRange: 2,
    selected: null,
    stroke: "#000000",
    fill: "#3b82f6",
    strokeWidth: 3,
    zoom: 1
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

interface WorkspaceValue {
  ids: string[];
  activeId: string | null;
  docs: Record<string, Document>;
  doc: Document | null;
  scene: Scene | null;
  layer: Layer | null;
  tab: TabState | null;
  frame: number;
  total: number;
  frames: EvalFrame[];
  transform: Transform;
  create: (input: NewDocument) => Promise<string | null>;
  open: (id: string) => Promise<boolean>;
  close: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  activate: (id: string) => void;
  setTab: (patch: Partial<TabState>) => void;
  actions: Actions;
}

export interface Actions {
  setTool: (tool: Tool) => void;
  select: (index: number | null) => void;
  selectLayer: (layerId: string) => void;
  selectScene: (sceneId: string) => void;
  seek: (frame: number) => void;
  step: (delta: number) => void;
  togglePlay: () => void;
  toggleLoop: () => void;
  toggleOnion: () => void;
  setOnionRange: (range: number) => void;
  zoomBy: (factor: number) => void;
  zoomFit: () => void;
  draw: (shape: Shape) => void;
  deleteSelected: () => void;
  setTransform: (patch: Partial<Transform>) => void;
  insertFrame: () => void;
  keyframe: (blank: boolean) => void;
  removeFrame: () => void;
  toggleTween: () => void;
  setLabel: (label: string) => void;
  addLayer: () => void;
  renameLayer: (layerId: string, name: string) => void;
  setLayerFlags: (
    layerId: string,
    patch: { visible?: boolean; locked?: boolean; opacity?: number }
  ) => void;
  moveLayer: (layerId: string, index: number) => void;
  removeLayer: (layerId: string) => void;
  addScene: () => void;
  renameScene: (sceneId: string, name: string) => void;
  moveScene: (sceneId: string, index: number) => void;
  duplicateScene: (sceneId: string) => void;
  removeScene: (sceneId: string) => void;
  renameDoc: (name: string) => void;
  undo: () => void;
  redo: () => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [docs, setDocs] = useState<Record<string, Document>>({});
  const [ids, setIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Record<string, TabState>>({});
  const [frames, setFrames] = useState<EvalFrame[]>([]);

  const doc = activeId ? docs[activeId] ?? null : null;
  const tab = activeId ? tabs[activeId] ?? null : null;
  const scene =
    doc && tab
      ? doc.scenes.find((item) => item.id === tab.sceneId) ?? doc.scenes[0]
      : null;
  const layer =
    scene && tab
      ? scene.layers.find((item) => item.id === tab.layerId) ?? scene.layers[0]
      : null;
  const total = scene ? sceneLength(scene) : 1;
  const frame = tab ? clamp(tab.frame, 0, total - 1) : 0;
  const evaluated =
    frames.length > 0
      ? frames[frames.length - 1].layers.find((item) => item.id === layer?.id)
      : undefined;
  const transform =
    evaluated?.transform ??
    (layer
      ? heldKey(layer, frame)?.transform ?? identityTransform
      : identityTransform);

  const setTab = useCallback(
    (patch: Partial<TabState>) => {
      setTabs((prev) => {
        if (!activeId || !prev[activeId]) {
          return prev;
        }
        return { ...prev, [activeId]: { ...prev[activeId], ...patch } };
      });
    },
    [activeId]
  );

  const adopt = useCallback((next: Document) => {
    setDocs((prev) => ({ ...prev, [next.id]: next }));
    setIds((prev) => (prev.includes(next.id) ? prev : [...prev, next.id]));
    setTabs((prev) => (prev[next.id] ? prev : { ...prev, [next.id]: firstTab(next) }));
    setActiveId(next.id);
  }, []);

  const create = useCallback(
    async (input: NewDocument) => {
      try {
        const next = await docNew(input.name, input.width, input.height, input.fps, input.background);
        adopt(next);
        return next.id;
      } catch (error) {
        toast.error(String(error));
        return null;
      }
    },
    [adopt]
  );

  const open = useCallback(
    async (id: string) => {
      try {
        adopt(await docGet(id));
        return true;
      } catch (error) {
        toast.error(String(error));
        return false;
      }
    },
    [adopt]
  );

  const forget = useCallback((id: string) => {
    setIds((prev) => {
      const next = prev.filter((item) => item !== id);
      setActiveId((current) => (current === id ? next[next.length - 1] ?? null : current));
      return next;
    });
    setDocs((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setTabs((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const close = useCallback(
    async (id: string) => {
      try {
        await docClose(id);
        forget(id);
      } catch (error) {
        toast.error(String(error));
      }
    },
    [forget]
  );

  const remove = useCallback(
    async (id: string) => {
      const name = docs[id]?.name ?? id;
      const accepted = await confirm({
        title: t("editor.deleteProject"),
        description: name,
        confirmLabel: t("editor.delete"),
        cancelLabel: t("editor.cancel"),
        destructive: true
      });
      if (!accepted) {
        return;
      }
      try {
        await docDelete(id);
        forget(id);
        toast.success(`${t("editor.projectDeleted")} ${name}`);
      } catch (error) {
        toast.error(String(error));
      }
    },
    [confirm, docs, forget, t]
  );

  const run = useCallback(
    (promise: Promise<Document>): Promise<boolean> => {
      const id = activeId;
      if (!id) {
        return Promise.resolve(false);
      }
      return promise
        .then((next) => {
          setDocs((prev) => ({ ...prev, [id]: next }));
          return true;
        })
        .catch((error) => {
          toast.error(String(error));
          return false;
        });
    },
    [activeId]
  );

  const edit = useCallback(
    (change: (doc: Document, scene: Scene, layer: Layer) => Promise<Document>) => {
      if (!doc || !scene || !layer) {
        return Promise.resolve(false);
      }
      return run(change(doc, scene, layer));
    },
    [doc, layer, run, scene]
  );

  useEffect(() => {
    if (!doc || !scene || !tab) {
      setFrames([]);
      return;
    }
    let cancelled = false;
    const start = tab.onion ? Math.max(0, frame - tab.onionRange) : frame;
    docEvaluate(doc.id, scene.id, start, frame)
      .then((next) => {
        if (!cancelled) {
          setFrames(next);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [doc, frame, scene, tab]);

  useEffect(() => {
    if (!doc || !tab?.playing) {
      return;
    }
    const timer = window.setInterval(() => {
      setTabs((prev) => {
        const current = prev[doc.id];
        if (!current) {
          return prev;
        }
        const next = current.frame + 1;
        if (next < total) {
          return { ...prev, [doc.id]: { ...current, frame: next } };
        }
        if (current.loop) {
          return { ...prev, [doc.id]: { ...current, frame: 0 } };
        }
        const index = doc.scenes.findIndex((item) => item.id === current.sceneId);
        const following = doc.scenes[index + 1];
        if (!following) {
          return { ...prev, [doc.id]: { ...current, frame: total - 1, playing: false } };
        }
        return {
          ...prev,
          [doc.id]: {
            ...current,
            sceneId: following.id,
            layerId: following.layers[0].id,
            frame: 0,
            selected: null
          }
        };
      });
    }, 1000 / doc.fps);
    return () => window.clearInterval(timer);
  }, [doc, tab?.playing, total]);

  const actions: Actions = {
    setTool: (tool) => setTab({ tool, selected: null }),
    select: (index) => setTab({ selected: index }),
    selectLayer: (layerId) => setTab({ layerId, selected: null }),
    selectScene: (sceneId) => {
      const next = doc?.scenes.find((item) => item.id === sceneId);
      if (!next) {
        return;
      }
      setTab({
        sceneId,
        layerId: next.layers[0].id,
        frame: 0,
        selected: null,
        playing: false
      });
    },
    seek: (next) => setTab({ frame: clamp(next, 0, total - 1), playing: false }),
    step: (delta) =>
      setTab({ frame: clamp(frame + delta, 0, total - 1), playing: false }),
    togglePlay: () => setTab({ playing: !tab?.playing }),
    toggleLoop: () => setTab({ loop: !tab?.loop }),
    toggleOnion: () => setTab({ onion: !tab?.onion }),
    setOnionRange: (range) => setTab({ onionRange: clamp(range, 1, 5) }),
    zoomBy: (factor) => setTab({ zoom: clamp((tab?.zoom ?? 1) * factor, 0.1, 8) }),
    zoomFit: () => setTab({ zoom: 1 }),
    draw: (shape) => edit((d, s, l) => docDraw(d.id, s.id, l.id, frame, shape)),
    deleteSelected: () => {
      if (tab?.selected == null) {
        return;
      }
      const index = tab.selected;
      setTab({ selected: null });
      edit((d, s, l) => docDeleteShape(d.id, s.id, l.id, frame, index));
    },
    setTransform: (patch) =>
      edit((d, s, l) => docSetTransform(d.id, s.id, l.id, frame, { ...transform, ...patch })),
    insertFrame: () => {
      const target = frame + 1;
      void edit((d, s, l) => docInsertFrame(d.id, s.id, l.id, frame)).then((ok) => {
        if (ok) {
          setTab({ frame: target });
        }
      });
    },
    keyframe: (blank) => edit((d, s, l) => docKeyframe(d.id, s.id, l.id, frame, blank)),
    removeFrame: () => edit((d, s, l) => docRemoveFrame(d.id, s.id, l.id, frame)),
    toggleTween: () =>
      edit((d, s, l) => {
        const key = heldKey(l, frame);
        return docSetTween(d.id, s.id, l.id, key?.frame ?? frame, !key?.tween);
      }),
    setLabel: (label) =>
      edit((d, s, l) => {
        const key = heldKey(l, frame);
        return docSetLabel(d.id, s.id, l.id, key?.frame ?? frame, label);
      }),
    addLayer: () => edit((d, s) => docAddLayer(d.id, s.id, "")),
    renameLayer: (layerId, name) =>
      edit((d, s) => docSetLayer(d.id, s.id, layerId, { name })),
    setLayerFlags: (layerId, patch) =>
      edit((d, s) => docSetLayer(d.id, s.id, layerId, patch)),
    moveLayer: (layerId, index) =>
      edit((d, s) => docMoveLayer(d.id, s.id, layerId, index)),
    removeLayer: (layerId) => {
      const target = scene?.layers.find((item) => item.id === layerId);
      if (!target || !scene) {
        return;
      }
      void confirm({
        title: t("editor.deleteLayer"),
        description: target.name,
        confirmLabel: t("editor.delete"),
        cancelLabel: t("editor.cancel"),
        destructive: true
      }).then(async (accepted) => {
        if (!accepted) {
          return;
        }
        if (await edit((d, s) => docRemoveLayer(d.id, s.id, layerId))) {
          toast.success(`${t("editor.layerDeleted")} ${target.name}`);
        }
      });
    },
    addScene: () => edit((d) => docAddScene(d.id, "")),
    renameScene: (sceneId, name) => edit((d) => docRenameScene(d.id, sceneId, name)),
    moveScene: (sceneId, index) => edit((d) => docMoveScene(d.id, sceneId, index)),
    duplicateScene: (sceneId) => edit((d) => docDuplicateScene(d.id, sceneId)),
    removeScene: (sceneId) => {
      const target = doc?.scenes.find((item) => item.id === sceneId);
      if (!target) {
        return;
      }
      void confirm({
        title: t("editor.deleteScene"),
        description: target.name,
        confirmLabel: t("editor.delete"),
        cancelLabel: t("editor.cancel"),
        destructive: true
      }).then(async (accepted) => {
        if (!accepted) {
          return;
        }
        if (await edit((d) => docRemoveScene(d.id, sceneId))) {
          toast.success(`${t("editor.sceneDeleted")} ${target.name}`);
        }
      });
    },
    renameDoc: (name) => {
      if (doc) {
        run(docRename(doc.id, name));
      }
    },
    undo: () => {
      if (doc) {
        run(docUndo(doc.id));
      }
    },
    redo: () => {
      if (doc) {
        run(docRedo(doc.id));
      }
    }
  };

  return (
    <WorkspaceContext.Provider
      value={{
        ids,
        activeId,
        docs,
        doc,
        scene,
        layer,
        tab,
        frame,
        total,
        frames,
        transform,
        create,
        open,
        close,
        remove,
        activate: setActiveId,
        setTab,
        actions
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider");
  }
  return context;
}