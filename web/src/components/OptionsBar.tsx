import type { ReactNode } from "react";
import {
  Brush, Check, Combine, Crop, Eraser, FlipHorizontal, Hand, Lasso, PenTool, Pipette, RotateCcw, RotateCw,
  Square, SquareDashed, SquareMinus, SquarePlus, Undo2, Wand, X, ZoomIn,
} from "lucide-react";
import { applyCrop, cancelCrop, flip, rotate } from "../actions";
import { penApply, penToSelection } from "../selectTools";
import { applySelection, clearSelection, invertSelection } from "../selection";
import { useStore, type SelMode } from "../store";
import { outputSize } from "../types";
import { fitAspect } from "./CropOverlay";

function Mini({ label, value, min, max, onChange, suffix = "" }: {
  label: string; value: number; min: number; max: number; onChange: (v: number) => void; suffix?: string;
}) {
  const p = ((value - min) / (max - min)) * 100;
  return (
    <div className="mini-slider">
      <span className="opt-label">{label}</span>
      <input type="range" min={min} max={max} value={value} style={{ ["--p" as string]: `${p}%` }}
        onChange={(e) => onChange(Number(e.target.value))} />
      <span className="val">{value}{suffix}</span>
    </div>
  );
}

/** 브러시 크기는 로그 눈금으로 (작은 값도 세밀하게) */
function SizeSlider() {
  const size = useStore((s) => s.brush.size);
  const setBrush = useStore((s) => s.setBrush);
  const t = Math.round((Math.log(size / 2) / Math.log(1000)) * 1000);
  return (
    <div className="mini-slider">
      <span className="opt-label">크기</span>
      <input type="range" min={0} max={1000} value={t} style={{ ["--p" as string]: `${t / 10}%` }}
        onChange={(e) => setBrush({ size: Math.max(2, Math.round(2 * Math.pow(1000, Number(e.target.value) / 1000))) })} />
      <span className="val">{size}px</span>
    </div>
  );
}

const ASPECTS: { label: string; v: number | null }[] = [
  { label: "자유", v: null },
  { label: "원본", v: 0 },
  { label: "1:1", v: 1 },
  { label: "4:5", v: 4 / 5 },
  { label: "3:4", v: 3 / 4 },
  { label: "2:3", v: 2 / 3 },
  { label: "16:9", v: 16 / 9 },
  { label: "9:16", v: 9 / 16 },
];

function Title({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <div className="opt-title">{icon}{children}</div>;
}

const SEL_MODES: { v: SelMode; icon: ReactNode; tip: string }[] = [
  { v: "new", icon: <Square size={15} />, tip: "새 선택" },
  { v: "add", icon: <SquarePlus size={15} />, tip: "선택에 더하기 (Shift)" },
  { v: "sub", icon: <SquareMinus size={15} />, tip: "선택에서 빼기 (Alt)" },
  { v: "and", icon: <Combine size={15} />, tip: "겹치는 부분만 (Shift+Alt)" },
];

function SelModeButtons() {
  const mode = useStore((s) => s.selMode);
  const set = useStore((s) => s.set);
  return (
    <div className="row" style={{ gap: 2 }}>
      {SEL_MODES.map((m) => (
        <button key={m.v} className={`iconbtn${mode === m.v ? " active" : ""}`} data-tip={m.tip} onClick={() => set({ selMode: m.v })}>
          {m.icon}
        </button>
      ))}
    </div>
  );
}

/** 선택 영역이 있을 때: 지우기 / 되살리기 / 이것만 남기기 / 반전 / 해제 */
function SelActions() {
  const box = useStore((s) => s.sel.box);
  if (!box) return <span className="opt-hint">영역을 선택한 뒤 Delete로 지우거나, ‘이것만 남기기’로 배경을 없애세요.</span>;
  return (
    <div className="row" style={{ gap: 6 }}>
      <button className="btn sm danger" onClick={() => applySelection("delete")} data-tip="선택한 부분을 지움 (Delete)">
        <Eraser size={13} /> 지우기
      </button>
      <button className="btn sm" onClick={() => applySelection("restore")} data-tip="선택한 부분을 피사체로 되살림">
        <Brush size={13} /> 되살리기
      </button>
      <button className="btn sm primary" onClick={() => applySelection("keep")} data-tip="선택한 부분만 남기고 나머지를 지움 (Ctrl+J)">
        <Check size={13} /> 이것만 남기기
      </button>
      <button className="btn sm ghost" onClick={invertSelection} data-tip="선택 반전 (Ctrl+Shift+I)">반전</button>
      <button className="btn sm ghost" onClick={clearSelection} data-tip="선택 해제 (Ctrl+D)">해제</button>
    </div>
  );
}

function SelectionToolBar() {
  const tool = useStore((s) => s.tool);
  const marqueeShape = useStore((s) => s.marqueeShape);
  const lassoMode = useStore((s) => s.lassoMode);
  const wand = useStore((s) => s.wand);
  const path = useStore((s) => s.penPath);
  const hasSel = useStore((s) => !!s.sel.box);
  const set = useStore((s) => s.set);
  const setWand = useStore((s) => s.setWand);

  const title = {
    marquee: <Title icon={<SquareDashed size={16} />}>선택 윤곽</Title>,
    lasso: <Title icon={<Lasso size={16} />}>올가미</Title>,
    wand: <Title icon={<Wand size={16} />}>자동 선택</Title>,
    pen: <Title icon={<PenTool size={16} />}>펜</Title>,
  }[tool as "marquee" | "lasso" | "wand" | "pen"];

  return (
    <div className="optionsbar">
      {title}
      {tool !== "pen" && <SelModeButtons />}
      <span className="opt-sep" />
      {tool === "marquee" && (
        <div className="chip-row">
          <button className={`chip${marqueeShape === "rect" ? " on" : ""}`} onClick={() => set({ marqueeShape: "rect" })}>사각형</button>
          <button className={`chip${marqueeShape === "ellipse" ? " on" : ""}`} onClick={() => set({ marqueeShape: "ellipse" })}>원형</button>
        </div>
      )}
      {tool === "lasso" && (
        <div className="chip-row">
          <button className={`chip${lassoMode === "free" ? " on" : ""}`} onClick={() => set({ lassoMode: "free" })}
            data-tip="드래그해서 자유롭게 그리기">자유</button>
          <button className={`chip${lassoMode === "poly" ? " on" : ""}`} onClick={() => set({ lassoMode: "poly" })}
            data-tip="클릭해서 꼭짓점 찍기 · 더블클릭/첫 점 클릭으로 닫기">다각형</button>
        </div>
      )}
      {tool === "wand" && (
        <>
          <Mini label="허용치" value={wand.tolerance} min={0} max={255} onChange={(v) => setWand({ tolerance: v })} />
          <button className={`chip${wand.contiguous ? " on" : ""}`} onClick={() => setWand({ contiguous: !wand.contiguous })}
            data-tip="이어진 영역만 선택">인접</button>
          <button className={`chip${wand.antialias ? " on" : ""}`} onClick={() => setWand({ antialias: !wand.antialias })}
            data-tip="경계를 부드럽게">앤티 앨리어스</button>
        </>
      )}
      {tool === "pen" && (
        path ? (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => penToSelection(useStore.getState().selMode)}>선택 영역으로 <span className="kbd">Enter</span></button>
            <button className="btn sm danger" onClick={() => penApply("delete")}>경로 안쪽 지우기</button>
            <button className="btn sm primary" onClick={() => penApply("keep")}><Check size={13} /> 경로 안쪽만 남기기</button>
            <button className="btn sm ghost" onClick={() => set({ penPath: null })}>경로 지우기 <span className="kbd">Esc</span></button>
          </div>
        ) : (
          <span className="opt-hint">클릭: 직선 점 · 드래그: 곡선 점 · 첫 점을 누르면 닫힘 · Backspace: 마지막 점 삭제 · 점과 핸들은 끌어서 수정 (Alt: 핸들 따로)</span>
        )
      )}
      {(tool !== "pen" || hasSel) && <span className="opt-sep" />}
      {(tool !== "pen" || hasSel) && <SelActions />}
    </div>
  );
}

export function OptionsBar() {
  const image = useStore((s) => s.image);
  const tool = useStore((s) => s.tool);
  const brush = useStore((s) => s.brush);
  const hasMask = useStore((s) => !!s.doc.cutout);
  const zoom = useStore((s) => s.view.zoom);
  const aspect = useStore((s) => s.cropAspect);
  const draft = useStore((s) => s.cropDraft);
  const orient = useStore((s) => s.doc.orient);
  const eyeTarget = useStore((s) => s.eyedropperTarget);
  const setBrush = useStore((s) => s.setBrush);
  const st = useStore.getState;

  if (!image) {
    return (
      <div className="optionsbar">
        <span className="opt-hint">사진을 열어 시작하세요 — 끌어다 놓기, Ctrl+O, Ctrl+V 모두 됩니다.</span>
      </div>
    );
  }

  if (tool === "marquee" || tool === "lasso" || tool === "wand" || tool === "pen") return <SelectionToolBar />;

  if (tool === "brush") {
    return (
      <div className="optionsbar">
        <Title icon={brush.mode === "add" ? <Brush size={16} /> : <Eraser size={16} />}>
          {brush.mode === "add" ? "복원 브러시" : "지우기 브러시"}
        </Title>
        <div className="chip-row">
          <button className={`chip${brush.mode === "add" ? " on" : ""}`} onClick={() => setBrush({ mode: "add" })}>복원 (B)</button>
          <button className={`chip${brush.mode === "sub" ? " on" : ""}`} onClick={() => setBrush({ mode: "sub" })}>지우기 (E)</button>
        </div>
        <span className="opt-sep" />
        <SizeSlider />
        <Mini label="경도" value={brush.hardness} min={0} max={100} suffix="%" onChange={(v) => setBrush({ hardness: v })} />
        <Mini label="불투명도" value={brush.opacity} min={1} max={100} suffix="%" onChange={(v) => setBrush({ opacity: v })} />
        <span className="opt-sep" />
        <button className={`chip${brush.auto ? " on" : ""}`} onClick={() => setBrush({ auto: !brush.auto })}
          data-tip="붓 중심과 비슷한 색만 칠하기">
          자동 경계 {brush.auto ? "켜짐" : "꺼짐"}
        </button>
        {brush.auto && <Mini label="허용" value={brush.tolerance} min={1} max={100} onChange={(v) => setBrush({ tolerance: v })} />}
        {!hasMask && <span className="opt-hint">먼저 누끼를 따면 브러시로 다듬을 수 있어요.</span>}
      </div>
    );
  }

  if (tool === "crop") {
    const [W, H] = outputSize(image.w, image.h, orient);
    const setAspect = (v: number | null) => {
      const s = st();
      const base = s.cropDraft ?? { x: 0, y: 0, w: 1, h: 1 };
      s.set({
        cropAspect: v,
        cropDraft: v === null ? base : fitAspect({ x: 0, y: 0, w: 1, h: 1 }, ((v === 0 ? W / H : v) * H) / W),
      });
    };
    return (
      <div className="optionsbar">
        <Title icon={<Crop size={16} />}>자르기</Title>
        <div className="chip-row">
          {ASPECTS.map((a) => (
            <button key={a.label} className={`chip${aspect === a.v ? " on" : ""}`} onClick={() => setAspect(a.v)}>{a.label}</button>
          ))}
        </div>
        <span className="opt-sep" />
        <button className="iconbtn" onClick={() => rotate(-1)} data-tip="왼쪽으로 90°"><RotateCcw size={16} /></button>
        <button className="iconbtn" onClick={() => rotate(1)} data-tip="오른쪽으로 90°"><RotateCw size={16} /></button>
        <button className="iconbtn" onClick={flip} data-tip="좌우 반전"><FlipHorizontal size={16} /></button>
        <span className="opt-sep" />
        <button className="btn sm ghost" onClick={() => st().set({ cropDraft: { x: 0, y: 0, w: 1, h: 1 }, cropAspect: null })}>
          <Undo2 size={13} /> 원래대로
        </button>
        <div className="spacer" />
        {draft && <span className="opt-hint">{Math.round(draft.w * W)} × {Math.round(draft.h * H)} px</span>}
        <button className="btn sm" onClick={cancelCrop}><X size={14} /> 취소 <span className="kbd">Esc</span></button>
        <button className="btn sm primary" onClick={applyCrop}><Check size={14} /> 적용 <span className="kbd" style={{ color: "rgba(255,255,255,.7)" }}>Enter</span></button>
      </div>
    );
  }

  if (tool === "eyedropper") {
    return (
      <div className="optionsbar">
        <Title icon={<Pipette size={16} />}>스포이드</Title>
        <span className="opt-hint">
          {eyeTarget === "matte"
            ? "원래 배경을 클릭하세요. 그 색을 테두리에서 걷어 냅니다."
            : "사진을 클릭하면 그 색이 배경색이 됩니다."}
        </span>
        <div className="spacer" />
        <button className="btn sm" onClick={() => st().setTool("hand")}><X size={14} /> 취소</button>
      </div>
    );
  }

  return (
    <div className="optionsbar">
      <Title icon={tool === "zoom" ? <ZoomIn size={16} /> : <Hand size={16} />}>{tool === "zoom" ? "돋보기" : "손 도구"}</Title>
      <button className="btn sm" onClick={() => st().fitView()}>화면 맞춤</button>
      <button className="btn sm" onClick={() => st().zoomAt(1)}>100%</button>
      <span className="opt-label" style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round(zoom * 100)}%</span>
      <span className="opt-sep" />
      <span className="opt-hint">
        {tool === "zoom"
          ? "클릭하면 확대 · Alt+클릭하면 축소"
          : "드래그로 이동 · 휠로 확대/축소 · 더블클릭하면 화면 맞춤 · 어느 도구에서든 Space를 누르고 드래그하면 이동"}
      </span>
    </div>
  );
}
