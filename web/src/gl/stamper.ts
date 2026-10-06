import type { Stroke } from "../types";

/**
 * 획(점 목록)을 일정 간격의 브러시 도장으로 바꾼다.
 * 실시간으로 그릴 때와 실행 취소 후 다시 그릴 때 결과가 똑같도록 결정적으로 동작한다.
 */
export class Stamper {
  private i = 0;
  private carry = 0;

  constructor(private s: Stroke) {}

  /** 지난 호출 이후 추가된 점들에 대한 도장 [x, y, 반지름, ...] */
  next(): Float32Array {
    const p = this.s.pts;
    const out: number[] = [];
    const spacing = Math.max(0.6, this.s.size * 0.08);
    const n = p.length / 3;
    while (this.i < n) {
      const k = this.i * 3;
      const x = p[k], y = p[k + 1], pr = p[k + 2];
      if (this.i === 0) {
        out.push(x, y, this.radius(pr));
        this.i++;
        continue;
      }
      const px = p[k - 3], py = p[k - 2], ppr = p[k - 1];
      const dx = x - px;
      const dy = y - py;
      const dist = Math.hypot(dx, dy);
      let t = spacing - this.carry;
      while (t <= dist) {
        const f = t / dist;
        out.push(px + dx * f, py + dy * f, this.radius(ppr + (pr - ppr) * f));
        t += spacing;
      }
      this.carry = dist - (t - spacing);
      this.i++;
    }
    return new Float32Array(out);
  }

  private radius(pressure: number) {
    return (this.s.size / 2) * (0.3 + 0.7 * pressure);
  }
}
