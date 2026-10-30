/** 잔티 제거: 주요 객체와 떨어져 있는 작은 덩어리(가로·세로 모두 size px 이하)를 마스크에서 지운다.
 *  반투명한 가장자리까지 한 덩어리로 보고(8방향으로 이어짐), 객체와 조금이라도 붙어 있으면 지우지 않는다.
 *  돌려주는 값: 새 마스크(원본은 그대로)와 지운 덩어리 수 */
export function despeckle(mask: Uint8Array, w: number, h: number, size: number): { data: Uint8Array; removed: number } {
  const out = mask.slice();
  if (size <= 0) return { data: out, removed: 0 };
  const T = 8; // 이보다 옅은 픽셀은 '없는 것'으로 (덩어리를 잇지 않음)
  const n = w * h;
  const seen = new Uint8Array(n);
  const list = new Int32Array(n); // 지금 덩어리의 픽셀들 (넓이 우선으로 훑는 줄을 겸함)
  let removed = 0;
  for (let start = 0; start < n; start++) {
    if (seen[start] || mask[start] <= T) continue;
    let head = 0, tail = 0;
    list[tail++] = start;
    seen[start] = 1;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    let small = true;
    while (head < tail) {
      const p = list[head++];
      const y = (p / w) | 0;
      const x = p - y * w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (small && (x1 - x0 >= size || y1 - y0 >= size)) small = false;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const row = yy * w;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
          const q = row + xx;
          if (!seen[q] && mask[q] > T) {
            seen[q] = 1;
            list[tail++] = q;
          }
        }
      }
    }
    if (small) {
      for (let k = 0; k < tail; k++) out[list[k]] = 0;
      removed++;
    }
  }
  return { data: out, removed };
}
