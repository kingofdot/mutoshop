import { sourceToScreen } from "../actions";
import { useDraft } from "../selectTools";
import { useStore, type PenPath } from "../store";

/** 진행 중인 선택 도형과 펜 경로를 화면 좌표로 그린다 (마우스 입력은 받지 않음) */
export function ToolOverlay() {
  const d = useDraft((s) => s.d);
  const path = useStore((s) => s.penPath);
  const tool = useStore((s) => s.tool);
  // 화면 이동/확대·회전 시 다시 그리도록 구독
  useStore((s) => s.view);
  useStore((s) => s.doc.orient);
  useStore((s) => s.doc.crop);

  const P = (x: number, y: number) => sourceToScreen(x, y) ?? [0, 0];
  const pts = (arr: number[]) => {
    const out: string[] = [];
    for (let i = 0; i < arr.length; i += 2) {
      const [a, b] = P(arr[i], arr[i + 1]);
      out.push(`${a.toFixed(1)},${b.toFixed(1)}`);
    }
    return out.join(" ");
  };

  let shape: React.ReactNode = null;
  if (d?.kind === "rect") {
    const [ax, ay] = P(d.x0, d.y0);
    const [bx, by] = P(d.x1, d.y1);
    const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
    shape = d.ellipse ? (
      <Ants><ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} /></Ants>
    ) : (
      <Ants><rect x={x} y={y} width={w} height={h} /></Ants>
    );
  } else if (d?.kind === "lasso") {
    shape = <Ants><polyline points={pts(d.pts)} /></Ants>;
  } else if (d?.kind === "poly") {
    const all = d.hover ? [...d.pts, ...d.hover] : d.pts;
    const [fx, fy] = P(d.pts[0], d.pts[1]);
    const [hx, hy] = d.hover ? P(d.hover[0], d.hover[1]) : [Infinity, Infinity];
    const nearStart = d.pts.length >= 6 && Math.hypot(fx - hx, fy - hy) < 9;
    shape = (
      <>
        <Ants><polyline points={pts(all)} /></Ants>
        <circle cx={fx} cy={fy} r={nearStart ? 6 : 4} fill={nearStart ? "#5b8cff" : "#fff"} stroke="#000" strokeWidth={1} />
      </>
    );
  }

  return (
    <svg className="tool-overlay">
      {shape}
      {path && tool === "pen" && <PenView path={path} P={P} />}
      {path && tool !== "pen" && <PenView path={path} P={P} dim />}
    </svg>
  );
}

function Ants({ children }: { children: React.ReactNode }) {
  return (
    <g fill="none">
      <g stroke="#000" strokeWidth={1}>{children}</g>
      <g stroke="#fff" strokeWidth={1} strokeDasharray="4 4" className="ants">{children}</g>
    </g>
  );
}

function PenView({ path, P, dim }: { path: PenPath; P: (x: number, y: number) => number[]; dim?: boolean }) {
  const p = path.pts;
  if (!p.length) return null;
  let dstr = "";
  const [x0, y0] = P(p[0].x, p[0].y);
  dstr = `M${x0},${y0}`;
  const segs = path.closed ? p.length : p.length - 1;
  for (let i = 1; i <= segs; i++) {
    const a = p[i - 1];
    const b = p[i % p.length];
    const c1 = a.hout ?? a;
    const c2 = b.hin ?? b;
    const [ax, ay] = P(c1.x, c1.y);
    const [bx, by] = P(c2.x, c2.y);
    const [ex, ey] = P(b.x, b.y);
    dstr += ` C${ax},${ay} ${bx},${by} ${ex},${ey}`;
  }
  if (path.closed) dstr += " Z";
  return (
    <g opacity={dim ? 0.5 : 1}>
      {path.closed && <path d={dstr} fill="rgba(91,140,255,0.12)" stroke="none" />}
      <path d={dstr} fill="none" stroke="#000" strokeWidth={3} opacity={0.5} />
      <path d={dstr} fill="none" stroke="#5b8cff" strokeWidth={1.5} />
      {!dim &&
        p.map((q, i) => {
          const [ax, ay] = P(q.x, q.y);
          return (
            <g key={i}>
              {(["hin", "hout"] as const).map((k) => {
                const h = q[k];
                if (!h) return null;
                const [hx, hy] = P(h.x, h.y);
                return (
                  <g key={k}>
                    <line x1={ax} y1={ay} x2={hx} y2={hy} stroke="#5b8cff" strokeWidth={1} />
                    <circle cx={hx} cy={hy} r={3.5} fill="#5b8cff" stroke="#fff" strokeWidth={1} />
                  </g>
                );
              })}
              <rect
                x={ax - 4}
                y={ay - 4}
                width={8}
                height={8}
                fill={i === 0 && !path.closed ? "#5b8cff" : "#fff"}
                stroke="#1e3a8a"
                strokeWidth={1.2}
              />
            </g>
          );
        })}
    </g>
  );
}
