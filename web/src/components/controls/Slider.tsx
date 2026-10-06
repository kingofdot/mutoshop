import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** 더블클릭 시 돌아갈 값 + 채움의 기준점 */
  def?: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  format?: (v: number) => string;
  /** 레일 배경 (CSS gradient). 지정하면 채움 대신 그라디언트 레일을 그림 */
  track?: string;
  disabled?: boolean;
  tip?: string;
}

const decimals = (step: number) => (step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step))));

export function Slider({
  label, value, min, max, step = 1, def = 0, onChange, onCommit, format, track, disabled, tip,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const dec = decimals(step);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const snap = (v: number) => {
    const s = Math.round(v / step) * step;
    return Number(clamp(s).toFixed(dec));
  };
  const pct = (v: number) => ((clamp(v) - min) / (max - min)) * 100;
  const fmt = format ?? ((v: number) => (v > 0 && min < 0 ? "+" : "") + v.toFixed(dec));

  const fromEvent = (e: PointerEvent) => {
    const r = trackRef.current!.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return snap(min + t * (max - min));
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    if (e.detail === 2) return; // 더블클릭은 onDoubleClick 에서
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(true);
    const v = fromEvent(e);
    if (v !== value) onChange(v);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const v = fromEvent(e);
    if (v !== value) onChange(v);
  };
  const onUp = () => {
    if (!drag) return;
    setDrag(false);
    onCommit?.();
  };
  const reset = () => {
    if (disabled) return;
    onChange(def);
    onCommit?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (disabled) return;
    const big = e.shiftKey ? 10 : 1;
    let v: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") v = snap(value + step * big);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") v = snap(value - step * big);
    else if (e.key === "Home") v = min;
    else if (e.key === "End") v = max;
    if (v !== null) {
      e.preventDefault();
      onChange(v);
    }
  };

  const commitEdit = () => {
    if (editing === null) return;
    const n = parseFloat(editing.replace(/[^\d.+-]/g, ""));
    setEditing(null);
    if (!Number.isNaN(n)) {
      onChange(snap(n));
      onCommit?.();
    }
  };

  const changed = Math.abs(value - def) > step / 2;
  const zero = def > min && def < max ? pct(def) : null;
  const fillA = Math.min(pct(def), pct(value));
  const fillB = Math.max(pct(def), pct(value));

  return (
    <div className={`slider${changed ? " changed" : ""}`} style={disabled ? { opacity: 0.4 } : undefined}>
      <div className="slider-top">
        <span className="slider-label" onDoubleClick={reset} data-tip={tip} data-tip-pos="top">
          {label}
        </span>
        <input
          className="slider-value"
          value={editing ?? fmt(value)}
          disabled={disabled}
          onFocus={(e) => {
            setEditing(value.toFixed(dec));
            requestAnimationFrame(() => e.target.select());
          }}
          onChange={(e) => setEditing(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setEditing(null);
              (e.target as HTMLInputElement).blur();
            }
            e.stopPropagation();
          }}
        />
      </div>
      <div
        ref={trackRef}
        className={`slider-track${drag ? " drag" : ""}`}
        tabIndex={disabled ? -1 : 0}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={reset}
        onKeyDown={onKey}
        onKeyUp={(e) => {
          if (["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) onCommit?.();
        }}
      >
        <div className="slider-rail" style={track ? { background: track, height: 6, top: 6 } : undefined} />
        {!track && <div className="slider-fill" style={{ left: `${fillA}%`, width: `${fillB - fillA}%` }} />}
        {zero !== null && !track && <div className="slider-zero" style={{ left: `${zero}%` }} />}
        <div className="slider-thumb" style={{ left: `${pct(value)}%` }} />
      </div>
    </div>
  );
}
