import type { JobState, ServerInfo } from "../store";
import type { SourceImage } from "../resources";

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

export async function startCutout(src: SourceImage, model: string, precise: boolean): Promise<string> {
  const q = new URLSearchParams({ w: String(src.w), h: String(src.h), model, precise: precise ? "1" : "0" });
  const r = await fetch(`/api/cutout?${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: src.data as unknown as BodyInit,
  });
  if (!r.ok) throw new Error(await errorText(r));
  return (await r.json()).id;
}

export async function pollJob(id: string): Promise<JobState & { error?: string | null }> {
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
