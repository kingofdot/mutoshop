import { useEffect, useState } from "react";
import { activateWindow } from "../lib/host";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useDialog } from "../dialog";
import { useStore } from "../store";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.kind === "success" ? <CheckCircle2 size={17} /> : t.kind === "error" ? <AlertCircle size={17} /> : <Info size={17} />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const cur = useDialog((s) => s.current);
  useEffect(() => {
    if (!cur) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cur.resolve(false);
      if (e.key === "Enter") cur.resolve(true);
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cur]);
  if (!cur) return null;
  return (
    <div className="modal-veil" onPointerDown={(e) => e.target === e.currentTarget && cur.resolve(false)}>
      <div className="modal small">
        <div className="modal-head">
          <h3>{cur.title}</h3>
        </div>
        {cur.body && <div className="modal-body" style={{ color: "var(--t2)", whiteSpace: "pre-line", wordBreak: "break-all" }}>{cur.body}</div>}
        <div className="modal-foot" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={() => cur.resolve(false)}>{cur.cancel ?? "취소"}</button>
          <button className={`btn primary`} autoFocus onClick={() => cur.resolve(true)}>{cur.ok ?? "확인"}</button>
        </div>
      </div>
    </div>
  );
}

/** 파일을 창 위로 끌고 오면 표시 */
export function DragOverlay({ onFile }: { onFile: (f: File, handle?: Promise<unknown> | null) => void }) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      activateWindow(); // 끌어다 놓으면 탐색기 대신 MUTOSHOP 이 활성 창이 되게
      const isImg = (x: File) => x.type.startsWith("image/") || /\.(heic|heif|avif|bmp|tiff?)$/i.test(x.name);
      // 파일 핸들은 이 이벤트 안에서만 받을 수 있다 (원본 덮어쓰기용)
      let f: File | null = null;
      let handle: Promise<unknown> | null = null;
      for (const it of [...(e.dataTransfer?.items ?? [])]) {
        if (it.kind !== "file") continue;
        const x = it.getAsFile();
        if (x && isImg(x)) {
          f = x;
          const g = (it as unknown as { getAsFileSystemHandle?: () => Promise<unknown> }).getAsFileSystemHandle;
          handle = g ? g.call(it) : null;
          break;
        }
      }
      if (!f) f = [...(e.dataTransfer?.files ?? [])].find(isImg) ?? null;
      if (f) onFile(f, handle);
      else useStore.getState().toast("이미지 파일만 열 수 있어요.", "error");
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overFn);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("drop", drop);
    };
  }, [onFile]);
  if (!over) return null;
  return (
    <div className="drag-over">
      <div>여기에 놓으면 사진이 열려요</div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl+O", "사진 열기"],
  ["Ctrl+V", "클립보드 이미지 붙여넣기"],
  ["Ctrl+S", "내보내기"],
  ["Ctrl+Shift+C", "결과를 클립보드에 복사"],
  ["Ctrl+Z / Ctrl+Shift+Z", "실행 취소 / 다시 실행 (선택도 한 단계씩)"],
  ["H", "손 도구"],
  ["Space + 드래그", "어느 도구에서든 화면 이동"],
  ["Z", "돋보기"],
  ["휠", "커서 위치 기준 확대/축소"],
  ["Ctrl+0 / Ctrl+1", "화면 맞춤 / 100%"],
  ["M", "선택 윤곽 (다시 누르면 사각형/원형)"],
  ["L", "올가미 (다시 누르면 자유/다각형)"],
  ["W", "자동 선택 (마술봉)"],
  ["P", "펜 도구"],
  ["Shift / Alt + 선택", "선택에 더하기 / 빼기"],
  ["Delete", "선택 영역 지우기"],
  ["Ctrl+J", "선택 영역만 남기기"],
  ["Ctrl+A / Ctrl+D", "전체 선택 / 선택 해제"],
  ["Ctrl+Shift+I", "선택 반전"],
  ["Enter (펜)", "경로를 선택 영역으로"],
  ["B / E", "복원 / 지우기 브러시"],
  ["X", "복원 ↔ 지우기 전환"],
  ["[ / ]", "브러시 크기"],
  ["Shift+[ / ]", "브러시 경도"],
  ["Alt+우클릭 드래그", "브러시 크기·경도 조절"],
  ["Ctrl+I", "마스크 반전"],
  ["F / A", "누끼 확인 보기 전환 (오른쪽 / 왼쪽)"],
  ["\\ (누르고 있기)", "원본 보기"],
  ["C", "색 범위 (비슷한 색 전부 선택 → Delete)"],
  ["Shift+C", "자르기 · 회전"],
  ["Enter / Esc", "자르기 적용 / 취소"],
  ["I", "스포이드 (배경색)"],
  ["슬라이더 더블클릭", "기본값으로"],
];

export function ShortcutsDialog() {
  const open = useStore((s) => s.shortcutsOpen);
  const set = useStore((s) => s.set);
  if (!open) return null;
  const close = () => set({ shortcutsOpen: false });
  return (
    <div className="modal-veil" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" style={{ width: "min(640px, calc(100vw - 40px))" }}>
        <div className="modal-head">
          <h3>단축키</h3>
          <button className="iconbtn" onClick={close}><X size={17} /></button>
        </div>
        <div className="modal-body" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px" }}>
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="row" style={{ justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
              <span style={{ color: "var(--t2)" }}>{v}</span>
              <span className="kbd" style={{ color: "var(--t1)" }}>{k}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
