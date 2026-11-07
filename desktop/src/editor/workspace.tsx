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
  docDeleteShapes,
  docDraw,
  docDuplicateScene,
  docErase,
  docEvaluate,
  docGet,
  docInsertFrame,
  docKeyframe,
  docMoveLayer,
  docMoveScene,
  docNew,
  docPaintShape,
  docRemoveFrame,
  docRemoveLayer,
  docRemoveScene,
  docRename,
  docRenameScene,
  docReorderShapes,
  docReplaceShape,
  docSetLabel,
  docSetLayer,
  docSetTransform,
  docSetTween,
  docTransformShapes,
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
  Point,
  Scene,
  Shape,
  Transform
} from "@/lib/document";
import {
  docCopyFrames,
  docDuplicateFrames,
  docInsertFrames,
  docMoveFrames,
  docPasteFrames,
  docRemoveFrames,
  frameClipboard,
  setFrameClipboard
} from "@/lib/frames";
import { docDuplicateLayer } from "@/lib/tauri";

export type Tool =
  | "select"
  | "pencil"
  | "brush"
  | "eraser"
  | "line"
  | "rect"
  | "ellipse"
  | "polygon"
  | "fill"
  | "eyedropper"
  | "text"
  | "pen"
  | "node";

export interface TabState {
  sceneId: string;
  layerId: string;
  frame: number;
  selectedFrames: number[];
  loopStart: number | null;
  loopEnd: number | null;
  tool: Tool;
  playing: boolean;
  loop: boolean;
  onion: boolean;
  onionRange: number;
  selected: number[];
  pivot: Point | null;
  selectedNode: number | null;
  stroke: string;
  fill: string;
  strokeWidth: number;
  smoothing: number;
  sides: number;
  eraserWidth: number;
  fontSize: number;
  fontFamily: string;
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
    selectedFrames: [],
    loopStart: null,
    loopEnd: null,
    tool: "pencil",
    playing: false,
    loop: true,
    onion: false,
    onionRange: 2,
    selected: [],
    pivot: null,
    selectedNode: null,
    stroke: "#000000",
    fill: "#3b82f6",
    strokeWidth: 3,
    smoothing: 30,
    sides: 5,
    eraserWidth: 20,
    fontSize: 32,
    fontFamily: "Segoe UI",
    zoom: 1
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function frameRange(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => start + index);
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
  selectMany: (indices: number[]) => void;
  toggleSelect: (index: number) => void;
  transformShapes: (
    pivot: Point,
    dx: number,
    dy: number,
    sx: number,
    sy: number,
    rotation: number
  ) => void;
  reorderSelected: (toFront: boolean) => void;
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
  erase: (path: Point[]) => void;
  paintShape: (index: number, color: string) => void;
  replaceShape: (index: number, shape: Shape) => void;
  deleteSelected: () => void;
  setTransform: (patch: Partial<Transform>) => void;
  insertFrame: () => void;
  keyframe: (blank: boolean) => void;
  removeFrame: () => void;
  insertFrames: (count: number) => void;
  removeFrames: (count: number) => void;
  copyFrames: () => void;
  pasteFrames: () => void;
  duplicateFrames: () => void;
  moveFrames: (target: number) => void;
  setSelectedFrames: (frames: number[]) => void;
  setLoopRange: (start: number | null, end: number | null) => void;
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
  duplicateLayer: (layerId: string) => void;
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
        const loopStart = current.loopStart;
        const loopEnd = current.loopEnd;
        const ranged = loopStart !== null && loopEnd !== null;
        const end = ranged ? Math.min(loopEnd, total - 1) : total - 1;
        const resume = ranged ? Math.min(loopStart, end) : 0;
        if (next < total && next <= end) {
          return { ...prev, [doc.id]: { ...current, frame: next } };
        }
        if (current.loop) {
          return { ...prev, [doc.id]: { ...current, frame: resume } };
        }
        if (ranged) {
          return { ...prev, [doc.id]: { ...current, frame: end, playing: false } };
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
            selected: [],
            pivot: null,
            selectedFrames: []
          }
        };
      });
    }, 1000 / doc.fps);
    return () => window.clearInterval(timer);
  }, [doc, tab?.playing, total]);

  const selectionStart = (): number => {
    const selected = tab?.selectedFrames ?? [];
    return selected.length > 0 ? selected[0] : frame;
  };

  const selectionCount = (): number => {
    const selected = tab?.selectedFrames ?? [];
    return selected.length > 0 ? selected[selected.length - 1] - selected[0] + 1 : 1;
  };

  const actions: Actions = {
    setTool: (tool) => setTab({ tool, selected: [], pivot: null, selectedNode: null }),
    select: (index) =>
      setTab({ selected: index === null ? [] : [index], pivot: null, selectedNode: null }),
    selectMany: (indices) =>
      setTab({
        selected: [...new Set(indices)].sort((a, b) => a - b),
        pivot: null,
        selectedNode: null
      }),
    toggleSelect: (index) => {
      const current = tab?.selected ?? [];
      setTab({
        selected: current.includes(index)
          ? current.filter((item) => item !== index)
          : [...current, index],
        pivot: null,
        selectedNode: null
      });
    },
    transformShapes: (pivot, dx, dy, sx, sy, rotation) => {
      const indices = tab?.selected ?? [];
      if (indices.length === 0) {
        return;
      }
      edit((d, s, l) =>
        docTransformShapes(d.id, s.id, l.id, frame, indices, pivot, dx, dy, sx, sy, rotation)
      );
    },
    reorderSelected: (toFront) => {
      const indices = tab?.selected ?? [];
      if (indices.length === 0 || !layer) {
        return;
      }
      const count = heldKey(layer, frame)?.shapes.length ?? 0;
      void edit((d, s, l) =>
        docReorderShapes(d.id, s.id, l.id, frame, indices, toFront)
      ).then((ok) => {
        if (ok) {
          const start = toFront ? count - indices.length : 0;
          setTab({ selected: frameRange(start, indices.length), pivot: null });
        }
      });
    },
    selectLayer: (layerId) => setTab({ layerId, selected: [], pivot: null, selectedFrames: [] }),
    selectScene: (sceneId) => {
      const next = doc?.scenes.find((item) => item.id === sceneId);
      if (!next) {
        return;
      }
      setTab({
        sceneId,
        layerId: next.layers[0].id,
        frame: 0,
        selected: [],
        pivot: null,
        selectedFrames: [],
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
    erase: (path) => {
      if (path.length === 0) {
        return;
      }
      edit((d, s, l) =>
        docErase(d.id, s.id, l.id, frame, path, (tab?.eraserWidth ?? 20) / 2)
      );
    },
    paintShape: (index, color) =>
      edit((d, s, l) => docPaintShape(d.id, s.id, l.id, frame, index, color)),
    replaceShape: (index, shape) =>
      edit((d, s, l) => docReplaceShape(d.id, s.id, l.id, frame, index, shape)),
    deleteSelected: () => {
      const indices = tab?.selected ?? [];
      if (indices.length === 0) {
        return;
      }
      setTab({ selected: [], pivot: null });
      edit((d, s, l) => docDeleteShapes(d.id, s.id, l.id, frame, indices));
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
    insertFrames: (count) => {
      const start = selectionStart();
      void edit((d, s, l) => docInsertFrames(d.id, s.id, l.id, start, count)).then((ok) => {
        if (ok) {
          setTab({ frame: start, selectedFrames: frameRange(start, count) });
        }
      });
    },
    removeFrames: (count) => {
      const start = selectionStart();
      const span = tab?.selectedFrames.length ? selectionCount() : count;
      void edit((d, s, l) => docRemoveFrames(d.id, s.id, l.id, start, span)).then((ok) => {
        if (ok) {
          setTab({ frame: start, selectedFrames: [] });
        }
      });
    },
    copyFrames: () => {
      if (!doc || !scene || !layer) {
        return;
      }
      docCopyFrames(doc.id, scene.id, layer.id, selectionStart(), selectionCount())
        .then((clip) => setFrameClipboard(clip))
        .catch((error) => toast.error(String(error)));
    },
    pasteFrames: () => {
      const clip = frameClipboard();
      if (!clip || clip.keys.length === 0) {
        toast.error(t("editor.clipboardEmpty"));
        return;
      }
      const start = selectionStart();
      void edit((d, s, l) => docPasteFrames(d.id, s.id, l.id, start, clip)).then((ok) => {
        if (ok) {
          setTab({ frame: start, selectedFrames: frameRange(start, clip.span) });
        }
      });
    },
    duplicateFrames: () => {
      const start = selectionStart();
      const count = selectionCount();
      void edit((d, s, l) => docDuplicateFrames(d.id, s.id, l.id, start, count)).then((ok) => {
        if (ok) {
          setTab({ frame: start + count, selectedFrames: frameRange(start + count, count) });
        }
      });
    },
    moveFrames: (target) => {
      const start = selectionStart();
      const count = selectionCount();
      const at = target > start ? Math.max(0, target - count) : target;
      void edit((d, s, l) => docMoveFrames(d.id, s.id, l.id, start, count, target)).then((ok) => {
        if (ok) {
          setTab({ frame: at, selectedFrames: frameRange(at, count) });
        }
      });
    },
    setSelectedFrames: (frames) => {
      const unique = [...new Set(frames.map((value) => clamp(value, 0, total - 1)))].sort(
        (a, b) => a - b
      );
      setTab({ selectedFrames: unique });
    },
    setLoopRange: (start, end) => {
      if (start === null || end === null) {
        setTab({ loopStart: null, loopEnd: null });
        return;
      }
      setTab({
        loopStart: clamp(Math.min(start, end), 0, total - 1),
        loopEnd: clamp(Math.max(start, end), 0, total - 1)
      });
    },
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
    duplicateLayer: (layerId) =>
      edit((d, s) => docDuplicateLayer(d.id, s.id, layerId)),
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