import { adjustIsIdentity, curvesActive, type AdjustSet, type Orient } from "../types";

/** 보정 세트 하나 = vec4 12개 (셰이더 FS_COMPOSITE 의 uP 배치와 일치해야 함) */
export const SET_VEC4 = 12;

export function packAdjust(a: AdjustSet, out: Float32Array, set: number) {
  const o = set * SET_VEC4 * 4;
  const v = [
    a.exposure, a.brightness / 100, a.contrast / 100, a.highlights / 100,
    a.shadows / 100, a.whites / 100, a.blacks / 100, a.temperature / 100,
    a.tint / 100, a.vibrance / 100, a.saturation / 100, a.hue / 360,
    a.gradeShadowHue / 360, a.gradeShadowSat / 100, a.gradeMidHue / 360, a.gradeMidSat / 100,
    a.gradeHighHue / 360, a.gradeHighSat / 100, a.gradeBalance / 100, curvesActive(a.curves) ? 1 : 0,
  ];
  for (let i = 0; i < v.length; i++) out[o + i] = v[i];
  for (let i = 0; i < 8; i++) {
    out[o + 20 + i] = a.hsl[i].h / 100;
    out[o + 28 + i] = a.hsl[i].s / 100;
    out[o + 36 + i] = a.hsl[i].l / 100;
  }
  out[o + 44] = adjustIsIdentity(a) ? 0 : 1;
  out[o + 45] = out[o + 46] = out[o + 47] = 0;
}

/**
 * 출력 uv(회전·반전 적용 후) → 원본 uv 로 가는 3x3 행렬 (GLSL column-major).
 * su = a*u + b*v + c,  sv = d*u + e*v + f
 */
export function orientMatrix(o: Orient): Float32Array {
  let [a, b, c, d, e, f] = [
    [1, 0, 0, 0, 1, 0],
    [0, 1, 0, -1, 0, 1],
    [-1, 0, 1, 0, -1, 1],
    [0, -1, 1, 1, 0, 0],
  ][o.rot];
  if (o.flip) {
    c = a + c;
    a = -a;
    f = d + f;
    d = -d;
  }
  return new Float32Array([a, d, 0, b, e, 0, c, f, 1]);
}

/** 출력 uv → 원본 uv */
export function outToSrc(m: Float32Array, u: number, v: number): [number, number] {
  return [m[0] * u + m[3] * v + m[6], m[1] * u + m[4] * v + m[7]];
}

/** 원본 uv → 출력 uv (역변환) */
export function srcToOut(m: Float32Array, su: number, sv: number): [number, number] {
  const a = m[0], b = m[3], c = m[6], d = m[1], e = m[4], f = m[7];
  const det = a * e - b * d;
  const x = su - c;
  const y = sv - f;
  return [(e * x - b * y) / det, (-d * x + a * y) / det];
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
