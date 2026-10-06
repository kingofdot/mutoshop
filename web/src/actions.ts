// 앱 동작 모음: 화면 컴포넌트는 여기 함수만 부른다.
import type { Renderer } from "./gl/renderer";
import { cancelJob, fetchResult, fetchStatus, pollJob, serverDecode, startCutout } from "./lib/api";
import { autoAdjust as computeAuto } from "./lib/autoAdjust";
import { presetToAdjust, type Preset } from "./lib/presets";
import { confirmAsk } from "./dialog";
import { clearResources, newId, resources } from "./resources";
import { hasUnsaved, useStore } from "./store";
import { defaultAdjust, defaultDoc, defaultEdge, outputSize, type Rect, type Target } from "./types";
import { orientMatrix, outToSrc, srcToOut } from "./gl/params";
import { clearSelection } from "./selection";

let renderer: Renderer | null = null;
export const setRenderer = (r: Renderer | null) => (renderer = r);
export const getRenderer = () => renderer;

const MAX_SIDE = 12000;
const MAX_PIXELS = 40_000_000;
let srcVersion = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toast = (t: string, k?: "info" | "success" | "error", ms?: number) => useStore.getState().toast(t, k, ms);

// ---------------------------------------------------------------------------
// 서버 상태

export async function refreshServer() {
  const info = await fetchStatus();
  useStore.getState().set({ server: info });
  return info;
}

// ---------------------------------------------------------------------------
// 열기

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image", premultiplyAlpha: "none" });
  } catch {
    // HEIC 등 브라우저가 못 여는 형식 → 서버에서 변환
    const img = await serverDecode(file);
    return createImageBitmap(img, { premultiplyAlpha: "none" });
  }
}

export async function openImage(file: Blob, name: string) {
  const st = useStore.getState();
  if (st.job) {
    toast("누끼 작업이 끝난 뒤에 열어 주세요.", "info");
    return;
  }
  if (hasUnsaved()) {
    const ok = await confirmAsk({
      title: "새 이미지를 열까요?",
      body: "내보내지 않은 편집 내용은 사라집니다.",
      ok: "열기",
      cancel: "취소",
    });
    if (!ok) return;
  }
  st.set({ busy: "이미지를 여는 중…" });
  try {
    let bmp = await decode(file);
    let note = "";
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height), Math.sqrt(MAX_PIXELS / (bmp.width * bmp.height)));
    if (scale < 1) {
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      note = `큰 이미지라 ${bmp.width}×${bmp.height} → ${w}×${h}로 줄여서 열었어요.`;
      const small = await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
      bmp.close();
      bmp = small;
    }
    const { width: w, height: h } = bmp;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const data = ctx.getImageData(0, 0, w, h).data;
    let hasAlpha = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) {
        hasAlpha = true;
        break;
      }
    }
    clearResources();
    resources.source = { name, w, h, data, hasAlpha, version: ++srcVersion };
    const doc = defaultDoc();
    if (hasAlpha) {
      // 이미 투명 배경인 PNG → 투명도를 누끼 마스크로 사용
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) mask[i] = data[i * 4 + 3];
      const maskId = newId("m");
      resources.masks.set(maskId, { w, h, data: mask });
      doc.cutout = { maskId, fgId: null, source: "alpha" };
      doc.bg.mode = "transparent";
    }
    clearSelection();
    useStore.getState().loadDoc({ name, w, h, version: srcVersion }, doc);
    if (note) toast(note, "info", 5000);
  } catch (e) {
    console.error(e);
    toast("이미지를 열 수 없습니다. 지원하지 않는 형식이거나 파일이 손상되었어요.", "error", 5000);
  } finally {
    useStore.getState().set({ busy: null });
  }
}

export function pickFile(accept = "image/*"): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function openFromPicker() {
  const f = await pickFile("image/*,.heic,.heif");
  if (f) await openImage(f, f.name);
}

// ---------------------------------------------------------------------------
// 누끼

let cutoutToken: object | null = null;

export async function runCutout() {
  const st = useStore.getState();
  const src = resources.source;
  if (!src || st.job) return;
  if (!st.server?.ok) {
    const info = await refreshServer();
    if (!info.ok) {
      toast("AI 서버에 연결할 수 없습니다. start.bat 으로 프로그램을 실행했는지 확인해 주세요.", "error", 6000);
      return;
    }
  }
  const token = {};
  cutoutToken = token;
  const alive = () => cutoutToken === token;
  const setJob = (j: Parameters<typeof st.set>[0]["job"]) => alive() && useStore.getState().set({ job: j });
  setJob({ id: "", state: "queued", stage: "upload", progress: 0, message: "이미지 보내는 중" });
  let id = "";
  try {
    id = await startCutout(src, useStore.getState().model, useStore.getState().precise);
    if (!alive()) return;
    setJob({ id, state: "queued", stage: "queued", progress: 0.02, message: "준비 중" });
    for (;;) {
      await sleep(250);
      if (!alive()) return;
      const j = await pollJob(id);
      if (j.state === "error") throw new Error(j.error || "알 수 없는 오류");
      if (j.state === "cancelled") return;
      setJob({ id, state: j.state, stage: j.stage, progress: j.progress, message: j.message });
      if (j.state === "done") break;
    }
    setJob({ id, state: "done", stage: "fetch", progress: 1, message: "결과 불러오는 중" });
    const [mask, fg] = await Promise.all([fetchResult(id, "mask"), fetchResult(id, "fg")]);
    if (!alive() || resources.source !== src) return; // 취소했거나 그 사이 다른 이미지를 열었음
    const maskId = newId("m");
    const fgId = newId("f");
    resources.masks.set(maskId, { w: src.w, h: src.h, data: mask });
    resources.fgs.set(fgId, { w: src.w, h: src.h, data: fg });
    useStore.getState().change("자동 누끼", (d) => {
      d.cutout = { maskId, fgId, source: "ai" };
      d.strokes = [];
      d.invert = false;
      if (d.bg.mode === "original") d.bg.mode = "transparent";
    });
    // 배경이 단색(흰 배경 사진·일러스트 등)이면 흰 테두리 제거까지 바로 적용 — Ctrl+Z 한 번으로 해제
    const bgInfo = detectBackground();
    if (bgInfo.uniform && bgInfo.light) {
      removeFringe(true);
      toast("누끼 완료! 흰 배경이라 테두리에 섞인 흰색도 자동으로 걷어 냈어요. (Ctrl+Z로 해제)", "success", 5000);
    } else {
      toast("누끼 완료! 브러시로 세밀하게 다듬거나 배경을 바꿔 보세요.", "success", 4000);
    }
  } catch (e) {
    console.error(e);
    if (alive()) toast(`누끼에 실패했어요: ${(e as Error).message}`, "error", 7000);
  } finally {
    if (id) cancelJob(id); // 서버 메모리 정리
    if (alive()) {
      cutoutToken = null;
      useStore.getState().set({ job: null });
    }
    refreshServer();
  }
}

export function cancelCutout() {
  const job = useStore.getState().job;
  if (!job) return;
  cutoutToken = null;
  if (job.id) cancelJob(job.id);
  useStore.getState().set({ job: null });
  toast("누끼 작업을 취소했어요.");
}

export function clearCutout() {
  useStore.getState().change("누끼 해제", (d) => {
    d.cutout = null;
    d.strokes = [];
    d.invert = false;
    d.edge = defaultEdge();
    d.bg.mode = "original";
    d.shadow.enabled = false;
  });
  const st = useStore.getState();
  if (st.tool === "brush") st.setTool("hand");
  st.set({ viewMode: "normal", target: "global" });
}

/** 원래 배경 추정: 확실한 배경(마스크≈0) 픽셀의 중앙값과, 배경이 단색에 가까운지 */
export function detectBackground(): { color: string; uniform: boolean; light: boolean } {
  const s = useStore.getState();
  const src = resources.source;
  const cut = s.doc.cutout;
  const none = { color: "#ffffff", uniform: false, light: false };
  if (!src || !cut || cut.source === "alpha") return none;
  const mask = resources.masks.get(cut.maskId)?.data;
  if (!mask) return none;
  const step = Math.max(1, Math.floor(Math.sqrt((src.w * src.h) / 150_000)));
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (let y = 0; y < src.h; y += step) {
    for (let x = 0; x < src.w; x += step) {
      const p = y * src.w + x;
      if (mask[p] > 8) continue;
      rs.push(src.data[p * 4]);
      gs.push(src.data[p * 4 + 1]);
      bs.push(src.data[p * 4 + 2]);
    }
  }
  if (rs.length < 20) return none;
  const med = (a: number[]) => a.slice().sort((u, v) => u - v)[a.length >> 1];
  const mr = med(rs), mg = med(gs), mb = med(bs);
  // 중앙값에서의 평균 거리(MAD)가 작으면 단색 배경
  const mad = med(rs.map((v, i) => Math.abs(v - mr) + Math.abs(gs[i] - mg) + Math.abs(bs[i] - mb)));
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  // 흰색·밝은 회색 배경 (색 있는 배경은 그림자와 피사체를 색만으로 구분하기 어려워 자동 적용하지 않는다)
  const light = 0.2126 * mr + 0.7152 * mg + 0.0722 * mb > 200 && Math.max(mr, mg, mb) - Math.min(mr, mg, mb) < 30;
  return { color: `#${hex(mr)}${hex(mg)}${hex(mb)}`, uniform: mad < 18, light };
}

export const detectMatteColor = () => detectBackground().color;

/** 흰 테두리(원래 배경색 번짐) 한 번에 제거: 배경색 빼기 + 가장자리 색 채우기 */
export function removeFringe(silent = false) {
  const s = useStore.getState();
  if (!s.doc.cutout) return;
  const alpha = s.doc.cutout.source === "alpha";
  const bg = detectBackground();
  s.change("흰 테두리 제거", (d) => {
    d.edge.deconMode = "matte";
    d.edge.matteSource = alpha ? "color" : "auto";
    if (alpha) d.edge.matteColor = "#ffffff";
    d.edge.decontaminate = 100;
    // 배경이 단색이면 투명도도 색으로 다시 계산 (가지·털 사이에 남은 흰 안개 제거).
    // 그러면 색도 정확히 되돌아오므로 색 채우기는 필요 없다. 아니면 색 채우기로 남은 기운을 덮는다.
    if (!alpha && bg.uniform && !d.invert) {
      d.edge.colorAlpha = 100;
      // 단색 배경은 위치마다 추정하는 것보다 감지한 한 가지 색이 더 정확하다 (실험으로 확인)
      d.edge.matteSource = "color";
      d.edge.matteColor = bg.color;
      d.edge.defringe = 0;
    } else {
      d.edge.defringe = Math.max(d.edge.defringe, 2);
    }
    if (d.bg.mode === "original") d.bg.mode = "transparent";
  });
  if (!silent) s.toast(alpha ? "흰색 배경이 섞인 테두리를 걷어 냈어요. 다른 색이 섞였다면 배경색을 직접 지정하세요." : "테두리에 섞인 원래 배경색을 걷어 냈어요.", "success", 4000);
}

export function resetMaskEdits() {
  useStore.getState().change("마스크 수정 초기화", (d) => {
    d.strokes = [];
    d.invert = false;
    d.edge = defaultEdge();
  });
}

// ---------------------------------------------------------------------------
// 이미지 변형

export function rotate(dir: 1 | -1) {
  useStore.getState().change(dir === 1 ? "오른쪽으로 90° 회전" : "왼쪽으로 90° 회전", (d) => {
    // 반전된 상태에서는 회전 방향이 화면 기준으로 뒤집히지 않도록 보정
    const step = d.orient.flip ? -dir : dir;
    d.orient.rot = (((d.orient.rot + step) % 4) + 4) % 4 as 0 | 1 | 2 | 3;
    if (d.crop) d.crop = rotateRect(d.crop, dir);
  });
  const st = useStore.getState();
  if (st.tool === "crop") st.set({ cropDraft: st.cropDraft ? rotateRect(st.cropDraft, dir) : null });
  st.fitView();
}

export function flip() {
  useStore.getState().change("좌우 반전", (d) => {
    d.orient.flip = !d.orient.flip;
    if (d.crop) d.crop = { ...d.crop, x: 1 - d.crop.x - d.crop.w };
  });
  const st = useStore.getState();
  if (st.tool === "crop" && st.cropDraft) st.set({ cropDraft: { ...st.cropDraft, x: 1 - st.cropDraft.x - st.cropDraft.w } });
}

function rotateRect(r: Rect, dir: 1 | -1): Rect {
  return dir === 1 ? { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w } : { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
}

export function applyCrop() {
  const st = useStore.getState();
  const c = st.cropDraft;
  if (!c) return;
  const full = c.x <= 0.0005 && c.y <= 0.0005 && c.w >= 0.999 && c.h >= 0.999;
  st.change(full ? "자르기 해제" : "자르기", (d) => {
    d.crop = full ? null : { ...c };
  });
  st.setTool(st.prevTool === "crop" ? "hand" : st.prevTool);
}

export function cancelCrop() {
  const st = useStore.getState();
  st.setTool(st.prevTool === "crop" ? "hand" : st.prevTool);
}

// ---------------------------------------------------------------------------
// 색감

export function applyPreset(p: Preset) {
  const st = useStore.getState();
  const target = st.target;
  st.change(`필터: ${p.name}`, (d) => {
    d.adjust[target] = presetToAdjust(p);
    if (target === "global") {
      d.effects.vignette = p.vignette ?? 0;
      d.effects.grain = p.grain ?? 0;
    }
  });
}

export function runAutoAdjust() {
  const st = useStore.getState();
  const src = resources.source;
  if (!src) return;
  const target = st.target;
  let weight: Uint8Array | null = null;
  if (target !== "global" && st.doc.cutout) weight = resources.masks.get(st.doc.cutout.maskId)?.data ?? null;
  const v = computeAuto(src, weight, target === "background");
  st.change("자동 보정", (d) => {
    const a = defaultAdjust();
    a.hsl = d.adjust[target].hsl;
    a.curves = d.adjust[target].curves;
    Object.assign(a, v);
    d.adjust[target] = a;
  });
}

export function resetAdjust(target: Target) {
  useStore.getState().change("보정 초기화", (d) => {
    d.adjust[target] = defaultAdjust();
    if (target === "global") d.effects = { clarity: 0, sharpen: 0, vignette: 0, grain: 0 };
  });
}

// ---------------------------------------------------------------------------
// 배경

export async function chooseBackgroundImage() {
  const f = await pickFile("image/*,.heic,.heif");
  if (!f) return;
  try {
    const bmp = await decode(f);
    const id = newId("b");
    resources.bgImages.set(id, bmp);
    useStore.getState().change("배경 이미지", (d) => {
      d.bg.mode = "image";
      d.bg.imageId = id;
    });
  } catch {
    toast("배경 이미지를 열 수 없습니다.", "error");
  }
}

/** 화면 좌표(CSS px) → 원본 픽셀 색 (#rrggbb) */
export function sampleSourceColor(sx: number, sy: number): string | null {
  const s = useStore.getState();
  const src = resources.source;
  if (!src || !s.image) return null;
  const p = screenToSource(sx, sy);
  if (!p) return null;
  const x = Math.min(src.w - 1, Math.max(0, Math.floor(p[0])));
  const y = Math.min(src.h - 1, Math.max(0, Math.floor(p[1])));
  // 3x3 평균으로 잡티 영향 줄이기
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(src.w - 1, Math.max(0, x + dx)), yy = Math.min(src.h - 1, Math.max(0, y + dy));
      const i = (yy * src.w + xx) * 4;
      r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; n++;
    }
  }
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// ---------------------------------------------------------------------------
// 좌표 변환

/** 화면 CSS px → 출력 px */
export function screenToOutput(sx: number, sy: number): [number, number] | null {
  const s = useStore.getState();
  if (!s.image) return null;
  const { zoom, ox, oy } = s.view;
  const dpr = s.viewport.dpr;
  const [vx, vy] = viewOffset();
  return [(sx * dpr - ox) / zoom + vx, (sy * dpr - oy) / zoom + vy];
}

/** 화면 CSS px → 원본 px */
export function screenToSource(sx: number, sy: number): [number, number] | null {
  const s = useStore.getState();
  const o = screenToOutput(sx, sy);
  if (!o || !s.image) return null;
  const [W, H] = outputSize(s.image.w, s.image.h, s.doc.orient);
  const [su, sv] = outToSrc(orientMatrix(s.doc.orient), o[0] / W, o[1] / H);
  return [su * s.image.w, sv * s.image.h];
}

/** 원본 px → 화면 CSS px */
export function sourceToScreen(x: number, y: number): [number, number] | null {
  const s = useStore.getState();
  if (!s.image) return null;
  const [W, H] = outputSize(s.image.w, s.image.h, s.doc.orient);
  const [ou, ov] = srcToOut(orientMatrix(s.doc.orient), x / s.image.w, y / s.image.h);
  const [vx, vy] = viewOffset();
  const { zoom, ox, oy } = s.view;
  const dpr = s.viewport.dpr;
  return [((ou * W - vx) * zoom + ox) / dpr, ((ov * H - vy) * zoom + oy) / dpr];
}

function viewOffset(): [number, number] {
  const s = useStore.getState();
  if (!s.image || s.tool === "crop" || !s.doc.crop) return [0, 0];
  const [W, H] = outputSize(s.image.w, s.image.h, s.doc.orient);
  return [Math.round(s.doc.crop.x * W), Math.round(s.doc.crop.y * H)];
}

// ---------------------------------------------------------------------------
// 내보내기

export type ExportFormat = "png" | "jpeg" | "webp";
export type ExportLayout = "as-is" | "trim" | "square";

export interface ExportOptions {
  format: ExportFormat;
  quality: number; // 0..1
  longSide: number | null; // null = 원본
  layout: ExportLayout;
  padding: number; // %
}

export const MIME: Record<ExportFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
export const EXT: Record<ExportFormat, string> = { png: ".png", jpeg: ".jpg", webp: ".webp" };

/** 내보낼 영역 (출력 px) */
function exportRegion(): { x: number; y: number; w: number; h: number } | null {
  const s = useStore.getState();
  if (!s.image) return null;
  const [W, H] = outputSize(s.image.w, s.image.h, s.doc.orient);
  const c = s.doc.crop;
  if (!c) return { x: 0, y: 0, w: W, h: H };
  const x = Math.round(c.x * W), y = Math.round(c.y * H);
  return { x, y, w: Math.max(1, Math.min(W - x, Math.round(c.w * W))), h: Math.max(1, Math.min(H - y, Math.round(c.h * H))) };
}

/** 레이아웃/크기 적용 후의 최종 크기 계산 (대화상자 미리 표시용) */
export function plannedExportSize(o: ExportOptions): [number, number] | null {
  const r = exportRegion();
  if (!r) return null;
  let [w, h] = [r.w, r.h];
  if (o.layout !== "as-is" && lastBounds) {
    const pad = Math.round((Math.max(lastBounds.w, lastBounds.h) * o.padding) / 100);
    if (o.layout === "trim") [w, h] = [lastBounds.w + pad * 2, lastBounds.h + pad * 2];
    else w = h = Math.max(lastBounds.w, lastBounds.h) + pad * 2;
  }
  if (o.longSide && Math.max(w, h) > o.longSide) {
    const s = o.longSide / Math.max(w, h);
    [w, h] = [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
  }
  return [w, h];
}

let lastBounds: { x: number; y: number; w: number; h: number } | null = null;

/** 대화상자를 열 때 한 번 피사체 영역을 계산해 둔다 */
export function measureSubject() {
  const r = exportRegion();
  lastBounds = r && renderer ? renderer.subjectBounds(r) : null;
  return lastBounds;
}

export async function renderExport(o: ExportOptions): Promise<Blob> {
  const s = useStore.getState();
  const r = exportRegion();
  if (!renderer || !r) throw new Error("이미지가 없습니다.");
  const img = renderer.readOutput(r);
  if (!img) throw new Error("결과를 읽지 못했습니다.");

  let canvas = document.createElement("canvas");
  canvas.width = r.w;
  canvas.height = r.h;
  canvas.getContext("2d")!.putImageData(img, 0, 0);

  const b = o.layout !== "as-is" ? lastBounds ?? measureSubject() : null;
  if (b) {
    const pad = Math.round((Math.max(b.w, b.h) * o.padding) / 100);
    const [cw, ch] = o.layout === "trim" ? [b.w + pad * 2, b.h + pad * 2] : [Math.max(b.w, b.h) + pad * 2, Math.max(b.w, b.h) + pad * 2];
    const out = document.createElement("canvas");
    out.width = cw;
    out.height = ch;
    const ctx = out.getContext("2d")!;
    if (s.doc.bg.mode === "color") {
      ctx.fillStyle = s.doc.bg.color;
      ctx.fillRect(0, 0, cw, ch);
    }
    ctx.drawImage(canvas, b.x - r.x, b.y - r.y, b.w, b.h, Math.round((cw - b.w) / 2), Math.round((ch - b.h) / 2), b.w, b.h);
    canvas = out;
  }

  if (o.longSide && Math.max(canvas.width, canvas.height) > o.longSide) {
    const sc = o.longSide / Math.max(canvas.width, canvas.height);
    const w = Math.max(1, Math.round(canvas.width * sc)), h = Math.max(1, Math.round(canvas.height * sc));
    const bmp = await createImageBitmap(canvas, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
    canvas = out;
  }

  if (o.format === "jpeg") {
    // JPG 는 투명을 지원하지 않으므로 흰색(또는 단색 배경색) 위에 깔기
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = s.doc.bg.mode === "color" ? s.doc.bg.color : "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    canvas = out;
  }

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("이미지 인코딩 실패"))), MIME[o.format], o.quality),
  );
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (o: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
}

/** 저장 위치를 고를 수 있으면 고르게, 아니면 다운로드 폴더로 */
export async function saveBlob(blob: Blob, filename: string, format: ExportFormat): Promise<boolean> {
  const w = window as unknown as SaveFilePickerWindow;
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: format.toUpperCase() + " 이미지", accept: { [MIME[format]]: [EXT[format]] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return false;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return true;
}

export async function copyToClipboard(o?: Partial<ExportOptions>) {
  try {
    const blob = await renderExport({ format: "png", quality: 1, longSide: null, layout: "as-is", padding: 0, ...o });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("클립보드에 복사했어요. 다른 프로그램에 붙여넣기 하세요.", "success");
  } catch (e) {
    console.error(e);
    toast("클립보드에 복사하지 못했습니다.", "error");
  }
}

export function baseName() {
  const n = useStore.getState().image?.name ?? "image";
  return n.replace(/\.[^.]+$/, "");
}
