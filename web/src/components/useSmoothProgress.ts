import { useEffect, useRef, useState } from "react";
import type { JobState } from "../store";

// 서버는 단계가 바뀔 때만 진행률을 알려 주므로, 각 단계 안에서는 다음 단계 직전까지
// 천천히 차오르게 보여 준다 (멈춘 것처럼 보이지 않도록).
const CAP: Record<string, number> = {
  upload: 0.04,
  queued: 0.06,
  load: 0.14,
  infer: 0.44,
  refine: 0.83,
  color: 0.97,
  fetch: 0.99,
  done: 1,
};

export function useSmoothProgress(job: JobState | null): number {
  const [p, setP] = useState(0);
  const jobRef = useRef(job);
  jobRef.current = job;
  const active = !!job;

  useEffect(() => {
    if (!active) {
      setP(0);
      return;
    }
    const id = window.setInterval(() => {
      const j = jobRef.current;
      if (!j) return;
      setP((prev) => {
        const target = j.progress;
        if (j.stage === "download") return Math.max(prev, target * 0.9);
        const cap = Math.max(target, CAP[j.stage] ?? target);
        const base = Math.max(prev, target);
        return Math.min(cap, base + (cap - base) * 0.035);
      });
    }, 100);
    return () => clearInterval(id);
  }, [active]);

  return p;
}
