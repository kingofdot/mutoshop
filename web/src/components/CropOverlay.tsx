import { useRef, type PointerEvent } from "react";
import { useStore } from "../store";
import { outputSize, type Rect } from "../types";

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLES: { h: Handle; style: React.CSSProperties; cursor: string }[] = [
  { h: "nw", style: { left: -9, top: -9 }, cursor: "nwse-resize" },
  { h: "ne", style: { right: -9, top: -9 }, cursor: "nesw-resize" },
  { h: "sw", style: { left: -9, bottom: -9 }, cursor: "nesw-resize" },
  { h: "se", style: { right: -9, bottom: -9 }, cursor: "nwse-resize" },
  { h: "n", style: { left: "calc(50% - 9px)", top: -9 }, cursor: "ns-resize" },
  { h: "s", style: { left: "calc(50% - 9px)", bottom: -9 }, cursor: "ns-resize" },
  { h: "w", style: { left: -9, top: "calc(50% - 9px)" }, cursor: "ew-resize" },
  { h: "e", style: { right: -9, top: "calc(50% - 9px)" }, cursor: "ew-resize" },
];

/** 비율을 지키며 rect 를 [0,1] 안에 넣는다 (가운데 기준 축소) */
export function fitAspect(r: Rect, aspectNorm: number): Rect {
  let { w, h } = r;
  if (w / h > aspectNorm) w = h * aspectNorm;
  else h = w / aspectNorm;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  let x = cx - w / 2, y = cy - h / 2;
  x = Math.min(1 - w, Math.max(0, x));
  y = Math.min(1 - h, Math.max(0, y));
  return { x, y, w, h };
}

export function CropOverlay() {
  const draft = useStore((s) => s.cropDraft);
  const view = useStore((s) => s.view);
  const dpr = useStore((s) => s.viewport.dpr);
  const image = useStore((s) => s.image);
  const orient = useStore((s) => s.doc.orient);
  const aspect = useStore((s) => s.cropAspect);
  const start = useRef<{ h: Handle; x: number; y: number; r: Rect } | null>(null);

  if (!draft || !image) return null;
  const [W, H] = outputSize(image.w, image.h, orient);
  const left = (view.ox + draft.x * W * view.zoom) / dpr;
  const top = (view.oy + draft.y * H * view.zoom) / dpr;
  const width = (draft.w * W * view.zoom) / dpr;
  const height = (draft.h * H * view.zoom) / dpr;
  // 정규화 좌표에서의 가로/세로 비 (출력 px 비율 → 정규화)
  const aspectNorm = aspect === null ? null : ((aspect === 0 ? W / H : aspect) * H) / W;

  const onDown = (h: Handle) => (e: PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { h, x: e.clientX, y: e.clientY, r: { ...draft } };
  };

  const onMove = (e: PointerEvent) => {
    const st = start.current;
    if (!st) return;
    const du = ((e.clientX - st.x) * dpr) / view.zoom / W;
    const dv = ((e.clientY - st.y) * dpr) / view.zoom / H;
    const r0 = st.r;
    const minW = Math.max(16 / W, 0.01), minH = Math.max(16 / H, 0.01);
    let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.w, y1 = r0.y + r0.h;
    if (st.h === "move") {
      const nx = Math.min(1 - r0.w, Math.max(0, r0.x + du));
      const ny = Math.min(1 - r0.h, Math.max(0, r0.y + dv));
      useStore.getState().set({ cropDraft: { ...r0, x: nx, y: ny } });
      return;
    }
    if (st.h.includes("w")) x0 = Math.min(x1 - minW, Math.max(0, r0.x + du));
    if (st.h.includes("e")) x1 = Math.max(x0 + minW, Math.min(1, r0.x + r0.w + du));
    if (st.h.includes("n")) y0 = Math.min(y1 - minH, Math.max(0, r0.y + dv));
    if (st.h.includes("s")) y1 = Math.max(y0 + minH, Math.min(1, r0.y + r0.h + dv));
    let r: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (aspectNorm) {
      const horiz = st.h === "e" || st.h === "w";
      const vert = st.h === "n" || st.h === "s";
      let w = r.w, h = r.h;
      if (horiz) h = w / aspectNorm;
      else if (vert) w = h * aspectNorm;
      else if (Math.abs(du) * W > Math.abs(dv) * H) h = w / aspectNorm;
      else w = h * aspectNorm;
      // 고정점(반대쪽 변/모서리)을 기준으로 다시 배치
      const ax = st.h.includes("w") ? r0.x + r0.w : st.h.includes("e") ? r0.x : r0.x + r0.w / 2;
      const ay = st.h.includes("n") ? r0.y + r0.h : st.h.includes("s") ? r0.y : r0.y + r0.h / 2;
      // 이미지 밖으로 나가면 축소
      const maxW = st.h.includes("w") ? ax : st.h.includes("e") ? 1 - ax : 2 * Math.min(ax, 1 - ax);
      const maxH = st.h.includes("n") ? ay : st.h.includes("s") ? 1 - ay : 2 * Math.min(ay, 1 - ay);
      const k = Math.min(1, maxW / w, maxH / h);
      w *= k;
      h *= k;
      const nx = st.h.includes("w") ? ax - w : st.h.includes("e") ? ax : ax - w / 2;
      const ny = st.h.includes("n") ? ay - h : st.h.includes("s") ? ay : ay - h / 2;
      r = { x: nx, y: ny, w, h };
    }
    useStore.getState().set({ cropDraft: r });
  };

  const onUp = () => {
    start.current = null;
  };

  return (
    <div
      className="crop-frame"
      style={{ left, top, width, height }}
      onPointerDown={onDown("move")}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <div className="crop-grid" />
      {HANDLES.map(({ h, style, cursor }) => (
        <div
          key={h}
          className="crop-h"
          style={{ ...style, cursor }}
          onPointerDown={onDown(h)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      ))}
      <div className="crop-size">
        {Math.round(draft.w * W)} × {Math.round(draft.h * H)}
      </div>
    </div>
  );
}
