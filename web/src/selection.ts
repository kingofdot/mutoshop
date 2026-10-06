// 포토샵식 선택 영역. 픽셀은 원본 크기의 Uint8Array(0..255)로 여기에 두고,
// 스토어에는 버전과 경계 상자만 둔다 (선택 영역 자체는 실행 취소 기록에 남기지 않는다).
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

export function getSelection(): { data: Uint8Array; w: number; h: number } | null {
  return selData ? { data: selData, w: selW, h: selH } : null;
}

function publish(box: Box | null) {
  if (!box) selData = null;
  useStore.getState().set({ sel: { version: ++version, box } });
}

export function clearSelection() {
  selData = null;
  publish(null);
}

function bboxOf(data: Uint8Array, w: number, h: number): Box | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) {
      if (data[row + x]) {
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
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 새 영역을 현재 선택과 합친다 (새 선택 / 더하기 / 빼기 / 교차) */
export function combineSelection(r: Region | null, mode: SelMode) {
  const src = resources.source;
  if (!src) return;
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
  selData = new Uint8Array(src.w * src.h).fill(255);
  selW = src.w;
  selH = src.h;
  publish({ x: 0, y: 0, w: src.w, h: src.h });
}

export function invertSelection() {
  const src = resources.source;
  if (!src) return;
  if (!selData) {
    selectAll();
    return;
  }
  for (let i = 0; i < selData.length; i++) selData[i] = 255 - selData[i];
  publish(bboxOf(selData, selW, selH));
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
  if (antialias) reg = smooth3(reg, rw, rh);
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
