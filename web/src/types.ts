// 문서(편집 상태) 자료형과 기본값.
// 무거운 픽셀 데이터(원본, 마스크, 전경색)는 resources.ts 에 id 로 보관하고,
// 문서에는 id 와 가벼운 값만 둔다 → 실행 취소 기록이 가볍다.

export type Target = "global" | "subject" | "background";

export interface CurvePoint {
  x: number; // 0..1
  y: number; // 0..1
}
export type CurveChannel = "master" | "r" | "g" | "b";
export type Curves = Record<CurveChannel, CurvePoint[]>;

export interface HslBand {
  h: number; // -100..100
  s: number;
  l: number;
}

export interface AdjustSet {
  exposure: number; // EV, -3..3
  brightness: number; // 이하 -100..100
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  vibrance: number;
  saturation: number;
  hue: number; // -180..180 (도)
  gradeShadowHue: number; // 0..360
  gradeShadowSat: number; // 0..100
  gradeMidHue: number;
  gradeMidSat: number;
  gradeHighHue: number;
  gradeHighSat: number;
  gradeBalance: number; // -100..100
  hsl: HslBand[]; // 8개 색상 대역
  curves: Curves;
}

export interface Effects {
  clarity: number; // -100..100
  sharpen: number; // 0..100
  vignette: number; // -100..100
  grain: number; // 0..100
}

export interface EdgeParams {
  feather: number; // px, 0..100
  contrast: number; // 0..100
  shift: number; // -100..100
  decontaminate: number; // 0..100 (테두리 색 보정 강도)
  /** auto: AI가 추정한 전경색 · matte: 원래 배경색을 알고 정확히 빼기 */
  deconMode: "auto" | "matte";
  /** 배경색 빼기에서 배경색: auto=경계 주변 배경을 위치마다 읽음 · color=지정한 단색 */
  matteSource: "auto" | "color";
  matteColor: string;
  /** 가장자리 색 채우기 반경 (px, 0=끔) */
  defringe: number;
  /** 투명도 다시 계산 (색 기준, 0..100) — 배경색과 피사체 색으로 경계의 투명도를 새로 구함 */
  colorAlpha: number;
  /** 테두리 깎기 (px, 0..50) — 피사체 바깥 가장자리를 1px 씩 깎는다. 외곽선을 너무 두껍게 넣은 사진 고치기 */
  shave: number;
}

export type BgMode = "original" | "transparent" | "color" | "blur" | "image";

export interface Background {
  mode: BgMode;
  color: string;
  blur: number; // 1..100
  imageId: string | null;
  fit: "cover" | "contain";
}

export interface Shadow {
  enabled: boolean;
  opacity: number; // 0..100
  blur: number; // 0..100
  x: number; // -100..100 (화면 크기 대비)
  y: number;
  color: string;
}

/** 테두리(외곽선) — 포토샵 레이어 스타일의 '획'과 같음 */
export interface Outline {
  enabled: boolean;
  position: "outside" | "center" | "inside";
  width: number; // 원본 px
  fill: "solid" | "gradient";
  color: string; // 단색 / 그라디언트의 바깥쪽 색
  color2: string; // 그라디언트의 안쪽 색
  alpha1: number; // 바깥쪽 불투명도 0..100
  alpha2: number; // 안쪽 불투명도 0..100
  opacity: number; // 전체 불투명도 0..100
  soft: number; // 가장자리 부드럽게 (px)
}

export interface Stroke {
  kind?: "brush";
  mode: "add" | "sub";
  size: number; // 지름, 원본 px
  hardness: number; // 0..100
  opacity: number; // 0..100
  auto: boolean; // 자동 경계 (색이 비슷한 곳만 칠함)
  tolerance: number; // 0..100
  pts: number[]; // [x, y, pressure, ...] 원본 px
}

/** 선택 영역을 마스크에 적용한 기록 (영역 픽셀은 resources.masks[id] 에 bbox 크기로 보관) */
export interface RasterOp {
  kind: "raster";
  mode: "add" | "sub" | "replace";
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 마스크 편집 기록: 브러시 획 또는 선택 영역 적용 */
export type MaskOp = Stroke | RasterOp;

export interface Orient {
  rot: 0 | 1 | 2 | 3; // 시계 방향 90° 회전 횟수
  flip: boolean; // 회전 후 좌우 반전
}

export interface Rect {
  x: number; // 출력(회전 적용 후) 이미지 기준 0..1
  y: number;
  w: number;
  h: number;
}

export interface Cutout {
  maskId: string;
  fgId: string | null; // null 이면 원본 색 사용
  source: "ai" | "alpha" | "manual";
  /** 누끼 따기로 만든 결과의 종류 (투명 PNG·직접 만든 마스크는 없음) */
  kind?: CutKind;
  /** 잔티 제거 전의 마스크 (잔티 제거를 끄면 이것으로 되돌린다) */
  rawMaskId?: string;
  /** 잔티 제거로 지운 점 개수 */
  specks?: number;
  /** '배경 찍기'로 찍은 자리 (원본 px). 다음에 찍으면 여기에 더해 다시 딴다 */
  seeds?: [number, number][];
  /** 찍기와 함께 사진 테두리의 배경도 자동으로 지웠는지 (자동 누끼 결과 위에 찍었을 때) */
  border?: boolean;
}

export interface Doc {
  adjust: Record<Target, AdjustSet>;
  effects: Effects;
  cutout: Cutout | null;
  strokes: MaskOp[];
  invert: boolean;
  edge: EdgeParams;
  bg: Background;
  shadow: Shadow;
  outline: Outline;
  orient: Orient;
  crop: Rect | null;
}

export const HSL_BANDS = [
  { key: "red", label: "빨강", hue: 0, color: "#ff4b4b" },
  { key: "orange", label: "주황", hue: 30, color: "#ff9a3d" },
  { key: "yellow", label: "노랑", hue: 60, color: "#ffdc3d" },
  { key: "green", label: "초록", hue: 120, color: "#46d468" },
  { key: "aqua", label: "청록", hue: 180, color: "#3cd2d2" },
  { key: "blue", label: "파랑", hue: 240, color: "#4b78ff" },
  { key: "purple", label: "보라", hue: 275, color: "#a25bff" },
  { key: "magenta", label: "자홍", hue: 315, color: "#ff4bc0" },
] as const;

export const defaultCurve = (): CurvePoint[] => [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export const defaultCurves = (): Curves => ({
  master: defaultCurve(),
  r: defaultCurve(),
  g: defaultCurve(),
  b: defaultCurve(),
});

export const defaultAdjust = (): AdjustSet => ({
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  hue: 0,
  gradeShadowHue: 210,
  gradeShadowSat: 0,
  gradeMidHue: 40,
  gradeMidSat: 0,
  gradeHighHue: 40,
  gradeHighSat: 0,
  gradeBalance: 0,
  hsl: HSL_BANDS.map(() => ({ h: 0, s: 0, l: 0 })),
  curves: defaultCurves(),
});

export const defaultEffects = (): Effects => ({ clarity: 0, sharpen: 0, vignette: 0, grain: 0 });

export const defaultEdge = (): EdgeParams => ({
  feather: 0, contrast: 0, shift: 0, decontaminate: 100, deconMode: "auto", matteSource: "auto", matteColor: "#ffffff", defringe: 0, colorAlpha: 0,
  shave: 0,
});

export const defaultBackground = (): Background => ({
  mode: "original",
  color: "#ffffff",
  blur: 40,
  imageId: null,
  fit: "cover",
});

export const defaultShadow = (): Shadow => ({
  enabled: false,
  opacity: 35,
  blur: 30,
  x: 0,
  y: 12,
  color: "#000000",
});

/** 외곽선 기본 두께: 가로·세로 모두 1024px 이하인 사진은 1px, 그보다 크면 2px */
export const defaultOutlineWidth = (w: number, h: number) => (Math.max(w, h) <= 1024 ? 1 : 2);

export const defaultOutline = (): Outline => ({
  enabled: false,
  position: "center",
  width: 2,
  fill: "solid",
  color: "#000000",
  color2: "#000000",
  alpha1: 100,
  alpha2: 0,
  opacity: 100,
  soft: 0,
});

export const defaultDoc = (): Doc => ({
  adjust: { global: defaultAdjust(), subject: defaultAdjust(), background: defaultAdjust() },
  effects: defaultEffects(),
  cutout: null,
  strokes: [],
  invert: false,
  edge: defaultEdge(),
  bg: defaultBackground(),
  shadow: defaultShadow(),
  outline: defaultOutline(),
  orient: { rot: 0, flip: false },
  crop: null,
});

// ---------------------------------------------------------------------------

export function isDefaultCurve(c: CurvePoint[]): boolean {
  return c.length === 2 && c[0].x === 0 && c[0].y === 0 && c[1].x === 1 && c[1].y === 1;
}

export function curvesActive(c: Curves): boolean {
  return !(isDefaultCurve(c.master) && isDefaultCurve(c.r) && isDefaultCurve(c.g) && isDefaultCurve(c.b));
}

const SCALAR_KEYS = [
  "exposure", "brightness", "contrast", "highlights", "shadows", "whites", "blacks",
  "temperature", "tint", "vibrance", "saturation", "hue",
] as const;

/** 아무 보정도 없는 상태인지 (셰이더에서 건너뛰기 위해) */
export function adjustIsIdentity(a: AdjustSet): boolean {
  if (SCALAR_KEYS.some((k) => a[k] !== 0)) return false;
  if (a.gradeShadowSat || a.gradeMidSat || a.gradeHighSat) return false;
  if (a.hsl.some((b) => b.h || b.s || b.l)) return false;
  return !curvesActive(a.curves);
}

/** 누끼 종류: 고른 종류에 맞춰 피사체를 지키는 방식이 달라진다 (server/assetcut.py 의 KINDS 와 같음) */
export type CutKind = "tree" | "mountain" | "item" | "person";
/** 피사체 안쪽에 갇힌 배경색: auto=종류대로 · keep=하나도 안 지움 · remove=갇힌 구멍도 지움 */
export type Inner = "auto" | "keep" | "remove";

export function outputSize(w: number, h: number, o: Orient): [number, number] {
  return o.rot % 2 === 1 ? [h, w] : [w, h];
}
