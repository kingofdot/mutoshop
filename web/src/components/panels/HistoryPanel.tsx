import { useEffect, useRef } from "react";
import { useStore } from "../../store";

export function HistoryPanel() {
  const hist = useStore((s) => s.hist);
  const idx = useStore((s) => s.histIndex);
  const jumpTo = useStore((s) => s.jumpTo);
  const cur = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cur.current?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  if (!hist.length) return <div className="empty-note">작업 기록이 여기에 쌓여요.</div>;

  return (
    <div style={{ paddingTop: 6 }}>
      <div className="hint" style={{ padding: "4px 14px 8px" }}>
        항목을 누르면 그 시점으로 돌아가요. (최근 60개)
      </div>
      {hist.map((h, i) => (
        <button
          key={i}
          ref={i === idx ? cur : undefined}
          className={`hist-item${i === idx ? " cur" : i > idx ? " future" : ""}`}
          onClick={() => jumpTo(i)}
        >
          <span className="n">{i + 1}</span>
          {h.label}
        </button>
      ))}
    </div>
  );
}
