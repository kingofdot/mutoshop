import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Clipboard, Columns2, Crop, Download, Eye, Film, FlipHorizontal, FlipHorizontal2, FolderOpen, Folders, Keyboard, Maximize,
  Redo2, RotateCcw, RotateCw, ScanSearch, Sparkles, Undo2, Wand2, X, ZoomIn, ZoomOut,
} from "lucide-react";
import {
  clearCutout, closeImage, copyToClipboard, flip, openFromPicker, resetAdjust, rotate, runAutoAdjust, runCutout, toggleInvert,
} from "../actions";
import { useBatch } from "../batch";
import { openFolderWork } from "../folder";
import { canRedoStep, canUndoStep, redoStep, undoStep } from "../selection";
import { KIND } from "../kinds";
import { hasUnsaved, useStore } from "../store";

interface Item {
  label: string;
  icon?: ReactNode;
  kbd?: string;
  run: () => void;
  disabled?: boolean;
}
type Entry = Item | "sep";

function useMenus(): { title: string; items: Entry[] }[] {
  const s = useStore();
  const img = !!s.image;
  const mask = !!s.doc.cutout;
  return [
    {
      title: "파일",
      items: [
        { label: "열기…", icon: <FolderOpen size={15} />, kbd: "Ctrl+O", run: openFromPicker },
        { label: "폴더 열기 (하나씩 작업)…", icon: <Film size={15} />, kbd: "Ctrl+Shift+O", run: () => openFolderWork() },
        { label: "폴더 작업 (일괄 누끼)…", icon: <Folders size={15} />, run: () => useBatch.getState().set({ open: true }) },
        { label: "내보내기…", icon: <Download size={15} />, kbd: "Ctrl+S", run: () => s.set({ exportOpen: true }), disabled: !img },
        { label: "사진 닫기", icon: <X size={15} />, kbd: "Ctrl+W", run: () => closeImage(), disabled: !img },
        { label: "클립보드에 복사", icon: <Clipboard size={15} />, kbd: "Ctrl+Shift+C", run: () => copyToClipboard(), disabled: !img },
      ],
    },
    {
      title: "편집",
      items: [
        { label: "실행 취소", icon: <Undo2 size={15} />, kbd: "Ctrl+Z", run: undoStep, disabled: !canUndoStep() },
        { label: "다시 실행", icon: <Redo2 size={15} />, kbd: "Ctrl+Shift+Z", run: redoStep, disabled: !canRedoStep() },
        "sep",
        { label: "색감 보정 모두 초기화", run: () => { resetAdjust("global"); resetAdjust("subject"); resetAdjust("background"); }, disabled: !img },
        { label: "마스크 반전", icon: <FlipHorizontal2 size={15} />, kbd: "Ctrl+I", run: toggleInvert, disabled: !mask },
        { label: "누끼 해제", run: clearCutout, disabled: !mask },
      ],
    },
    {
      title: "이미지",
      items: [
        { label: `누끼 따기 (${KIND[s.kind].label})`, icon: <Sparkles size={15} />, run: () => { s.set({ panel: "cutout" }); runCutout(); }, disabled: !img || !!s.job },
        { label: "자동 보정", icon: <Wand2 size={15} />, run: () => { s.set({ panel: "adjust" }); runAutoAdjust(); }, disabled: !img },
        "sep",
        { label: "오른쪽으로 90° 회전", icon: <RotateCw size={15} />, run: () => rotate(1), disabled: !img },
        { label: "왼쪽으로 90° 회전", icon: <RotateCcw size={15} />, run: () => rotate(-1), disabled: !img },
        { label: "좌우 반전", icon: <FlipHorizontal size={15} />, run: flip, disabled: !img },
        "sep",
        { label: "자르기", icon: <Crop size={15} />, kbd: "C", run: () => s.setTool("crop"), disabled: !img },
        { label: "자르기 해제", run: () => s.change("자르기 해제", (d) => { d.crop = null; }), disabled: !s.doc.crop },
      ],
    },
    {
      title: "보기",
      items: [
        { label: "화면에 맞추기", icon: <Maximize size={15} />, kbd: "Ctrl+0", run: s.fitView, disabled: !img },
        { label: "실제 크기 (100%)", icon: <ScanSearch size={15} />, kbd: "Ctrl+1", run: () => s.zoomAt(1), disabled: !img },
        { label: "확대", icon: <ZoomIn size={15} />, kbd: "Ctrl++", run: () => s.zoomAt(s.view.zoom * 1.25), disabled: !img },
        { label: "축소", icon: <ZoomOut size={15} />, kbd: "Ctrl+−", run: () => s.zoomAt(s.view.zoom / 1.25), disabled: !img },
        "sep",
        { label: s.split !== null ? "분할 비교 끄기" : "분할 비교 (원본 | 결과)", icon: <Columns2 size={15} />, run: () => s.set({ split: s.split !== null ? null : 0.5 }), disabled: !img },
        { label: "누끼 확인 보기 전환", icon: <Eye size={15} />, kbd: "F / A", run: () => cycleView(), disabled: !mask },
      ],
    },
    {
      title: "도움말",
      items: [{ label: "단축키 보기", icon: <Keyboard size={15} />, kbd: "?", run: () => s.set({ shortcutsOpen: true }) }],
    },
  ];
}

/** 누끼 확인 보기 전환: F = 오른쪽(다음), A = 왼쪽(이전) */
export function cycleView(dir: 1 | -1 = 1) {
  const s = useStore.getState();
  if (!s.doc.cutout) return;
  const order = ["normal", "overlay", "mask", "black", "white"] as const;
  const n = order.length;
  s.set({ viewMode: order[(order.indexOf(s.viewMode) + dir + n) % n] });
}

function MenuBar() {
  const menus = useMenus();
  const [open, setOpen] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="row" ref={root} style={{ gap: 2 }}>
      {menus.map((m, i) => (
        <div className="menu-root" key={m.title}>
          <button
            className={`menu-btn${open === i ? " open" : ""}`}
            onClick={() => setOpen(open === i ? null : i)}
            onPointerEnter={() => open !== null && setOpen(i)}
          >
            {m.title}
          </button>
          {open === i && (
            <div className="menu">
              {m.items.map((it, j) =>
                it === "sep" ? (
                  <div key={j} className="menu-sep" />
                ) : (
                  <button
                    key={j}
                    className="menu-item"
                    disabled={it.disabled}
                    onClick={() => {
                      setOpen(null);
                      it.run();
                    }}
                  >
                    <span style={{ width: 16, display: "grid", placeItems: "center" }}>{it.icon}</span>
                    <span className="grow">{it.label}</span>
                    {it.kbd && <span className="kbd">{it.kbd}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function TopBar() {
  const image = useStore((s) => s.image);
  useStore((s) => s.histIndex);
  useStore((s) => s.hist.length);
  useStore((s) => s.sel.version); // 선택이 바뀌면 단추 상태도 다시
  const split = useStore((s) => s.split);
  const set = useStore((s) => s.set);
  useStore((s) => s.savedIndex);
  const unsaved = hasUnsaved();

  return (
    <div className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <svg width="14" height="14" viewBox="0 0 32 32" fill="none">
            <path d="M6 25V8l10 10L26 8v17" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        MUTOSHOP
      </div>
      <MenuBar />
      {image && (
        <div className="docname">
          <span className="opt-sep" />
          <b title={image.name}>{image.name}</b>
          {unsaved && <span className="dot-unsaved" data-tip="내보내지 않은 변경 사항" />}
        </div>
      )}
      <div className="spacer" />
      <button className="iconbtn" onClick={undoStep} disabled={!canUndoStep()} data-tip="실행 취소 (Ctrl+Z) · 선택도 한 단계씩">
        <Undo2 size={17} />
      </button>
      <button className="iconbtn" onClick={redoStep} disabled={!canRedoStep()} data-tip="다시 실행 (Ctrl+Shift+Z)">
        <Redo2 size={17} />
      </button>
      <span className="opt-sep" style={{ margin: "0 4px" }} />
      <button
        className="btn ghost sm"
        disabled={!image}
        onPointerDown={() => set({ compare: true })}
        onPointerUp={() => set({ compare: false })}
        onPointerLeave={() => set({ compare: false })}
        data-tip="누르고 있는 동안 원본 보기 (\ 키)"
      >
        <Eye size={15} /> 원본 비교
      </button>
      <button
        className={`iconbtn${split !== null ? " active" : ""}`}
        disabled={!image}
        onClick={() => set({ split: split !== null ? null : 0.5 })}
        data-tip="분할 비교"
      >
        <Columns2 size={17} />
      </button>
      <button className="btn" style={{ marginLeft: 6 }} onClick={() => openFolderWork()}
        data-tip="폴더의 사진을 위쪽 필름 줄에 띄워 하나씩 직접 작업 (Ctrl+Shift+O)">
        <Film size={15} /> 폴더 열기
      </button>
      <button className="btn" style={{ marginLeft: 6 }} onClick={() => useBatch.getState().set({ open: true })}
        data-tip="폴더 안의 사진을 한 번에 누끼 따기">
        <Folders size={15} /> 폴더 작업
      </button>
      <button className="btn primary" style={{ marginLeft: 6 }} disabled={!image} onClick={() => set({ exportOpen: true })}>
        <Download size={15} /> 내보내기
      </button>
    </div>
  );
}
