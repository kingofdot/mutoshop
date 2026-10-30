import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { create } from "zustand";
import { ImagePlus, MoveHorizontal, X } from "lucide-react";
import { Renderer, type DisplayState } from "../gl/renderer";
import {
  cancelCutout,
  getRenderer,
  openFromPicker,
  sampleSourceColor,
  pickBackground,
  screenToSource,
  setRenderer,
} from "../actions";
import { KIND } from "../kinds";
import { cancelDrafts, toolDoubleClick, toolDown, toolMove, toolUp } from "../selectTools";
import { getSelection } from "../selection";
import { useStore, viewImageOffset, viewImageSize, type State, type Tool } from "../store";
import { outputSize, type Stroke } from "../types";
import { ToolOverlay } from "./ToolOverlay";
import { useHisto } from "./controls/HistogramView";
import { CropOverlay } from "./CropOverlay";
import { useSmoothProgress } from "./useSmoothProgress";

const SEL_TOOLS = new Set<Tool>(["marquee", "lasso", "wand", "pen", "colorrange"]);

/** 스페이스바(임시 손 도구) 상태 */
export const useKeys = create<{ space: boolean }>(() => ({ space: false }));

const MODE_INDEX = { normal: 0, overlay: 1, mask: 2, black: 3, white: 4 } as const;
const MODE_LABEL = { overlay: "오버레이 보기 · 빨간 부분이 지워진 영역", mask: "마스크 보기", black: "검정 배경에서 확인", white: "흰 배경에서 확인" } as const;

function displayState(s: State): DisplayState {
  const vs = viewImageSize(s) ?? [1, 1];
  const vo = viewImageOffset(s);
  let shade: DisplayState["shade"] = null;
  if (s.tool === "crop" && s.cropDraft && s.image) {
    const [W, H] = outputSize(s.image.w, s.image.h, s.doc.orient);
    const c = s.cropDraft;
    shade = [c.x * W, c.y * H, c.w * W, c.h * H];
  }
  return {
    canvasW: Math.max(1, Math.round(s.viewport.w)),
    canvasH: Math.max(1, Math.round(s.viewport.h)),
    dpr: s.viewport.dpr,
    zoom: s.view.zoom,
    ox: s.view.ox,
    oy: s.view.oy,
    viewRect: [vo[0], vo[1], vs[0], vs[1]],
    mode: s.compare ? 5 : MODE_INDEX[s.viewMode],
    split: s.split !== null && !s.compare ? s.split * s.viewport.w : -1,
    shade,
  };
}

type Drag =
  | { kind: "pan"; x: number; y: number; ox: number; oy: number }
  | { kind: "paint"; stroke: Stroke }
  | { kind: "resize"; x: number; y: number; size: number; hard: number }
  | { kind: "split" }
  | { kind: "tool" };

export function Viewport() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);

  const image = useStore((s) => s.image);
  const tool = useStore((s) => s.tool);
  const brush = useStore((s) => s.brush);
  const zoom = useStore((s) => s.view.zoom);
  const dpr = useStore((s) => s.viewport.dpr);
  const viewMode = useStore((s) => s.viewMode);
  const compare = useStore((s) => s.compare);
  const split = useStore((s) => s.split);
  const hasMask = useStore((s) => !!s.doc.cutout);
  const busy = useStore((s) => s.busy);
  const job = useStore((s) => s.job);
  const kind = useStore((s) => s.kind);
  const space = useKeys((s) => s.space);
  const prog = useSmoothProgress(job);
  const hasSel = useStore((s) => !!s.sel.box);

  // 렌더러 생성 + 상태 구독
  useEffect(() => {
    let r: Renderer;
    try {
      r = new Renderer(canvas.current!);
    } catch (e) {
      setGlError((e as Error).message);
      return;
    }
    setRenderer(r);
    let histTimer = 0;
    r.onComposite = () => {
      clearTimeout(histTimer);
      histTimer = window.setTimeout(() => {
        useHisto.setState({ h: r.readHistogram(useStore.getState().doc.crop) });
      }, 120);
    };
    r.onLost = () => setGlError("그래픽 장치가 초기화되었습니다. 창을 새로고침(F5) 해 주세요. (편집 내용은 유지되지 않습니다)");
    const st = useStore.getState();
    r.sync(st.image ? st.doc : null);
    r.setView(displayState(st));
    r.setSelection(getSelection(), st.sel.version);
    const unsub = useStore.subscribe((s, p) => {
      if (s.doc !== p.doc || s.image !== p.image) r.sync(s.image ? s.doc : null);
      if (s.sel !== p.sel) r.setSelection(getSelection(), s.sel.version);
      if (s.tool !== p.tool) cancelDrafts();
      if (
        s.view !== p.view || s.viewport !== p.viewport || s.viewMode !== p.viewMode || s.compare !== p.compare ||
        s.split !== p.split || s.tool !== p.tool || s.cropDraft !== p.cropDraft || s.doc.crop !== p.doc.crop ||
        s.doc.orient !== p.doc.orient || s.image !== p.image
      ) r.setView(displayState(s));
    });
    return () => {
      unsub();
      clearTimeout(histTimer);
      setRenderer(null);
      r.dispose();
    };
  }, []);

  // 선택 영역 테두리(움직이는 점선) 애니메이션
  useEffect(() => {
    if (!hasSel) return;
    let t = 0;
    // 1px 씩 (8px 주기) 밀어서 점선이 테두리를 따라 도는 것처럼 — 예전처럼 한 번에 뒤집혀 깜빡이지 않게
    const id = window.setInterval(() => getRenderer()?.setTime((t = (t + 1) % 8)), 60);
    return () => clearInterval(id);
  }, [hasSel]);

  // 크기 변화 추적
  useEffect(() => {
    const el = wrap.current!;
    let first = true;
    const ro = new ResizeObserver(() => {
      const d = window.devicePixelRatio || 1;
      const s = useStore.getState();
      const nw = el.clientWidth * d, nh = el.clientHeight * d;
      // 창 크기가 바뀌어도 화면 중앙이 유지되도록 이동
      const { w: pw, h: ph } = s.viewport;
      s.set({
        viewport: { w: nw, h: nh, dpr: d },
        view: first ? s.view : { ...s.view, ox: s.view.ox + (nw - pw) / 2, oy: s.view.oy + (nh - ph) / 2 },
      });
      if (first && s.image) s.fitView();
      first = false;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 휠 = 커서 위치 기준 확대/축소 (passive 해제 위해 직접 등록)
  useEffect(() => {
    const el = wrap.current!;
    const onWheel = (e: WheelEvent) => {
      const s = useStore.getState();
      if (!s.image) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const d = s.viewport.dpr;
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      if (e.shiftKey && !e.ctrlKey) {
        s.set({ view: { ...s.view, ox: s.view.ox - delta * d } });
        return;
      }
      const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0018));
      s.zoomAt(s.view.zoom * factor, (e.clientX - r.left) * d, (e.clientY - r.top) * d);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const pressure = (e: RPointerEvent | PointerEvent) =>
    e.pointerType === "pen" ? Math.max(0.05, e.pressure || 0.5) : 1;

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    const s = useStore.getState();
    if (!s.image) return;
    wrap.current!.focus();
    const p = local(e);
    const panTool = e.button === 1 || useKeys.getState().space || (e.button === 0 && (s.tool === "hand" || s.tool === "crop"));
    if (panTool) {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { kind: "pan", x: e.clientX, y: e.clientY, ox: s.view.ox, oy: s.view.oy };
      setDragging(true);
      return;
    }
    if (SEL_TOOLS.has(s.tool)) {
      if (e.button === 0 && toolDown(e, p.x, p.y)) {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { kind: "tool" };
      }
      return;
    }
    if (s.tool === "brush" && e.button === 2 && e.altKey) {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { kind: "resize", x: e.clientX, y: e.clientY, size: s.brush.size, hard: s.brush.hardness };
      return;
    }
    if (e.button !== 0) return;
    if (s.tool === "zoom") {
      const d = s.viewport.dpr;
      s.zoomAt(s.view.zoom * (e.altKey ? 1 / 1.6 : 1.6), p.x * d, p.y * d);
      return;
    }
    if (s.tool === "eyedropper") {
      const c = sampleSourceColor(p.x, p.y);
      if (c && s.eyedropperTarget === "matte") {
        s.change("원래 배경색 지정", (d) => {
          d.edge.deconMode = "matte";
          d.edge.matteSource = "color";
          d.edge.matteColor = c;
        });
        s.toast(`원래 배경색을 ${c.toUpperCase()}(으)로 정했어요.`, "success");
        s.set({ eyedropperTarget: "bg" });
        s.setTool(s.prevTool === "eyedropper" ? "hand" : s.prevTool);
        return;
      }
      if (c) {
        s.change("배경색 스포이드", (d) => {
          d.bg.color = c;
          if (d.cutout) d.bg.mode = "color";
        });
        s.toast(`배경색을 ${c.toUpperCase()}(으)로 정했어요.`, "success");
        s.setTool(s.prevTool === "eyedropper" ? "hand" : s.prevTool);
      }
      return;
    }
    if (s.tool === "bgpick") {
      const sp = screenToSource(p.x, p.y);
      if (sp) pickBackground(sp[0], sp[1]);
      return;
    }
    if (s.tool === "brush") {
      if (!s.doc.cutout) {
        s.toast("먼저 오른쪽 누끼 탭에서 '누끼 따기'를 눌러 주세요.", "info", 4000);
        return;
      }
      const sp = screenToSource(p.x, p.y);
      const renderer = getRenderer();
      if (!sp || !renderer) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const b = s.brush;
      const stroke: Stroke = {
        mode: b.mode, size: b.size, hardness: b.hardness, opacity: b.opacity,
        auto: b.auto, tolerance: b.tolerance, pts: [sp[0], sp[1], pressure(e)],
      };
      drag.current = { kind: "paint", stroke };
      renderer.beginStroke(stroke);
    }
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = local(e);
    setCursor(p);
    const s = useStore.getState();
    if (s.image) {
      const sp = screenToSource(p.x, p.y);
      s.set({ cursor: sp ? { x: Math.floor(sp[0]), y: Math.floor(sp[1]) } : null });
    }
    const dg = drag.current;
    if (SEL_TOOLS.has(s.tool) && (!dg || dg.kind === "tool")) {
      toolMove(e, p.x, p.y, dg?.kind === "tool");
      return;
    }
    if (!dg) return;
    if (dg.kind === "pan") {
      const d = s.viewport.dpr;
      s.set({ view: { ...s.view, ox: dg.ox + (e.clientX - dg.x) * d, oy: dg.oy + (e.clientY - dg.y) * d } });
    } else if (dg.kind === "paint") {
      const evs = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
      for (const ev of evs.length ? evs : [e.nativeEvent]) {
        const q = local(ev);
        const sp = screenToSource(q.x, q.y);
        if (sp) dg.stroke.pts.push(sp[0], sp[1], pressure(ev));
      }
      getRenderer()?.extendStroke();
    } else if (dg.kind === "resize") {
      const dx = e.clientX - dg.x, dy = e.clientY - dg.y;
      s.setBrush({
        size: Math.round(Math.min(2000, Math.max(2, dg.size * Math.exp(dx * 0.01)))),
        hardness: Math.round(Math.min(100, Math.max(0, dg.hard - dy * 0.5))),
      });
    } else if (dg.kind === "split") {
      const r = wrap.current!.getBoundingClientRect();
      s.set({ split: Math.min(0.98, Math.max(0.02, (e.clientX - r.left) / r.width)) });
    }
  };

  const endDrag = () => {
    const dg = drag.current;
    drag.current = null;
    setDragging(false);
    if (dg?.kind === "tool") toolUp();
    if (dg?.kind === "paint") {
      getRenderer()?.endStroke();
      useStore.getState().change(dg.stroke.mode === "add" ? "브러시: 복원" : "브러시: 지우기", (d) => {
        d.strokes.push(dg.stroke);
      });
    }
  };

  const onDoubleClick = () => {
    const s = useStore.getState();
    if (s.tool === "hand") s.fitView();
    if (s.tool === "lasso") toolDoubleClick();
  };

  // 커서 모양
  let cssCursor = "default";
  if (image) {
    if (space || tool === "hand") cssCursor = dragging ? "grabbing" : "grab";
    else if (tool === "zoom") cssCursor = "zoom-in";
    else if (tool === "eyedropper" || tool === "bgpick" || SEL_TOOLS.has(tool)) cssCursor = "crosshair";
    else if (tool === "brush") cssCursor = hasMask ? "none" : "not-allowed";
  }

  const brushPx = (brush.size * zoom) / dpr;
  const showBrush = image && tool === "brush" && hasMask && cursor && !space && !dragging;
  // 마술봉·색 범위: 선택이 있으면 끌어서 문지를 붓 크기를 보여 준다
  const showSelBrush = image && (tool === "wand" || tool === "colorrange") && hasSel && cursor && !space && brushPx >= 6;
  const badge = compare ? "원본 보기 (보정 전)" : hasMask && viewMode !== "normal" ? MODE_LABEL[viewMode] : null;

  return (
    <div
      ref={wrap}
      className="viewport"
      tabIndex={-1}
      style={{ cursor: cssCursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => setCursor(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvas} />

      {!image && !glError && (
        <div className="drop-hero">
          <div className="drop-card" onClick={openFromPicker}>
            <div className="ico">
              <ImagePlus size={30} color="#fff" />
            </div>
            <h2>사진을 끌어다 놓으세요</h2>
            <p>
              또는 클릭해서 파일 선택 · <b>Ctrl+V</b>로 붙여넣기
            </p>
            <div className="drop-steps">
              <span><i>1</i>사진 열기</span>
              <span><i>2</i>누끼 따기 · 색감 보정</span>
              <span><i>3</i>내보내기</span>
            </div>
            <div className="formats">JPG · PNG · WEBP · HEIC · BMP · GIF 지원</div>
          </div>
        </div>
      )}

      {glError && (
        <div className="drop-hero">
          <div className="empty-note" style={{ maxWidth: 460 }}>
            <b>화면을 그릴 수 없습니다</b>
            <div className="mt8">{glError}</div>
          </div>
        </div>
      )}

      {image && <ToolOverlay />}
      {tool === "crop" && image && <CropOverlay />}

      {showBrush && (
        brushPx >= 6 ? (
          <div className="brush-cursor" style={{ left: cursor!.x, top: cursor!.y, width: brushPx, height: brushPx }}>
            {brush.hardness < 95 && brushPx > 24 && (
              <div className="inner" style={{ width: (brushPx * brush.hardness) / 100, height: (brushPx * brush.hardness) / 100 }} />
            )}
            <span className="sign">{brush.mode === "add" ? "+" : "−"}</span>
          </div>
        ) : (
          <div className="brush-cursor" style={{ left: cursor!.x, top: cursor!.y, width: 9, height: 9 }} />
        )
      )}

      {showSelBrush && <div className="brush-cursor sel" style={{ left: cursor!.x, top: cursor!.y, width: brushPx, height: brushPx }} />}

      {split !== null && !compare && image && (
        <>
          <div
            className="split-handle"
            style={{ left: `${split * 100}%` }}
            onPointerDown={(e) => {
              e.stopPropagation();
              wrap.current!.setPointerCapture(e.pointerId);
              drag.current = { kind: "split" };
            }}
          >
            <div className="knob">
              <MoveHorizontal size={16} />
            </div>
          </div>
          <div className="split-label" style={{ right: `calc(${(1 - split) * 100}% + 12px)` }}>원본</div>
          <div className="split-label" style={{ left: `calc(${split * 100}% + 12px)` }}>보정 후</div>
        </>
      )}

      {badge && <div className="view-badge">{badge}</div>}

      {job && (
        <div style={{ position: "absolute", left: "50%", bottom: 20, transform: "translateX(-50%)", zIndex: 6 }}>
          <div className="busy-card" style={{ minWidth: 340 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ fontWeight: 650, flex: 1 }}>{KIND[kind].label} 누끼 따는 중</span>
              <span className="muted small" style={{ fontVariantNumeric: "tabular-nums" }}>
                {Math.round(prog * 100)}%
              </span>
              <button className="iconbtn" style={{ width: 26, height: 26 }} onClick={cancelCutout} data-tip="취소">
                <X size={15} />
              </button>
            </div>
            <div className={`progress${prog < 0.02 ? " indeterminate" : ""}`}>
              <div style={{ width: `${Math.max(3, prog * 100)}%` }} />
            </div>
            <div className="hint mt8">{job.message}</div>
          </div>
        </div>
      )}

      {busy && (
        <div className="busy-veil">
          <div className="busy-card">
            <div style={{ fontWeight: 600, marginBottom: 10 }}>{busy}</div>
            <div className="progress indeterminate">
              <div />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
