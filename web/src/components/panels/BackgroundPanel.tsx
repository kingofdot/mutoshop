import { useEffect, useState } from "react";
import { Droplet, Image as ImageIcon, ImagePlus, Pipette, Sparkles } from "lucide-react";
import { chooseBackgroundImage, runCutout } from "../../actions";
import { KIND } from "../../kinds";
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
  const kind = useStore((s) => s.kind);
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
          <Sparkles size={17} /> {KIND[kind].label} 누끼 따기
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
    </>
  );
}
