import {
  Brush, Check, CheckCircle2, CircleDashed, Eraser, FlipHorizontal2, Lasso, LassoSelect, PenTool, Pipette, RefreshCw,
  Sparkles, SquareDashed, Trash2, Undo2, Wand, X,
} from "lucide-react";
import type { ReactNode } from "react";
import { cancelCutout, clearCutout, detectMatteColor, removeFringe, resetMaskEdits, runCutout } from "../../actions";
import { applySelection, clearSelection, invertSelection } from "../../selection";
import { useStore, type ViewMode } from "../../store";
import { ColorField, Section, Segmented, Slider, Toggle } from "../controls";
import { useSmoothProgress } from "../useSmoothProgress";

const fmtMB = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)}GB` : `${Math.round(b / 1e6)}MB`);

function ModelPicker() {
  const server = useStore((s) => s.server);
  const model = useStore((s) => s.model);
  const precise = useStore((s) => s.precise);
  const set = useStore((s) => s.set);
  const models = server?.models ?? [
    { id: "general", name: "정밀", desc: "머리카락·털·복잡한 경계까지 가장 섬세하게 (권장)", size: 972_666_916, downloaded: false, loaded: false },
    { id: "portrait", name: "인물", desc: "사람 사진 특화", size: 972_666_916, downloaded: false, loaded: false },
    { id: "lite", name: "빠름", desc: "속도 우선", size: 224_005_088, downloaded: false, loaded: false },
  ];
  const dev = server?.device;
  return (
    <div className="col">
      {models.map((m) => (
        <button key={m.id} className={`model-card${model === m.id ? " on" : ""}`} onClick={() => set({ model: m.id })}>
          <span className="radio" />
          <span style={{ flex: 1 }}>
            <span className="mn">
              {m.name}
              {m.id === "general" && <span className="pill accent">추천</span>}
              {m.downloaded ? <span className="pill ok">준비됨</span> : <span className="pill">{fmtMB(m.size)} · 첫 사용 시 다운로드</span>}
            </span>
            <span className="md">{m.desc}</span>
          </span>
        </button>
      ))}
      <div className="mt8">
        <Toggle
          on={precise}
          onChange={(v) => set({ precise: v })}
          label="정밀 모드 (2단계 분석)"
          desc="피사체를 확대해 한 번 더 분석합니다. 머리카락·털 같은 세부가 더 살아나요."
        />
      </div>
      {server && (
        <div className="hint mt8">
          {!server.ok
            ? "⚠ AI 서버에 연결되지 않았습니다. start.bat 으로 실행해 주세요."
            : dev?.kind === "cpu"
              ? "CPU로 처리합니다. 사진 한 장에 30초 이상 걸릴 수 있어요."
              : `${dev?.gpu ?? "GPU"} 가속 사용 · 보통 3~6초`}
        </div>
      )}
    </div>
  );
}

function ManualTools() {
  const tool = useStore((s) => s.tool);
  const marqueeShape = useStore((s) => s.marqueeShape);
  const lassoMode = useStore((s) => s.lassoMode);
  const hasSel = useStore((s) => !!s.sel.box);
  const set = useStore((s) => s.set);
  const setTool = useStore((s) => s.setTool);
  const items: { label: string; key: string; icon: ReactNode; on: boolean; go: () => void }[] = [
    { label: "펜", key: "P", icon: <PenTool size={18} />, on: tool === "pen", go: () => setTool("pen") },
    { label: "올가미", key: "L", icon: <Lasso size={18} />, on: tool === "lasso" && lassoMode === "free",
      go: () => { set({ lassoMode: "free" }); setTool("lasso"); } },
    { label: "다각형 올가미", key: "L", icon: <LassoSelect size={18} />, on: tool === "lasso" && lassoMode === "poly",
      go: () => { set({ lassoMode: "poly" }); setTool("lasso"); } },
    { label: "사각형 선택", key: "M", icon: <SquareDashed size={18} />, on: tool === "marquee" && marqueeShape === "rect",
      go: () => { set({ marqueeShape: "rect" }); setTool("marquee"); } },
    { label: "원형 선택", key: "M", icon: <CircleDashed size={18} />, on: tool === "marquee" && marqueeShape === "ellipse",
      go: () => { set({ marqueeShape: "ellipse" }); setTool("marquee"); } },
    { label: "자동 선택", key: "W", icon: <Wand size={18} />, on: tool === "wand", go: () => setTool("wand") },
  ];
  return (
    <>
      <div className="manual-grid">
        {items.map((it) => (
          <button key={it.label} className={`manual-tool${it.on ? " on" : ""}`} onClick={it.go} data-tip={`단축키 ${it.key}`}>
            {it.icon}
            <span>{it.label}</span>
          </button>
        ))}
      </div>
      <div className="hint mt8">
        포토샵처럼 영역을 선택한 뒤 <b>Delete</b>로 지우거나 <b>Ctrl+J</b>로 선택한 부분만 남겨요.
        Shift를 누르고 그리면 더하기, Alt는 빼기.
      </div>
      {hasSel && (
        <div className="grid2 mt12">
          <button className="btn sm danger" onClick={() => applySelection("delete")}><Eraser size={13} /> 지우기 <span className="kbd">Del</span></button>
          <button className="btn sm primary" onClick={() => applySelection("keep")}><Check size={13} /> 이것만 남기기</button>
          <button className="btn sm" onClick={() => applySelection("restore")}><Brush size={13} /> 되살리기</button>
          <button className="btn sm ghost" onClick={invertSelection}>선택 반전</button>
          <button className="btn sm ghost" onClick={clearSelection}>선택 해제 <span className="kbd">Ctrl+D</span></button>
        </div>
      )}
    </>
  );
}

/** 경계에 섞인 원래 배경색(흰 테두리 등) 처리 */
function EdgeColor() {
  const edge = useStore((s) => s.doc.edge);
  const cutout = useStore((s) => s.doc.cutout);
  const invert = useStore((s) => s.doc.invert);
  const setDoc = useStore((s) => s.setDoc);
  const commit = useStore((s) => s.commit);
  const change = useStore((s) => s.change);
  const set = useStore((s) => s.set);
  const setTool = useStore((s) => s.setTool);
  if (!cutout) return null;
  const hasAi = cutout.fgId !== null;
  const alpha = cutout.source === "alpha";
  const mode = edge.deconMode;
  const source = alpha ? "color" : edge.matteSource;

  return (
    <>
      <button className="btn block" onClick={() => removeFringe()}>
        <Sparkles size={14} /> 흰 테두리 한 번에 제거
      </button>
      <div className="hint mt8">
        가는 가지·머리카락 끝이 하얗게 뜨는 건 원래 배경색이 테두리에 섞여 있어서예요.
        <b> F</b> 키로 ‘검정’ 보기에서 확인하면 잘 보입니다.
      </div>

      <div className="field-label mt12">걷어 내는 방식</div>
      <Segmented
        value={mode}
        onChange={(v) => change(v === "matte" ? "배경색 빼기" : "AI 추정 방식", (d) => {
          d.edge.deconMode = v;
          if (v === "matte" && d.edge.decontaminate === 0) d.edge.decontaminate = 100;
        })}
        options={[
          { value: "auto", label: "AI 추정", disabled: !hasAi, tip: hasAi ? "AI가 추정한 원래 색으로 바꿈" : "AI 누끼 결과에서만 쓸 수 있어요" },
          { value: "matte", label: "배경색 빼기", tip: "원래 배경색을 정확히 빼냄 (흰 배경·단색 배경에 가장 깨끗)" },
        ]}
      />
      {mode === "auto" && !hasAi && (
        <div className="hint mt8">AI 누끼가 아니라서 지금은 테두리 색을 고치지 않고 있어요. ‘배경색 빼기’를 고르거나 위 버튼을 누르세요.</div>
      )}
      {mode === "matte" && (
        <div className="mt8">
          <Segmented
            value={source}
            onChange={(v) => change("원래 배경색", (d) => {
              d.edge.matteSource = v;
              if (v === "color" && d.edge.matteColor === "#ffffff") d.edge.matteColor = detectMatteColor();
            })}
            options={[
              { value: "auto", label: "주변 배경 자동", disabled: alpha, tip: alpha ? "투명 PNG는 원래 배경 정보가 없어요" : "경계 주변의 실제 배경색을 위치마다 읽음" },
              { value: "color", label: "색 직접 지정", tip: "원래 배경이 한 가지 색일 때" },
            ]}
          />
          {source === "color" && (
            <div className="row mt8">
              <div style={{ flex: 1 }}>
                <ColorField value={edge.matteColor} onChange={(v) => setDoc((d) => { d.edge.matteColor = v; })}
                  onCommit={() => commit("원래 배경색")} />
              </div>
              <button className="btn icon" data-tip="사진에서 원래 배경 찍기" onClick={() => { set({ eyedropperTarget: "matte" }); setTool("eyedropper"); }}>
                <Pipette size={15} />
              </button>
            </div>
          )}
        </div>
      )}
      <div className="mt8">
        <Slider label="강도" value={edge.decontaminate} min={0} max={100} def={100} format={(v) => `${v}%`}
          onChange={(v) => setDoc((d) => { d.edge.decontaminate = v; })} onCommit={() => commit("테두리 색 강도")} />
        <Slider label="투명도 다시 계산" value={edge.colorAlpha} min={0} max={100} def={0}
          format={(v) => (v ? `${v}%` : "끔")} disabled={invert}
          tip="배경이 단색일 때 — 가지·털 사이에 남은 흰 안개를 색으로 다시 계산해 없앰. 밝은 줄기처럼 굵은 부분은 불투명하게 유지"
          onChange={(v) => setDoc((d) => { d.edge.colorAlpha = v; })} onCommit={() => commit("투명도 다시 계산")} />
        <Slider label="가장자리 색 채우기" value={edge.defringe} min={0} max={20} step={0.5} def={0} format={(v) => (v ? `${v}px` : "끔")}
          tip="반투명 테두리를 가까운 피사체 색으로 덮음 — 배경색을 빼도 남는 흰 기운에"
          onChange={(v) => setDoc((d) => { d.edge.defringe = v; })} onCommit={() => commit("가장자리 색 채우기")} />
      </div>
    </>
  );
}

const VIEW_OPTIONS: { value: ViewMode; label: string; tip: string }[] = [
  { value: "normal", label: "합성", tip: "최종 결과" },
  { value: "overlay", label: "오버레이", tip: "지워진 곳을 빨갛게 표시" },
  { value: "mask", label: "마스크", tip: "흑백 마스크" },
  { value: "black", label: "검정", tip: "검정 배경에서 경계 확인" },
  { value: "white", label: "흰색", tip: "흰 배경에서 경계 확인" },
];

export function CutoutPanel() {
  const image = useStore((s) => s.image);
  const cutout = useStore((s) => s.doc.cutout);
  const edge = useStore((s) => s.doc.edge);
  const strokes = useStore((s) => s.doc.strokes.length);
  const invert = useStore((s) => s.doc.invert);
  const job = useStore((s) => s.job);
  const prog = useSmoothProgress(job);
  const viewMode = useStore((s) => s.viewMode);
  const tool = useStore((s) => s.tool);
  const brush = useStore((s) => s.brush);
  const set = useStore((s) => s.set);
  const setDoc = useStore((s) => s.setDoc);
  const commit = useStore((s) => s.commit);
  const change = useStore((s) => s.change);
  const setTool = useStore((s) => s.setTool);
  const setBrush = useStore((s) => s.setBrush);

  if (!image) return <div className="empty-note">사진을 열면 AI로 배경을 지울 수 있어요.</div>;

  const pickBrush = (mode: "add" | "sub") => {
    setBrush({ mode });
    setTool("brush");
  };
  const edgeChanged = edge.feather !== 0 || edge.contrast !== 0 || edge.shift !== 0;
  const colorChanged = edge.decontaminate !== 100 || edge.deconMode !== "auto" || edge.defringe !== 0 || edge.colorAlpha !== 0;

  return (
    <>
      {job ? (
        <div className="hero">
          <h3>AI가 피사체를 찾는 중…</h3>
          <p>{job.message}</p>
          <div className={`progress${prog < 0.02 ? " indeterminate" : ""}`}>
            <div style={{ width: `${Math.max(3, prog * 100)}%` }} />
          </div>
          <div className="row mt12">
            <span className="hint" style={{ flex: 1 }}>{Math.round(prog * 100)}% 완료</span>
            <button className="btn sm" onClick={cancelCutout}>
              <X size={14} /> 취소
            </button>
          </div>
        </div>
      ) : !cutout ? (
        <div className="hero">
          <h3>AI 자동 누끼</h3>
          <p>버튼 한 번이면 AI가 피사체를 찾아 배경을 지웁니다. 머리카락처럼 섬세한 경계도 살려요.</p>
          <button className="btn magic" onClick={runCutout}>
            <Sparkles size={18} /> 자동 누끼 따기
          </button>
          <button className="btn ghost sm block mt8" onClick={() => setTool("pen")}>
            <PenTool size={13} /> AI 없이 포토샵 도구로 직접 따기
          </button>
        </div>
      ) : (
        <div className="result-banner">
          <CheckCircle2 size={18} color="var(--ok)" />
          <span style={{ flex: 1 }}>
            {cutout.source === "ai" ? "누끼 완료" : cutout.source === "alpha" ? "투명 배경 이미지" : "직접 만든 마스크"}
            {strokes > 0 && <span className="muted"> · 수정 {strokes}회</span>}
          </span>
          <button className="btn sm ghost" onClick={runCutout} data-tip="AI로 다시 따기">
            <RefreshCw size={13} />
          </button>
          <button className="btn sm ghost danger" onClick={clearCutout} data-tip="누끼 해제 (원본으로)">
            <Trash2 size={13} />
          </button>
        </div>
      )}

      {cutout && (
        <>
          <Section id="cut.view" title="결과 확인">
            <Segmented value={viewMode} options={VIEW_OPTIONS} onChange={(v) => set({ viewMode: v })} />
            <div className="hint mt8">
              <b>F</b> 키로 보기 전환 · <b>\</b> 키를 누르고 있으면 원본
            </div>
          </Section>

          <Section
            id="cut.brush"
            title="브러시로 다듬기"
            modified={strokes > 0 || invert}
            onReset={strokes > 0 || invert ? () => change("브러시 수정 초기화", (d) => { d.strokes = []; d.invert = false; }) : undefined}
          >
            <div className="brush-cards">
              <button className={`brush-card${tool === "brush" && brush.mode === "add" ? " on" : ""}`} onClick={() => pickBrush("add")}>
                <Brush size={20} />
                복원 브러시
                <span className="k">지워진 부분 되살리기 · B</span>
              </button>
              <button className={`brush-card${tool === "brush" && brush.mode === "sub" ? " on" : ""}`} onClick={() => pickBrush("sub")}>
                <Eraser size={20} />
                지우기 브러시
                <span className="k">남은 배경 지우기 · E</span>
              </button>
            </div>
            <div className="mt12">
              <Slider label="크기" value={brush.size} min={2} max={1000} step={1} def={80}
                format={(v) => `${v}px`} onChange={(v) => setBrush({ size: v })} />
              <Slider label="경도" value={brush.hardness} min={0} max={100} def={60}
                format={(v) => `${v}%`} onChange={(v) => setBrush({ hardness: v })} tip="낮을수록 가장자리가 부드러워요" />
              <Slider label="불투명도" value={brush.opacity} min={1} max={100} def={100}
                format={(v) => `${v}%`} onChange={(v) => setBrush({ opacity: v })} />
            </div>
            <div className="mt12">
              <Toggle
                on={brush.auto}
                onChange={(v) => setBrush({ auto: v })}
                label="자동 경계"
                desc="붓 중심과 색이 비슷한 곳만 칠해요. 피사체 경계를 따라 칠할 때 편해요."
              />
            </div>
            {brush.auto && (
              <Slider label="허용 범위" value={brush.tolerance} min={1} max={100} def={30}
                format={(v) => `${v}`} onChange={(v) => setBrush({ tolerance: v })} />
            )}
            <div className="hint mt8">
              <b>[ ]</b> 크기 · <b>Shift+[ ]</b> 경도 · <b>X</b> 복원/지우기 전환 · <b>Alt+우클릭 드래그</b>로 크기·경도 조절
            </div>
            <div className="grid2 mt12">
              <button className="btn sm" onClick={() => change(invert ? "마스크 반전 해제" : "마스크 반전", (d) => { d.invert = !d.invert; })}>
                <FlipHorizontal2 size={13} /> 반전 <span className="kbd">Ctrl+I</span>
              </button>
              <button className="btn sm" disabled={strokes === 0} onClick={() => change("브러시 수정 초기화", (d) => { d.strokes = []; })}>
                <Undo2 size={13} /> 브러시 지우기
              </button>
            </div>
          </Section>

          <Section id="cut.edge" title="가장자리 다듬기" modified={edgeChanged} onReset={edgeChanged ? resetMaskEdits : undefined}>
            <Slider label="부드럽게 (페더)" value={edge.feather} min={0} max={100} step={0.5} def={0}
              format={(v) => `${v}px`} tip="경계를 흐리게 해서 자연스럽게"
              onChange={(v) => setDoc((d) => { d.edge.feather = v; })} onCommit={() => commit("페더")} />
            <Slider label="경계 대비" value={edge.contrast} min={0} max={100} def={0}
              format={(v) => `${v}%`} tip="흐릿한 경계를 또렷하게"
              onChange={(v) => setDoc((d) => { d.edge.contrast = v; })} onCommit={() => commit("경계 대비")} />
            <Slider label="가장자리 이동" value={edge.shift} min={-100} max={100} def={0}
              format={(v) => `${v > 0 ? "+" : ""}${v}%`} tip="− 안쪽으로 줄이기 · + 바깥으로 넓히기"
              onChange={(v) => setDoc((d) => { d.edge.shift = v; })} onCommit={() => commit("가장자리 이동")} />
          </Section>

          <Section
            id="cut.color"
            title="테두리 색 (흰 테두리 제거)"
            modified={colorChanged}
            onReset={colorChanged ? () => change("테두리 색 초기화", (d) => {
              d.edge.decontaminate = 100;
              d.edge.deconMode = "auto";
              d.edge.matteSource = "auto";
              d.edge.defringe = 0;
              d.edge.colorAlpha = 0;
            }) : undefined}
          >
            <EdgeColor />
          </Section>
        </>
      )}

      <Section id="cut.manual" title="직접 따기 (포토샵 도구)">
        <ManualTools />
      </Section>

      <Section id="cut.ai" title="AI 설정" defaultOpen={!cutout}>
        <ModelPicker />
      </Section>
    </>
  );
}
