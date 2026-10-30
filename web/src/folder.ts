// 폴더 '하나씩 작업': 폴더를 고르면 맨 위 필름 줄에 사진들이 나오고, 눌러서 하나씩 열어 직접 작업한 뒤
// Ctrl+S 로 그 폴더 안의 '누끼' 폴더에 바로 저장한다. 결과 파일이 있는 사진은 '완료'로 표시된다.
// (파일 읽기·쓰기·미리보기는 서버의 폴더 작업 API 를 같이 쓴다 — 원본은 건드리지 않는다)
import { create } from "zustand";
import { isBatchActive, loadSourceData, renderExport, type ExportOptions } from "./actions";
import { confirmAsk } from "./dialog";
import { batchPick, batchRead, batchSave, batchScan } from "./lib/api";
import { clearPendingOrigin, expectOrigin, overwriteOriginal } from "./origin";
import { outFor, rememberOut, shortDir } from "./outs";
import { hasUnsaved, useStore } from "./store";

export interface FolderFile {
  rel: string;
  size: number;
}

interface FolderState {
  token: string | null;
  folder: string;
  out: string;
  files: FolderFile[];
  /** 결과 폴더에 저장된 사진 (작업 완료) */
  done: boolean[];
  /** 편집기에 열려 있는 사진 번호 (-1: 폴더 밖 사진이거나 없음) */
  current: number;
  /** 여는 중인 사진 번호 */
  loading: number | null;
  /** 저장하면 다음 '안 한' 사진을 바로 연다 */
  autoNext: boolean;
  /** 원본을 덮어쓴 사진의 미리보기 새로 고침 번호 */
  thumbVer: Record<number, number>;
}

const AUTO_KEY = "mutoshop.folder.autoNext";

export const useFolder = create<FolderState>(() => ({
  token: null,
  folder: "",
  out: "",
  files: [],
  done: [],
  current: -1,
  loading: null,
  thumbVer: {},
  autoNext: (() => {
    try {
      return localStorage.getItem(AUTO_KEY) !== "0";
    } catch {
      return true;
    }
  })(),
}));

export function setAutoNext(v: boolean) {
  useFolder.setState({ autoNext: v });
  try {
    localStorage.setItem(AUTO_KEY, v ? "1" : "0");
  } catch {
    /* 무시 */
  }
}

const toast = (t: string, k?: "info" | "success" | "error", ms?: number) => useStore.getState().toast(t, k, ms);

export const thumbUrl = (token: string, i: number, v = 0) => `/api/batch/${token}/thumb/${i}?s=144${v ? `&v=${v}` : ""}`;

/** 편집기에 사진이 새로 열리거나 닫히면: 필름 줄에서 연 것이면 그 번호, 아니면 -1 */
let pending: number | null = null;
useStore.subscribe((s, p) => {
  if (s.image !== p.image) {
    useFolder.setState({ current: s.image && pending !== null ? pending : -1 });
    pending = null;
  }
});

async function fetchDone(token: string): Promise<boolean[]> {
  const r = await fetch(`/api/batch/${token}/done`, { cache: "no-store" });
  if (!r.ok) throw new Error(`서버 오류 (${r.status})`);
  return (await r.json()).done as boolean[];
}

/** 서버의 폴더 정보가 만료됐으면(다른 폴더 작업을 여러 번 한 뒤 등) 같은 폴더를 다시 읽는다 */
async function refreshToken(): Promise<string | null> {
  const f = useFolder.getState();
  if (!f.folder) return null;
  try {
    const sc = await batchScan(f.folder, false, f.out || undefined);
    const same = sc.files.length === f.files.length && sc.files.every((x, i) => x.rel === f.files[i]?.rel);
    const done = await fetchDone(sc.token);
    useFolder.setState({ token: sc.token, out: sc.out, files: sc.files, done, ...(same ? {} : { current: -1 }) });
    return sc.token;
  } catch {
    return null;
  }
}

async function withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const t = useFolder.getState().token;
  if (!t) throw new Error("폴더가 열려 있지 않습니다.");
  try {
    return await fn(t);
  } catch (e) {
    if (!/만료|404/.test((e as Error).message)) throw e;
    const t2 = await refreshToken();
    if (!t2) throw e;
    return fn(t2);
  }
}

/** 폴더 고르기 → 필름 줄 열기 → 아직 안 한 첫 사진 열기 */
export async function openFolderWork() {
  if (isBatchActive()) {
    toast("폴더 작업이 끝난 뒤에 열어 주세요.", "info");
    return;
  }
  let p: string | null;
  try {
    p = await batchPick(useFolder.getState().folder, "하나씩 작업할 사진 폴더 선택");
  } catch (e) {
    toast(`폴더를 고르지 못했어요: ${(e as Error).message}`, "error");
    return;
  }
  if (!p) return;
  // 저장 위치: 이 폴더에 정해 둔 곳이 있으면 그곳, 처음이면 물어본다 (결과가 여기저기 섞이지 않게)
  let out = outFor(p);
  if (!out) {
    const def = `${p.replace(/[\\/]+$/, "")}\\누끼`;
    const ok = await confirmAsk({
      title: "결과를 어디에 저장할까요?",
      body: `기본: ${def}\n(이 사진 폴더에 대해 기억해 두고, 위쪽 필름 줄에서 언제든 바꿀 수 있어요)`,
      ok: "여기에 저장",
      cancel: "다른 폴더 고르기…",
    });
    out = def;
    if (!ok) {
      try {
        const q = await batchPick(p, "결과를 저장할 폴더 선택");
        if (q) out = q;
      } catch {
        /* 고르기 실패 → 기본 */
      }
    }
    rememberOut(p, out);
  }
  try {
    const sc = await batchScan(p, false, out);
    if (!sc.files.length) {
      toast("이 폴더에는 이미지가 없어요 (JPG·PNG·WEBP·HEIC 등).", "info", 5000);
      return;
    }
    const done = await fetchDone(sc.token);
    useFolder.setState({ token: sc.token, folder: sc.folder, out: sc.out, files: sc.files, done, current: -1, loading: null });
    const first = done.findIndex((d) => !d);
    toast(`사진 ${sc.files.length}장 · 완료 ${done.filter(Boolean).length}장 — Ctrl+S 로 ${shortDir(sc.out)} 에 저장`, "info", 5000);
    await openFolderItem(first >= 0 ? first : 0);
  } catch (e) {
    toast(`폴더를 열지 못했어요: ${(e as Error).message}`, "error", 6000);
  }
}

/** 저장 위치 바꾸기 (필름 줄의 '변경'): 고른 곳을 이 사진 폴더에 기억하고, 완료 표시를 그 기준으로 다시 */
export async function changeFolderOut() {
  const f = useFolder.getState();
  if (!f.token) return;
  let q: string | null = null;
  try {
    q = await batchPick(f.out || f.folder, "결과를 저장할 폴더 선택");
  } catch (e) {
    toast(`폴더를 고르지 못했어요: ${(e as Error).message}`, "error");
    return;
  }
  if (!q) return;
  if (q.replace(/[\\/]+$/, "").toLowerCase() === f.folder.replace(/[\\/]+$/, "").toLowerCase()) {
    toast("원본 사진 폴더와 같은 곳에는 저장하지 않아요 (원본을 덮어쓸 수 있어서). 다른 폴더를 골라 주세요.", "error", 6000);
    return;
  }
  try {
    const sc = await batchScan(f.folder, false, q);
    const done = await fetchDone(sc.token);
    rememberOut(f.folder, sc.out);
    useFolder.setState({ token: sc.token, out: sc.out, files: sc.files, done });
    toast(`저장 위치를 바꿨어요 → ${sc.out}`, "success", 4000);
  } catch (e) {
    toast(`저장 위치를 바꾸지 못했어요: ${(e as Error).message}`, "error", 6000);
  }
}

export function closeFolderWork() {
  pending = null;
  useFolder.setState({ token: null, folder: useFolder.getState().folder, out: "", files: [], done: [], current: -1, loading: null });
}

/** 필름 줄의 i 번째 사진을 편집기에 연다 (저장 안 한 편집이 있으면 먼저 묻는다) */
export async function openFolderItem(i: number) {
  const f = useFolder.getState();
  const st = useStore.getState();
  if (!f.token || i < 0 || i >= f.files.length || f.loading !== null) return;
  if (i === f.current && st.image) return;
  if (st.job) {
    toast("누끼 작업이 끝난 뒤에 열어 주세요.", "info");
    return;
  }
  if (hasUnsaved()) {
    const ok = await confirmAsk({
      title: "다른 사진을 열까요?",
      body: "저장하지 않은 편집 내용은 사라집니다. (Ctrl+S 로 누끼 폴더에 저장)",
      ok: "열기",
      cancel: "취소",
    });
    if (!ok) return;
  }
  useFolder.setState({ loading: i });
  try {
    const r = await withToken((t) => batchRead(t, i));
    const name = f.files[i].rel.split(/[\\/]/).pop() || f.files[i].rel;
    pending = i;
    const token = useFolder.getState().token;
    if (token) expectOrigin({ kind: "folder", token, index: i, name });
    loadSourceData(name, r.w, r.h, r.data);
  } catch (e) {
    pending = null;
    clearPendingOrigin();
    toast(`사진을 열지 못했어요: ${(e as Error).message}`, "error", 6000);
  } finally {
    useFolder.setState({ loading: null });
  }
}

/** 다음 / 이전 사진 (dir: +1 / -1). onlyTodo 면 아직 안 한 사진만 */
export function stepFolder(dir: 1 | -1, onlyTodo = false) {
  const f = useFolder.getState();
  const n = f.files.length;
  if (!f.token || !n) return;
  let i = f.current;
  for (let k = 0; k < n; k++) {
    i = i < 0 ? (dir > 0 ? 0 : n - 1) : i + dir;
    if (i < 0 || i >= n) return;
    if (!onlyTodo || !f.done[i]) {
      openFolderItem(i);
      return;
    }
  }
}

/** 지금 사진을 결과 폴더(기본: 고른 폴더 안의 '누끼')에 PNG 로 바로 저장. 투명 배경은 그대로 */
export async function saveToFolder(): Promise<boolean> {
  const f = useFolder.getState();
  const st = useStore.getState();
  if (!f.token || f.current < 0 || !st.image) return false;
  const i = f.current;
  try {
    const opts: ExportOptions = { format: "png", quality: 0.92, longSide: null, layout: "as-is", padding: 8 };
    const blob = await renderExport(opts);
    const r = await withToken((t) => batchSave(t, i, "png", "", blob, true));
    const shown = shortPath(r.path, useFolder.getState().out);
    const done = [...useFolder.getState().done];
    done[i] = true;
    useFolder.setState({ done });
    st.markSaved({ name: shown, info: `PNG · ${(blob.size / 1024 / 1024).toFixed(1)}MB` });
    const left = done.filter((d) => !d).length;
    toast(`저장했어요 · ${shown}${left ? ` · 남은 사진 ${left}장` : " · 모두 끝났어요!"}`, "success", 3500);
    if (useFolder.getState().autoNext && left) {
      const n = done.length;
      for (let k = 1; k < n; k++) {
        const j = (i + k) % n;
        if (!done[j]) {
          await openFolderItem(j);
          break;
        }
      }
    }
    return true;
  } catch (e) {
    toast(`저장하지 못했어요: ${(e as Error).message}`, "error", 6000);
    return false;
  }
}

/** 원본에 덮어쓰기 (필름 줄에서 연 사진이면 완료 표시 + 미리보기 새로 고침 + '저장 후 다음') */
export async function overwriteCurrent(): Promise<boolean> {
  const i = useFolder.getState().current;
  return overwriteOriginal((o) => {
    if (o.kind !== "folder") return;
    const f = useFolder.getState();
    const done = [...f.done];
    done[o.index] = true;
    useFolder.setState({ done, thumbVer: { ...f.thumbVer, [o.index]: (f.thumbVer[o.index] ?? 0) + 1 } });
    const left = done.filter((d) => !d).length;
    if (f.autoNext && left && i === o.index) {
      const n = done.length;
      for (let k = 1; k < n; k++) {
        const j = (i + k) % n;
        if (!done[j]) {
          openFolderItem(j);
          break;
        }
      }
    }
  });
}

/** Ctrl+S · 저장 버튼: 필름 줄에서 연 사진이면 누끼 폴더에 바로, 아니면 내보내기 창 */
export function saveCurrent() {
  const f = useFolder.getState();
  if (f.token && f.current >= 0) saveToFolder();
  else useStore.getState().set({ exportOpen: true });
}

function shortPath(path: string, out: string) {
  const sep = path.includes("\\") ? "\\" : "/";
  const outName = out.split(/[\\/]/).pop() || "누끼";
  const rel = path.startsWith(out) ? path.slice(out.length).replace(/^[\\/]+/, "") : path.split(/[\\/]/).pop() || path;
  return `${outName}${sep}${rel}`;
}
