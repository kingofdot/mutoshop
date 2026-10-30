import { useEffect, useRef, type ReactNode } from "react";
import {
  Brush, Check, Crop, Droplets, Eraser, FlipHorizontal, Hand, Lasso, MousePointerClick, PenTool, Pipette, RotateCcw, RotateCw,
  SquareDashed, SquareMinus, SquarePlus, Undo2, Wand, X, ZoomIn,
} from "lucide-react";
import { applyCrop, cancelCrop, clearCutout, flip, rotate } from "../actions";
import { penApply, penToSelection } from "../selectTools";
import { applySelection, clearSelection, growSelection, invertSelection } from "../selection";
import { useStore } from "../store";
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
function SizeSlider({ label = "크기" }: { label?: string }) {
  const size = useStore((s) => s.brush.size);
  const setBrush = useStore((s) => s.setBrush);
  const t = Math.round((Math.log(size / 2) / Math.log(1000)) * 1000);
  return (
    <div className="mini-slider">
      <span className="opt-label">{label}</span>
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

/** 누르면 한 번, 누르고 있으면 계속 (0.4초 뒤부터 빠르게 반복). Shift 를 누르고 있으면 5배 */
export function useRepeat(fn: (shift: boolean) => void) {
  const timer = useRef(0);
  const stop = () => {
    clearTimeout(timer.current);
    clearInterval(timer.current);
  };
  useEffect(() => stop, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const shift = e.shiftKey;
      stop();
      fn(shift);
      timer.current = window.setTimeout(() => {
        timer.current = window.setInterval(() => fn(shift), 80);
      }, 380);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fn(e.shiftKey);
      }
    },
  };
}

/** 선택 영역 1px 줄이기 / 넓히기. 선택 방식(더하기·빼기)은 Shift·Alt 를 누르고 클릭하면 된다 */
function GrowButtons() {
  const has = useStore((s) => !!s.sel.box);
  const grow = useStore((s) => s.sel.grow);
  const minus = useRepeat((sh) => growSelection(sh ? -5 : -1));
  const plus = useRepeat((sh) => growSelection(sh ? 5 : 1));
  return (
    <div className="row grow-stepper" style={{ gap: 2 }}>
      <button className="iconbtn" disabled={!has} {...minus}
        data-tip="선택 영역 1px 줄이기 · 누르고 있으면 계속 · Shift 5px (Alt+-)">
        <SquareMinus size={15} />
      </button>
      <span className={`grow-val tnum${grow ? " on" : ""}`} data-tip="처음 고른 선택에서 넓히거나(+) 줄인(−) 만큼">
        {grow > 0 ? "+" : grow < 0 ? "−" : ""}{Math.abs(grow)}px
      </span>
      <button className="iconbtn" disabled={!has} {...plus}
        data-tip="선택 영역 1px 넓히기 · 누르고 있으면 계속 · Shift 5px (Alt+=)">
        <SquarePlus size={15} />
      </button>
    </div>
  );
}

/** 선택 영역이 있을 때: 지우기 / 되살리기 / 이것만 남기기 / 반전 / 해제 */
function SelActions({ grow = true }: { grow?: boolean }) {
  const box = useStore((s) => s.sel.box);
  const area = useStore((s) => s.sel.area);
  if (!box) return <span className="opt-hint">영역을 선택한 뒤 Delete로 지우거나, ‘이것만 남기기’로 배경을 없애세요. Shift+클릭 더하기 · Alt+클릭 빼기</span>;
  return (
    <div className="row" style={{ gap: 6 }}>
      {grow && <GrowButtons />}
      <span className="opt-label tnum" data-tip={`선택 영역 ${box.w}×${box.h}`}>{area.toLocaleString()}px 선택</span>
      <span className="opt-sep" />
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

/** 마술봉·색 범위: 끌어서 문지르면 선택에서 빼기 */
function SelBrushHint() {
  return (
    <>
      <span className="opt-sep" />
      <span className="row" style={{ gap: 6 }} data-tip="사진 위를 끌어서 문지르면 그 부분이 선택에서 빠져요 · Shift+끌기 더하기 · [ ] 크기">
        <SizeSlider label="문질러 빼기 붓" />
      </span>
    </>
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
    colorrange: <Title icon={<Droplets size={16} />}>색 범위</Title>,
  }[tool as "marquee" | "lasso" | "wand" | "pen" | "colorrange"];

  return (
    <div className="optionsbar">
      {title}
      {tool !== "pen" && <GrowButtons />}
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
      {tool === "colorrange" && (
        <>
          <WandTolerance color />
          <button className={`chip${wand.antialias ? " on" : ""}`} onClick={() => setWand({ antialias: !wand.antialias })}
            data-tip="경계를 부드럽게">앤티 앨리어스</button>
          {!hasSel && <span className="opt-hint">지울 색을 클릭 → 사진 전체에서 비슷한 색이 선택돼요 · Shift+클릭 색 더하기 · Delete 지우기</span>}
          {hasSel && <SelBrushHint />}
        </>
      )}
      {tool === "wand" && (
        <>
          <WandTolerance />
          <button className={`chip${wand.contiguous ? " on" : ""}`} onClick={() => setWand({ contiguous: !wand.contiguous })}
            data-tip="이어진 영역만 선택">인접</button>
          <button className={`chip${wand.antialias ? " on" : ""}`} onClick={() => setWand({ antialias: !wand.antialias })}
            data-tip="경계를 부드럽게">앤티 앨리어스</button>
          {hasSel && <SelBrushHint />}
        </>
      )}
      {tool === "pen" && (
        path ? (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => penToSelection("new")}>선택 영역으로 <span className="kbd">Enter</span></button>
            <button className="btn sm danger" onClick={() => penApply("delete")}>경로 안쪽 지우기</button>
            <button className="btn sm primary" onClick={() => penApply("keep")}><Check size={13} /> 경로 안쪽만 남기기</button>
            <button className="btn sm ghost" onClick={() => set({ penPath: null })}>경로 지우기 <span className="kbd">Esc</span></button>
          </div>
        ) : (
          <span className="opt-hint">클릭: 직선 점 · 드래그: 곡선 점 · 첫 점을 누르면 닫힘 · Backspace: 마지막 점 삭제 · 점과 핸들은 끌어서 수정 (Alt: 핸들 따로)</span>
        )
      )}
      {(tool !== "pen" || hasSel) && <span className="opt-sep" />}
      {(tool !== "pen" || hasSel) && <SelActions grow={tool === "pen"} />}
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
  const hasSel = useStore((s) => !!s.sel.box);
  const setBrush = useStore((s) => s.setBrush);
  const st = useStore.getState;

  if (!image) {
    return (
      <div className="optionsbar">
        <span className="opt-hint">사진을 열어 시작하세요 — 끌어다 놓기, Ctrl+O, Ctrl+V 모두 됩니다.</span>
      </div>
    );
  }

  if (tool === "marquee" || tool === "lasso" || tool === "wand" || tool === "pen" || tool === "colorrange") return <SelectionToolBar />;

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

  if (tool === "bgpick") {
    return <PickBar />;
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
      {hasSel ? (
        // 선택 영역이 있으면 어느 도구에서든 지우기·남기기 버튼이 보이게 (누끼 탭의 '직접 따기' 묶음을 대신함)
        <SelActions />
      ) : (
        <span className="opt-hint">
          {tool === "zoom"
            ? "클릭하면 확대 · Alt+클릭하면 축소"
            : "드래그로 이동 · 휠로 확대/축소 · 더블클릭하면 화면 맞춤 · 어느 도구에서든 Space를 누르고 드래그하면 이동"}
        </span>
      )}
    </div>
  );
}

/** 배경 찍기 도구 막대 */
function PickBar() {
  const n = useStore((s) => s.doc.cutout?.seeds?.length ?? 0);
  const busy = useStore((s) => !!s.job);
  const setTool = useStore((s) => s.setTool);
  return (
    <div className="optionsbar">
      <Title icon={<MousePointerClick size={16} />}>배경 찍기</Title>
      <span className="opt-hint">
        {busy ? "지우는 중…" : "지울 배경을 클릭하세요 · 찍은 곳과 이어진 배경만 지워요 · 고리 안쪽 같은 구멍도 클릭 · Ctrl+Z 되돌리기"}
      </span>
      <div className="spacer" />
      {n > 0 && <span className="opt-label">{n}곳 찍음</span>}
      {n > 0 && <button className="btn sm" onClick={clearCutout}><RotateCcw size={14} /> 처음부터</button>}
      <button className="btn sm primary" onClick={() => setTool("hand")}><Check size={14} /> 끝</button>
    </div>
  );
}

/** 마술봉 허용치: 끌거나 숫자를 바꾸면 방금 클릭한 영역이 새 허용치로 바로 다시 선택된다 */
function WandTolerance({ color = false }: { color?: boolean }) {
  const tol = useStore((s) => (color ? s.wand.colorTol : s.wand.tolerance));
  const setWand = useStore((s) => s.setWand);
  const set = (v: number) => {
    const t = Math.max(0, Math.min(255, Math.round(v) || 0));
    setWand(color ? { colorTol: t } : { tolerance: t });
  };
  const p = (tol / 255) * 100;
  return (
    <div className="mini-slider" data-tip="바꾸면 방금 고른 영역에 바로 적용돼요">
      <span className="opt-label">허용치</span>
      <input type="range" min={0} max={255} value={tol} style={{ ["--p" as string]: `${p}%` }}
        onChange={(e) => set(Number(e.target.value))} />
      <input className="num-input" type="number" min={0} max={255} value={tol}
        onKeyDown={(e) => {
          // Enter·Esc: 칸에서 빠져나와 바로 Delete 등을 쓸 수 있게 · Alt+-/= 는 선택 넓히기·줄이기로 넘긴다
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
          else if (!e.altKey) e.stopPropagation();
        }}
        onChange={(e) => set(Number(e.target.value))} />
    </div>
  );
}
