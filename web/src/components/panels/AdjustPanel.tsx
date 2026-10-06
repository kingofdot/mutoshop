import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Wand2 } from "lucide-react";
import { applyPreset, getRenderer, resetAdjust, runAutoAdjust } from "../../actions";
import { packAdjust } from "../../gl/params";
import { curvesToLut } from "../../lib/curves";
import { PRESETS, presetToAdjust } from "../../lib/presets";
import { useStore } from "../../store";
import {
  HSL_BANDS,
  adjustIsIdentity,
  curvesActive,
  defaultCurve,
  type AdjustSet,
  type CurveChannel,
  type Target,
} from "../../types";
import { CurveEditor, HistogramView, Section, Segmented, Slider, useHisto } from "../controls";

type Key = keyof Omit<AdjustSet, "hsl" | "curves">;
interface Def {
  key: Key;
  label: string;
  min: number;
  max: number;
  step?: number;
  track?: string;
  tip?: string;
  format?: (v: number) => string;
}

const RAINBOW = "linear-gradient(90deg,#ff3b3b,#ffd23b,#4be36b,#3bdcff,#3b6bff,#c23bff,#ff3b3b)";
const signed = (v: number) => (v > 0 ? "+" : "") + v;

const LIGHT: Def[] = [
  { key: "exposure", label: "노출", min: -3, max: 3, step: 0.01, format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}` },
  { key: "brightness", label: "밝기", min: -100, max: 100, tip: "중간 밝기 위주로 밝게/어둡게" },
  { key: "contrast", label: "대비", min: -100, max: 100 },
  { key: "highlights", label: "하이라이트", min: -100, max: 100, tip: "밝은 영역 (− 로 날아간 하늘 복구)" },
  { key: "shadows", label: "섀도", min: -100, max: 100, tip: "어두운 영역 (+ 로 그늘 밝히기)" },
  { key: "whites", label: "흰색 계열", min: -100, max: 100 },
  { key: "blacks", label: "검정 계열", min: -100, max: 100 },
];

const COLOR: Def[] = [
  { key: "temperature", label: "색온도", min: -100, max: 100, track: "linear-gradient(90deg,#3f7bff,#cfd3dc,#ffbe3b)", tip: "− 차갑게 · + 따뜻하게" },
  { key: "tint", label: "색조", min: -100, max: 100, track: "linear-gradient(90deg,#3fd46a,#cfd3dc,#e64fe6)", tip: "− 초록 · + 자홍" },
  { key: "vibrance", label: "활기", min: -100, max: 100, tip: "덜 선명한 색 위주로 채도 조절 (피부톤 보호)" },
  { key: "saturation", label: "채도", min: -100, max: 100, track: "linear-gradient(90deg,#8a8a8a,#cfcfcf 50%,#ff4f6a)" },
  { key: "hue", label: "색상 회전", min: -180, max: 180, track: RAINBOW, format: (v) => `${signed(v)}°` },
];

const CURVE_COLORS: Record<CurveChannel, string> = { master: "#e6e6ea", r: "#ff5b5b", g: "#4fd16a", b: "#5b8cff" };

const TARGET_DESC: Record<Target, string> = {
  global: "사진 전체에 적용됩니다.",
  subject: "누끼 딴 피사체에만 적용됩니다.",
  background: "피사체를 뺀 배경에만 적용됩니다.",
};

function useAdjust() {
  const target = useStore((s) => s.target);
  const a = useStore((s) => s.doc.adjust[s.target]);
  const setDoc = useStore((s) => s.setDoc);
  const commit = useStore((s) => s.commit);
  const set = <K extends Key>(k: K, v: AdjustSet[K]) => setDoc((d) => { d.adjust[target][k] = v; });
  return { target, a, set, setDoc, commit };
}

function SliderList({ defs }: { defs: Def[] }) {
  const { a, set, commit } = useAdjust();
  return (
    <>
      {defs.map((d) => (
        <Slider
          key={d.key}
          label={d.label}
          value={a[d.key]}
          min={d.min}
          max={d.max}
          step={d.step ?? 1}
          track={d.track}
          tip={d.tip}
          format={d.format}
          onChange={(v) => set(d.key, v)}
          onCommit={() => commit(d.label)}
        />
      ))}
    </>
  );
}

function PresetGrid() {
  const target = useStore((s) => s.target);
  const doc = useStore((s) => s.doc);
  const version = useStore((s) => s.image?.version);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const current = useMemo(() => JSON.stringify(doc.adjust[target]), [doc.adjust, target]);
  const presetJson = useMemo(() => PRESETS.map((p) => JSON.stringify(presetToAdjust(p))), []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      const r = getRenderer();
      if (!r) return;
      const base = r.currentParams();
      const slot = target === "global" ? 0 : target === "subject" ? 1 : 2;
      const items = PRESETS.map((p) => {
        const adj = presetToAdjust(p);
        const params = base.params.slice();
        packAdjust(adj, params, slot);
        const lut = base.lut.slice();
        curvesToLut(adj.curves, lut, slot * 1024);
        return { params, lut, vignette: target === "global" ? p.vignette ?? 0 : doc.effects.vignette };
      });
      const imgs = r.renderPreviews(items, 140);
      const cv = document.createElement("canvas");
      setThumbs(
        imgs.map((im) => {
          cv.width = im.width;
          cv.height = im.height;
          cv.getContext("2d")!.putImageData(im, 0, 0);
          return cv.toDataURL("image/png");
        }),
      );
    }, 350);
    return () => clearTimeout(t);
  }, [doc.cutout, doc.strokes, doc.edge, doc.bg, doc.shadow, doc.orient, doc.crop, doc.adjust, doc.effects.vignette, target, version]);

  return (
    <div className="preset-grid">
      {PRESETS.map((p, i) => (
        <button key={p.id} className={`preset${presetJson[i] === current ? " on" : ""}`} onClick={() => applyPreset(p)}>
          <div className="thumb">{thumbs[i] && <img src={thumbs[i]} alt="" draggable={false} />}</div>
          {p.name}
        </button>
      ))}
    </div>
  );
}

function HslMixer() {
  const { a, setDoc, commit, target } = useAdjust();
  const [band, setBand] = useState(0);
  const b = HSL_BANDS[band];
  const v = a.hsl[band];
  const hue = b.hue;
  const setV = (k: "h" | "s" | "l", val: number) => setDoc((d) => { d.adjust[target].hsl[band][k] = val; });
  return (
    <>
      <div className="bands">
        {HSL_BANDS.map((x, i) => {
          const m = a.hsl[i];
          return (
            <button key={x.key} className={`band${i === band ? " on" : ""}`} onClick={() => setBand(i)} data-tip={x.label}>
              <span style={{ background: x.color }} />
              {(m.h || m.s || m.l) ? <i className="mod" /> : null}
            </button>
          );
        })}
      </div>
      <Slider label={`${b.label} · 색상`} value={v.h} min={-100} max={100}
        track={`linear-gradient(90deg,hsl(${hue - 30} 90% 55%),hsl(${hue} 90% 55%),hsl(${hue + 30} 90% 55%))`}
        onChange={(x) => setV("h", x)} onCommit={() => commit(`${b.label} 색상`)} />
      <Slider label={`${b.label} · 채도`} value={v.s} min={-100} max={100}
        track={`linear-gradient(90deg,hsl(${hue} 5% 50%),hsl(${hue} 95% 55%))`}
        onChange={(x) => setV("s", x)} onCommit={() => commit(`${b.label} 채도`)} />
      <Slider label={`${b.label} · 밝기`} value={v.l} min={-100} max={100}
        track={`linear-gradient(90deg,hsl(${hue} 60% 18%),hsl(${hue} 85% 50%),hsl(${hue} 90% 85%))`}
        onChange={(x) => setV("l", x)} onCommit={() => commit(`${b.label} 밝기`)} />
    </>
  );
}

function GradeGroup({ label, hueKey, satKey, defHue }: { label: string; hueKey: Key; satKey: Key; defHue: number }) {
  const { a, set, commit } = useAdjust();
  const h = a[hueKey], s = a[satKey];
  return (
    <div className="grade-row mt8">
      <div className="grade-swatch" style={{ background: `hsl(${h} ${s}% ${50 + (100 - s) * 0.2}%)` }} />
      <div style={{ flex: 1 }}>
        <Slider label={`${label} 색상`} value={h} min={0} max={360} def={defHue} track={RAINBOW}
          format={(v) => `${v}°`} onChange={(v) => set(hueKey, v)} onCommit={() => commit(`${label} 색상`)} />
        <Slider label={`${label} 강도`} value={s} min={0} max={100}
          track={`linear-gradient(90deg,#77787e,hsl(${h} 95% 55%))`}
          onChange={(v) => set(satKey, v)} onCommit={() => commit(`${label} 강도`)} />
      </div>
    </div>
  );
}

function CurvesBox() {
  const { a, setDoc, commit, target } = useAdjust();
  const [ch, setCh] = useState<CurveChannel>("master");
  const histo = useHisto((s) => s.h);
  const hist = histo ? (ch === "master" ? histo.l : histo[ch]) : null;
  return (
    <>
      <Segmented
        value={ch}
        onChange={setCh}
        options={[
          { value: "master", label: "RGB" },
          { value: "r", label: <span style={{ color: "#ff7b7b" }}>빨강</span> },
          { value: "g", label: <span style={{ color: "#6fe08a" }}>초록</span> },
          { value: "b", label: <span style={{ color: "#7ea6ff" }}>파랑</span> },
        ]}
      />
      <div className="mt8">
        <CurveEditor
          points={a.curves[ch]}
          color={CURVE_COLORS[ch]}
          histogram={hist}
          onChange={(p) => setDoc((d) => { d.adjust[target].curves[ch] = p; })}
          onCommit={() => commit("곡선")}
        />
      </div>
      <div className="row mt8">
        <span className="hint" style={{ flex: 1 }}>클릭해서 점 추가 · 밖으로 끌어내면 삭제</span>
        <button className="btn sm ghost" onClick={() => {
          setDoc((d) => { d.adjust[target].curves[ch] = defaultCurve(); });
          commit("곡선 초기화");
        }}>
          <RotateCcw size={12} /> 채널 초기화
        </button>
      </div>
    </>
  );
}

function Effects() {
  const fx = useStore((s) => s.doc.effects);
  const setDoc = useStore((s) => s.setDoc);
  const commit = useStore((s) => s.commit);
  const defs: { key: keyof typeof fx; label: string; min: number; tip?: string }[] = [
    { key: "clarity", label: "부분 대비", min: -100, tip: "질감과 입체감 (− 는 뽀샤시)" },
    { key: "sharpen", label: "선명하게", min: 0 },
    { key: "vignette", label: "비네팅", min: -100, tip: "+ 가장자리 어둡게 · − 밝게" },
    { key: "grain", label: "그레인", min: 0, tip: "필름 같은 입자감" },
  ];
  return (
    <>
      {defs.map((d) => (
        <Slider key={d.key} label={d.label} value={fx[d.key]} min={d.min} max={100} tip={d.tip}
          onChange={(v) => setDoc((x) => { x.effects[d.key] = v; })} onCommit={() => commit(d.label)} />
      ))}
    </>
  );
}

export function AdjustPanel() {
  const image = useStore((s) => s.image);
  const target = useStore((s) => s.target);
  const hasMask = useStore((s) => !!s.doc.cutout);
  const adjust = useStore((s) => s.doc.adjust);
  const fx = useStore((s) => s.doc.effects);
  const set = useStore((s) => s.set);
  const change = useStore((s) => s.change);

  useEffect(() => {
    if (!hasMask && target !== "global") set({ target: "global" });
  }, [hasMask, target, set]);

  if (!image) return <div className="empty-note">사진을 열면 색감을 보정할 수 있어요.</div>;

  const a = adjust[target];
  const lightMod = LIGHT.some((d) => a[d.key] !== 0);
  const colorMod = COLOR.some((d) => a[d.key] !== 0);
  const hslMod = a.hsl.some((b) => b.h || b.s || b.l);
  const gradeMod = !!(a.gradeShadowSat || a.gradeMidSat || a.gradeHighSat || a.gradeBalance);
  const curveMod = curvesActive(a.curves);
  const fxMod = !!(fx.clarity || fx.sharpen || fx.vignette || fx.grain);
  const dot = (t: Target) => (!adjustIsIdentity(adjust[t]) || (t === "global" && fxMod) ? " •" : "");

  const resetKeys = (label: string, keys: Key[], extra?: (s: AdjustSet) => void) =>
    change(`${label} 초기화`, (d) => {
      const s = d.adjust[target];
      for (const k of keys) (s[k] as number) = 0;
      extra?.(s);
    });

  return (
    <>
      <div className="pad" style={{ paddingBottom: 0 }}>
        <Segmented
          value={target}
          onChange={(v) => set({ target: v })}
          options={[
            { value: "global", label: `전체${dot("global")}` },
            { value: "subject", label: `피사체${dot("subject")}`, disabled: !hasMask, tip: hasMask ? undefined : "누끼를 딴 뒤 사용할 수 있어요" },
            { value: "background", label: `배경${dot("background")}`, disabled: !hasMask, tip: hasMask ? undefined : "누끼를 딴 뒤 사용할 수 있어요" },
          ]}
        />
        <div className="hint mt8">{TARGET_DESC[target]}</div>
      </div>
      <HistogramView />
      <div className="grid2" style={{ padding: "6px 14px 12px" }}>
        <button className="btn sm" onClick={runAutoAdjust} data-tip="노출·대비·화이트밸런스 자동 보정">
          <Wand2 size={14} /> 자동 보정
        </button>
        <button className="btn sm" onClick={() => resetAdjust(target)} disabled={adjustIsIdentity(a) && (target !== "global" || !fxMod)}>
          <RotateCcw size={13} /> 모두 초기화
        </button>
      </div>

      <Section id="adj.preset" title="필터">
        <PresetGrid />
      </Section>
      <Section id="adj.light" title="빛" modified={lightMod} onReset={lightMod ? () => resetKeys("빛", LIGHT.map((d) => d.key)) : undefined}>
        <SliderList defs={LIGHT} />
      </Section>
      <Section id="adj.color" title="색" modified={colorMod} onReset={colorMod ? () => resetKeys("색", COLOR.map((d) => d.key)) : undefined}>
        <SliderList defs={COLOR} />
      </Section>
      <Section id="adj.hsl" title="컬러 믹서" defaultOpen={false} modified={hslMod}
        onReset={hslMod ? () => resetKeys("컬러 믹서", [], (s) => { s.hsl = s.hsl.map(() => ({ h: 0, s: 0, l: 0 })); }) : undefined}>
        <HslMixer />
      </Section>
      <Section id="adj.grade" title="컬러 그레이딩" defaultOpen={false} modified={gradeMod}
        onReset={gradeMod ? () => resetKeys("컬러 그레이딩", ["gradeShadowSat", "gradeMidSat", "gradeHighSat", "gradeBalance"]) : undefined}>
        <GradeGroup label="섀도" hueKey="gradeShadowHue" satKey="gradeShadowSat" defHue={210} />
        <GradeGroup label="중간톤" hueKey="gradeMidHue" satKey="gradeMidSat" defHue={40} />
        <GradeGroup label="하이라이트" hueKey="gradeHighHue" satKey="gradeHighSat" defHue={40} />
        <div className="mt8">
          <BalanceSlider />
        </div>
      </Section>
      <Section id="adj.curve" title="곡선" defaultOpen={false} modified={curveMod}
        onReset={curveMod ? () => resetKeys("곡선", [], (s) => { s.curves = { master: defaultCurve(), r: defaultCurve(), g: defaultCurve(), b: defaultCurve() }; }) : undefined}>
        <CurvesBox />
      </Section>
      {target === "global" && (
        <Section id="adj.fx" title="효과" modified={fxMod}
          onReset={fxMod ? () => change("효과 초기화", (d) => { d.effects = { clarity: 0, sharpen: 0, vignette: 0, grain: 0 }; }) : undefined}>
          <Effects />
        </Section>
      )}
    </>
  );
}

function BalanceSlider() {
  const { a, set, commit } = useAdjust();
  return (
    <Slider label="균형" value={a.gradeBalance} min={-100} max={100} tip="− 섀도 쪽 · + 하이라이트 쪽"
      onChange={(v) => set("gradeBalance", v)} onCommit={() => commit("그레이딩 균형")} />
  );
}
