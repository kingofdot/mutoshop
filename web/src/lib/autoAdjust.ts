import type { SourceImage } from "../resources";
import type { AdjustSet } from "../types";

const srgb2lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/**
 * 원본 통계로 노출·대비·흰색/검정·화이트밸런스를 보수적으로 추정.
 * weight(0..255, 원본과 같은 크기)를 주면 그 영역(예: 피사체 마스크)만 본다.
 */
export function autoAdjust(src: SourceImage, weight?: Uint8Array | null, invertWeight = false): Partial<AdjustSet> {
  const { w, h, data } = src;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250_000)));
  const hist = new Float64Array(256);
  let total = 0;
  let sr = 0, sg = 0, sb = 0, sw = 0, satSum = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const p = y * w + x;
      let wt = data[p * 4 + 3] / 255;
      if (weight) wt *= (invertWeight ? 255 - weight[p] : weight[p]) / 255;
      if (wt < 0.5) continue;
      const r = data[p * 4] / 255, g = data[p * 4 + 1] / 255, b = data[p * 4 + 2] / 255;
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      hist[Math.round(L * 255)] += 1;
      total += 1;
      if (L > 0.15 && L < 0.85) {
        sr += r; sg += g; sb += b; sw += 1;
      }
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      satSum += mx > 0 ? (mx - mn) / mx : 0;
    }
  }
  if (total < 50) return {};
  const pct = (q: number) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= q * total) return i / 255;
    }
    return 1;
  };
  const lo = pct(0.005), hi = pct(0.995), med = pct(0.5);
  let clipped = 0, dark = 0;
  for (let i = 250; i < 256; i++) clipped += hist[i];
  for (let i = 0; i < 26; i++) dark += hist[i];

  const out: Partial<AdjustSet> = {};
  const medLin = Math.max(srgb2lin(med), 1e-3);
  out.exposure = Math.round(clamp(Math.log2(0.18 / medLin) * 0.55, -1.5, 1.5) * 100) / 100;
  if (hi < 0.94) out.whites = Math.round(clamp((0.97 - hi) * 220, 0, 55));
  if (lo > 0.04) out.blacks = -Math.round(clamp((lo - 0.02) * 220, 0, 45));
  const range = hi - lo;
  if (range < 0.72) out.contrast = Math.round(clamp((0.75 - range) * 60, 0, 25));
  if (clipped / total > 0.02) out.highlights = -Math.round(clamp((clipped / total) * 900, 15, 50));
  if (dark / total > 0.15) out.shadows = Math.round(clamp((dark / total) * 90, 10, 35));
  if (sw > 50) {
    const mr = sr / sw, mg = sg / sw, mb = sb / sw;
    out.temperature = Math.round(clamp(((mb - mr) / Math.max(mg, 1e-3)) * 70, -30, 30));
    out.tint = Math.round(clamp((((mr + mb) / 2 - mg) / Math.max(mg, 1e-3)) * -60, -20, 20));
  }
  if (satSum / total < 0.22) out.vibrance = 15;
  return out;
}
