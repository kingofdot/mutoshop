import { HSL_BANDS, defaultAdjust, defaultCurve, type AdjustSet, type CurvePoint } from "../types";

type BandKey = (typeof HSL_BANDS)[number]["key"];

export interface Preset {
  id: string;
  name: string;
  adjust?: Partial<Omit<AdjustSet, "hsl" | "curves">>;
  hsl?: Partial<Record<BandKey, Partial<{ h: number; s: number; l: number }>>>;
  master?: CurvePoint[];
  vignette?: number;
  grain?: number;
}

export const PRESETS: Preset[] = [
  { id: "none", name: "원본" },
  { id: "bright", name: "화사하게", adjust: { exposure: 0.3, shadows: 20, whites: 14, vibrance: 16, contrast: -4 } },
  { id: "vivid", name: "선명하게", adjust: { contrast: 22, vibrance: 38, saturation: 6, highlights: -12, shadows: 10 } },
  { id: "warm", name: "따뜻하게", adjust: { temperature: 28, tint: 4, vibrance: 12, exposure: 0.05 } },
  { id: "cool", name: "시원하게", adjust: { temperature: -26, tint: -4, vibrance: 8, contrast: 6 } },
  { id: "soft", name: "부드럽게", adjust: { contrast: -18, highlights: -22, shadows: 18, saturation: -6, exposure: 0.08 } },
  {
    id: "product", name: "제품 화이트",
    adjust: { exposure: 0.2, whites: 30, highlights: -10, blacks: -6, contrast: 8, vibrance: 6 },
  },
  {
    id: "food", name: "맛있게",
    adjust: { temperature: 14, vibrance: 30, contrast: 12, shadows: 8 },
    hsl: { orange: { s: 15 }, red: { s: 10 } },
  },
  { id: "pastel", name: "파스텔", adjust: { exposure: 0.25, contrast: -25, saturation: -18, highlights: -15, shadows: 25, vibrance: 10 } },
  {
    id: "fresh", name: "싱그럽게",
    adjust: { tint: -6, vibrance: 22, contrast: 6 },
    hsl: { green: { h: 10, s: 20, l: 8 }, yellow: { h: 12 }, aqua: { s: 12 } },
  },
  {
    id: "film", name: "필름",
    adjust: { contrast: -6, saturation: -12, gradeShadowHue: 190, gradeShadowSat: 22, gradeHighHue: 40, gradeHighSat: 18, temperature: 6 },
    master: [{ x: 0, y: 0.07 }, { x: 0.5, y: 0.52 }, { x: 1, y: 0.95 }],
    grain: 18,
  },
  {
    id: "vintage", name: "빈티지",
    adjust: { temperature: 22, saturation: -28, contrast: -10, gradeShadowHue: 30, gradeShadowSat: 20 },
    master: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }],
    vignette: 30,
    grain: 22,
  },
  {
    id: "cinema", name: "시네마틱",
    adjust: { contrast: 18, saturation: -8, gradeShadowHue: 195, gradeShadowSat: 35, gradeHighHue: 32, gradeHighSat: 30, highlights: -15 },
    vignette: 20,
  },
  { id: "sunset", name: "노을빛", adjust: { temperature: 35, tint: 10, gradeHighHue: 25, gradeHighSat: 25, vibrance: 15 } },
  { id: "mono", name: "흑백", adjust: { saturation: -100, contrast: 12 } },
  { id: "mono-hc", name: "흑백 강하게", adjust: { saturation: -100, contrast: 40, blacks: -15, whites: 15 }, vignette: 15 },
];

/** 프리셋을 적용한 보정 세트 (기본값 위에 덮어씀) */
export function presetToAdjust(p: Preset): AdjustSet {
  const a = defaultAdjust();
  Object.assign(a, p.adjust ?? {});
  if (p.hsl) {
    HSL_BANDS.forEach((b, i) => {
      const v = p.hsl![b.key];
      if (v) a.hsl[i] = { h: v.h ?? 0, s: v.s ?? 0, l: v.l ?? 0 };
    });
  }
  a.curves.master = p.master ? p.master.map((q) => ({ ...q })) : defaultCurve();
  return a;
}
