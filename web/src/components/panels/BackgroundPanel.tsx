import { useEffect, useState } from "react";
import { Droplet, Image as ImageIcon, ImagePlus, Pipette, Sparkles } from "lucide-react";
import { chooseBackgroundImage, runCutout } from "../../actions";
import { resources } from "../../resources";
import { useStore } from "../../store";
import type { BgMode } from "../../types";
import { ColorField, Section, Segmented, Slider, Toggle } from "../controls";

const SWATCHES = [
  "#ffffff", "#f4f4f5", "#e4e4e7", "#a1a1aa", "#3f3f46", "#18181b", "#000000", "#f5ebe0",
  "#ffe4e6", "#fde68a", "#d9f99d", "#bbf7d0", "#bae6fd", "#c7d2fe", "#e9d5ff", "#fbcfe8",
];

const MODES: { mode: BgMode; label: string }[] = [
  { mode: "original", label: "원본" },
  { mode: "transparent", label: "투명" },
  { mode: "color", label: "단색" },
  { mode: "blur", label: "흐림" },
  { mode: "image", label: "이미지" },
];

const MODE_HINT: Record<BgMode, string> = {
  original: "원래 배경을 유지해요. ‘색감’ 탭에서 피사체와 배경을 따로 보정할 수 있어요.",
  transparent: "PNG·WEBP로 내보내면 투명 배경이 그대로 유지돼요.",
  color: "",
  blur: "배경만 흐리게 해서 인물 사진 모드처럼 피사체를 돋보이게 해요.",
  image: "",
};

function bgThumb(id: string | null): string | null {
  if (!id) return null;
  const b = resources.bgImages.get(id);
  if (!b) return null;
  const cv = document.createElement("canvas");
  const s = 320 / Math.max(b.width, b.height);
  cv.width = Math.round(b.width * s);
  cv.height = Math.round(b.height * s);
  cv.getContext("2d")!.drawImage(b, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", 0.85);
}

export function BackgroundPanel() {
  const image = useStore((s) => s.image);
  const hasMask = useStore((s) => !!s.doc.cutout);
  const bg = useStore((s) => s.doc.bg);
  const sh = useStore((s) => s.doc.shadow);
  const job = useStore((s) => s.job);
  const setDoc = useStore((s) => s.setDoc);
  const commit = useStore((s) => s.commit);
  const change = useStore((s) => s.change);
  const setTool = useStore((s) => s.setTool);
  const set = useStore((s) => s.set);
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => setThumb(bgThumb(bg.imageId)), [bg.imageId]);

  if (!image) return <div className="empty-note">사진을 열면 배경을 바꿀 수 있어요.</div>;
  if (!hasMask) {
    return (
      <div className="empty-note">
        배경을 바꾸려면 먼저 피사체를 분리해야 해요.
        <button className="btn magic mt12" disabled={!!job} onClick={() => { set({ panel: "cutout" }); runCutout(); }}>
          <Sparkles size={17} /> 자동 누끼 따기
        </button>
      </div>
    );
  }

  const setMode = (m: BgMode) => {
    if (m === "image" && !bg.imageId) {
      chooseBackgroundImage();
      return;
    }
    change(`배경: ${MODES.find((x) => x.mode === m)!.label}`, (d) => { d.bg.mode = m; });
  };

  const preview = (m: BgMode) => {
    switch (m) {
      case "original":
        return <ImageIcon size={18} />;
      case "transparent":
        return <div className="checker" style={{ width: "100%", height: "100%" }} />;
      case "color":
        return <div style={{ width: "100%", height: "100%", background: bg.color }} />;
      case "blur":
        return <Droplet size={18} />;
      case "image":
        return thumb ? <img src={thumb} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <ImagePlus size={18} />;
    }
  };

  return (
    <>
      <div className="pad">
        <div className="bg-grid">
          {MODES.map(({ mode, label }) => (
            <button key={mode} className={`bg-opt${bg.mode === mode ? " on" : ""}`} onClick={() => setMode(mode)}>
              <span className="sw">{preview(mode)}</span>
              {label}
            </button>
          ))}
        </div>
        {MODE_HINT[bg.mode] && <div className="hint mt12">{MODE_HINT[bg.mode]}</div>}

        {bg.mode === "color" && (
          <div className="mt12">
            <div className="swatches">
              {SWATCHES.map((c) => (
                <button key={c} className={`swatch${bg.color === c ? " on" : ""}`} style={{ background: c }}
                  data-tip={c.toUpperCase()} onClick={() => change("배경색", (d) => { d.bg.color = c; })} />
              ))}
            </div>
            <div className="row mt12">
              <div style={{ flex: 1 }}>
                <ColorField value={bg.color} onChange={(v) => setDoc((d) => { d.bg.color = v; })} onCommit={() => commit("배경색")} />
              </div>
              <button className="btn icon" data-tip="사진에서 색 고르기 (I)" onClick={() => setTool("eyedropper")}>
                <Pipette size={15} />
              </button>
            </div>
          </div>
        )}

        {bg.mode === "blur" && (
          <div className="mt12">
            <Slider label="흐림 강도" value={bg.blur} min={1} max={100} def={40}
              onChange={(v) => setDoc((d) => { d.bg.blur = v; })} onCommit={() => commit("배경 흐림")} />
          </div>
        )}

        {bg.mode === "image" && (
          <div className="mt12 col">
            {thumb && <img className="bgimg-thumb" src={thumb} alt="" />}
            <div className="row">
              <div style={{ flex: 1 }}>
                <Segmented value={bg.fit} onChange={(v) => change("배경 맞춤", (d) => { d.bg.fit = v; })}
                  options={[{ value: "cover", label: "꽉 채우기" }, { value: "contain", label: "전체 보이기" }]} />
              </div>
              <button className="btn" onClick={chooseBackgroundImage}>
                <ImagePlus size={14} /> 바꾸기
              </button>
            </div>
          </div>
        )}
      </div>

      <Section id="bg.shadow" title="그림자" modified={sh.enabled}>
        <Toggle
          on={sh.enabled}
          onChange={(v) => change(v ? "그림자 켜기" : "그림자 끄기", (d) => { d.shadow.enabled = v; })}
          label="그림자 넣기"
          desc="제품 사진을 바닥에 놓인 것처럼 자연스럽게 보이게 해요."
        />
        {sh.enabled && bg.mode === "transparent" && (
          <div className="hint mt8">투명 배경에서는 그림자도 반투명으로 함께 저장돼요.</div>
        )}
        {sh.enabled && (
          <div className="mt12">
            <Slider label="진하기" value={sh.opacity} min={0} max={100} def={35} format={(v) => `${v}%`}
              onChange={(v) => setDoc((d) => { d.shadow.opacity = v; })} onCommit={() => commit("그림자 진하기")} />
            <Slider label="흐림" value={sh.blur} min={0} max={100} def={30}
              onChange={(v) => setDoc((d) => { d.shadow.blur = v; })} onCommit={() => commit("그림자 흐림")} />
            <Slider label="가로 위치" value={sh.x} min={-100} max={100} def={0}
              onChange={(v) => setDoc((d) => { d.shadow.x = v; })} onCommit={() => commit("그림자 위치")} />
            <Slider label="세로 위치" value={sh.y} min={-100} max={100} def={12}
              onChange={(v) => setDoc((d) => { d.shadow.y = v; })} onCommit={() => commit("그림자 위치")} />
            <div className="field-label mt8">색</div>
            <div className="row">
              {["#000000", "#3b2a1e", "#1e2a3b"].map((c) => (
                <button key={c} className={`swatch${sh.color === c ? " on" : ""}`} style={{ background: c, width: 28 }}
                  onClick={() => change("그림자 색", (d) => { d.shadow.color = c; })} />
              ))}
              <div style={{ flex: 1 }}>
                <ColorField value={sh.color} onChange={(v) => setDoc((d) => { d.shadow.color = v; })} onCommit={() => commit("그림자 색")} />
              </div>
            </div>
          </div>
        )}
      </Section>

      <OutlineSection />
    </>
  );
}

const GRADIENT_PRESETS: { label: string; c1: string; a1: number; c2: string; a2: number }[] = [
  { label: "검정 → 투명", c1: "#000000", a1: 100, c2: "#000000", a2: 0 },
  { label: "검정 → 흰색", c1: "#000000", a1: 100, c2: "#ffffff", a2: 100 },
  { label: "흰색 → 투명", c1: "#ffffff", a1: 100, c2: "#ffffff", a2: 0 },
  { label: "흰색 → 검정", c1: "#ffffff", a1: 100, c2: "#000000", a2: 100 },
];

function rgba(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha / 100})`;
}

/** 테두리(외곽선): 포토샵 레이어 스타일의 '획'. 그라디언트는 윤곽을 따라 바깥 → 안쪽으로 */
function OutlineSection() {
  const ol = useStore((s) => s.doc.outline);
  const image = useStore((s) => s.image);
  const setDoc = useStore((s) => s.setDoc);
  const commit = useStore((s) => s.commit);
  const change = useStore((s) => s.change);
  const long = image ? Math.max(image.w, image.h) : 2000;
  const maxW = Math.max(60, Math.round(long / 8));
  const grad = ol.fill === "gradient";

  const enable = (v: boolean) =>
    change(v ? "테두리 켜기" : "테두리 끄기", (d) => {
      d.outline.enabled = v;
      // 처음 켤 때 사진 크기에 맞는 두께로
      if (v && d.outline.width === 16) d.outline.width = Math.round(Math.min(60, Math.max(4, long * 0.006)));
    });

  return (
    <Section id="bg.outline" title="테두리" modified={ol.enabled}>
      <Toggle
        on={ol.enabled}
        onChange={enable}
        label="테두리 넣기"
        desc="피사체 둘레에 외곽선을 입혀요. 그라디언트로 하면 가장 바깥에서 안쪽으로 색이 바뀝니다."
      />
      {ol.enabled && (
        <div className="mt12">
          <div className="field-label">위치</div>
          <Segmented
            value={ol.position}
            onChange={(v) => change("테두리 위치", (d) => { d.outline.position = v; })}
            options={[
              { value: "outside", label: "바깥", tip: "피사체 바깥으로" },
              { value: "center", label: "가운데", tip: "윤곽선 기준 양쪽으로" },
              { value: "inside", label: "안쪽", tip: "피사체 안쪽으로 (크기 변화 없음)" },
            ]}
          />
          <div className="mt8">
            <Slider label="두께" value={ol.width} min={1} max={maxW} def={Math.round(Math.min(60, Math.max(4, long * 0.006)))}
              format={(v) => `${v}px`} onChange={(v) => setDoc((d) => { d.outline.width = v; })} onCommit={() => commit("테두리 두께")} />
            <Slider label="부드럽게" value={ol.soft} min={0} max={30} step={0.5} def={0} format={(v) => `${v}px`}
              tip="테두리 가장자리를 흐리게" onChange={(v) => setDoc((d) => { d.outline.soft = v; })} onCommit={() => commit("테두리 부드럽게")} />
            <Slider label="불투명도" value={ol.opacity} min={0} max={100} def={100} format={(v) => `${v}%`}
              onChange={(v) => setDoc((d) => { d.outline.opacity = v; })} onCommit={() => commit("테두리 불투명도")} />
          </div>

          <div className="field-label mt8">채우기</div>
          <Segmented
            value={ol.fill}
            onChange={(v) => change("테두리 채우기", (d) => { d.outline.fill = v; })}
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
                  <button key={p.label} className="chip" onClick={() => change(`테두리: ${p.label}`, (d) => {
                    Object.assign(d.outline, { color: p.c1, alpha1: p.a1, color2: p.c2, alpha2: p.a2, fill: "gradient" });
                  })}>{p.label}</button>
                ))}
              </div>
            </>
          )}

          <div className="field-label mt12">{grad ? "가장 바깥 색" : "색"}</div>
          <ColorField value={ol.color} onChange={(v) => setDoc((d) => { d.outline.color = v; })} onCommit={() => commit("테두리 색")} />
          {grad && (
            <>
              <Slider label="바깥 불투명도" value={ol.alpha1} min={0} max={100} def={100} format={(v) => `${v}%`}
                onChange={(v) => setDoc((d) => { d.outline.alpha1 = v; })} onCommit={() => commit("테두리 바깥 불투명도")} />
              <div className="field-label mt8">가장 안쪽 색</div>
              <ColorField value={ol.color2} onChange={(v) => setDoc((d) => { d.outline.color2 = v; })} onCommit={() => commit("테두리 안쪽 색")} />
              <Slider label="안쪽 불투명도" value={ol.alpha2} min={0} max={100} def={0} format={(v) => `${v}%`}
                onChange={(v) => setDoc((d) => { d.outline.alpha2 = v; })} onCommit={() => commit("테두리 안쪽 불투명도")} />
            </>
          )}
          {ol.position === "outside" && ol.width > long / 40 && (
            <div className="hint mt8">가는 가지·털이 많은 피사체는 바깥 테두리가 두꺼우면 틈이 메워져요. 그럴 땐 두께를 줄이거나 ‘안쪽’을 써 보세요.</div>
          )}
        </div>
      )}
    </Section>
  );
}

