import {
  Brush, CircleDashed, Crop, Droplets, Eraser, Hand, Lasso, LassoSelect, MousePointerClick, PenTool, Pipette, SquareDashed, Wand, ZoomIn,
} from "lucide-react";
import type { ReactNode } from "react";
import { useStore, type Tool } from "../store";

function ToolBtn({ active, tip, onClick, children, disabled }: {
  active: boolean; tip: string; onClick: () => void; children: ReactNode; disabled?: boolean;
}) {
  return (
    <button className={`tool${active ? " active" : ""}`} data-tip={tip} data-tip-pos="right" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const mode = useStore((s) => s.brush.mode);
  const marqueeShape = useStore((s) => s.marqueeShape);
  const lassoMode = useStore((s) => s.lassoMode);
  const image = useStore((s) => s.image);
  const setTool = useStore((s) => s.setTool);
  const setBrush = useStore((s) => s.setBrush);
  const set = useStore((s) => s.set);
  const brush = (m: "add" | "sub") => {
    setBrush({ mode: m });
    setTool("brush");
  };
  // 같은 도구를 다시 누르면 변형 전환 (포토샵의 Shift+단축키와 같은 역할)
  const pick = (t: Tool, toggle?: () => void) => {
    if (tool === t && toggle) toggle();
    else setTool(t);
  };
  const off = !image;
  return (
    <div className="toolbar">
      <ToolBtn active={tool === "hand"} tip="손 도구 (H)" onClick={() => setTool("hand")} disabled={off}><Hand size={19} /></ToolBtn>
      <ToolBtn active={tool === "zoom"} tip="돋보기 (Z)" onClick={() => setTool("zoom")} disabled={off}><ZoomIn size={19} /></ToolBtn>
      <div className="tool-sep" />
      <ToolBtn
        active={tool === "marquee"}
        tip={`선택 윤곽 — ${marqueeShape === "rect" ? "사각형" : "원형"} (M · 다시 누르면 전환)`}
        onClick={() => pick("marquee", () => set({ marqueeShape: marqueeShape === "rect" ? "ellipse" : "rect" }))}
        disabled={off}
      >
        {marqueeShape === "rect" ? <SquareDashed size={19} /> : <CircleDashed size={19} />}
      </ToolBtn>
      <ToolBtn
        active={tool === "lasso"}
        tip={`올가미 — ${lassoMode === "free" ? "자유" : "다각형"} (L · 다시 누르면 전환)`}
        onClick={() => pick("lasso", () => set({ lassoMode: lassoMode === "free" ? "poly" : "free" }))}
        disabled={off}
      >
        {lassoMode === "free" ? <Lasso size={19} /> : <LassoSelect size={19} />}
      </ToolBtn>
      <ToolBtn active={tool === "wand"} tip="자동 선택 · 마술봉 (W)" onClick={() => setTool("wand")} disabled={off}><Wand size={19} /></ToolBtn>
      <ToolBtn active={tool === "colorrange"} tip="색 범위 — 클릭한 색과 비슷한 곳을 사진 전체에서 선택 → Delete 로 지우기 (C)"
        onClick={() => setTool("colorrange")} disabled={off}><Droplets size={19} /></ToolBtn>
      <ToolBtn active={tool === "pen"} tip="펜 도구 (P)" onClick={() => setTool("pen")} disabled={off}><PenTool size={19} /></ToolBtn>
      <ToolBtn active={tool === "bgpick"} tip="배경 찍기 — 클릭한 배경만 지우기 (G)" onClick={() => setTool("bgpick")} disabled={off}>
        <MousePointerClick size={19} />
      </ToolBtn>
      <div className="tool-sep" />
      <ToolBtn active={tool === "brush" && mode === "add"} tip="복원 브러시 (B)" onClick={() => brush("add")} disabled={off}>
        <Brush size={19} />
        <span className="badge">+</span>
      </ToolBtn>
      <ToolBtn active={tool === "brush" && mode === "sub"} tip="지우기 브러시 (E)" onClick={() => brush("sub")} disabled={off}>
        <Eraser size={19} />
        <span className="badge">−</span>
      </ToolBtn>
      <div className="tool-sep" />
      <ToolBtn active={tool === "crop"} tip="자르기 · 회전 (Shift+C)" onClick={() => setTool("crop")} disabled={off}><Crop size={19} /></ToolBtn>
      <ToolBtn active={tool === "eyedropper"} tip="스포이드 — 배경색 고르기 (I)" onClick={() => setTool("eyedropper")} disabled={off}><Pipette size={19} /></ToolBtn>
    </div>
  );
}
