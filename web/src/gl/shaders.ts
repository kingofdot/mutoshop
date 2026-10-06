// GLSL ES 3.00 셰이더 모음.
// 규칙: 모든 텍스처/FBO 는 v=0 이 이미지 맨 윗줄. 화면(캔버스)에 그릴 때만 y 를 뒤집는다.

const HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
`;

export const VS_QUAD = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** 단순 복사 (축소 시 밉맵 자동 선택) */
export const FS_COPY = HEAD + /* glsl */ `
uniform sampler2D uTex;
in vec2 vUv;
out vec4 o;
void main() { o = texture(uTex, vUv); }`;

/** 원본 좌표계 텍스처를 출력(회전 적용) 좌표계로 옮겨 그리기 */
export const FS_ORIENT = HEAD + /* glsl */ `
uniform sampler2D uTex;
uniform mat3 uOrient;
in vec2 vUv;
out vec4 o;
void main() { o = texture(uTex, (uOrient * vec3(vUv, 1.0)).xy); }`;

/** 박스 평균 축소: 저해상도 픽셀 하나가 덮는 원본 영역을 4x4 쌍선형 샘플로 평균 */
export const FS_DOWN = HEAD + /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uSrcTexel;
uniform float uFactor;
in vec2 vUv;
out vec4 o;
void main() {
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 off = (vec2(float(x), float(y)) - 1.5) * 0.25 * uFactor * uSrcTexel;
      acc += textureLod(uTex, vUv + off, 0.0);
    }
  }
  o = acc / 16.0;
}`;

/** 배경 흐림 준비: 피사체를 뺀 배경만 (premultiplied) 축소 → 흐려도 피사체 색이 번지지 않음 */
export const FS_BGPREP = HEAD + /* glsl */ `
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform vec2 uSrcTexel;
uniform float uFactor;
in vec2 vUv;
out vec4 o;
void main() {
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 uv = vUv + (vec2(float(x), float(y)) - 1.5) * 0.25 * uFactor * uSrcTexel;
      float b = 1.0 - textureLod(uMask, uv, 0.0).r;
      acc += vec4(textureLod(uSrc, uv, 0.0).rgb * b, b);
    }
  }
  o = acc / 16.0;
}`;

/** 분리형 가우시안 블러 */
export const FS_BLUR = HEAD + /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uDir;
uniform float uSigma;
uniform int uRadius;
in vec2 vUv;
out vec4 o;
void main() {
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  float k = -0.5 / (uSigma * uSigma);
  for (int i = -uRadius; i <= uRadius; i++) {
    float fi = float(i);
    float w = exp(fi * fi * k);
    acc += texture(uTex, vUv + uDir * fi) * w;
    ws += w;
  }
  o = acc / ws;
}`;

/** 가장자리 다듬기 마지막 단계: 이동/대비 곡선 + 반전 */
export const FS_REFINE = HEAD + /* glsl */ `
uniform sampler2D uTex;
uniform float uLo;
uniform float uHi;
uniform int uInvert;
in vec2 vUv;
out vec4 o;
void main() {
  float m = texture(uTex, vUv).r;
  m = clamp((m - uLo) / max(uHi - uLo, 1e-4), 0.0, 1.0);
  if (uInvert == 1) m = 1.0 - m;
  o = vec4(m);
}`;

/** 선택 영역 적용: 영역 텍스처를 마스크의 해당 위치에 찍는다 (더하기=MAX, 빼기=MIN) */
export const VS_REGION = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
uniform vec4 uRect;
uniform vec2 uSize;
out vec2 vUv;
void main() {
  vec2 t = aPos * 0.5 + 0.5;
  vUv = t;
  gl_Position = vec4((uRect.xy + t * uRect.zw) / uSize * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FS_REGION = HEAD + /* glsl */ `
uniform sampler2D uTex;
uniform int uSub;
in vec2 vUv;
out vec4 o;
void main() {
  float v = texture(uTex, vUv).r;
  o = vec4(uSub == 1 ? 1.0 - v : v);
}`;

/** 브러시 도장 (인스턴싱). 복원=MAX 블렌드, 지우기=MIN 블렌드 → 한 획 안에서 겹쳐도 진해지지 않음 */
export const VS_STAMP = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec3 aInst;
uniform vec2 uSize;
out vec2 vLocal;
out vec2 vUv;
out vec2 vCenterUv;
void main() {
  float r = max(aInst.z, 0.5);
  float ext = r + 1.5;
  vec2 p = aInst.xy + aPos * ext;
  vLocal = aPos * ext / r;
  vUv = p / uSize;
  vCenterUv = aInst.xy / uSize;
  gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FS_STAMP = HEAD + /* glsl */ `
uniform sampler2D uSrc;
uniform float uHard;
uniform float uOpacity;
uniform float uTol;
uniform int uSub;
uniform int uAuto;
in vec2 vLocal;
in vec2 vUv;
in vec2 vCenterUv;
out vec4 o;
vec3 ycc(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec3(y, (c.b - y) * 0.564, (c.r - y) * 0.713);
}
void main() {
  float d = length(vLocal);
  float aa = max(fwidth(d), 1e-4);
  float inner = min(uHard, 1.0 - aa);
  float a = 1.0 - smoothstep(inner, 1.0, d);
  if (uAuto == 1) {
    vec3 dd = ycc(texture(uSrc, vUv).rgb) - ycc(texture(uSrc, vCenterUv).rgb);
    float dist = length(vec3(dd.x * 0.8, dd.y * 1.6, dd.z * 1.6));
    a *= 1.0 - smoothstep(uTol * 0.55, uTol, dist);
  }
  a *= uOpacity;
  float v = uSub == 1 ? 1.0 - a : a;
  o = vec4(v);
}`;

// ---------------------------------------------------------------------------
// 색 보정 함수 (합성 셰이더와 미리보기에서 공용)

const COLOR_LIB = /* glsl */ `
uniform vec4 uP[36];   // 보정 세트 3개 x vec4 12개 (전체 / 피사체 / 배경)
uniform sampler2D uLut; // 256x3 곡선 LUT (r,g,b,master)

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 srgb2lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 lin2srgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
float sCurve(float x, float s) {
  x = clamp(x, 0.0, 1.0);
  return x < 0.5 ? 0.5 * pow(2.0 * x, s) : 1.0 - 0.5 * pow(2.0 * (1.0 - x), s);
}
vec3 tint3(float hue, float sat) {
  vec3 c = hsv2rgb(vec3(hue, 1.0, 1.0));
  return (c - luma(c)) * sat;
}
float band(vec4 a, vec4 b, int i) {
  float arr[8] = float[8](a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w);
  return arr[i];
}

const float BC[8] = float[8](0.0, 0.083333, 0.166667, 0.333333, 0.5, 0.666667, 0.763889, 0.875);

vec3 applyAdj(vec3 c, int b, float row) {
  if (uP[b + 11].x < 0.5) return c;
  vec4 p0 = uP[b], p1 = uP[b + 1], p2 = uP[b + 2], p3 = uP[b + 3], p4 = uP[b + 4];

  // 1) 화이트밸런스 + 노출 — 선형 공간에서
  vec3 lin = srgb2lin(c);
  vec3 wb = vec3(1.0 + 0.32 * p1.w, 1.0 - 0.22 * p2.x, 1.0 - 0.32 * p1.w);
  wb /= luma(wb);
  lin *= wb * exp2(p0.x);
  c = lin2srgb(lin);

  // 2) 하이라이트 / 섀도 / 흰색 / 검정 — 휘도 대역별 이동
  float L = luma(c);
  float Lc = clamp(L, 0.0, 1.0);
  float wHi = smoothstep(0.35, 0.8, L);
  float wSh = smoothstep(0.0, 0.18, Lc) * (1.0 - smoothstep(0.25, 0.65, Lc));
  float wWh = smoothstep(0.6, 1.0, L);
  float wBk = 1.0 - smoothstep(0.0, 0.35, Lc);
  float dL = 0.25 * p0.w * wHi + 0.25 * p1.x * wSh + 0.2 * p1.y * wWh + 0.15 * p1.z * wBk;
  if (dL != 0.0) {
    float Ln = max(L + dL, 0.0);
    vec3 cMul = c * (Ln / max(L, 1e-4));
    vec3 cAdd = c + dL;
    c = mix(cAdd, cMul, smoothstep(0.04, 0.2, L));
  }

  // 3) 대비 (S-곡선, 클리핑 없음)
  c = clamp(c, 0.0, 1.0);
  float k = p0.z;
  if (k > 0.0) {
    float s = 1.0 + 1.6 * k;
    c = vec3(sCurve(c.r, s), sCurve(c.g, s), sCurve(c.b, s));
  } else if (k < 0.0) {
    c = 0.5 + (c - 0.5) * (1.0 + 0.6 * k);
  }

  // 4) 밝기 (중간톤 감마)
  float br = p0.y;
  if (br != 0.0) {
    float g = br > 0.0 ? 1.0 / (1.0 + 0.9 * br) : 1.0 - 0.9 * br;
    c = pow(c, vec3(g));
  }

  // 5) 색상 회전 + 컬러 믹서(HSL 8대역) + 활기
  vec3 hsv = rgb2hsv(c);
  hsv.x = fract(hsv.x + p2.w + 1.0);
  int i = 7;
  for (int j = 0; j < 7; j++) {
    if (hsv.x < BC[j + 1]) { i = j; break; }
  }
  int n = i == 7 ? 0 : i + 1;
  float c1 = i == 7 ? 1.0 : BC[i + 1];
  float t = smoothstep(0.0, 1.0, (hsv.x - BC[i]) / (c1 - BC[i]));
  float dh = mix(band(uP[b + 5], uP[b + 6], i), band(uP[b + 5], uP[b + 6], n), t);
  float ds = mix(band(uP[b + 7], uP[b + 8], i), band(uP[b + 7], uP[b + 8], n), t);
  float dl = mix(band(uP[b + 9], uP[b + 10], i), band(uP[b + 9], uP[b + 10], n), t);
  float sw = smoothstep(0.02, 0.25, hsv.y);
  hsv.x = fract(hsv.x + dh * (30.0 / 360.0) * sw + 1.0);
  hsv.y = clamp(hsv.y * (1.0 + ds * sw), 0.0, 1.0);
  hsv.z = clamp(hsv.z * (1.0 + dl * 0.5 * sw), 0.0, 1.0);
  hsv.y = clamp(hsv.y * (1.0 + p2.y * (1.0 - hsv.y) * 1.2), 0.0, 1.0);
  c = hsv2rgb(hsv);

  // 6) 채도 (휘도 보존)
  c = mix(vec3(luma(c)), c, 1.0 + p2.z);

  // 7) 컬러 그레이딩 (섀도 / 중간톤 / 하이라이트)
  float L3 = luma(clamp(c, 0.0, 1.0));
  float pivot = 0.5 - 0.3 * p4.z;
  float wS = 1.0 - smoothstep(0.0, pivot, L3);
  float wH = smoothstep(pivot, 1.0, L3);
  float wM = 1.0 - wS - wH;
  c += tint3(p3.x, p3.y) * wS * 0.5 + tint3(p3.z, p3.w) * wM * 0.4 + tint3(p4.x, p4.y) * wH * 0.5;

  // 8) 곡선
  if (p4.w > 0.5) {
    c = clamp(c, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0;
    c = vec3(texture(uLut, vec2(c.r, row)).a, texture(uLut, vec2(c.g, row)).a, texture(uLut, vec2(c.b, row)).a);
    c = c * (255.0 / 256.0) + 0.5 / 256.0;
    c = vec3(texture(uLut, vec2(c.r, row)).r, texture(uLut, vec2(c.g, row)).g, texture(uLut, vec2(c.b, row)).b);
  }
  return clamp(c, 0.0, 1.0);
}
`;


// ---------------------------------------------------------------------------
// 경계 색 보정 (합성과 확인용 보기에서 공용)

const FG_LIB = /* glsl */ `
uniform sampler2D uFg;
uniform sampler2D uMaskRaw;
uniform sampler2D uFringe;
uniform sampler2D uMatteTex;
uniform sampler2D uFgRef;      // 근처 불투명 피사체 색 (투명도 다시 계산 때 만든 것)
uniform int uHasFgRef;         // 투명도 다시 계산 결과 사용 중 (uMaskRaw.g = 색 계산용 투명도)
uniform int uMatteLocal;
uniform int uHasFg;
uniform int uMatteOn;
uniform int uHasFringe;
uniform int uRawInvert;
uniform float uDecon;
uniform vec3 uMatteColor;

/** 경계 픽셀에 섞인 원래 배경색을 걷어 낸 전경색 */
vec3 cleanFg(vec2 suv, vec3 orig) {
  float mr = texture(uMaskRaw, suv).r;
  if (uRawInvert == 1) mr = 1.0 - mr;
  vec3 f = orig;
  if (uMatteOn == 1) {
    // 원래 배경색 B 를 알면 정확히 되돌릴 수 있다:  I = aF + (1-a)B  ->  F = (I - (1-a)B) / a
    vec3 B = uMatteColor;
    if (uMatteLocal == 1) {
      vec4 b = texture(uMatteTex, suv);  // 경계 주변의 실제 배경색 (위치마다 다름)
      if (b.a > 0.003) B = b.rgb / b.a;
    }
    float mc = uHasFgRef == 1 ? texture(uMaskRaw, suv).g : mr;
    vec3 raw = (orig - (1.0 - mc) * B) / max(mc, 0.03);
    vec3 um = clamp(raw, 0.0, 1.0);
    // 투명도가 색에 비해 너무 낮으면(범위 끝·안개) 계산이 검게 잘린다 → 원래 색으로
    float under = max(0.0, -min(min(raw.r, raw.g), raw.b));
    um = mix(um, orig, smoothstep(0.1, 0.4, under));
    // 아주 옅은 픽셀은 나눗셈이 작은 오차를 크게 키우므로(색 얼룩) 근처 피사체 색으로 넘어간다
    if (uHasFgRef == 1) {
      vec4 rr = texture(uFgRef, suv);
      if (rr.a > 0.003) um = mix(rr.rgb / rr.a, um, smoothstep(0.04, 0.3, mc));
    }
    f = mix(orig, um, uDecon * smoothstep(0.0, 0.03, mr));
  } else if (uHasFg == 1) {
    f = mix(orig, texture(uFg, suv).rgb, uDecon);
  }
  if (uHasFringe == 1) {
    // 반투명 테두리를 가까운 불투명 부분의 색으로 덮는다 (가는 가지·머리카락 끝)
    vec4 ic = texture(uFringe, suv);
    if (ic.a > 0.003) {
      float w = (1.0 - smoothstep(0.55, 0.97, mr)) * smoothstep(0.003, 0.03, ic.a);
      f = mix(f, ic.rgb / ic.a, w);
    }
  }
  return f;
}
`;

/** 최소/최대 필터 (분리형). 최소→최대 순서로 쓰면 '열림': 반경보다 가는 구조만 지워진다 */
export const FS_MORPH = HEAD + /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uDir;
uniform int uRadius;
uniform int uMax;
in vec2 vUv;
out vec4 o;
void main() {
  float v = uMax == 1 ? 0.0 : 1.0;
  for (int i = -uRadius; i <= uRadius; i++) {
    float s = textureLod(uTex, vUv + uDir * float(i), 0.0).r;
    v = uMax == 1 ? max(v, s) : min(v, s);
  }
  o = vec4(v);
}`;

/** 테두리용 거리장 (Jump Flooding).
 *  각 픽셀에 '가장 가까운 피사체 픽셀'(rg)과 '가장 가까운 배경 픽셀'(ba)의 좌표(원본 px)를 저장한다. */
export const FS_JFA_INIT = HEAD + /* glsl */ `
uniform sampler2D uMask;
uniform vec2 uSize;
uniform float uF;
out vec4 o;
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float m = textureLod(uMask, (p + 0.5) / uSize, 0.0).r;
  vec2 pc = (p + 0.5) * uF;
  o = vec4(m >= 0.5 ? pc : vec2(-1.0), m < 0.5 ? pc : vec2(-1.0));
}`;

export const FS_JFA_STEP = HEAD + /* glsl */ `
uniform sampler2D uTex;
uniform int uStep;
uniform float uF;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uTex, 0);
  vec2 pc = (vec2(p) + 0.5) * uF;
  vec4 best = vec4(-1.0);
  float bi = 1e30, bo = 1e30;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 q = p + ivec2(x, y) * uStep;
      if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) continue;
      vec4 s = texelFetch(uTex, q, 0);
      if (s.x >= 0.0) {
        vec2 d = pc - s.xy;
        float dd = dot(d, d);
        if (dd < bi) { bi = dd; best.xy = s.xy; }
      }
      if (s.z >= 0.0) {
        vec2 d = pc - s.zw;
        float dd = dot(d, d);
        if (dd < bo) { bo = dd; best.zw = s.zw; }
      }
    }
  }
  o = best;
}`;

/** 배경색과 확실히 다른 색인지 (0..1) — '꽉 찬 영역' 판단의 재료 */
export const FS_KEY = HEAD + /* glsl */ `
uniform sampler2D uSrc;
uniform sampler2D uMatteTex;
uniform int uMatteLocal;
uniform vec3 uMatteColor;
uniform int uDark;             // 1: 배경색 → 피사체 대표(어두운) 색 직선 위에서 얼마나 진한지 (0..1), 2: 그 값이 0.35 이상인지 (0/1)
uniform vec3 uRefGlobal;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 I = textureLod(uSrc, vUv, 0.0).rgb;
  vec3 B = uMatteColor;
  if (uMatteLocal == 1) {
    vec4 b = textureLod(uMatteTex, vUv, 0.0);
    if (b.a > 0.003) B = b.rgb / b.a;
  }
  if (uDark > 0) {
    vec3 dG = uRefGlobal - B;
    float t = clamp(dot(I - B, dG) / max(dot(dG, dG), 1e-4), 0.0, 1.0);
    o = vec4(uDark == 2 ? step(0.35, t) : t);
    return;
  }
  vec3 d = abs(I - B);
  // 옅은 안개·그림자(차이 0.08 미만)는 꽉 찬 피사체로 보지 않는다
  o = vec4(smoothstep(0.08, 0.15, max(max(d.r, d.g), d.b)));
}`;

/** 두 텍스처의 최댓값 */
export const FS_MAX2 = HEAD + /* glsl */ `
uniform sampler2D uA;
uniform sampler2D uB;
in vec2 vUv;
out vec4 o;
void main() { o = vec4(max(textureLod(uA, vUv, 0.0).r, textureLod(uB, vUv, 0.0).r)); }`;

/** 투명도 다시 계산 (배경이 단색일 때).
 *  - 꽉 찬 영역(주변이 모두 배경과 다른 색 · 또는 AI 가 확신한 굵은 부분): 불투명. 밝은 나무 표면도 여기에 든다.
 *  - 그 밖(잔가지·경계): 보이는 색 I 가 '피사체 색 F 와 배경색 B 의 섞임'이라 보고 a = (I-B)·(F-B)/|F-B|².
 *    F 는 근처의 꽉 찬 영역 색 → 밝은 나무 옆은 밝게, 짙은 가지 옆은 짙게 잡혀 두 판단이 이음매 없이 맞물린다.
 *  - AI 마스크는 '어디까지가 피사체인가'의 범위(넉넉히 넓힌 것)로 쓴다. */
export const FS_CALPHA = HEAD + /* glsl */ `
uniform sampler2D uSrc;
uniform sampler2D uMask;       // AI 마스크
uniform sampler2D uRef;        // 넓은 범위의 피사체 색 (꽉 찬 영역에서)
uniform sampler2D uRefNear;    // 가까운 범위의 피사체 색
uniform sampler2D uSolid;      // 꽉 찬 영역 0..1
uniform sampler2D uROI;        // AI 마스크를 넓힌 범위
uniform sampler2D uNearThick;  // 굵은 구조(줄기·큰 가지)와 그 바로 옆 = 1, 가는 구조만 있는 곳 = 0
uniform sampler2D uCoreTone;   // 주변 가지 가운데의 진하기 (배경색 0 → 대표 색 1)
uniform sampler2D uWide;       // 진하기를 믿을 만큼 굵은 가지 = 1
uniform sampler2D uBase;       // 손대기 전 AI 마스크 (uMask 와의 차이 = 사용자가 브러시·선택으로 고친 곳)
uniform sampler2D uMatteTex;
uniform int uMatteLocal;
uniform vec3 uMatteColor;
uniform vec3 uRefGlobal;
uniform int uHasGlobal;
uniform float uAmt;
in vec2 vUv;
out vec4 o;
void main() {
  float m = texture(uMask, vUv).r;
  vec3 I = texture(uSrc, vUv).rgb;
  vec3 B = uMatteColor;
  if (uMatteLocal == 1) {
    vec4 b = texture(uMatteTex, vUv);
    if (b.a > 0.003) B = b.rgb / b.a;
  }
  float roi = smoothstep(0.05, 0.6, texture(uROI, vUv).r);
  float solid = smoothstep(0.5, 0.9, texture(uSolid, vUv).r);

  // 피사체 색 F: 가까운 꽉 찬 영역 → 넓은 범위 → 대표 색
  vec4 r = texture(uRef, vUv);
  vec4 rn = texture(uRefNear, vUv);
  vec3 F = r.a > 0.003 ? r.rgb / r.a : (uHasGlobal == 1 ? uRefGlobal : I);
  if (rn.a > 0.003) F = mix(F, rn.rgb / rn.a, smoothstep(0.01, 0.12, rn.a));
  vec3 d = F - B;
  float dd = dot(d, d);
  float ac = clamp(dot(I - B, d) / max(dd, 1e-4), 0.0, 1.0);
  float conf = smoothstep(0.02, 0.06, dd);   // 피사체 색이 배경과 비슷하면 계산 불가 → AI
  // 색이 F–B 직선을 벗어나면(다른 색조) 섞임이 아니므로 AI 와 계산값 중 더 불투명한 쪽
  float lineConf = 1.0 - smoothstep(0.035, 0.11, length((I - B) - ac * d));
  float aCol = mix(m, mix(max(m, ac), ac, lineConf), conf);

  // 가는 가지: 그 가지 가운데의 진하기(core)를 기준으로 투명도를 구한다.
  //  - 중간 톤 이상(core ≥ 0.7): 가지 원래 색 그대로 불투명, 가장자리만 반투명
  //  - 옅게 그려진 먼 잔가지(core ≤ 0.45): 배경색에 바랜 것으로 보고 어두운 가지 색의 반투명으로 풀어서
  //    불투명한 흰 선으로 남지 않게
  //  - 그 사이는 연속으로 이어져, 한 가지 안에서 뚝 끊기는 곳이 없다
  // 굵은 구조 근처와 AI 가 확실하다고 본 곳(제품의 밝은 부분 등)은 위의 계산을 그대로 쓴다
  if (uHasGlobal == 1) {
    vec3 dG = uRefGlobal - B;
    float ddG = dot(dG, dG);
    float acG = clamp(dot(I - B, dG) / max(ddG, 1e-4), 0.0, 1.0);
    float lineG = 1.0 - smoothstep(0.035, 0.11, length((I - B) - acG * dG));
    float core = texture(uCoreTone, vUv).r;
    float T = mix(1.0, max(core, 0.05), smoothstep(0.45, 0.7, core) * smoothstep(0.5, 0.9, texture(uWide, vUv).r));
    float aTone = clamp(acG / T, 0.0, 1.0);
    float keepNear = max(smoothstep(0.2, 0.8, texture(uNearThick, vUv).r), smoothstep(0.75, 0.95, m));
    aCol = mix(aCol, aTone, lineG * (1.0 - keepNear) * smoothstep(0.02, 0.06, ddG));
  }

  // 배경색과 거의 같은 색(안개·배경 얼룩)은 피사체로 보지 않는다
  vec3 dI = abs(I - B);
  float ev = smoothstep(0.045, 0.08, max(max(dI.r, dI.g), dI.b));
  // 물리적 하한: 이보다 낮으면 원래 색 계산이 검게 잘린다 (노이즈 수준은 무시)
  vec3 lo = (B - I) / max(B, vec3(0.2));
  float aMin = max(0.0, (clamp(max(max(lo.r, lo.g), lo.b), 0.0, 1.0) - 0.03) / 0.97);
  float aC = max(aCol, aMin);
  float a = mix(aC * ev, 1.0, solid) * roi;
  // 사용자가 지운 곳은 지운 만큼까지만, 되살린 곳은 되살린 만큼은 반드시 (색으로 다시 살아나거나 사라지지 않게)
  float mb = texture(uBase, vUv).r;
  a = min(a, mix(1.0, m, smoothstep(0.02, 0.15, mb - m)));
  a = max(a, m * smoothstep(0.02, 0.15, m - mb));
  // r = 최종 투명도, g = 원래 색을 되돌릴 때 쓰는 투명도 (안개 제거·범위 끝 처리로 깎기 전 값 → 색이 검게 잘리지 않음)
  o = vec4(mix(m, a, uAmt), mix(m, mix(aC, 1.0, solid), uAmt), 0.0, 1.0);
}`;

/** 확실한 피사체(uPickBg=0) 또는 확실한 배경(uPickBg=1) 픽셀의 색만 (premultiplied) 축소.
 *  흐리게 펴면 가장자리 색 채우기 / 경계 주변 배경색 추정에 쓴다. */
export const FS_FRINGEPREP = HEAD + /* glsl */ `
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform vec2 uSrcTexel;
uniform float uFactor;
uniform int uInvert;
uniform int uPickBg;
in vec2 vUv;
out vec4 o;
void main() {
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 uv = vUv + (vec2(float(x), float(y)) - 1.5) * 0.25 * uFactor * uSrcTexel;
      float m = textureLod(uMask, uv, 0.0).r;
      if (uInvert == 1) m = 1.0 - m;
      // 배경은 거의 완전히 투명한 곳만 (놓친 잔가지가 섞이면 배경색이 어둡게 추정됨)
      m = uPickBg == 1 ? smoothstep(0.97, 1.0, 1.0 - m) : smoothstep(0.9, 1.0, m);
      // 축소 렌더라 texture() 는 밉맵(이미 흐려진 사진)을 읽으므로 반드시 원본 해상도(LOD 0)에서
      acc += vec4(textureLod(uSrc, uv, 0.0).rgb * m, m);
    }
  }
  o = acc / 16.0;
}`;

/** 합성: 원본 → (색 오염 제거) → 보정 → 배경/그림자 위에 마스크로 합성. 출력은 회전 적용된 좌표계. */
export const FS_COMPOSITE = HEAD + COLOR_LIB + FG_LIB + /* glsl */ `
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform sampler2D uBgBlur;
uniform sampler2D uShadow;
uniform sampler2D uBgImg;
uniform mat3 uOrient;
uniform int uHasMask;
uniform int uBgMode;       // 0 원본, 1 투명, 2 단색, 3 흐림, 4 이미지
uniform vec3 uBgColor;
uniform vec4 uBgImgXf;
uniform int uShadowOn;
uniform vec4 uShadowP;     // xy: 오프셋(출력 uv), z: 불투명도
uniform vec3 uShadowColor;
uniform sampler2D uDist;       // 테두리용 거리장 (FS_JFA_*)
uniform vec2 uSrcSize;
uniform int uOutlineOn;
uniform int uOutlinePos;       // 0 바깥, 1 가운데, 2 안쪽
uniform float uOutlineW;
uniform float uOutlineSoft;
uniform float uOutlineOpacity;
uniform vec4 uOutlineC1;       // 가장 바깥쪽 색 (a = 불투명도)
uniform vec4 uOutlineC2;       // 가장 안쪽 색
in vec2 vUv;
out vec4 o;

const float R0 = 0.5 / 3.0;
const float R1 = 1.5 / 3.0;
const float R2 = 2.5 / 3.0;

bool inside01(vec2 p) { return p.x >= 0.0 && p.y >= 0.0 && p.x <= 1.0 && p.y <= 1.0; }

void main() {
  vec2 suv = (uOrient * vec3(vUv, 1.0)).xy;
  vec4 s = texture(uSrc, suv);
  vec3 orig = s.rgb;
  vec3 cs;
  float m;
  vec3 cb = vec3(0.0);
  float ab = 0.0;

  if (uHasMask == 0) {
    cs = applyAdj(orig, 0, R0);
    m = s.a;
  } else {
    m = texture(uMask, suv).r;
    vec3 f = orig;
    if (uBgMode != 0) f = cleanFg(suv, orig);
    cs = applyAdj(applyAdj(f, 0, R0), 12, R1);

    if (uBgMode == 0) {
      cb = applyAdj(applyAdj(orig, 0, R0), 24, R2);
      ab = s.a;
    } else if (uBgMode == 2) {
      cb = uBgColor;
      ab = 1.0;
    } else if (uBgMode == 3) {
      vec4 bb = texture(uBgBlur, suv);
      cb = bb.a > 0.002 ? bb.rgb / bb.a : orig;
      cb = applyAdj(applyAdj(cb, 0, R0), 24, R2);
      ab = 1.0;
    } else if (uBgMode == 4) {
      vec2 bu = vUv * uBgImgXf.xy + uBgImgXf.zw;
      if (inside01(bu)) {
        cb = applyAdj(applyAdj(texture(uBgImg, bu).rgb, 0, R0), 24, R2);
        ab = 1.0;
      }
    }

    if (uShadowOn == 1) {
      vec2 so = vUv - uShadowP.xy;
      float sh = inside01(so) ? texture(uShadow, (uOrient * vec3(so, 1.0)).xy).r * uShadowP.z : 0.0;
      cb = ab > 0.0 ? mix(cb, uShadowColor, sh) : uShadowColor;
      ab = ab + sh * (1.0 - ab);
    }
  }

  // 테두리: 피사체 윤곽까지의 거리로 띠를 만들고, 바깥→안쪽 방향으로 그라디언트 (포토샵 '획 · 모양 폭발형')
  vec3 sC = vec3(0.0);
  float sA = 0.0;
  if (uHasMask == 1 && uOutlineOn == 1) {
    ivec2 dsz = textureSize(uDist, 0);
    vec4 nn = texelFetch(uDist, clamp(ivec2(suv * vec2(dsz)), ivec2(0), dsz - 1), 0);
    vec2 sp = suv * uSrcSize;
    float dOut = nn.x >= 0.0 ? max(0.0, length(sp - nn.xy) - 0.5) : 1e5;
    float dIn = nn.z >= 0.0 ? max(0.0, length(sp - nn.zw) - 0.5) : 1e5;
    float sd = m >= 0.5 ? -dIn : dOut;            // + 바깥, - 안쪽
    float W = uOutlineW;
    float ob = uOutlinePos == 0 ? W : (uOutlinePos == 1 ? W * 0.5 : 0.0);  // 띠의 가장 바깥
    float ib = ob - W;                                                     // 띠의 가장 안쪽
    vec4 c = mix(uOutlineC1, uOutlineC2, clamp((ob - sd) / max(W, 1e-3), 0.0, 1.0));
    float s = max(uOutlineSoft, 0.6);
    // 피사체와 맞닿는 쪽은 끊김 없이 (바깥: 안쪽 경계 / 안쪽: 바깥 경계는 흐리지 않음)
    float outerF = uOutlinePos == 2 ? 1.0 : 1.0 - smoothstep(ob - s, ob + s, sd);
    float innerF = uOutlinePos == 0 ? 1.0 : smoothstep(ib - s, ib + s, sd);
    sA = c.a * outerF * innerF * uOutlineOpacity;
    if (uOutlinePos == 2) sA *= m;               // 안쪽: 피사체 밖으로 나가지 않게
    sC = c.rgb;
  }

  vec3 Pb = cb * ab;
  float Ab = ab;
  if (uOutlinePos == 0 && sA > 0.0) {            // 바깥 테두리는 피사체 뒤에
    Pb = sC * sA + Pb * (1.0 - sA);
    Ab = sA + Ab * (1.0 - sA);
  }
  vec3 P = cs * m + Pb * (1.0 - m);
  float A = m + Ab * (1.0 - m);
  if (uOutlinePos != 0 && sA > 0.0) {            // 가운데·안쪽 테두리는 피사체 위에
    P = sC * sA + P * (1.0 - sA);
    A = sA + A * (1.0 - sA);
  }
  o = vec4(A > 1e-4 ? P / A : cs, A);
}`;

/** 효과: 선명하게 / 부분 대비 / 비네팅 / 그레인 (합성 결과에 적용) */
export const FS_EFFECTS = HEAD + /* glsl */ `
uniform sampler2D uComp;
uniform sampler2D uBlur;
uniform vec2 uTexel;
uniform vec2 uOutSize;
uniform vec4 uCrop;
uniform float uClarity;
uniform float uSharpen;
uniform float uVignette;
uniform float uGrain;
uniform float uGrainSize;
in vec2 vUv;
out vec4 o;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
void main() {
  vec4 c = texture(uComp, vUv);
  vec3 col = c.rgb;
  if (uSharpen > 0.0) {
    vec3 nb = texture(uComp, vUv + vec2(uTexel.x, 0.0)).rgb + texture(uComp, vUv - vec2(uTexel.x, 0.0)).rgb
            + texture(uComp, vUv + vec2(0.0, uTexel.y)).rgb + texture(uComp, vUv - vec2(0.0, uTexel.y)).rgb;
    col += luma(col - nb * 0.25) * uSharpen * 2.0;
  }
  if (uClarity != 0.0) {
    float L = luma(col);
    float d = L - luma(texture(uBlur, vUv).rgb);
    float w = 1.0 - pow(abs(2.0 * clamp(L, 0.0, 1.0) - 1.0), 2.0);
    col += d * uClarity * 1.2 * w;
  }
  if (uVignette != 0.0) {
    vec2 p = (vUv - (uCrop.xy + uCrop.zw * 0.5)) / (uCrop.zw * 0.5);
    float v = smoothstep(0.35, 1.0, length(p) / 1.41421);
    if (uVignette > 0.0) col *= 1.0 - uVignette * v * 0.85;
    else col = mix(col, vec3(1.0), -uVignette * v * 0.8);
  }
  if (uGrain > 0.0) {
    vec2 gp = floor(vUv * uOutSize / uGrainSize);
    float nz = hash(gp) + hash(gp + 17.31) - 1.0;
    float L = luma(col);
    col += nz * uGrain * 0.12 * (1.0 - 0.6 * abs(2.0 * clamp(L, 0.0, 1.0) - 1.0));
  }
  o = vec4(clamp(col, 0.0, 1.0), c.a);
}`;

/** 화면 표시: 확대/이동, 투명 체커보드, 확인용 보기 모드, 비교, 자르기 음영 */
export const FS_DISPLAY = HEAD + FG_LIB + /* glsl */ `
uniform sampler2D uFinal;
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform mat3 uOrient;
uniform vec2 uCanvas;
uniform vec2 uOrigin;
uniform vec2 uOut;
uniform float uZoom;
uniform float uChecker;
uniform float uSplit;
uniform vec4 uView;
uniform vec4 uShade;
uniform int uMode;
uniform int uHasMask;
uniform vec3 uWork;
uniform sampler2D uSel;
uniform int uHasSel;
uniform float uTime;
out vec4 o;

float selAt(vec2 uv) {
  return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? 0.0 : texture(uSel, uv).r;
}

vec4 sampleSrc(vec2 suv, bool crisp) {
  if (crisp) {
    ivec2 sz = textureSize(uSrc, 0);
    return texelFetch(uSrc, clamp(ivec2(suv * vec2(sz)), ivec2(0), sz - 1), 0);
  }
  return texture(uSrc, suv);
}

void main() {
  vec2 sp = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec2 vp = (sp - uOrigin) / uZoom;
  vec2 op = vp + uView.xy;
  vec2 ouv = op / uOut;
  vec2 suv = (uOrient * vec3(ouv, 1.0)).xy;
  vec2 sdx = dFdx(suv);
  vec2 sdy = dFdy(suv);
  if (vp.x < 0.0 || vp.y < 0.0 || vp.x >= uView.z || vp.y >= uView.w) {
    o = vec4(uWork, 1.0);
    return;
  }
  bool crisp = uZoom >= 3.0;
  int mode = uMode;
  if (uSplit >= 0.0 && sp.x < uSplit) mode = 5;

  vec2 cc = floor(sp / uChecker);
  vec3 checker = mod(cc.x + cc.y, 2.0) < 1.0 ? vec3(1.0) : vec3(0.85);
  vec3 col;
  if (mode == 0) {
    vec4 f = crisp ? texelFetch(uFinal, ivec2(op), 0) : texture(uFinal, ouv);
    col = mix(checker, f.rgb, f.a);
  } else if (mode == 5) {
    vec4 s = sampleSrc(suv, crisp);
    col = mix(checker, s.rgb, s.a);
  } else {
    float m = uHasMask == 1 ? texture(uMask, suv).r : 1.0;
    vec4 s = sampleSrc(suv, crisp);
    if (mode == 1) {
      col = mix(s.rgb, vec3(1.0, 0.16, 0.3), (1.0 - m) * 0.6);
    } else if (mode == 2) {
      col = vec3(m);
    } else {
      vec3 f = cleanFg(suv, s.rgb);
      col = mix(mode == 3 ? vec3(0.0) : vec3(1.0), f, m);
    }
  }
  if (uShade.z > 0.0) {
    if (op.x < uShade.x || op.y < uShade.y || op.x > uShade.x + uShade.z || op.y > uShade.y + uShade.w) col *= 0.35;
  }
  // 선택 영역 테두리 (움직이는 점선)
  if (uHasSel == 1) {
    bool in0 = selAt(suv) > 0.5;
    bool edge = in0 != (selAt(suv + sdx) > 0.5) || in0 != (selAt(suv - sdx) > 0.5) ||
                in0 != (selAt(suv + sdy) > 0.5) || in0 != (selAt(suv - sdy) > 0.5);
    if (edge) col = vec3(mod(floor((sp.x + sp.y) / 4.0 + uTime), 2.0));
  }
  o = vec4(col, 1.0);
}`;
