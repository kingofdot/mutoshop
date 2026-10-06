import { useMemo, useRef, useState, type PointerEvent } from "react";
import { curveFn, sortedPoints } from "../../lib/curves";
import type { CurvePoint } from "../../types";

const SIZE = 256;

/** 포토샵식 곡선 편집기: 클릭으로 점 추가, 끌어서 이동, 밖으로 끌어내거나 더블클릭하면 삭제 */
export function CurveEditor({
  points, color, onChange, onCommit, histogram,
}: {
  points: CurvePoint[];
  color: string;
  onChange: (p: CurvePoint[]) => void;
  onCommit: () => void;
  histogram?: Uint32Array | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const pts = useMemo(() => sortedPoints(points), [points]);

  const path = useMemo(() => {
    const f = curveFn(pts);
    let d = "";
    for (let i = 0; i <= 128; i++) {
      const x = i / 128;
      d += `${i ? "L" : "M"}${(x * SIZE).toFixed(1)},${((1 - f(x)) * SIZE).toFixed(1)}`;
    }
    return d;
  }, [pts]);

  const histPath = useMemo(() => {
    if (!histogram) return "";
    let mx = 1;
    for (let i = 1; i < 255; i++) mx = Math.max(mx, histogram[i]);
    let d = `M0,${SIZE}`;
    for (let i = 0; i < 256; i++) {
      const h = Math.min(1, Math.sqrt(histogram[i] / mx)) * SIZE * 0.9;
      d += `L${(i / 255) * SIZE},${SIZE - h}`;
    }
    return d + `L${SIZE},${SIZE}Z`;
  }, [histogram]);

  const toLocal = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height };
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const p = toLocal(e);
    const near = pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.045);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (near >= 0) {
      if (e.detail === 2 && near > 0 && near < pts.length - 1) {
        onChange(pts.filter((_, i) => i !== near));
        onCommit();
        return;
      }
      setDrag(near);
      return;
    }
    // 새 점 추가 (곡선 근처를 누르면 곡선 위에, 아니면 누른 위치에)
    const x = Math.min(0.99, Math.max(0.01, p.x));
    const onCurve = curveFn(pts)(x);
    const np = { x, y: Math.abs(onCurve - p.y) < 0.06 ? onCurve : Math.min(1, Math.max(0, p.y)) };
    const next = sortedPoints([...pts, np]);
    onChange(next);
    setDrag(next.indexOf(np));
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const p = toLocal(e);
    const isEnd = drag === 0 || drag === pts.length - 1;
    const out = p.x < -0.12 || p.x > 1.12 || p.y < -0.12 || p.y > 1.12;
    if (out && !isEnd) {
      onChange(pts.filter((_, i) => i !== drag));
      setDrag(null);
      return;
    }
    const lo = drag > 0 ? pts[drag - 1].x + 0.01 : 0;
    const hi = drag < pts.length - 1 ? pts[drag + 1].x - 0.01 : 1;
    const x = drag === 0 ? 0 : drag === pts.length - 1 ? 1 : Math.min(hi, Math.max(lo, p.x));
    const y = Math.min(1, Math.max(0, p.y));
    onChange(pts.map((q, i) => (i === drag ? { x, y } : q)));
  };

  const onUp = () => {
    if (drag === null) return;
    setDrag(null);
    onCommit();
  };

  return (
    <div className="curve-box" ref={box} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} preserveAspectRatio="none">
        {histPath && <path d={histPath} fill="rgba(255,255,255,0.07)" />}
        {[0.25, 0.5, 0.75].map((t) => (
          <g key={t} stroke="rgba(255,255,255,0.07)" strokeWidth="1">
            <line x1={t * SIZE} y1="0" x2={t * SIZE} y2={SIZE} />
            <line x1="0" y1={t * SIZE} x2={SIZE} y2={t * SIZE} />
          </g>
        ))}
        <line x1="0" y1={SIZE} x2={SIZE} y2="0" stroke="rgba(255,255,255,0.12)" strokeDasharray="3 4" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {pts.map((q, i) => (
          <circle
            key={i}
            cx={q.x * SIZE}
            cy={(1 - q.y) * SIZE}
            r={drag === i ? 6 : 4.5}
            fill={drag === i ? color : "#1a1b1e"}
            stroke={color}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  );
}
