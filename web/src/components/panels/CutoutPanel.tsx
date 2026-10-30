import {
  Brush, Check, CheckCircle2, Download, Eraser, FlipHorizontal2, MousePointerClick, PenTool, Pipette, RefreshCw, Sparkles,
  SquareMinus, SquarePlus, Trash2, X,
} from "lucide-react";
import {
  cancelCutout, clearCutout, detectMatteColor, removeFringe, resetEdge, runCutout, toggleInvert,
} from "../../actions";
import { KIND, type CutKind } from "../../kinds";
import { overwriteCurrent, saveCurrent } from "../../folder";
import { useOrigin } from "../../origin";
import { setDespeckle } from "../../actions";
import { DespeckleRow } from "../DespeckleRow";
import { useStore, type ViewMode } from "../../store";
import { defaultEdge, type Cutout, type EdgeParams } from "../../types";
import { ColorField, Section, Segmented, Slider } from "../controls";
import { CutOptions, KindPicker } from "../KindPicker";
import { useSmoothProgress } from "../useSmoothProgress";
import { OutlineSection } from "./OutlineSection";
import { useRepeat } from "../OptionsBar";

const VIEW_OPTIONS: { value: ViewMode; label: string; tip: string }[] = [
  { value: "normal", label: "합성", tip: "최종 결과" },
  { value: "overlay", label: "오버레이", tip: "지워진 곳을 빨갛게" },
  { value: "mask", label: "마스크", tip: "흑백 마스크" },
  { value: "black", label: "검정", tip: "검정 배경에서 확인" },
  { value: "white", label: "흰색", tip: "흰 배경에서 확인" },
];

function edgeIsDefault(e: EdgeParams) {
  const d = defaultEdge();
  return (Object.keys(d) as (keyof EdgeParams)[]).every((k) => e[k] === d[k]);
}

/** 결과 줄 문구 */
function resultText(c: Cutout) {
  if (c.kind && KIND[c.kind] && c.seeds?.length) return `${KIND[c.kind].ro} 땄어요 · 배경 ${c.seeds.length}곳 찍음`;
  if (c.kind && KIND[c.kind]) return `${KIND[c.kind].ro} 땄어요`;
  if (c.source === "alpha") return "투명 배경 이미지";
  if (c.source === "manual") return "직접 만든 마스크";
  return "누끼 완료";
}

/** 서버 안내 한 줄 (우선순위대로 하나만) */
function ServerHint({ kind }: { kind: CutKind }) {
  const server = useStore((s) => s.server);
  if (!server) return null;
  if (!server.ok) return <div className="hint mt8">⚠ 서버에 연결되지 않았어요. 바탕 화면 아이콘으로 다시 켜 주세요.</div>;
  if (kind !== "person") return null;
  const portrait = server.models?.find((m) => m.id === "portrait");
  if (portrait && !portrait.downloaded) {
    return (
      <div className="hint mt8">
        사진이면 처음 한 번 인물용 AI 모델(약 {Math.max(1, Math.round(portrait.size / 1e6))}MB)을 내려받아요.
      </div>
    );
  }
  if (server.device?.kind === "cpu") return <div className="hint mt8">CPU로 처리해요 · 사진은 한 장에 30초 넘게 걸릴 수 있어요.</div>;
  return null;
}

/** 히어로: 종류 고르기 → 누끼 따기 → (따는 중) 진행 → (딴 뒤) 결과 줄 · 다시 따기 · 누끼 해제.
 *  상태가 바뀌어도 종류 고르기는 같은 자리에 있어 화면이 흔들리지 않는다 */
function Hero() {
  const cutout = useStore((s) => s.doc.cutout);
  const strokes = useStore((s) => s.doc.strokes.length);
  const invert = useStore((s) => s.doc.invert);
  const job = useStore((s) => s.job);
  const kind = useStore((s) => s.kind);
  const serverDown = useStore((s) => s.server?.ok === false);
  const setKind = useStore((s) => s.setKind);
  const setTool = useStore((s) => s.setTool);
  const picking = useStore((s) => s.tool === "bgpick");
  const despeckle = useStore((s) => s.despeckle);
  const specks = useStore((s) => (s.doc.cutout?.source === "ai" ? s.doc.cutout.specks ?? 0 : 0));
  const prog = useSmoothProgress(job);
  const k = KIND[kind];
  const same = !!cutout && cutout.kind === kind;

  return (
    <div className="hero">
      <h3>누끼 따기</h3>
      <div className="field-label">무엇을 따나요?</div>
      <KindPicker value={kind} onChange={setKind} disabled={!!job} />
      <div className="hint mt8">{k.help}</div>
      <DespeckleRow size={despeckle} onChange={setDespeckle} removed={specks} />

      {job ? (
        <div className="mt12">
          <div className="row">
            <b className="grow">{k.label} 누끼 따는 중…</b>
            <span className="muted tnum">{Math.round(prog * 100)}%</span>
          </div>
          <div className={`progress mt8${prog < 0.02 ? " indeterminate" : ""}`}>
            <div style={{ width: `${Math.max(3, prog * 100)}%` }} />
          </div>
          <div className="row mt8">
            <span className="hint grow ellipsis" title={job.message}>{job.message}</span>
            <button className="btn sm" onClick={cancelCutout}>
              <X size={14} /> 취소
            </button>
          </div>
        </div>
      ) : !cutout ? (
        <>
          <button className="btn magic mt12" onClick={() => runCutout()}>
            <Sparkles size={18} /> {k.label} 누끼 따기
          </button>
          <button className={`btn sm block mt8${picking ? " primary" : ""}`} onClick={() => setTool(picking ? "hand" : "bgpick")}
            data-tip="지울 배경을 클릭하면 그곳과 이어진 배경만 지워요 (G)">
            <MousePointerClick size={13} /> {picking ? "배경 찍는 중 — 사진을 클릭하세요" : "배경 찍어서 지우기"}
          </button>
          <button className="btn ghost sm block mt8" onClick={() => setTool("pen")}>
            <PenTool size={13} /> 직접 따기 (펜 도구)
          </button>
          <ServerHint kind={kind} />
        </>
      ) : (
        <>
          <div className="result-banner in-hero">
            <CheckCircle2 size={18} color="var(--ok)" />
            <span className="grow">
              {resultText(cutout)}
              {strokes > 0 && <span className="muted"> · 수정 {strokes}회</span>}
              {invert && <span className="muted"> · 반전됨</span>}
            </span>
          </div>
          <div className="recut-row mt8">
            {same ? (
              <button className="btn sm" onClick={() => runCutout()}>
                <RefreshCw size={13} /> 다시 따기
              </button>
            ) : (
              <button className="btn sm primary" onClick={() => runCutout()}>
                <RefreshCw size={13} /> {k.ro} 다시 따기
              </button>
            )}
            <button className="btn sm ghost danger" onClick={clearCutout}>
              <Trash2 size={13} /> 누끼 해제
            </button>
          </div>
          <SaveStatus />
          {(serverDown || !same) && <ServerHint kind={kind} />}
        </>
      )}
    </div>
  );
}

/** 저장 상태: 저장한 뒤 바뀐 게 없으면 '저장됨 · 파일 이름 · 시각', 바뀌었으면 '저장 안 됨' + 저장 버튼 */
function SaveStatus() {
  const unsaved = useStore((s) => !!s.image && s.histIndex !== s.savedIndex);
  const last = useStore((s) => s.lastSave);
  const canOverwrite = useOrigin((s) => !!s.origin);
  if (!unsaved && last) {
    const t = new Date(last.at);
    const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    return (
      <div className="save-status ok mt8" title={`${last.name} · ${last.info}`}>
        <Check size={14} />
        <span className="grow ellipsis">저장됨 · {last.name}</span>
        <span className="muted tnum">{hm}</span>
      </div>
    );
  }
  return (
    <div className="save-status mt8">
      <span className="dot" />
      <span className="grow">{last ? "저장한 뒤 바뀐 게 있어요" : "아직 저장 안 함"}</span>
      {canOverwrite && (
        <button className="btn sm danger-ghost" onClick={() => overwriteCurrent()} data-tip="원본 파일에 그대로 덮어쓰기 (확인 후)">
          덮어쓰기
        </button>
      )}
      <button className="btn sm" onClick={saveCurrent} data-tip="저장 (Ctrl+S) · 폴더에서 연 사진은 누끼 폴더에 바로">
        <Download size={13} /> 저장
      </button>
    </div>
  );
}

/** 경계에 섞인 원래 배경색(흰 테두리 등) 처리 */
function EdgeColor({ cutout }: { cutout: Cutout }) {
  const edge = useStore((s) => s.doc.edge);
  const invert = useStore((s) => s.doc.invert);
  const setDoc = useStore((s) => s.setDoc);
  const commit = useStore((s) => s.commit);
  const change = useStore((s) => s.change);
  const set = useStore((s) => s.set);
  const setTool = useStore((s) => s.setTool);
  const hasFg = cutout.fgId !== null;
  const alpha = cutout.source === "alpha";
  const mode = edge.deconMode;
  const source = alpha ? "color" : edge.matteSource;

  return (
    <>
      <div className="field-label">걷어 내는 방식</div>
      <Segmented
        value={mode}
        onChange={(v) => change(v === "matte" ? "배경색 빼기" : "자동 테두리 색", (d) => {
          d.edge.deconMode = v;
          if (v === "matte" && d.edge.decontaminate === 0) d.edge.decontaminate = 100;
        })}
        options={[
          { value: "auto", label: "자동", disabled: !hasFg, tip: hasFg ? "누끼 때 계산한 원래 색" : "누끼 따기 결과에서만" },
          { value: "matte", label: "배경색 빼기", tip: "원래 배경색을 정확히 빼냄" },
        ]}
      />
      {mode === "auto" && !hasFg && (
        <div className="hint mt8">직접 만든 마스크·투명 PNG는 테두리 색을 그대로 둬요. 고치려면 ‘배경색 빼기’를 고르세요.</div>
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
              { value: "auto", label: "주변 배경 자동", disabled: alpha, tip: alpha ? "투명 PNG는 배경 정보가 없어요" : "경계 주변 배경색을 읽음" },
              { value: "color", label: "색 직접 지정", tip: "배경이 한 가지 색일 때" },
            ]}
          />
          {source === "color" && (
            <div className="row mt8">
              <div style={{ flex: 1 }}>
                <ColorField value={edge.matteColor} onChange={(v) => setDoc((d) => { d.edge.matteColor = v; })}
                  onCommit={() => commit("원래 배경색")} />
              </div>
              <button className="btn icon" data-tip="사진에서 원래 배경 찍기" data-tip-pos="left"
                onClick={() => { set({ eyedropperTarget: "matte" }); setTool("eyedropper"); }}>
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
          tip="단색 배경일 때 흰 안개를 색으로 없앰"
          onChange={(v) => setDoc((d) => { d.edge.colorAlpha = v; })} onCommit={() => commit("투명도 다시 계산")} />
        <Slider label="가장자리 색 채우기" value={edge.defringe} min={0} max={20} step={0.5} def={0} format={(v) => (v ? `${v}px` : "끔")}
          tip="반투명 테두리를 피사체 색으로"
          onChange={(v) => setDoc((d) => { d.edge.defringe = v; })} onCommit={() => commit("가장자리 색 채우기")} />
      </div>
    </>
  );
}

/** 고급 설정: 따기 옵션(다음에 딸 때) + (딴 뒤) 가장자리 · 테두리 색 · 마스크 반전 */
function Advanced() {
  const cutout = useStore((s) => s.doc.cutout);
  const edge = useStore((s) => s.doc.edge);
  const invert = useStore((s) => s.doc.invert);
  const kind = useStore((s) => s.kind);
  const inner = useStore((s) => s.inner);
  const fine = useStore((s) => s.fine);
  const set = useStore((s) => s.set);
  const setDoc = useStore((s) => s.setDoc);
  const commit = useStore((s) => s.commit);

  const edgeChanged = !!cutout && (!edgeIsDefault(edge) || invert);
  const fineOn = kind === "person" && fine;
  const modified = inner !== "auto" || fineOn || edgeChanged;
  // 되돌리기: 따기 옵션과 가장자리·테두리 색·반전만 (브러시로 다듬은 것은 '브러시로 다듬기'에서)
  const reset = () => {
    set({ inner: "auto", fine: false });
    if (edgeChanged) resetEdge();
  };

  return (
    <Section id="cut.adv" title="고급 설정" defaultOpen={false} modified={modified} onReset={modified ? reset : undefined}>
      <div className="adv-group">따기 옵션 · 다음에 딸 때 적용</div>
      <CutOptions kind={kind} inner={inner} fine={fine} onInner={(v) => set({ inner: v })} onFine={(v) => set({ fine: v })} />

      {cutout && (
        <>
          <div className="adv-group mt16">가장자리</div>
          <button className="btn block" onClick={() => removeFringe()} data-tip="가지·머리카락 끝이 하얗게 뜰 때">
            <Sparkles size={14} /> 흰 테두리 한 번에 제거
          </button>
          <div className="mt8">
            <Slider label="부드럽게 (페더)" value={edge.feather} min={0} max={100} step={0.5} def={0}
              format={(v) => `${v}px`} tip="경계를 흐리게"
              onChange={(v) => setDoc((d) => { d.edge.feather = v; })} onCommit={() => commit("페더")} />
            <Slider label="경계 대비" value={edge.contrast} min={0} max={100} def={0}
              format={(v) => `${v}%`} tip="흐릿한 경계를 또렷하게"
              onChange={(v) => setDoc((d) => { d.edge.contrast = v; })} onCommit={() => commit("경계 대비")} />
            <Slider label="가장자리 이동" value={edge.shift} min={-100} max={100} def={0}
              format={(v) => `${v > 0 ? "+" : ""}${v}%`} tip="− 안쪽으로 · + 바깥으로"
              onChange={(v) => setDoc((d) => { d.edge.shift = v; })} onCommit={() => commit("가장자리 이동")} />
          </div>

          <div className="adv-group mt16">테두리 색</div>
          <EdgeColor cutout={cutout} />

          <button className="btn sm mt12" onClick={toggleInvert}>
            <FlipHorizontal2 size={13} /> {invert ? "마스크 반전 해제" : "마스크 반전"} <span className="kbd">Ctrl+I</span>
          </button>
        </>
      )}
    </Section>
  );
}

const SHAVE_MAX = 50;

/** 테두리 깎기: 피사체 바깥 가장자리를 1px 씩 깎는다 — 외곽선을 너무 두껍게 넣은 사진을 얇게 */
function ShaveRow() {
  const shave = useStore((s) => s.doc.edge.shave || 0);
  const change = useStore((s) => s.change);
  const step = (n: number) => {
    const cur = useStore.getState().doc.edge.shave || 0;
    const v = Math.max(0, Math.min(SHAVE_MAX, cur + n));
    if (v !== cur) change("테두리 깎기", (d) => { d.edge.shave = v; });
  };
  const minus = useRepeat((sh) => step(sh ? -5 : -1));
  const plus = useRepeat((sh) => step(sh ? 5 : 1));
  return (
    <div className="shave-row">
      <span className="shave-label" data-tip="피사체 바깥 테두리를 1px 씩 깎아요 — 외곽선이 너무 두꺼운 사진을 얇게 · Shift 5px">
        테두리 깎기
      </span>
      <div className="row grow-stepper" style={{ gap: 2 }}>
        <button className="iconbtn" {...minus} data-tip="1px 덜 깎기 (Shift 5px)"><SquareMinus size={15} /></button>
        <span className={`grow-val tnum${shave ? " on" : ""}`}>{shave ? `−${shave}px` : "0px"}</span>
        <button className="iconbtn" {...plus} data-tip="1px 더 깎기 · 누르고 있으면 계속 (Shift 5px)"><SquarePlus size={15} /></button>
      </div>
      {shave > 0 && (
        <button className="btn ghost sm" onClick={() => change("테두리 깎기", (d) => { d.edge.shave = 0; })}>원래대로</button>
      )}
    </div>
  );
}

/** 브러시로 다듬기: 복원·지우기 카드만. 크기·경도·불투명도·자동 경계는 브러시를 고르면 위쪽 옵션 막대에 있다 */
function BrushSection() {
  const strokes = useStore((s) => s.doc.strokes.length);
  const tool = useStore((s) => s.tool);
  const mode = useStore((s) => s.brush.mode);
  const setTool = useStore((s) => s.setTool);
  const setBrush = useStore((s) => s.setBrush);
  const change = useStore((s) => s.change);
  const pick = (m: "add" | "sub") => {
    setBrush({ mode: m });
    setTool("brush");
  };

  return (
    <Section
      id="cut.brush"
      title="브러시로 다듬기"
      modified={strokes > 0}
      onReset={strokes > 0 ? () => change("브러시 수정 초기화", (d) => { d.strokes = []; }) : undefined}
    >
      <div className="brush-cards">
        <button className={`brush-card${tool === "brush" && mode === "add" ? " on" : ""}`} onClick={() => pick("add")}>
          <Brush size={20} />
          복원 브러시
          <span className="k">지워진 곳 되살리기 · B</span>
        </button>
        <button className={`brush-card${tool === "brush" && mode === "sub" ? " on" : ""}`} onClick={() => pick("sub")}>
          <Eraser size={20} />
          지우기 브러시
          <span className="k">남은 배경 지우기 · E</span>
        </button>
      </div>
      <div className="hint mt8">
        크기·경도는 위쪽 막대에서 · <b>[ ]</b> 크기 · <b>X</b> 전환
      </div>
    </Section>
  );
}

/** 누끼 탭. 기본 화면은 '종류 고르기 → 누끼 따기' 하나, 따고 나면 보기 · 외곽선 · 브러시. 나머지는 고급 설정에 접어 둔다 */
export function CutoutPanel() {
  const image = useStore((s) => s.image);
  const hasCutout = useStore((s) => !!s.doc.cutout);
  const viewMode = useStore((s) => s.viewMode);
  const set = useStore((s) => s.set);

  if (!image) return <div className="empty-note">사진을 열면 배경을 지울 수 있어요.</div>;

  return (
    <>
      <Hero />
      {hasCutout && (
        <>
          <div className="view-row">
            <Segmented value={viewMode} options={VIEW_OPTIONS} onChange={(v) => set({ viewMode: v })} />
            <div className="hint mt8"><b>F</b> / <b>A</b> 보기 전환 · <b>\</b> 누르고 있으면 원본</div>
            <ShaveRow />
          </div>
          <OutlineSection />
          <BrushSection />
        </>
      )}
      <Advanced />
    </>
  );
}
