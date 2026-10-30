import { Ban } from "lucide-react";
import type { ReactNode } from "react";
import { defaultOutline, type Outline } from "../types";
import { ColorField, More, Segmented, Slider } from "./controls";

/** 자주 쓰는 선 색 — 누르면 바로 그 색 외곽선이 켜진다 */
export const LINE_SWATCHES = ["#ffffff", "#000000", "#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#a855f7"];

const GRADIENT_PRESETS: { label: string; c1: string; a1: number; c2: string; a2: number }[] = [
  { label: "검정 → 투명", c1: "#000000", a1: 100, c2: "#000000", a2: 0 },
  { label: "검정 → 흰색", c1: "#000000", a1: 100, c2: "#ffffff", a2: 100 },
  { label: "흰색 → 투명", c1: "#ffffff", a1: 100, c2: "#ffffff", a2: 0 },
  { label: "흰색 → 검정", c1: "#ffffff", a1: 100, c2: "#000000", a2: 100 },
];

const POSITION_LABEL: Record<Outline["position"], string> = { outside: "바깥", center: "가운데", inside: "안쪽" };

function rgba(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha / 100})`;
}

/** '더보기'가 접혀 있어도 보이는 요약: 가운데 · 단색 (· 부드럽게 2px · 80% …) */
export function outlineSummary(ol: Outline, extra?: string) {
  const parts = [POSITION_LABEL[ol.position], ol.fill === "gradient" ? "그라디언트" : "단색"];
  if (ol.soft) parts.push(`부드럽게 ${ol.soft}px`);
  if (ol.opacity < 100) parts.push(`${ol.opacity}%`);
  if (extra) parts.push(extra);
  return parts.join(" · ");
}

export interface OutlineControlsProps {
  value: Outline;
  /** 사진의 긴 변 (px) — 두께 최대값 계산용 */
  long: number;
  /** 즉시 반영 (슬라이더를 끄는 중에도) */
  set: (p: Partial<Outline>) => void;
  /** 실행 취소 기록 한 단계 (폴더 작업은 아무것도 안 함) */
  commit: (label: string) => void;
  /** '더보기' 열림 상태 저장 키 */
  moreId: string;
  /** '더보기' 맨 위 (폴더 작업: 두께를 사진 크기에 비례) */
  moreExtra?: ReactNode;
  /** '더보기' 요약 끝에 붙일 말 (폴더 작업: 비례 두께) */
  summaryExtra?: string;
  /** 두께 슬라이더를 두 번 눌렀을 때 돌아갈 기본 두께 (편집기: 사진 크기에 따라 1·2px) */
  defWidth?: number;
  /** 두께 슬라이더 대신 (폴더 작업: % 슬라이더) */
  widthOverride?: ReactNode;
  /** 사진에 비해 선이 두꺼운지 (바깥 선 경고용). 기본은 width > long/40 */
  thick?: boolean;
  /** 편집기: 합성 보기 안내 */
  viewHint?: ReactNode;
}

/** 외곽선(포토샵 레이어 스타일의 '획'). 기본 화면은 색 + 두께, 나머지는 '더보기' 안에. 편집기와 폴더 작업이 같이 쓴다.
 *  기록 이름은 그대로 둬야 1.5초 안의 같은 이름 합치기가 동작한다 */
export function OutlineControls({
  value: ol, long, set, commit, moreId, moreExtra, summaryExtra, widthOverride, thick, viewHint, defWidth,
}: OutlineControlsProps) {
  const maxW = Math.max(60, Math.round(long / 8));
  const grad = ol.fill === "gradient";
  const once = (p: Partial<Outline>, label: string) => {
    set(p);
    commit(label);
  };
  const off = () => ol.enabled && once({ enabled: false }, "외곽선 끄기");
  // 색을 누르면 그 색 그대로의 선 (그라디언트는 '더보기'에서)
  const pick = (c: string) => once({ enabled: true, color: c, fill: "solid" }, ol.enabled ? "외곽선 색" : "외곽선 켜기");
  const isThick = thick ?? ol.width > long / 40;

  return (
    <>
      <div className="swatches nine">
        <button className={`swatch none${!ol.enabled ? " on" : ""}`} data-tip="외곽선 없음" onClick={off}>
          <Ban size={14} />
        </button>
        {LINE_SWATCHES.map((c) => (
          <button key={c} className={`swatch${ol.enabled && !grad && ol.color === c ? " on" : ""}`} style={{ background: c }}
            data-tip={c.toUpperCase()} onClick={() => pick(c)} />
        ))}
      </div>
      {!ol.enabled && <div className="hint mt8">색을 누르면 윤곽을 따라 그 색 선을 넣어요.</div>}
      {ol.enabled && (
        <>
          {viewHint}
          <div className="mt12">
            {widthOverride ?? (
              <Slider label="두께" value={ol.width} min={1} max={maxW} def={defWidth ?? defaultOutline().width}
                format={(v) => `${v}px`} onChange={(v) => set({ width: v })} onCommit={() => commit("외곽선 두께")} />
            )}
          </div>
          <More id={moreId} summary={outlineSummary(ol, summaryExtra)}>
            {moreExtra}
            <div className="field-label">위치</div>
            <Segmented
              value={ol.position}
              onChange={(v) => once({ position: v }, "외곽선 위치")}
              options={[
                { value: "outside", label: "바깥", tip: "피사체 바깥으로" },
                { value: "center", label: "가운데", tip: "윤곽선 양쪽으로" },
                { value: "inside", label: "안쪽", tip: "피사체 안쪽으로" },
              ]}
            />
            {ol.position === "outside" && isThick && (
              <div className="hint mt8">가는 가지·털이 많으면 바깥 선이 틈을 메워요. 두께를 줄이거나 ‘안쪽’을 써 보세요.</div>
            )}

            <div className="field-label mt12">{grad ? "가장 바깥 색" : "색"}</div>
            <ColorField value={ol.color} onChange={(v) => set({ color: v })} onCommit={() => commit("외곽선 색")} />
            <div className="mt8">
              <Slider label="부드럽게" value={ol.soft} min={0} max={30} step={0.5} def={0} format={(v) => `${v}px`}
                tip="선 가장자리를 흐리게" onChange={(v) => set({ soft: v })} onCommit={() => commit("외곽선 부드럽게")} />
              <Slider label="불투명도" value={ol.opacity} min={0} max={100} def={100} format={(v) => `${v}%`}
                onChange={(v) => set({ opacity: v })} onCommit={() => commit("외곽선 불투명도")} />
            </div>

            <div className="field-label mt8">채우기</div>
            <Segmented
              value={ol.fill}
              onChange={(v) => once({ fill: v }, "외곽선 채우기")}
              options={[{ value: "solid", label: "단색" }, { value: "gradient", label: "그라디언트" }]}
            />
            {grad && (
              <>
                <div className="outline-preview checker mt8">
                  <div style={{ background: `linear-gradient(90deg, ${rgba(ol.color, ol.alpha1)}, ${rgba(ol.color2, ol.alpha2)})` }} />
                </div>
                <div className="row small muted" style={{ justifyContent: "space-between", marginTop: 3 }}>
                  <span>가장 바깥</span>
                  <span>안쪽</span>
                </div>
                <div className="chip-row mt8" style={{ flexWrap: "wrap" }}>
                  {GRADIENT_PRESETS.map((p) => (
                    <button key={p.label} className="chip"
                      onClick={() => once({ color: p.c1, alpha1: p.a1, color2: p.c2, alpha2: p.a2, fill: "gradient" }, `외곽선: ${p.label}`)}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <Slider label="바깥 불투명도" value={ol.alpha1} min={0} max={100} def={100} format={(v) => `${v}%`}
                  onChange={(v) => set({ alpha1: v })} onCommit={() => commit("외곽선 바깥 불투명도")} />
                <div className="field-label mt8">가장 안쪽 색</div>
                <ColorField value={ol.color2} onChange={(v) => set({ color2: v })} onCommit={() => commit("외곽선 안쪽 색")} />
                <Slider label="안쪽 불투명도" value={ol.alpha2} min={0} max={100} def={0} format={(v) => `${v}%`}
                  onChange={(v) => set({ alpha2: v })} onCommit={() => commit("외곽선 안쪽 불투명도")} />
              </>
            )}
          </More>
        </>
      )}
    </>
  );
}
