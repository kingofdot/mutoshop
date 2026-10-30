// 포토샵식 선택 도구의 마우스/키보드 동작.
// 선택 윤곽(사각형·원형), 올가미(자유·다각형), 자동 선택(마술봉), 펜 도구.
// 좌표는 모두 원본 px 로 저장하고, 화면 표시는 ToolOverlay 가 변환해서 그린다.
import { create } from "zustand";
import { screenToSource, sourceToScreen } from "./actions";
import { resources } from "./resources";
import {
  applySelection, beginSelBrush, clearSelection, combineSelection, endSelBrush, moveSelBrush, penRegion, polygonRegion, rectRegion,
  wandClick, withoutSelHistory,
  type SelApply,
} from "./selection";
import { useStore, type PenPath, type PenPoint, type SelMode } from "./store";

export type Draft =
  | { kind: "rect"; ellipse: boolean; x0: number; y0: number; x1: number; y1: number; mode: SelMode }
  | { kind: "lasso"; pts: number[]; mode: SelMode }
  | { kind: "poly"; pts: number[]; hover: [number, number] | null; mode: SelMode }
  | null;

export const useDraft = create<{ d: Draft }>(() => ({ d: null }));

type PenDrag =
  | { kind: "new"; index: number; moved: boolean }
  | { kind: "anchor"; index: number; sx: number; sy: number; orig: PenPoint }
  | { kind: "handle"; index: number; which: "hin" | "hout"; free: boolean };

let penDrag: PenDrag | null = null;

/** 마술봉·색 범위: 누른 채 움직이지 않고 떼면 클릭(색 고르기), 끌면 선택 붓 */
let wandDown: {
  x: number; y: number; sx: number; sy: number; mode: SelMode; color: boolean; add: boolean;
  brush: "no" | "on" | "skip";
} | null = null;

interface Ev {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey?: boolean;
}

/** Shift=더하기, Alt=빼기, Shift+Alt=교차, 아니면 옵션바에서 고른 모드 */
export function modeFromEvent(e: Ev): SelMode {
  if (e.shiftKey && e.altKey) return "and";
  if (e.shiftKey) return "add";
  if (e.altKey) return "sub";
  return "new";
}

const draft = () => useDraft.getState().d;
const setDraft = (d: Draft) => useDraft.setState({ d });

/** 화면에서 두 원본 좌표 사이 거리 (CSS px) */
function screenDist(ax: number, ay: number, bx: number, by: number) {
  const a = sourceToScreen(ax, ay);
  const b = sourceToScreen(bx, by);
  return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : Infinity;
}

const clone = (p: PenPath): PenPath => ({ closed: p.closed, pts: p.pts.map((q) => ({ ...q })) });
const setPath = (p: PenPath | null) => useStore.getState().set({ penPath: p });

// ---------------------------------------------------------------------------

/** 누르기. 끌기를 이어서 받아야 하면 true (포인터 캡처) */
export function toolDown(e: Ev, sx: number, sy: number): boolean {
  const s = useStore.getState();
  const p = screenToSource(sx, sy);
  const src = resources.source;
  if (!p || !src) return false;
  const [x, y] = p;

  switch (s.tool) {
    case "marquee":
      setDraft({ kind: "rect", ellipse: s.marqueeShape === "ellipse", x0: x, y0: y, x1: x, y1: y, mode: modeFromEvent(e) });
      return true;

    case "lasso": {
      if (s.lassoMode === "free") {
        setDraft({ kind: "lasso", pts: [x, y], mode: modeFromEvent(e) });
        return true;
      }
      const d = draft();
      if (d?.kind !== "poly") {
        setDraft({ kind: "poly", pts: [x, y], hover: [x, y], mode: modeFromEvent(e) });
        return false;
      }
      // 첫 점 근처를 누르면 닫기
      if (d.pts.length >= 6 && screenDist(x, y, d.pts[0], d.pts[1]) < 9) {
        finishPoly();
        return false;
      }
      setDraft({ ...d, pts: [...d.pts, x, y] });
      return false;
    }

    case "colorrange":
    case "wand":
      wandDown = {
        x, y, sx, sy, mode: modeFromEvent(e), color: s.tool === "colorrange",
        add: e.shiftKey && !e.altKey, brush: "no",
      };
      return true;

    case "pen":
      return penDown(e, x, y);
  }
  return false;
}

export function toolMove(e: Ev, sx: number, sy: number, dragging: boolean) {
  const s = useStore.getState();
  const p = screenToSource(sx, sy);
  if (!p) return;
  const [x, y] = p;
  const w = wandDown;
  if (w && dragging && (s.tool === "wand" || s.tool === "colorrange")) {
    if (w.brush === "no" && Math.hypot(sx - w.sx, sy - w.sy) >= 4) {
      w.brush = beginSelBrush(w.x, w.y, w.add, s.brush.size) ? "on" : "skip";
    }
    if (w.brush === "on") moveSelBrush(x, y);
    return;
  }
  const d = draft();
  if (s.tool === "marquee" && d?.kind === "rect" && dragging) {
    let x1 = x, y1 = y;
    if (e.shiftKey && d.mode !== "add") {
      // Shift 를 누른 채 끌면 정사각형/정원 (처음부터 Shift 로 시작한 '더하기'는 제외)
      const m = Math.max(Math.abs(x - d.x0), Math.abs(y - d.y0));
      x1 = d.x0 + Math.sign(x - d.x0 || 1) * m;
      y1 = d.y0 + Math.sign(y - d.y0 || 1) * m;
    }
    setDraft({ ...d, x1, y1 });
  } else if (s.tool === "lasso" && d?.kind === "lasso" && dragging) {
    const n = d.pts.length;
    if (screenDist(x, y, d.pts[n - 2], d.pts[n - 1]) >= 2) setDraft({ ...d, pts: [...d.pts, x, y] });
  } else if (s.tool === "lasso" && d?.kind === "poly") {
    setDraft({ ...d, hover: [x, y] });
  } else if (s.tool === "pen") {
    penMove(e, x, y);
  }
}

export function toolUp() {
  const s = useStore.getState();
  const w = wandDown;
  if (w) {
    wandDown = null;
    if (w.brush === "on") endSelBrush();
    else if (w.brush === "no" && resources.source) {
      const t0 = performance.now();
      wandClick(resources.source, w.x, w.y, w.mode, w.color ? "color" : "wand");
      if (performance.now() - t0 > 400) s.toast("넓은 영역을 선택했어요.", "info", 1500);
    }
    return;
  }
  const d = draft();
  if (s.tool === "marquee" && d?.kind === "rect") {
    setDraft(null);
    if (screenDist(d.x0, d.y0, d.x1, d.y1) < 3) {
      if (d.mode === "new") clearSelection(); // 그냥 클릭하면 선택 해제 (포토샵과 같음)
      return;
    }
    combineSelection(rectRegion(d.x0, d.y0, d.x1, d.y1, d.ellipse), d.mode);
  } else if (s.tool === "lasso" && d?.kind === "lasso") {
    setDraft(null);
    if (d.pts.length < 6) {
      if (d.mode === "new") clearSelection();
      return;
    }
    combineSelection(polygonRegion(d.pts), d.mode);
  } else if (s.tool === "pen") {
    if (penDrag?.kind === "new" && !penDrag.moved) {
      // 끌지 않고 클릭만 했으면 직선 점
      const path = useStore.getState().penPath;
      if (path) {
        const np = clone(path);
        const q = np.pts[penDrag.index];
        if (q) {
          q.hin = null;
          q.hout = null;
          setPath(np);
        }
      }
    }
    penDrag = null;
  }
}

export function toolDoubleClick() {
  const d = draft();
  if (useStore.getState().tool === "lasso" && d?.kind === "poly") finishPoly();
}

/** Enter / Backspace / Esc 처리. 처리했으면 true */
export function toolKey(e: KeyboardEvent): boolean {
  const s = useStore.getState();
  const d = draft();
  if (s.tool === "lasso" && d?.kind === "poly") {
    if (e.key === "Enter") {
      finishPoly();
      return true;
    }
    if (e.key === "Escape") {
      setDraft(null);
      return true;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      const pts = d.pts.slice(0, -2);
      setDraft(pts.length ? { ...d, pts } : null);
      return true;
    }
  }
  if (s.tool === "pen" && s.penPath) {
    if (e.key === "Enter") {
      penToSelection(modeFromEvent(e));
      return true;
    }
    if (e.key === "Escape") {
      setPath(null);
      return true;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      const np = clone(s.penPath);
      if (np.closed) np.closed = false;
      else np.pts.pop();
      setPath(np.pts.length ? np : null);
      return true;
    }
  }
  return false;
}

/** 진행 중인 그리기를 모두 취소 (도구를 바꿀 때) */
export function cancelDrafts() {
  setDraft(null);
  penDrag = null;
  if (wandDown?.brush === "on") endSelBrush();
  wandDown = null;
}

function finishPoly() {
  const d = draft();
  if (d?.kind !== "poly") return;
  setDraft(null);
  // 더블클릭으로 생긴 중복 점 제거
  const pts: number[] = [];
  for (let i = 0; i < d.pts.length; i += 2) {
    const n = pts.length;
    if (n && Math.hypot(pts[n - 2] - d.pts[i], pts[n - 1] - d.pts[i + 1]) < 0.5) continue;
    pts.push(d.pts[i], d.pts[i + 1]);
  }
  if (pts.length < 6) return;
  combineSelection(polygonRegion(pts), d.mode);
}

// ---------------------------------------------------------------------------
// 펜 도구

function penDown(e: Ev, x: number, y: number): boolean {
  const path = useStore.getState().penPath;
  if (path) {
    // 1) 핸들 잡기
    for (let i = path.pts.length - 1; i >= 0; i--) {
      const q = path.pts[i];
      for (const which of ["hout", "hin"] as const) {
        const h = q[which];
        if (h && screenDist(x, y, h.x, h.y) < 7) {
          penDrag = { kind: "handle", index: i, which, free: e.altKey };
          return true;
        }
      }
    }
    // 2) 기준점 잡기
    for (let i = 0; i < path.pts.length; i++) {
      const q = path.pts[i];
      if (screenDist(x, y, q.x, q.y) < 8) {
        if (!path.closed && i === 0 && path.pts.length >= 2) {
          // 첫 점을 누르면 경로 닫기 (끌면 곡선)
          const np = clone(path);
          np.closed = true;
          setPath(np);
          penDrag = { kind: "new", index: 0, moved: false };
          return true;
        }
        penDrag = { kind: "anchor", index: i, sx: x, sy: y, orig: { ...q } };
        return true;
      }
    }
    if (path.closed) {
      useStore.getState().toast("경로가 닫혔어요. Enter로 선택 영역을 만들거나, Esc로 지우고 새로 그리세요.", "info", 3000);
      return false;
    }
  }
  const np: PenPath = path ? clone(path) : { pts: [], closed: false };
  np.pts.push({ x, y, hin: null, hout: null });
  setPath(np);
  penDrag = { kind: "new", index: np.pts.length - 1, moved: false };
  return true;
}

function penMove(e: Ev, x: number, y: number) {
  const path = useStore.getState().penPath;
  if (!path || !penDrag) return;
  const np = clone(path);
  const q = np.pts[penDrag.index];
  if (!q) return;
  if (penDrag.kind === "new") {
    if (!penDrag.moved && screenDist(x, y, q.x, q.y) < 3) return;
    penDrag.moved = true;
    // 끈 방향이 나가는 핸들, 반대쪽은 대칭 (부드러운 곡선 점)
    q.hout = { x, y };
    q.hin = { x: 2 * q.x - x, y: 2 * q.y - y };
  } else if (penDrag.kind === "anchor") {
    const dx = x - penDrag.sx, dy = y - penDrag.sy;
    const o = penDrag.orig;
    q.x = o.x + dx;
    q.y = o.y + dy;
    q.hin = o.hin ? { x: o.hin.x + dx, y: o.hin.y + dy } : null;
    q.hout = o.hout ? { x: o.hout.x + dx, y: o.hout.y + dy } : null;
  } else {
    const which = penDrag.which;
    const other = which === "hin" ? "hout" : "hin";
    q[which] = { x, y };
    const op = q[other];
    // Alt 로 잡으면 반대쪽 핸들과 따로 움직임 (모서리 곡선)
    if (op && !(penDrag.free || e.altKey)) {
      const len = Math.hypot(op.x - q.x, op.y - q.y);
      const dl = Math.hypot(x - q.x, y - q.y) || 1;
      q[other] = { x: q.x - ((x - q.x) / dl) * len, y: q.y - ((y - q.y) / dl) * len };
    }
  }
  setPath(np);
}

/** 펜 경로 → 선택 영역 */
export function penToSelection(mode: SelMode = "new"): boolean {
  const s = useStore.getState();
  const path = s.penPath;
  if (!path || path.pts.length < 3) {
    s.toast("점을 3개 이상 찍어 영역을 감싸 주세요.", "info");
    return false;
  }
  combineSelection(penRegion(path), mode);
  setPath(null);
  return true;
}

/** 펜 경로로 바로 지우기/남기기 */
export function penApply(kind: SelApply) {
  // 펜 경로 → 선택 → 지우기 는 편집 한 단계로만 (Ctrl+Z 한 번에 되돌아가게)
  withoutSelHistory(() => {
    if (penToSelection("new")) {
      applySelection(kind);
      clearSelection();
    }
  });
}
