import { useEffect, useState } from "react";

let lastOn = 5; // 껐다 켤 때 돌아갈 크기

/** 잔티 제거: [v] 잔티 제거 · 떨어진 [5] px 이하 점  (0 = 끔). 숫자는 Enter·칸을 벗어날 때 적용 */
export function DespeckleRow({ size, onChange, removed }: { size: number; onChange: (v: number) => void; removed?: number }) {
  const [text, setText] = useState(String(size || lastOn));
  useEffect(() => {
    if (size) lastOn = size;
    setText(String(size || lastOn));
  }, [size]);
  const commit = () => {
    const v = Math.max(1, Math.min(50, Math.round(Number(text)) || lastOn));
    setText(String(v));
    if (size && v !== size) onChange(v);
  };
  return (
    <div className="despeckle-row" data-tip="주요 객체와 떨어져 있는 작은 점(가로·세로 모두 이 크기 이하)을 자동으로 지워요">
      <label>
        <input type="checkbox" checked={size > 0} onChange={(e) => onChange(e.target.checked ? lastOn : 0)} /> 잔티 제거
      </label>
      <span className="muted">떨어진</span>
      <input className="num-input" type="number" min={1} max={50} value={text} disabled={!size}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      <span className="muted">px 이하 점</span>
      {!!removed && size > 0 && <span className="pill ok">{removed}개 지움</span>}
    </div>
  );
}
