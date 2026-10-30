import { create } from "zustand";
import { produce, setAutoFreeze, type Draft } from "immer";
import {
  defaultDoc,
  outputSize,
  type CutKind,
  type Doc,
  type Inner,
  type Rect,
  type Target,
} from "./types";
import { isKind } from "./kinds";
import { collectGarbage, resources } from "./resources";

setAutoFreeze(false);

export type Tool = "hand" | "zoom" | "marquee" | "lasso" | "wand" | "pen" | "brush" | "crop" | "eyedropper" | "bgpick" | "colorrange";
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
  /** 색 범위 도구(C)의 허용치 — 사진 전체에서 클릭한 색과 비슷한 곳 */
  colorTol: number;
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
/** 기록에 남겨 두는 누끼 결과(마스크 + 전경색, 사진 한 장에 수십 MB) 수. 종류를 바꿔 가며 여러 번 따도
 *  메모리가 계속 불어나지 않게, 그보다 오래된 기록은 버린다 (지금 화면의 결과는 항상 남음) */
const MAX_CUTOUT_RESULTS = 3;

function capCutoutResults(hist: HistEntry[]): HistEntry[] {
  const seen = new Set<string>();
  for (let i = hist.length - 1; i >= 0; i--) {
    const fg = hist[i].doc.cutout?.fgId;
    if (!fg || seen.has(fg)) continue;
    seen.add(fg);
    if (seen.size > MAX_CUTOUT_RESULTS) return hist.slice(i + 1);
  }
  return hist;
}

// ---------------------------------------------------------------------------
// 환경설정 (localStorage)

interface Prefs {
  brush: BrushSettings;
  wand: WandSettings;
  marqueeShape: "rect" | "ellipse";
  lassoMode: "free" | "poly";
  kind: CutKind;
  /** 잔티 제거: 떨어진 이 크기(px) 이하 점을 지움, 0 = 끔 */
  despeckle: number;
  open: Record<string, boolean>;
}

const PREF_KEY = "mutoshop.prefs.v1";
const defaultPrefs: Prefs = {
  brush: { mode: "add", size: 80, hardness: 60, opacity: 100, auto: false, tolerance: 30 },
  wand: { tolerance: 32, contiguous: true, antialias: true, colorTol: 24 },
  marqueeShape: "rect",
  lassoMode: "free",
  kind: "tree",
  despeckle: 5,
  open: {},
};

/** 저장된 값은 필드를 골라서 읽는다. 통째로 펼치면 예전 버전이 저장한 'ultra(최고 품질) 켬' 같은
 *  메모리를 많이 쓰는 값이 되살아난다 */
function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return defaultPrefs;
    const p = JSON.parse(raw);
    if (!p || typeof p !== "object") return defaultPrefs;
    const d = defaultPrefs;
    return {
      brush: { ...d.brush, ...(p.brush && typeof p.brush === "object" ? p.brush : {}) },
      wand: { ...d.wand, ...(p.wand && typeof p.wand === "object" ? p.wand : {}) },
      marqueeShape: p.marqueeShape === "ellipse" ? "ellipse" : "rect",
      lassoMode: p.lassoMode === "poly" ? "poly" : "free",
      // 예전 버전은 종류 대신 AI 모델을 저장했다 (인물 모델 → 인물)
      kind: isKind(p.kind) ? p.kind : p.model === "portrait" ? "person" : d.kind,
      despeckle: Number.isFinite(p.despeckle) ? Math.max(0, Math.min(50, Math.round(p.despeckle))) : d.despeckle,
      open: p.open && typeof p.open === "object" ? p.open : {},
    };
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
        kind: s.kind, despeckle: s.despeckle, open: s.sectionsOpen,
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
  /** 마지막으로 저장(내보내기)한 파일 — 누끼 탭에 '저장됨'으로 보여 준다 */
  lastSave: { name: string; at: number; info: string } | null;

  tool: Tool;
  prevTool: Tool;
  brush: BrushSettings;
  wand: WandSettings;
  marqueeShape: "rect" | "ellipse";
  lassoMode: "free" | "poly";
  selMode: SelMode;
  /** 선택 영역 (픽셀은 selection.ts) — 바뀔 때마다 version 증가 */
  /** 선택 영역: 버전 · 경계 상자 · 선택된 픽셀 수 · 넓히기/줄이기 누적(px, 새로 고르면 0) */
  sel: { version: number; box: Box | null; area: number; grow: number };
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
  /** 누끼 종류 (나무·산·아이템·인물) — 사용자가 고르고, 저장된다 */
  kind: CutKind;
  /** 잔티 제거: 주요 객체와 떨어진 이 크기(px) 이하 점을 지움 (0 = 끔, 기본 5, 저장됨) */
  despeckle: number;
  /** 피사체 안쪽에 갇힌 배경색 처리 (저장 안 함, 종류를 바꾸면 '종류대로'로) */
  inner: Inner;
  /** 인물 사진의 머리카락 최고 품질 (느리고 메모리를 많이 씀 — 저장 안 함, 기본 끔) */
  fine: boolean;
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
  markSaved: (save?: { name: string; info: string }) => void;

  // UI
  set: (p: Partial<State>) => void;
  setTool: (t: Tool) => void;
  /** 종류만 바꾼다 (누끼를 다시 돌리지 않음) */
  setKind: (k: CutKind) => void;
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
  lastSave: null,

  tool: "hand",
  prevTool: "hand",
  brush: prefs.brush,
  wand: prefs.wand,
  marqueeShape: prefs.marqueeShape,
  lassoMode: prefs.lassoMode,
  selMode: "new",
  sel: { version: 0, box: null, area: 0, grow: 0 },
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
  kind: prefs.kind,
  despeckle: prefs.despeckle,
  inner: "auto",
  fine: false,
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
      lastSave: null,
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
    hist = capCutoutResults(hist);
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

  markSaved: (save) => set((s) => ({
    savedIndex: s.histIndex,
    lastSave: save ? { ...save, at: Date.now() } : s.lastSave,
  })),

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

  setKind: (k) => {
    if (k === get().kind) return;
    set({ kind: k, inner: "auto" });
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

// 누끼 종류·선택 도구 모양 변경도 저장
useStore.subscribe((s, p) => {
  if (s.kind !== p.kind || s.despeckle !== p.despeckle || s.marqueeShape !== p.marqueeShape || s.lassoMode !== p.lassoMode) savePrefs(s);
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
      if (d.cutout.rawMaskId) ref.add(d.cutout.rawMaskId);
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
