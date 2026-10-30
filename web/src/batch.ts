// 폴더 일괄 누끼: 서버가 폴더의 사진을 한 장씩 읽기 → 누끼 → 외곽선·배경 → 결과 폴더에 복사본으로 저장하고
// (원본은 그대로), 화면은 진행 상황만 보여 준다. 예전처럼 사진마다 편집기(브라우저 WebGL)에 열면 큰 사진을
// 연달아 다룰 때 브라우저 메모리가 불어나 메모리가 적은 PC 에서 'Out of Memory' 가 났다.
import { create } from "zustand";
import { outFor, rememberOut } from "./outs";
import { getRenderer, setBatchActive, type ExportFormat, type ExportLayout } from "./actions";
import { fineFor, isInner, isKind, kindSec } from "./kinds";
import { batchRun, batchScan, batchStatus, batchStop } from "./lib/api";
import type { BatchFolder } from "./lib/api";
import { useStore } from "./store";
import { defaultOutline, type CutKind, type Inner, type Outline } from "./types";

export interface BatchSettings {
  /** 저장 형식 버전 (기본값이 바뀌었을 때 예전 설정을 맞추는 용도) */
  ver: number;
  folder: string;
  recursive: boolean;
  /** 비우면 기본 위치 (고른 폴더 안의 '누끼' 폴더) */
  out: string;
  /** 무엇을 따는지 (나무·산·아이템·인물) — 폴더마다 사용자가 고른다. 편집기의 종류와는 따로 저장 */
  kind: CutKind;
  /** 피사체 안쪽에 갇힌 배경색: 종류대로 / 남기기 / 지우기 (종류를 바꾸면 '종류대로'로) */
  inner: Inner;
  /** 인물 사진의 머리카락 최고 품질 (느리고 메모리를 많이 씀 — 저장하지 않고 매번 직접 켬) */
  fine: boolean;
  /** 이미 투명한 PNG 는 누끼를 다시 따지 않고 그 투명도를 그대로 */
  keepAlpha: boolean;
  /** 잔티 제거: 주요 객체와 떨어진 이 크기(px) 이하 점을 지움 (0 = 끔) */
  despeckle: number;
  outline: Outline;
  /** auto: 1024 이하 사진 1px · 넘으면 2px / px: 모든 사진 같은 두께 / pct: 사진 긴 변의 % */
  widthUnit: "auto" | "px" | "pct";
  /** widthUnit 이 pct 일 때: 사진 긴 변의 % */
  widthPct: number;
  bg: "transparent" | "color";
  bgColor: string;
  format: ExportFormat;
  quality: number; // 50..100
  longSide: number | null;
  layout: ExportLayout;
  padding: number;
  suffix: string;
  skipExisting: boolean;
}

export type ItemStatus = "pending" | "running" | "done" | "warn" | "skipped" | "error" | "stopped";
export interface BatchItem {
  status: ItemStatus;
  msg?: string;
  ms?: number;
}

const KEY = "mutoshop.batch.v1";

const defaults = (): BatchSettings => ({
  ver: 3,
  folder: "",
  recursive: false,
  out: "",
  kind: "tree",
  inner: "auto",
  fine: false,
  keepAlpha: true,
  despeckle: 5,
  outline: { ...defaultOutline(), fill: "solid" },
  widthUnit: "auto",
  widthPct: 0.5,
  bg: "transparent",
  bgColor: "#ffffff",
  format: "png",
  quality: 92,
  longSide: null,
  layout: "as-is",
  padding: 8,
  suffix: "",
  skipExisting: true,
});

/** '고급 설정'의 기본값 (폴더·저장 위치·종류·외곽선은 빼고) */
export const ADVANCED_KEYS = [
  "recursive", "inner", "fine", "keepAlpha", "skipExisting", "bg", "bgColor", "format", "quality",
  "longSide", "layout", "padding", "suffix",
] as const satisfies readonly (keyof BatchSettings)[];

export function advancedDefaults(): Pick<BatchSettings, (typeof ADVANCED_KEYS)[number]> {
  const d = defaults();
  return Object.fromEntries(ADVANCED_KEYS.map((k) => [k, d[k]])) as Pick<BatchSettings, (typeof ADVANCED_KEYS)[number]>;
}

/** 예전에 쓰던 설정 이름 (누끼 방식·모델·강도 등) — 읽지 않고 지운다. 특히 예전 기본값 strength:"ultra" 는
 *  메모리를 많이 쓰므로 절대 되살리지 않는다 */
const LEGACY_KEYS = ["mode", "itemHoles", "model", "strength", "holes", "colorKey", "fringe", "photo"];

function load(): BatchSettings {
  const d = defaults();
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "null");
    if (p && typeof p === "object") {
      // 설정 버전 2: 외곽선 기본값이 '가운데 · 2px' 로 바뀜 → 예전에 저장된 값도 한 번 맞춰 준다
      if ((p.ver ?? 1) < 2) p.outline = { ...p.outline, position: d.outline.position, width: d.outline.width };
      // 설정 버전 3: 누끼 방식·모델·강도 대신 사용자가 고르는 '종류'(나무·산·아이템·인물)
      if ((p.ver ?? 1) < 3 || !isKind(p.kind)) {
        if (!isKind(p.kind)) p.kind = p.mode === "item" ? "item" : p.model === "portrait" ? "person" : d.kind;
        if (!isInner(p.inner)) p.inner = p.mode === "item" && p.itemHoles ? "remove" : "auto";
      }
      for (const k of LEGACY_KEYS) delete p[k];
      return {
        ...d, ...p, ver: 4,
        outline: { ...d.outline, ...(p.outline && typeof p.outline === "object" ? p.outline : {}) },
        kind: isKind(p.kind) ? p.kind : d.kind,
        inner: isInner(p.inner) ? p.inner : d.inner,
        fine: false, // 머리카락 최고 품질은 매번 직접 켠다
        // 설정 버전 4: 두께 기본이 '자동'으로 — 예전 기본값(2px) 그대로였으면 자동으로 바꾼다
        widthUnit: p.widthUnit === "pct" ? "pct" : p.widthUnit === "auto" || ((p.ver ?? 1) < 4 && (p.outline?.width ?? 2) === 2) ? "auto" : "px",
      };
    }
  } catch {
    /* 저장된 설정이 깨졌으면 기본값 */
  }
  return d;
}

/** 서버(server/batch.py)로 보내는 처리 설정. 폴더·저장 위치는 scan 토큰이 이미 알고 있다 */
export function toServerSettings(s: BatchSettings) {
  return {
    kind: s.kind,
    inner: s.inner,
    fine: fineFor(s.kind, s.fine),
    keepAlpha: s.keepAlpha,
    despeckle: s.despeckle,
    skipExisting: s.skipExisting,
    outline: { ...s.outline },
    widthUnit: s.widthUnit,
    widthPct: s.widthPct,
    bg: s.bg,
    bgColor: s.bgColor,
    format: s.format,
    quality: s.quality,
    longSide: s.longSide,
    layout: s.layout,
    padding: s.padding,
    suffix: s.suffix,
  };
}

interface BatchState {
  open: boolean;
  phase: "setup" | "running" | "done";
  scan: BatchFolder | null;
  scanning: boolean;
  error: string | null;
  items: BatchItem[];
  index: number;
  started: number;
  finished: number;
  stopping: boolean;
  /** 지금 처리 중인 사진의 단계 메시지·진행률 (서버에서) */
  message: string;
  progress: number;
  settings: BatchSettings;
  set: (p: Partial<BatchState>) => void;
  setSettings: (p: Partial<BatchSettings>) => void;
  setOutline: (p: Partial<Outline>) => void;
}

let saveTimer = 0;
const persist = (s: BatchSettings) => {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...s, fine: false }));
    } catch {
      /* 저장 실패는 무시 */
    }
  }, 300);
};

export const useBatch = create<BatchState>((set, get) => ({
  open: false,
  phase: "setup",
  scan: null,
  scanning: false,
  error: null,
  items: [],
  index: -1,
  started: 0,
  finished: 0,
  stopping: false,
  message: "",
  progress: 0,
  settings: load(),
  set: (p) => set(p),
  setSettings: (p) => {
    const prev = get().settings;
    const q = { ...p };
    if (q.folder !== undefined && q.folder !== prev.folder && q.out === undefined) q.out = outFor(q.folder) ?? "";
    if (q.out !== undefined && q.out !== prev.out) rememberOut(q.folder ?? prev.folder, q.out);
    const settings = { ...prev, ...q };
    set({ settings });
    persist(settings);
  },
  setOutline: (p) => get().setSettings({ outline: { ...get().settings.outline, ...p } }),
}));

/** 장당 대략 걸리는 시간 (초): 종류별 누끼 + 저장 1초 */
export const perImageSec = (s: Pick<BatchSettings, "kind" | "fine">) => kindSec(s.kind, s.fine) + 1;

export const outExt = (f: ExportFormat) => (f === "jpeg" ? "jpg" : f);

/** 외곽선 두께 (원본 px). 자동이면 1024 이하 1px · 넘으면 2px, % 단위면 사진 긴 변 기준 */
export function outlineWidth(s: BatchSettings, w: number, h: number) {
  if (s.widthUnit === "auto") return Math.max(w, h) <= 1024 ? 1 : 2;
  return s.widthUnit === "pct"
    ? Math.max(1, Math.round((Math.max(w, h) * s.widthPct) / 100))
    : Math.max(1, s.outline.width);
}

export async function scanFolder() {
  const b = useBatch.getState();
  const { folder, recursive, out } = b.settings;
  if (!folder.trim() || b.phase === "running") return;
  b.set({ scanning: true, error: null });
  try {
    const scan = await batchScan(folder.trim(), recursive, out.trim() || undefined);
    if (useBatch.getState().phase === "running") return; // 그 사이 작업이 시작됨
    useBatch.getState().set({ scan, scanning: false, items: [] });
    if (scan.folder !== folder) useBatch.getState().setSettings({ folder: scan.folder });
  } catch (e) {
    useBatch.getState().set({ scan: null, scanning: false, error: (e as Error).message });
  }
}

let stopFlag = false;

export function stopBatch() {
  stopFlag = true;
  useBatch.getState().set({ stopping: true });
  const sc = useBatch.getState().scan;
  if (sc) batchStop(sc.token).catch(() => undefined);
}

interface WakeLockNav {
  wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startBatch() {
  const b = useBatch.getState();
  const st = b.settings;
  if (!b.scan || b.phase === "running") return;
  if (useStore.getState().job) {
    // 편집기 누끼와 폴더 작업이 동시에 돌면 메모리를 두 배로 쓴다
    useBatch.getState().set({ error: "편집기에서 누끼를 따는 중이에요. 끝난 뒤에 시작해 주세요.", phase: "setup" });
    return;
  }
  let sc: BatchFolder;
  try {
    // 시작할 때 폴더를 다시 읽는다 (그 사이 바뀐 파일·서버 재시작에도 안전하게)
    sc = await batchScan(st.folder.trim(), st.recursive, st.out.trim() || undefined);
    if (!sc.files.length) throw new Error("이 폴더에는 이미지가 없어요.");
    await batchRun(sc.token, toServerSettings(st));
  } catch (e) {
    useBatch.getState().set({ error: (e as Error).message, phase: b.phase === "done" ? "setup" : b.phase });
    return;
  }

  setBatchActive(true); // 처리 중에는 편집기에서 다른 사진을 열지 않는다 (붙여넣기·끌어다 놓기 포함)
  getRenderer()?.trim(); // 처리하는 동안 편집기의 다시 만들 수 있는 GPU 메모리는 돌려준다 (화면은 그대로)
  stopFlag = false;
  const n = sc.files.length;
  b.set({
    scan: sc, phase: "running", items: sc.files.map(() => ({ status: "pending" })), index: -1,
    started: Date.now(), finished: 0, stopping: false, error: null, message: "준비 중", progress: 0,
  });
  const title = document.title;
  let lock: { release: () => Promise<void> } | null = null;
  try {
    lock = (await (navigator as unknown as WakeLockNav).wakeLock?.request("screen")) ?? null; // 처리 중 화면 꺼짐·절전 방지
  } catch {
    lock = null;
  }
  let misses = 0;
  try {
    for (;;) {
      await sleep(500);
      let r;
      try {
        r = await batchStatus(sc.token);
        misses = 0;
      } catch {
        if (++misses > 20) throw new Error("서버와 연결이 끊겼어요. 프로그램을 다시 켜고 '남은 것 다시'를 눌러 주세요.");
        continue;
      }
      useBatch.getState().set({ items: r.items, index: r.index, message: r.message, progress: r.progress });
      const done = r.items.filter((x) => x.status !== "pending" && x.status !== "running").length;
      document.title = `(${Math.min(n, done + 1)}/${n}) MUTOSHOP 폴더 작업`;
      if (r.state !== "running") break;
    }
  } catch (e) {
    useBatch.getState().set({ error: (e as Error).message });
  } finally {
    setBatchActive(false);
    document.title = title;
    lock?.release().catch(() => undefined);
    useBatch.getState().set({ phase: "done", finished: Date.now(), stopping: false, index: -1 });
    const items2 = useBatch.getState().items;
    const ok = items2.filter((x) => x.status === "done" || x.status === "warn").length;
    const bad = items2.filter((x) => x.status === "error").length;
    useStore.getState().toast(
      stopFlag ? `폴더 작업을 중지했어요 · ${ok}장 저장` : `폴더 작업 완료 · ${ok}장 저장${bad ? ` · 실패 ${bad}장` : ""}`,
      bad ? "error" : "success", 6000,
    );
  }
}

/** 남은 시간 추정 (초). 처리한 사진들의 평균으로, 아직 없으면 종류별 대략값 */
export function etaSeconds(s: BatchState): number | null {
  const left = s.items.filter((x) => x.status === "pending").length + (s.index >= 0 ? 1 : 0);
  if (!left) return 0;
  const doneMs = s.items.filter((x) => x.ms !== undefined).map((x) => x.ms!);
  const per = doneMs.length ? doneMs.reduce((a, v) => a + v, 0) / doneMs.length / 1000
    : perImageSec(s.settings);
  return Math.round(per * left);
}
