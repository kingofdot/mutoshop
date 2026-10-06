import type { CurvePoint, Curves } from "../types";

/** 단조 3차 보간(Fritsch–Carlson) — 곡선이 출렁이거나 역전되지 않는다 */
function slopes(pts: CurvePoint[]): number[] {
  const n = pts.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    d.push(dx > 1e-6 ? (pts[i + 1].y - pts[i].y) / dx : 0);
  }
  const m = new Array<number>(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return m;
}

export function sortedPoints(points: CurvePoint[]): CurvePoint[] {
  return [...points].sort((a, b) => a.x - b.x);
}

/** 곡선 함수를 만든다 (x: 0..1 → y: 0..1) */
export function curveFn(points: CurvePoint[]): (x: number) => number {
  const pts = sortedPoints(points);
  const n = pts.length;
  if (n < 2) return (x) => x;
  const m = slopes(pts);
  return (x: number) => {
    if (x <= pts[0].x) return clamp01(pts[0].y);
    if (x >= pts[n - 1].x) return clamp01(pts[n - 1].y);
    let i = 0;
    while (i < n - 2 && x > pts[i + 1].x) i++;
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const h = p1.x - p0.x;
    if (h < 1e-6) return clamp01(p1.y);
    const t = (x - p0.x) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y =
      (2 * t3 - 3 * t2 + 1) * p0.y + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p1.y + (t3 - t2) * h * m[i + 1];
    return clamp01(y);
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 곡선 4개 → 256x1 RGBA (r, g, b, master) */
export function curvesToLut(c: Curves, out: Uint8Array, offset: number) {
  const fr = curveFn(c.r);
  const fg = curveFn(c.g);
  const fb = curveFn(c.b);
  const fm = curveFn(c.master);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const o = offset + i * 4;
    out[o] = Math.round(fr(x) * 255);
    out[o + 1] = Math.round(fg(x) * 255);
    out[o + 2] = Math.round(fb(x) * 255);
    out[o + 3] = Math.round(fm(x) * 255);
  }
}
