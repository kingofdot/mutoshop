import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { Histogram } from "../../gl/renderer";

export const useHisto = create<{ h: Histogram | null }>(() => ({ h: null }));

/** RGB 히스토그램 (채널을 가산 혼합해 겹치는 부분이 흰색으로 보임) */
export function HistogramView() {
  const h = useHisto((s) => s.h);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr);
    const ht = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== ht) {
      cv.width = w;
      cv.height = ht;
    }
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, w, ht);
    if (!h) return;
    ctx.globalCompositeOperation = "lighter";
    const draw = (arr: Uint32Array, color: string) => {
      ctx.beginPath();
      ctx.moveTo(0, ht);
      for (let i = 0; i < 256; i++) {
        const v = Math.min(1, arr[i] / h.max);
        ctx.lineTo((i / 255) * w, ht - v * (ht - 4 * dpr));
      }
      ctx.lineTo(w, ht);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    draw(h.r, "rgba(255,70,70,0.55)");
    draw(h.g, "rgba(70,220,90,0.55)");
    draw(h.b, "rgba(80,120,255,0.6)");
    ctx.globalCompositeOperation = "source-over";
  }, [h]);

  return (
    <div className="histo">
      <canvas ref={ref} />
    </div>
  );
}
