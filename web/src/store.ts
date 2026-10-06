import { create } from "zustand";
import { produce, setAutoFreeze, type Draft } from "immer";
import {
  defaultDoc,
  outputSize,
  type Doc,
  type Rect,
  type Target,
} from "./types";
import { collectGarbage, resources } from "./resources";

setAutoFreeze(false);

export type Tool = "hand" | "zoom" | "marquee" | "lasso" | "wand" | "pen" | "brush" | "crop" | "eyedropper";
export type SelMode = "new" | "add" | "sub" | "and";

export interface PenPoint {
  x: number; // 원본 px
  y: number;
  hin: { x: number; y: number } | null; // 들어오는 핸들
  hout: { x: number; y: number } | null; // 나가는 핸들
}

export interface PenPath {
  pts: PenPoint[];
  closed: boolean;
}

export interface WandSettings {
  tolerance: number; // 0..255
  contiguous: boolean;
  antialias: boolean;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Panel = "cutout" | "adjust" | "background" | "history";
export type ViewMode = "normal" | "overlay" | "mask" | "black" | "white";

export interface HistEntry {
  label: string;
  doc: Doc;
  time: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  desc: string;
  size: number;
  downloaded: boolean;
  loaded: boolean;
}

export interface ServerInfo {
  ok: boolean;
  device?: { kind: "cuda" | "dml" | "cpu"; label: string; gpu: string | null; confirmed: boolean };
  models?: ModelInfo[];
}

export interface JobState {
  id: string;
  state: string;
  stage: string;
  progress: number;
  message: string;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

export interface BrushSettings {
  mode: "add" | "sub";
  size: number;
  hardness: number;
  opacity: number;
  auto: boolean;
  tolerance: number;
}

export interface ImageInfo {
  name: string;
  w: number;
  h: number;
  version: number;
}

const MAX_HISTORY = 60;

// ---------------------------------------------------------------------------
// 환경설정 (localStorage)

interface Prefs {
  brush: BrushSettings;
  wand: WandSettings;
  marqueeShape: "rect" | "ellipse";
  lassoMode: "free" | "poly";
  model: string;
  precise: boolean;
  open: Record<string, boolean>;
}

const PREF_KEY = "mutoshop.prefs.v1";
const defaultPrefs: Prefs = {
  brush: { mode: "add", size: 80, hardness: 60, opacity: 100, auto: false, tolerance: 30 },
  wand: { tolerance: 32, contiguous: true, antialias: true },
  marqueeShape: "rect",
  lassoMode: "free",
  model: "general",
  precise: true,
  open: {},
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return defaultPrefs;
    const p = JSON.parse(raw);
    return { ...defaultPrefs, ...p, brush: { ...defaultPrefs.brush, ...p.brush }, wand: { ...defaultPrefs.wand, ...p.wand } };
  } catch {
    return defaultPrefs;
  }
}

let prefTimer = 0;
function savePrefs(s: State) {
  clearTimeout(prefTimer);
  prefTimer = window.setTimeout(() => {
    try {
      const p: Prefs = {
        brush: s.brush, wand: s.wand, marqueeShape: s.marqueeShape, lassoMode: s.lassoMode,
        model: s.model, precise: s.precise, open: s.sectionsOpen,
      };
      localStorage.setItem(PREF_KEY, JSON.stringify(p));
    } catch {
      /* 저장 실패는 무시 (사생활 보호 모드 등) */
    }
  }, 300);
}

const prefs = loadPrefs();

// ---------------------------------------------------------------------------

export interface State {
  image: ImageInfo | null;
  doc: Doc;
  hist: HistEntry[];
  histIndex: number;
  savedIndex: number;

  tool: Tool;
  prevTool: Tool;
  brush: BrushSettings;
  wand: WandSettings;
  marqueeShape: "rect" | "ellipse";
  lassoMode: "free" | "poly";
  selMode: SelMode;
  /** 선택 영역 (픽셀은 selection.ts) — 바뀔 때마다 version 증가 */
  sel: { version: number; box: Box | null };
  /** 스포이드로 고를 색: 배경색 / 원래 배경색(매트) */
  eyedropperTarget: "bg" | "matte";
  penPath: PenPath | null;
  panel: Panel;
  target: Target;
  viewMode: ViewMode;
  compare: boolean;
  split: number | null;
  view: { zoom: number; ox: number; oy: number };
  viewport: { w: number; h: number; dpr: number };
  cropDraft: Rect | null;
  cropAspect: number | null; // null=자유, 0=원본 비율
  model: string;
  precise: boolean;
  job: JobState | null;
  server: ServerInfo | null;
  exportOpen: boolean;
  shortcutsOpen: boolean;
  toasts: Toast[];
  sectionsOpen: Record<string, boolean>;
  cursor: { x: number; y: number } | null;
  busy: string | null;

  // 문서
  loadDoc: (info: ImageInfo, doc: Doc, label?: string) => void;
  setDoc: (recipe: (d: Draft<Doc>) => void) => void;
  commit: (label: string) => void;
  change: (label: string, recipe: (d: Draft<Doc>) => void) => void;
  undo: () => void;
  redo: () => void;
  jumpTo: (i: number) => void;
  markSaved: () => void;

  // UI
  set: (p: Partial<State>) => void;
  setTool: (t: Tool) => void;
  setBrush: (p: Partial<BrushSettings>) => void;
  setWand: (p: Partial<WandSettings>) => void;
  setSectionOpen: (key: string, open: boolean) => void;
  toast: (text: string, kind?: Toast["kind"], ms?: number) => void;
  dismissToast: (id: number) => void;
  fitView: () => void;
  zoomAt: (zoom: number, sx?: number, sy?: number) => void;
}

let toastSeq = 0;

export const useStore = create<State>((set, get) => ({
  image: null,
  doc: defaultDoc(),
  hist: [],
  histIndex: -1,
  savedIndex: 0,

  tool: "hand",
  prevTool: "hand",
  brush: prefs.brush,
  wand: prefs.wand,
  marqueeShape: prefs.marqueeShape,
  lassoMode: prefs.lassoMode,
  selMode: "new",
  sel: { version: 0, box: null },
  eyedropperTarget: "bg",
  penPath: null,
  panel: "cutout",
  target: "global",
  viewMode: "normal",
  compare: false,
  split: null,
  view: { zoom: 1, ox: 0, oy: 0 },
  viewport: { w: 800, h: 600, dpr: 1 },
  cropDraft: null,
  cropAspect: null,
  model: prefs.model,
  precise: prefs.precise,
  job: null,
  server: null,
  exportOpen: false,
  shortcutsOpen: false,
  toasts: [],
  sectionsOpen: prefs.open,
  cursor: null,
  busy: null,

  loadDoc: (info, doc, label = "열기") => {
    set({
      image: info,
      doc,
      hist: [{ label, doc, time: performance.now() }],
      histIndex: 0,
      savedIndex: 0,
      tool: "hand",
      target: "global",
      viewMode: "normal",
      compare: false,
      split: null,
      cropDraft: null,
      job: null,
      penPath: null,
    });
    gc();
    get().fitView();
  },

  setDoc: (recipe) => set((s) => ({ doc: produce(s.doc, recipe) })),

  commit: (label) => {
    const s = get();
    const cur = s.hist[s.histIndex];
    if (!cur || cur.doc === s.doc) return;
    const now = performance.now();
    // 같은 슬라이더를 연달아 조절(방향키 여러 번 등)하면 한 단계로 합친다. 붓질은 매번 따로.
    if (
      s.histIndex > 0 && s.histIndex === s.hist.length - 1 && s.histIndex !== s.savedIndex &&
      cur.label === label && now - cur.time < 1500 && !label.startsWith("브러시")
    ) {
      const hist = s.hist.slice();
      hist[s.histIndex] = { label, doc: s.doc, time: now };
      set({ hist });
      gc();
      return;
    }
    let hist = s.hist.slice(0, s.histIndex + 1);
    hist.push({ label, doc: s.doc, time: now });
    if (hist.length > MAX_HISTORY) hist = hist.slice(hist.length - MAX_HISTORY);
    const dropped = s.histIndex + 1 - (hist.length - 1);
    set({ hist, histIndex: hist.length - 1, savedIndex: s.savedIndex - Math.max(0, dropped) });
    gc();
  },

  change: (label, recipe) => {
    get().setDoc(recipe);
    get().commit(label);
  },

  undo: () => {
    const s = get();
    if (s.histIndex <= 0) return;
    // 드래그 중이던 미확정 변경은 버리고 이전 기록으로
    const i = s.histIndex - 1;
    set({ histIndex: i, doc: s.hist[i].doc });
  },

  redo: () => {
    const s = get();
    if (s.histIndex >= s.hist.length - 1) return;
    const i = s.histIndex + 1;
    set({ histIndex: i, doc: s.hist[i].doc });
  },

  jumpTo: (i) => {
    const s = get();
    if (i < 0 || i >= s.hist.length) return;
    set({ histIndex: i, doc: s.hist[i].doc });
  },

  markSaved: () => set((s) => ({ savedIndex: s.histIndex })),

  set: (p) => set(p),

  setTool: (t) => {
    const s = get();
    if (t === s.tool) return;
    if (t === "crop") {
      set({ tool: t, prevTool: s.tool, cropDraft: s.doc.crop ?? { x: 0, y: 0, w: 1, h: 1 } });
      get().fitView();
      return;
    }
    if (s.tool === "crop") {
      set({ tool: t, prevTool: s.tool, cropDraft: null });
      get().fitView();
      return;
    }
    set({ tool: t, prevTool: s.tool, ...(s.tool === "eyedropper" ? { eyedropperTarget: "bg" as const } : {}) });
  },

  setBrush: (p) => {
    set((s) => ({ brush: { ...s.brush, ...p } }));
    savePrefs(get());
  },

  setWand: (p) => {
    set((s) => ({ wand: { ...s.wand, ...p } }));
    savePrefs(get());
  },

  setSectionOpen: (key, open) => {
    set((s) => ({ sectionsOpen: { ...s.sectionsOpen, [key]: open } }));
    savePrefs(get());
  },

  toast: (text, kind = "info", ms = 3200) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    window.setTimeout(() => get().dismissToast(id), ms);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  fitView: () => {
    const s = get();
    const vs = viewImageSize(s);
    if (!vs) return;
    const { w, h } = s.viewport;
    const pad = 48 * s.viewport.dpr;
    const zoom = Math.max(0.01, Math.min((w - pad * 2) / vs[0], (h - pad * 2) / vs[1], 16));
    set({ view: { zoom, ox: (w - vs[0] * zoom) / 2, oy: (h - vs[1] * zoom) / 2 } });
  },

  zoomAt: (zoom, sx, sy) => {
    const s = get();
    const z = Math.min(32, Math.max(0.02, zoom));
    const cx = sx ?? s.viewport.w / 2;
    const cy = sy ?? s.viewport.h / 2;
    const { zoom: z0, ox, oy } = s.view;
    set({ view: { zoom: z, ox: cx - ((cx - ox) / z0) * z, oy: cy - ((cy - oy) / z0) * z } });
  },
}));

// 모델·정밀모드 변경도 저장
useStore.subscribe((s, p) => {
  if (s.model !== p.model || s.precise !== p.precise || s.marqueeShape !== p.marqueeShape || s.lassoMode !== p.lassoMode) savePrefs(s);
});

/** 화면에 보이는 영역의 크기(출력 px). 자르기 도구 중에는 전체, 아니면 자른 영역. */
export function viewImageSize(s: Pick<State, "image" | "doc" | "tool">): [number, number] | null {
  if (!s.image) return null;
  const [W, H] = outputSize(s.image.w, s.image.h, s.doc.orient);
  const c = s.tool === "crop" ? null : s.doc.crop;
  return c ? [Math.max(1, Math.round(c.w * W)), Math.max(1, Math.round(c.h * H))] : [W, H];
}

/** 보이는 영역의 좌상단이 출력 이미지의 어디인지 (출력 px) */
export function viewImageOffset(s: Pick<State, "image" | "doc" | "tool">): [number, number] {
  if (!s.image) return [0, 0];
  const [W, H] = outputSize(s.image.w, s.image.h, s.doc.orient);
  const c = s.tool === "crop" ? null : s.doc.crop;
  return c ? [Math.round(c.x * W), Math.round(c.y * H)] : [0, 0];
}

function gc() {
  const s = useStore.getState();
  const ref = new Set<string>();
  const add = (d: Doc) => {
    if (d.cutout) {
      ref.add(d.cutout.maskId);
      if (d.cutout.fgId) ref.add(d.cutout.fgId);
    }
    if (d.bg.imageId) ref.add(d.bg.imageId);
    for (const op of d.strokes) if (op.kind === "raster") ref.add(op.id);
  };
  s.hist.forEach((e) => add(e.doc));
  add(s.doc);
  collectGarbage(ref);
}

export const hasUnsaved = () => {
  const s = useStore.getState();
  return !!s.image && s.histIndex !== s.savedIndex;
};

export const getSource = () => resources.source;
