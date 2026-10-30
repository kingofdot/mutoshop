import type { JobState, ServerInfo } from "../store";
import type { SourceImage } from "../resources";
import type { CutKind, Inner } from "../types";

async function errorText(r: Response) {
  try {
    const j = await r.json();
    return typeof j.detail === "string" ? j.detail : `서버 오류 (${r.status})`;
  } catch {
    return `서버 오류 (${r.status})`;
  }
}

export async function fetchStatus(): Promise<ServerInfo> {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return { ok: true, device: j.device, models: j.models };
  } catch {
    return { ok: false };
  }
}

/** 누끼 시작. 서버가 배경을 보고 고른다: 단색(에 가까운) 배경이면 종류별 에셋 누끼, 사진이면 AI.
 *  사진 AI 의 모델·강도는 서버가 종류로 정한다 (인물만 인물 모델, fine 은 인물 사진에서만 최고 품질) */
export async function startCutout(
  src: SourceImage, kind: CutKind, inner: Inner, fine: boolean, seeds?: [number, number][], border = true,
): Promise<string> {
  const q = new URLSearchParams({
    w: String(src.w), h: String(src.h), kind, inner, fine: kind === "person" && fine ? "1" : "0",
  });
  if (seeds?.length) {
    // 배경 찍기: 찍은 자리와 이어진 배경을 지운다 (border=1 이면 테두리 배경도 자동으로)
    q.set("seeds", seeds.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(";"));
    q.set("border", border ? "1" : "0");
  }
  const r = await fetch(`/api/cutout?${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: src.data as unknown as BodyInit,
  });
  if (!r.ok) throw new Error(await errorText(r));
  return (await r.json()).id;
}

/** method: asset = 단색 배경이라 배경색으로 땀 · ai = 사진이라 AI 로 땀. note = 사용자에게 보여 줄 서버 알림 */
export async function pollJob(id: string): Promise<JobState & {
  error?: string | null; note?: string | null; method?: "asset" | "ai" | null;
}> {
  const r = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
  if (!r.ok) throw new Error(await errorText(r));
  return r.json();
}

export async function fetchResult(id: string, kind: "mask" | "fg"): Promise<Uint8Array> {
  const r = await fetch(`/api/jobs/${id}/${kind}`, { cache: "no-store" });
  if (!r.ok) throw new Error(await errorText(r));
  return new Uint8Array(await r.arrayBuffer());
}

export function cancelJob(id: string) {
  return fetch(`/api/jobs/${id}`, { method: "DELETE" }).catch(() => undefined);
}

/** 브라우저가 못 여는 이미지(HEIC 등)를 서버에서 RGBA 로 변환 */
export async function serverDecode(file: Blob): Promise<ImageData> {
  const r = await fetch("/api/decode", { method: "POST", body: file });
  if (!r.ok) throw new Error(await errorText(r));
  const w = Number(r.headers.get("X-Width"));
  const h = Number(r.headers.get("X-Height"));
  const buf = new Uint8ClampedArray(await r.arrayBuffer());
  return new ImageData(buf, w, h);
}

// ---------------------------------------------------------------------------
// 폴더 일괄 처리 (파일 입출력은 서버가, 누끼·외곽선·내보내기는 편집기가)

export interface BatchFolder {
  token: string;
  folder: string;
  out: string;
  files: { rel: string; size: number }[];
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await errorText(r));
  return r.json();
}

/** Windows 폴더 선택 창 (취소하면 null) */
export async function batchPick(initial = "", title = "폴더 선택"): Promise<string | null> {
  const q = new URLSearchParams({ initial, title });
  return (await postJson<{ path: string | null }>(`/api/batch/pick?${q}`)).path;
}

export function batchScan(folder: string, recursive: boolean, out?: string): Promise<BatchFolder> {
  return postJson<BatchFolder>("/api/batch/scan", { folder, recursive, out: out || null });
}

export async function batchPlan(token: string, ext: string, suffix: string): Promise<boolean[]> {
  return (await postJson<{ exists: boolean[] }>(`/api/batch/${token}/plan`, { ext, suffix })).exists;
}

export async function batchRead(token: string, i: number): Promise<{ w: number; h: number; data: Uint8ClampedArray; orig: string }> {
  const r = await fetch(`/api/batch/${token}/file/${i}`, { cache: "no-store" });
  if (!r.ok) throw new Error(await errorText(r));
  const w = Number(r.headers.get("X-Width"));
  const h = Number(r.headers.get("X-Height"));
  return { w, h, data: new Uint8ClampedArray(await r.arrayBuffer()), orig: r.headers.get("X-Orig") ?? "" };
}

export async function batchSave(
  token: string, i: number, ext: string, suffix: string, blob: Blob, overwrite: boolean,
): Promise<{ path: string; skipped: boolean }> {
  const q = new URLSearchParams({ ext, suffix, overwrite: overwrite ? "1" : "0" });
  const r = await fetch(`/api/batch/${token}/save/${i}?${q}`, { method: "POST", body: blob });
  if (!r.ok) throw new Error(await errorText(r));
  return r.json();
}

export function batchOpenOut(token: string) {
  return postJson(`/api/batch/${token}/open`).catch(() => undefined);
}

export interface BatchRunStatus {
  state: "running" | "done" | "stopped";
  index: number;
  message: string;
  progress: number;
  items: { status: "pending" | "running" | "done" | "warn" | "skipped" | "error" | "stopped"; msg?: string; ms?: number }[];
}

/** 폴더 처리를 서버에서 시작 (설정은 폴더 작업 창의 값 그대로) */
export function batchRun(token: string, settings: unknown) {
  return postJson(`/api/batch/${token}/run`, { settings });
}

export async function batchStatus(token: string): Promise<BatchRunStatus> {
  const r = await fetch(`/api/batch/${token}/status`, { cache: "no-store" });
  if (!r.ok) throw new Error(await errorText(r));
  return r.json();
}

export function batchStop(token: string) {
  return postJson(`/api/batch/${token}/stop`);
}
