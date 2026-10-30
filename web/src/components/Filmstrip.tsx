import { Check, ChevronLeft, ChevronRight, Film, FolderOpen, FolderOutput, LoaderCircle, Save, X } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  changeFolderOut, closeFolderWork, overwriteCurrent, openFolderItem, openFolderWork, saveToFolder, setAutoNext, stepFolder, thumbUrl, useFolder,
} from "../folder";
import { shortDir } from "../outs";
import { batchOpenOut } from "../lib/api";
import { useStore } from "../store";

/** 맨 위 필름 줄: 폴더의 사진들을 한 줄로. 누르면 열기, 저장한 사진은 초록 체크(완료) */
export function Filmstrip() {
  const token = useFolder((s) => s.token);
  const folder = useFolder((s) => s.folder);
  const files = useFolder((s) => s.files);
  const done = useFolder((s) => s.done);
  const current = useFolder((s) => s.current);
  const loading = useFolder((s) => s.loading);
  const autoNext = useFolder((s) => s.autoNext);
  const out = useFolder((s) => s.out);
  const thumbVer = useFolder((s) => s.thumbVer);
  const hasImage = useStore((s) => !!s.image);
  const track = useRef<HTMLDivElement>(null);

  // 지금 사진이 보이게 (가운데로)
  useEffect(() => {
    if (current < 0) return;
    track.current?.querySelector<HTMLElement>(`[data-i="${current}"]`)?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [current]);

  if (!token) return null;
  const n = files.length;
  const doneN = done.filter(Boolean).length;
  const name = folder.split(/[\\/]/).filter(Boolean).pop() || folder;

  return (
    <div className="filmstrip">
      <div className="film-info">
        <div className="film-title" title={folder}><Film size={14} /> <span className="ellipsis">{name}</span></div>
        <div className="film-count tnum">
          <span className="film-done-n">{doneN}</span> / {n} 완료
          {doneN < n && <span className="muted"> · 남은 {n - doneN}</span>}
        </div>
        <button className="film-out" onClick={() => changeFolderOut()} title={`저장 위치: ${out}\n누르면 바꿀 수 있어요`}>
          저장 → <b className="ellipsis">{shortDir(out)}</b> <span className="muted">변경</span>
        </button>
        <div className="row" style={{ gap: 2 }}>
          <button className="btn sm primary" disabled={!hasImage || current < 0} onClick={() => saveToFolder()}
            data-tip="누끼 폴더에 바로 저장 (Ctrl+S)">
            <Save size={13} /> 저장
          </button>
          <button className="btn sm danger-ghost" disabled={!hasImage || current < 0} onClick={() => overwriteCurrent()}
            data-tip="원본 파일에 그대로 덮어쓰기 (확인 후)">
            덮어쓰기
          </button>
          <button className="iconbtn" onClick={() => batchOpenOut(token)} data-tip="결과(누끼) 폴더 열기"><FolderOutput size={15} /></button>
          <button className="iconbtn" onClick={() => openFolderWork()} data-tip="다른 폴더 열기"><FolderOpen size={15} /></button>
          <button className="iconbtn" onClick={closeFolderWork} data-tip="필름 줄 닫기"><X size={15} /></button>
        </div>
      </div>
      <button className="film-nav" onClick={() => stepFolder(-1)} disabled={current <= 0} data-tip="이전 사진 (PageUp)">
        <ChevronLeft size={18} />
      </button>
      <div className="film-track" ref={track}
        onWheel={(e) => { if (track.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) track.current.scrollLeft += e.deltaY; }}>
        {files.map((f, i) => (
          <button
            key={f.rel}
            data-i={i}
            className={`film-item${i === current ? " cur" : ""}${done[i] ? " done" : ""}`}
            onClick={() => openFolderItem(i)}
            title={`${f.rel}${done[i] ? " · 완료" : ""}`}
          >
            <img src={thumbUrl(token, i, thumbVer[i])} loading="lazy" decoding="async" alt="" draggable={false} />
            {done[i] && <span className="film-check"><Check size={11} strokeWidth={3} /></span>}
            {loading === i && <span className="film-loading"><LoaderCircle size={18} className="spin" /></span>}
            <span className="film-no tnum">{i + 1}</span>
          </button>
        ))}
      </div>
      <button className="film-nav" onClick={() => stepFolder(1)} disabled={current >= n - 1} data-tip="다음 사진 (PageDown)">
        <ChevronRight size={18} />
      </button>
      <div className="film-side">
        <button className="btn sm" onClick={() => stepFolder(1, true)} disabled={doneN >= n} data-tip="아직 안 한 다음 사진">
          안 한 것 <ChevronRight size={13} />
        </button>
        <label className="film-auto" data-tip="저장하면 아직 안 한 다음 사진을 바로 열어요">
          <input type="checkbox" checked={autoNext} onChange={(e) => setAutoNext(e.target.checked)} /> 저장 후 다음
        </label>
      </div>
    </div>
  );
}
