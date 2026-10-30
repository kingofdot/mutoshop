// 지금 사진을 '어디서 가져왔는지' 기억해서 원본에 그대로 덮어쓸 수 있게 한다.
//  - 필름 줄(폴더 열기)에서 연 사진: 서버가 원본 경로를 알고 있다
//  - 열기(Ctrl+O)·끌어다 놓기로 연 사진: 브라우저가 준 파일 핸들로 (처음 한 번 '수정 허용'을 물을 수 있음)
//  - 붙여넣기로 연 사진은 원본 파일이 없어 덮어쓸 수 없다
import { create } from "zustand";
import { renderExport, type ExportFormat } from "./actions";
import { confirmAsk } from "./dialog";
import { useStore } from "./store";

export interface FileHandleLike {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
  requestPermission?: (o: { mode: "readwrite" }) => Promise<"granted" | "denied" | "prompt">;
  createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>;
}

export type Origin =
  | { kind: "folder"; token: string; index: number; name: string }
  | { kind: "file"; handle: FileHandleLike; name: string };

export const useOrigin = create<{ origin: Origin | null }>(() => ({ origin: null }));

/** 다음에 열리는 사진의 출처 (사진을 여는 쪽이 열기 직전에 정한다) */
let pending: Origin | Promise<Origin | null> | null = null;

export function expectOrigin(o: Origin | Promise<Origin | null> | null) {
  pending = o;
}

/** 여는 걸 취소했으면 (확인 창에서 취소 등) 다음 사진에 잘못 붙지 않게 */
export function clearPendingOrigin() {
  pending = null;
}

useStore.subscribe((s, p) => {
  if (s.image === p.image) return;
  const o = pending;
  pending = null;
  useOrigin.setState({ origin: null });
  if (!s.image || !o) return;
  const img = s.image;
  Promise.resolve(o).then((v) => {
    if (v && useStore.getState().image === img) useOrigin.setState({ origin: v });
  }, () => undefined);
});

const FORMAT: Record<string, ExportFormat> = { png: "png", webp: "webp", jpg: "jpeg", jpeg: "jpeg", jfif: "jpeg" };

export function originFormat(o: Origin): ExportFormat | null {
  return FORMAT[(o.name.split(".").pop() || "").toLowerCase()] ?? null;
}

/** 서버(폴더 열기)로 원본 덮어쓰기 */
async function overwriteOnServer(token: string, i: number, blob: Blob): Promise<void> {
  const r = await fetch(`/api/batch/${token}/overwrite/${i}`, { method: "POST", body: blob });
  if (!r.ok) {
    let msg = `서버 오류 (${r.status})`;
    try {
      const j = await r.json();
      if (typeof j.detail === "string") msg = j.detail;
    } catch {
      /* 무시 */
    }
    throw new Error(msg);
  }
}

/** 지금 결과를 원본 파일에 그대로 덮어쓴다 (같은 이름 · 같은 형식). 덮어쓰기 전에 꼭 확인을 받는다.
 *  onDone: 폴더 열기에서 연 사진이면 완료 표시 등 (folder.ts) */
export async function overwriteOriginal(onDone?: (o: Origin) => void): Promise<boolean> {
  const st = useStore.getState();
  const o = useOrigin.getState().origin;
  if (!o || !st.image) {
    st.toast("원본 파일을 알 수 없는 사진이에요 (붙여넣기 등). 내보내기로 저장해 주세요.", "info", 5000);
    return false;
  }
  const format = originFormat(o);
  if (!format) {
    st.toast(`${o.name} 형식은 덮어쓸 수 없어요. 내보내기로 저장해 주세요.`, "info", 5000);
    return false;
  }
  const loseAlpha = format === "jpeg" && !!st.doc.cutout && st.doc.bg.mode === "transparent";
  const ok = await confirmAsk({
    title: "원본에 덮어쓸까요?",
    body: `${o.name}\n원래 파일이 지금 편집한 결과로 바뀌고, 되돌릴 수 없어요.${loseAlpha ? "\nJPG 파일이라 투명한 곳은 흰색으로 저장돼요." : ""}`,
    ok: "덮어쓰기",
    cancel: "취소",
    danger: true,
  });
  if (!ok) return false;
  try {
    const blob = await renderExport({ format, quality: format === "png" ? 0.92 : 0.95, longSide: null, layout: "as-is", padding: 8 });
    if (o.kind === "file") {
      if (o.handle.requestPermission && (await o.handle.requestPermission({ mode: "readwrite" })) !== "granted") {
        throw new Error("파일 수정 권한을 받지 못했어요");
      }
      const w = await o.handle.createWritable();
      await w.write(blob);
      await w.close();
    } else {
      await overwriteOnServer(o.token, o.index, blob);
    }
    const info = `${format.toUpperCase()} · ${(blob.size / 1024 / 1024).toFixed(1)}MB`;
    st.markSaved({ name: `${o.name} (원본 덮어씀)`, info });
    st.toast(`원본에 덮어썼어요 · ${o.name} · ${info}`, "success", 3500);
    onDone?.(o);
    return true;
  } catch (e) {
    st.toast(`덮어쓰지 못했어요: ${(e as Error).message}`, "error", 6000);
    return false;
  }
}
