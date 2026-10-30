// 포토샵식 선택 영역. 픽셀은 원본 크기의 Uint8Array(0..255)로 여기에 두고,
// 스토어에는 버전과 경계 상자만 둔다. 선택을 바꿀 때마다 따로 기록해 두어 Ctrl+Z 로 한 단계씩 되돌린다
// (편집 기록과 섞이면 더 최근에 한 쪽부터).
// 선택 영역을 마스크에 적용(지우기/되살리기/남기기)할 때 RasterOp 로 기록된다.
import { newId, resources, type SourceImage } from "./resources";
import { useStore, type Box, type PenPath, type SelMode } from "./store";
import type { RasterOp } from "./types";

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  data: Uint8Array; // w*h
}

let selData: Uint8Array | null = null;
let selW = 0;
let selH = 0;
let version = 0;

/** dirty: 이번에 바뀐 부분만 (선택 붓) — 없으면 전체를 다시 올린다 */
export function getSelection(): { data: Uint8Array; w: number; h: number; dirty: Box | null } | null {
  return selData ? { data: selData, w: selW, h: selH, dirty: selDirty } : null;
}

let selArea = 0;
let selDirty: Box | null = null;

function publish(box: Box | null, grow = 0) {
  if (!box) selData = null;
  try {
    useStore.getState().set({ sel: { version: ++version, box, area: box ? selArea : 0, grow: box ? grow : 0 } });
  } finally {
    selDirty = null;
  }
}

// ---------------------------------------------------------------------------
// 선택 기록 (Ctrl+Z). 선택 영역은 대부분 0/255 의 긴 줄이라 (값, 길이) 묶음으로 줄여 보관하고,
// 잘 안 줄어드는 자글자글한 선택만 그대로 복사한다. 전체 크기를 제한해 메모리를 지킨다.

interface SelSnap {
  runs: Uint32Array | null; // (값<<24 | 길이)
  raw: Uint8Array | null;
  w: number; h: number; box: Box | null; area: number; grow: number;
  t: number; tag: string;
}
const selUndo: SelSnap[] = [];
const selRedo: SelSnap[] = [];
const SEL_HISTORY = 40;
const SEL_BYTES = 96 * 1024 * 1024;
/** 되돌린 순서 — 다시 실행은 이 반대로 */
const redoOrder: ("sel" | "doc")[] = [];
let quiet = 0; // 허용치를 바꿔 다시 고를 때 등은 기록하지 않는다

function encodeRuns(d: Uint8Array): Uint32Array | null {
  const limit = d.length >> 3; // 원본의 절반(바이트)보다 커지면 그냥 복사하는 게 낫다
  let buf = new Uint32Array(Math.min(limit, 4096) || 1);
  let n = 0;
  let i = 0;
  while (i < d.length) {
    const v = d[i];
    let j = i + 1;
    while (j < d.length && d[j] === v && j - i < 0xffffff) j++;
    if (n >= buf.length) {
      if (n >= limit) return null;
      const b2 = new Uint32Array(Math.min(limit, buf.length * 2));
      b2.set(buf);
      buf = b2;
    }
    buf[n++] = ((v << 24) | (j - i)) >>> 0;
    i = j;
  }
  return buf.slice(0, n);
}

function decodeRuns(r: Uint32Array, len: number): Uint8Array {
  const d = new Uint8Array(len);
  let i = 0;
  for (let k = 0; k < r.length; k++) {
    const v = r[k] >>> 24, n = r[k] & 0xffffff;
    if (v) d.fill(v, i, i + n);
    i += n;
  }
  return d;
}

function snap(tag = ""): SelSnap {
  const s = useStore.getState().sel;
  const runs = selData ? encodeRuns(selData) : null;
  const raw = selData && !runs ? selData.slice() : null;
  return { runs, raw, w: selW, h: selH, box: s.box, area: s.area, grow: s.grow, t: performance.now(), tag };
}

const bytesOf = (s: SelSnap) => (s.runs ? s.runs.byteLength : 0) + (s.raw ? s.raw.byteLength : 0);

function trim(stack: SelSnap[]) {
  let total = 0;
  for (const s of stack) total += bytesOf(s);
  while (stack.length > 1 && (stack.length > SEL_HISTORY || total > SEL_BYTES)) total -= bytesOf(stack.shift()!);
}

/** 선택을 바꾸기 직전에 부른다. tag 가 같고 바로 이어지면(⊞ 꾹 누르기 등) 한 단계로 합친다 */
function remember(tag = "") {
  if (quiet) return;
  const top = selUndo[selUndo.length - 1];
  const now = performance.now();
  if (top && tag && top.tag === tag && now - top.t < 900) {
    top.t = now;
    return;
  }
  if (top && !selData && !top.runs && !top.raw) return; // 빈 선택이 이어지면 한 번만
  selUndo.push(snap(tag));
  trim(selUndo);
  selRedo.length = 0;
}

function restore(sn: SelSnap) {
  const src = resources.source;
  lastWand = null;
  const data = sn.runs ? decodeRuns(sn.runs, sn.w * sn.h) : sn.raw;
  if (!data || !src || sn.w !== src.w || sn.h !== src.h) {
    selData = null;
    publish(null);
    return;
  }
  selData = data; // 꺼낸 기록은 다시 안 쓰므로 그대로
  selW = sn.w;
  selH = sn.h;
  selArea = sn.area;
  publish(sn.box, sn.grow);
}

/** fn 동안의 선택 변경은 기록하지 않는다 (펜으로 바로 지우기 등 — 편집 한 단계로만 남게) */
export function withoutSelHistory<T>(fn: () => T): T {
  quiet++;
  try {
    return fn();
  } finally {
    quiet--;
  }
}

/** Ctrl+Z: 선택을 바꾼 게 마지막 편집보다 나중이면 선택을 한 단계 되돌리고, 아니면 편집을 되돌린다 */
export function undoStep() {
  const st = useStore.getState();
  const top = selUndo[selUndo.length - 1];
  const docT = st.histIndex > 0 ? st.hist[st.histIndex]?.time ?? 0 : -1;
  if (top && top.t >= docT) {
    selRedo.push(snap());
    restore(selUndo.pop()!);
    redoOrder.push("sel");
    return;
  }
  if (st.histIndex > 0) {
    st.undo();
    redoOrder.push("doc");
  }
}

/** Ctrl+Shift+Z: 되돌린 순서의 반대로 다시 */
export function redoStep() {
  const st = useStore.getState();
  while (redoOrder.length) {
    const k = redoOrder.pop()!;
    if (k === "sel" && selRedo.length) {
      const cur = snap();
      restore(selRedo.pop()!);
      selUndo.push(cur);
      trim(selUndo);
      return;
    }
    if (k === "doc" && st.histIndex < st.hist.length - 1) {
      st.redo();
      return;
    }
  }
  st.redo(); // 기록 패널에서 되돌린 경우 등
}

/** 되돌릴 / 다시 할 게 있는지 (선택 기록 포함) — 실행 취소 단추 */
export const canUndoStep = () => selUndo.length > 0 || useStore.getState().histIndex > 0;
export const canRedoStep = () => {
  const s = useStore.getState();
  return selRedo.length > 0 || s.histIndex < s.hist.length - 1;
};

// 다른 사진을 열면 선택 기록은 버린다
useStore.subscribe((s, p) => {
  if (s.image !== p.image) {
    selUndo.length = 0;
    selRedo.length = 0;
    redoOrder.length = 0;
  }
});

export function clearSelection() {
  if (selData) remember();
  selData = null;
  publish(null);
}

/** 경계 상자 (+ 선택된 픽셀 수를 selArea 에) */
function bboxOf(data: Uint8Array, w: number, h: number): Box | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  let area = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) {
      const v = data[row + x];
      if (v) {
        if (v >= 128) area++;
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first >= 0) {
      if (first < x0) x0 = first;
      if (last > x1) x1 = last;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  selArea = area;
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 새 영역을 현재 선택과 합친다 (새 선택 / 더하기 / 빼기 / 교차) */
export function combineSelection(r: Region | null, mode: SelMode) {
  const src = resources.source;
  if (!src) return;
  remember();
  quiet++; // 안에서 부르는 clearSelection 이 또 기록하지 않게
  try {
    combineInto(src, r, mode);
  } finally {
    quiet--;
  }
}

function combineInto(src: SourceImage, r: Region | null, mode: SelMode) {
  const W = src.w, H = src.h;
  if (!selData || selW !== W || selH !== H) {
    selData = null;
    if (mode === "sub" || mode === "and") {
      if (mode === "and") clearSelection();
      return;
    }
  }
  if (mode === "new" || !selData) {
    selData = new Uint8Array(W * H);
    selW = W;
    selH = H;
  }
  const d = selData;
  if (r) {
    for (let y = 0; y < r.h; y++) {
      const sy = r.y + y;
      if (sy < 0 || sy >= H) continue;
      for (let x = 0; x < r.w; x++) {
        const sx = r.x + x;
        if (sx < 0 || sx >= W) continue;
        const v = r.data[y * r.w + x];
        const i = sy * W + sx;
        if (mode === "sub") d[i] = Math.min(d[i], 255 - v);
        else if (mode === "and") d[i] = Math.min(d[i], v);
        else d[i] = Math.max(d[i], v);
      }
    }
  }
  if (mode === "and") {
    // 영역 밖은 모두 해제
    for (let y = 0; y < H; y++) {
      const inY = r && y >= r.y && y < r.y + r.h;
      for (let x = 0; x < W; x++) {
        if (!inY || x < r!.x || x >= r!.x + r!.w) d[y * W + x] = 0;
      }
    }
  }
  publish(bboxOf(d, W, H));
}

export function selectAll() {
  const src = resources.source;
  if (!src) return;
  remember();
  selData = new Uint8Array(src.w * src.h).fill(255);
  selW = src.w;
  selH = src.h;
  selArea = src.w * src.h;
  publish({ x: 0, y: 0, w: src.w, h: src.h });
}

export function invertSelection() {
  const src = resources.source;
  if (!src) return;
  if (!selData) {
    selectAll();
    return;
  }
  remember();
  for (let i = 0; i < selData.length; i++) selData[i] = 255 - selData[i];
  publish(bboxOf(selData, selW, selH));
}

// ---------------------------------------------------------------------------
// 마술봉 다시 계산: 허용치·인접·앤티 앨리어스를 바꾸면 방금 클릭한 자리를 새 값으로 다시 선택한다
// (클릭 전 선택 + 클릭 영역 + 그 뒤에 넓히기/줄이기 한 만큼). 다른 방법으로 선택을 바꾸면 기록은 끝난다.

interface WandOp {
  src: SourceImage; x: number; y: number; mode: SelMode; base: Uint8Array | null; version: number; grow: number;
  /** wand: 마술봉 (이어진 곳, 설정대로) / color: 색 범위 (사진 전체에서 비슷한 색) */
  tool: "wand" | "color";
}

/** 도구별 선택 영역: 색 범위는 이어지지 않은 곳까지 사진 전체에서 */
function regionFor(op: Pick<WandOp, "src" | "x" | "y" | "tool">) {
  const w = useStore.getState().wand;
  return op.tool === "color"
    ? wandRegion(op.src, op.x, op.y, w.colorTol, false, w.antialias)
    : wandRegion(op.src, op.x, op.y, w.tolerance, w.contiguous, w.antialias);
}
let lastWand: WandOp | null = null;
let wandTimer = 0;

export function wandClick(src: SourceImage, x: number, y: number, mode: SelMode, tool: "wand" | "color" = "wand") {
  const base = selData && selW === src.w && selH === src.h && mode !== "new" ? selData.slice() : null;
  combineSelection(regionFor({ src, x, y, tool }), mode);
  lastWand = { src, x, y, mode, base, version, grow: 0, tool };
}

function refreshWand() {
  const op = lastWand;
  if (!op || op.version !== version || resources.source !== op.src) {
    lastWand = null;
    return;
  }
  if (op.base) {
    selData = op.base.slice();
    selW = op.src.w;
    selH = op.src.h;
  } else selData = null;
  // 허용치만 바꾼 것 — 같은 선택 단계로 본다 (Ctrl+Z 하면 클릭 전으로)
  withoutSelHistory(() => {
    combineSelection(regionFor(op), op.mode);
    if (op.grow) growBy(op.grow, op.grow);
  });
  op.version = version;
}

useStore.subscribe((s, p) => {
  if (s.wand !== p.wand && lastWand) {
    clearTimeout(wandTimer);
    wandTimer = window.setTimeout(refreshWand, 40); // 끄는 동안은 잠깐씩만 (큰 사진에서 버벅이지 않게)
  }
});

// ---------------------------------------------------------------------------
// 선택 붓: 마술봉·색 범위에서 끌어서 문지르면 선택에서 빼기 (Shift+끌기: 더하기).
// 붓 크기는 브러시와 같이 쓴다 ([ ] 키). 한 번 문지른 게 실행 취소 한 단계.

interface SelBrush { add: boolean; r: number; lx: number; ly: number; dirty: Box | null; raf: number }
let selBrush: SelBrush | null = null;

/** 문지르기 시작. 뺄 선택이 없으면 false */
export function beginSelBrush(x: number, y: number, add: boolean, size: number): boolean {
  const src = resources.source;
  if (!src) return false;
  const has = !!selData && selW === src.w && selH === src.h;
  if (!has && !add) return false;
  remember();
  if (!has) {
    selData = new Uint8Array(src.w * src.h);
    selW = src.w;
    selH = src.h;
  }
  lastWand = null; // 붓으로 고친 뒤 허용치를 바꿔도 덮어쓰지 않게
  selBrush = { add, r: Math.max(0.5, size / 2), lx: x, ly: y, dirty: null, raf: 0 };
  stampSeg(selBrush, x, y, x, y);
  return true;
}

export function moveSelBrush(x: number, y: number) {
  const b = selBrush;
  if (!b) return;
  stampSeg(b, b.lx, b.ly, x, y);
  b.lx = x;
  b.ly = y;
}

export function endSelBrush() {
  const b = selBrush;
  if (!b) return;
  selBrush = null;
  if (b.raf) cancelAnimationFrame(b.raf);
  if (!selData) return;
  selDirty = b.dirty;
  publish(bboxOf(selData, selW, selH)); // 끝나면 경계 상자·넓이를 정확히
}

/** 선분(둥근 끝) 모양으로 칠하기 — 가장자리 1px 은 부드럽게 */
function stampSeg(b: SelBrush, ax: number, ay: number, bx: number, by: number) {
  const d = selData;
  if (!d) return;
  const W = selW, H = selH, r = b.r;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), x1 = Math.min(W, Math.ceil(Math.max(ax, bx) + r + 1));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y1 = Math.min(H, Math.ceil(Math.max(ay, by) + r + 1));
  if (x1 <= x0 || y1 <= y0) return;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  for (let y = y0; y < y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x < x1; x++) {
      const px = x + 0.5;
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const cov = r + 0.5 - Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (cov <= 0) continue;
      const v = cov >= 1 ? 255 : Math.round(cov * 255);
      const i = y * W + x;
      if (b.add) {
        if (d[i] < v) d[i] = v;
      } else if (d[i] > 255 - v) d[i] = 255 - v;
    }
  }
  const bx0 = b.dirty ? Math.min(b.dirty.x, x0) : x0, by0 = b.dirty ? Math.min(b.dirty.y, y0) : y0;
  const bx1 = b.dirty ? Math.max(b.dirty.x + b.dirty.w, x1) : x1, by1 = b.dirty ? Math.max(b.dirty.y + b.dirty.h, y1) : y1;
  b.dirty = { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
  // 화면에는 한 프레임에 한 번만 (큰 사진에서도 부드럽게)
  if (!b.raf) {
    b.raf = requestAnimationFrame(() => {
      b.raf = 0;
      if (selBrush !== b || !b.dirty) return;
      const cur = useStore.getState().sel;
      let box = cur.box;
      if (b.add || !box) {
        const u = b.dirty;
        box = box
          ? (() => {
              const ux0 = Math.min(box!.x, u.x), uy0 = Math.min(box!.y, u.y);
              return { x: ux0, y: uy0, w: Math.max(box!.x + box!.w, u.x + u.w) - ux0, h: Math.max(box!.y + box!.h, u.y + u.h) - uy0 };
            })()
          : { ...u };
      }
      selArea = cur.area; // 문지르는 동안은 예전 값 — 끝나면 다시 센다
      selDirty = b.dirty;
      b.dirty = null;
      publish(box);
    });
  }
}

/** 선택 영역을 n px 넓히거나(+) 좁힌다(−). 포토샵 '선택 › 수정 › 확대/축소'와 같다.
 *  1px 마다 이웃 8칸의 최댓값(넓히기)·최솟값(좁히기) — 부드러운(안티앨리어스) 가장자리는 그대로 유지된다.
 *  사진 테두리에 닿은 선택은 좁혀도 테두리에서 떨어지지 않는다 */
export function growSelection(n: number) {
  if (!selData) return;
  remember("grow");
  const follow = !!lastWand && lastWand.version === version;
  growBy(n, useStore.getState().sel.grow + n);
  if (follow && lastWand) {
    lastWand.grow += n;
    lastWand.version = version;
  }
}

function growBy(n: number, total: number) {
  const box = useStore.getState().sel.box;
  if (!selData || !box || !n) return;
  const W = selW, H = selH;
  const steps = Math.abs(n);
  const grow = n > 0;
  // 작업 범위: 경계 상자 + 넓어질 만큼 (밖은 전부 0 이라 계산할 필요 없음)
  const x0 = Math.max(0, box.x - steps - 1), y0 = Math.max(0, box.y - steps - 1);
  const x1 = Math.min(W, box.x + box.w + steps + 1), y1 = Math.min(H, box.y + box.h + steps + 1);
  const w = x1 - x0, h = y1 - y0;
  let a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) a.set(selData.subarray((y0 + y) * W + x0, (y0 + y) * W + x1), y * w);
  let b = new Uint8Array(w * h);
  for (let s = 0; s < steps; s++) {
    // 3×3 최대/최소를 가로 → 세로 두 번으로 (작업 범위 밖 이웃은 없는 것으로 = 테두리는 그대로)
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        let v = a[r + x];
        if (x > 0) { const u = a[r + x - 1]; if (grow ? u > v : u < v) v = u; }
        if (x < w - 1) { const u = a[r + x + 1]; if (grow ? u > v : u < v) v = u; }
        b[r + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        let v = b[r + x];
        if (y > 0) { const u = b[r - w + x]; if (grow ? u > v : u < v) v = u; }
        if (y < h - 1) { const u = b[r + w + x]; if (grow ? u > v : u < v) v = u; }
        a[r + x] = v;
      }
    }
  }
  for (let y = 0; y < h; y++) selData.set(a.subarray(y * w, (y + 1) * w), (y0 + y) * W + x0);
  a = b = new Uint8Array(0);
  publish(bboxOf(selData, W, H), total);
}

/** 선택 영역을 경계 상자 크기로 잘라 낸다 (마스크 적용 기록용) */
function selectionRegion(): Region | null {
  const box = useStore.getState().sel.box;
  if (!selData || !box) return null;
  const data = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    const off = (box.y + y) * selW + box.x;
    data.set(selData.subarray(off, off + box.w), y * box.w);
  }
  return { ...box, data };
}

// ---------------------------------------------------------------------------
// 도형 → 영역

function rasterize(box: Box, draw: (ctx: OffscreenCanvasRenderingContext2D) => void, antialias = true): Region | null {
  const src = resources.source;
  if (!src) return null;
  const x0 = Math.max(0, Math.floor(box.x) - 1), y0 = Math.max(0, Math.floor(box.y) - 1);
  const x1 = Math.min(src.w, Math.ceil(box.x + box.w) + 1), y1 = Math.min(src.h, Math.ceil(box.y + box.h) + 1);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d")!;
  ctx.translate(-x0, -y0);
  ctx.fillStyle = "#fff";
  draw(ctx);
  const px = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = px[i * 4 + 3];
    data[i] = antialias ? a : a >= 128 ? 255 : 0;
  }
  return { x: x0, y: y0, w, h, data };
}

const boxOfPoints = (pts: number[]): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]);
    x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]);
    y1 = Math.max(y1, pts[i + 1]);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

export function rectRegion(x0: number, y0: number, x1: number, y1: number, ellipse: boolean): Region | null {
  const box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  if (box.w < 1 || box.h < 1) return null;
  return rasterize(box, (ctx) => {
    ctx.beginPath();
    if (ellipse) ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
    else ctx.rect(box.x, box.y, box.w, box.h);
    ctx.fill();
  }, ellipse);
}

/** 다각형 (올가미). pts = [x, y, x, y, ...] 원본 px */
export function polygonRegion(pts: number[]): Region | null {
  if (pts.length < 6) return null;
  return rasterize(boxOfPoints(pts), (ctx) => {
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
    ctx.fill();
  });
}

/** 펜 경로(베지어) → 영역 */
export function penRegion(path: PenPath): Region | null {
  const p = path.pts;
  if (p.length < 3) return null;
  const all: number[] = [];
  for (const q of p) {
    all.push(q.x, q.y);
    if (q.hin) all.push(q.hin.x, q.hin.y);
    if (q.hout) all.push(q.hout.x, q.hout.y);
  }
  return rasterize(boxOfPoints(all), (ctx) => {
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i <= p.length; i++) {
      const a = p[i - 1];
      const b = p[i % p.length];
      const c1 = a.hout ?? a;
      const c2 = b.hin ?? b;
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
    }
    ctx.closePath();
    ctx.fill();
  });
}

/** 자동 선택 (마술봉): 클릭한 곳과 색이 비슷한 영역 */
export function wandRegion(src: SourceImage, sx: number, sy: number, tol: number, contiguous: boolean, antialias: boolean): Region | null {
  const { w, h, data } = src;
  const x0 = Math.min(w - 1, Math.max(0, Math.floor(sx)));
  const y0 = Math.min(h - 1, Math.max(0, Math.floor(sy)));
  const i0 = (y0 * w + x0) * 4;
  const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2];
  const match = (p: number) => {
    const i = p * 4;
    return Math.abs(data[i] - r0) <= tol && Math.abs(data[i + 1] - g0) <= tol && Math.abs(data[i + 2] - b0) <= tol;
  };
  const out = new Uint8Array(w * h);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const mark = (y: number, xa: number, xb: number) => {
    out.fill(255, y * w + xa, y * w + xb + 1);
    if (xa < minX) minX = xa;
    if (xb > maxX) maxX = xb;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  if (!contiguous) {
    for (let y = 0; y < h; y++) {
      let run = -1;
      for (let x = 0; x <= w; x++) {
        const m = x < w && match(y * w + x);
        if (m && run < 0) run = x;
        if (!m && run >= 0) {
          mark(y, run, x - 1);
          run = -1;
        }
      }
    }
  } else {
    // 스캔라인 채우기
    const stack: number[] = [x0, y0];
    while (stack.length) {
      const y = stack.pop()!;
      let x = stack.pop()!;
      const row = y * w;
      if (out[row + x] || !match(row + x)) continue;
      let xa = x;
      while (xa > 0 && !out[row + xa - 1] && match(row + xa - 1)) xa--;
      let xb = x;
      while (xb < w - 1 && !out[row + xb + 1] && match(row + xb + 1)) xb++;
      mark(y, xa, xb);
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= h) continue;
        const nrow = ny * w;
        let inSpan = false;
        for (x = xa; x <= xb; x++) {
          const ok = !out[nrow + x] && match(nrow + x);
          if (ok && !inSpan) {
            stack.push(x, ny);
            inSpan = true;
          } else if (!ok) inSpan = false;
        }
      }
    }
  }
  if (maxX < 0) return null;
  // 1px 여유를 두고 잘라 내기 (부드럽게 처리할 공간)
  const rx = Math.max(0, minX - 1), ry = Math.max(0, minY - 1);
  const rw = Math.min(w, maxX + 2) - rx, rh = Math.min(h, maxY + 2) - ry;
  let reg: Uint8Array = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) reg.set(out.subarray((ry + y) * w + rx, (ry + y) * w + rx + rw), y * rw);
  if (antialias) {
    // 선택된 쪽 가장자리만 부드럽게 하고, 선택 안 된 픽셀은 그대로 둔다 — 그냥 평균만 내면 선택된 곳 사이에 낀
    // 1px 윤곽선이 절반을 넘어 선택된 것처럼 되어, 얇은 윤곽선 너머(옅은 칼날 등)까지 이어져 보였다
    const sm = smooth3(reg, rw, rh);
    for (let i = 0; i < sm.length; i++) sm[i] = reg[i] ? Math.max(sm[i], 128) : 0; // 선택 안 된 픽셀(윤곽선 등)은 건드리지 않음
    reg = sm;
  }
  return { x: rx, y: ry, w: rw, h: rh, data: reg };
}

/** 3x3 평균 (계단 현상 완화). 내부(이웃이 모두 같은 값)는 그대로 */
function smooth3(d: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(d.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += d[yy * w + xx];
          n++;
        }
      }
      o[y * w + x] = Math.round(s / n);
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// 선택 영역 → 피사체 마스크

/** 마스크가 아직 없으면 만든다 (full: 전체가 피사체로 시작할지) */
function ensureMask(full: boolean): boolean {
  const s = useStore.getState();
  const src = resources.source;
  if (!src) return false;
  if (s.doc.cutout) return true;
  const maskId = newId("m");
  resources.masks.set(maskId, { w: src.w, h: src.h, data: new Uint8Array(src.w * src.h).fill(full ? 255 : 0) });
  s.setDoc((d) => {
    d.cutout = { maskId, fgId: null, source: "manual" };
    d.strokes = [];
    d.invert = false;
    if (d.bg.mode === "original") d.bg.mode = "transparent";
  });
  return true;
}

export type SelApply = "delete" | "restore" | "keep";

const LABEL: Record<SelApply, string> = {
  delete: "선택 영역 지우기",
  restore: "선택 영역 되살리기",
  keep: "선택 영역만 남기기",
};

/** 지우기(배경으로) / 되살리기(피사체로) / 이것만 남기기 */
export function applySelection(kind: SelApply): boolean {
  const s = useStore.getState();
  const r = selectionRegion();
  if (!r) {
    s.toast("먼저 선택 도구로 영역을 선택하세요.", "info");
    return false;
  }
  // 마스크가 없을 때: 지우기는 '전체가 피사체'에서, 되살리기·남기기는 '빈 상태'에서 시작
  if (!ensureMask(kind === "delete")) return false;
  const id = newId("r");
  resources.masks.set(id, { w: r.w, h: r.h, data: r.data });
  const op: RasterOp = {
    kind: "raster",
    mode: kind === "delete" ? "sub" : kind === "restore" ? "add" : "replace",
    id, x: r.x, y: r.y, w: r.w, h: r.h,
  };
  s.change(LABEL[kind], (d) => {
    d.strokes.push(op);
  });
  return true;
}
