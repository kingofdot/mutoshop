import { Minus, Plus } from "lucide-react";
import { useStore } from "../store";
import { outputSize } from "../types";

const HINTS: Record<string, string> = {
  hand: "드래그: 이동 · 휠: 확대/축소",
  zoom: "클릭: 확대 · Alt+클릭: 축소",
  marquee: "드래그: 선택 · Shift: 더하기/정사각형 · Alt: 빼기 · 클릭: 선택 해제",
  lasso: "자유: 드래그 · 다각형: 클릭으로 점 찍고 더블클릭으로 닫기 · Shift 더하기 · Alt 빼기",
  wand: "클릭: 비슷한 색 선택 · Shift 더하기 · Alt 빼기 · 끌기: 문질러 선택에서 빼기 (Shift+끌기 더하기)",
  colorrange: "클릭: 사진 전체에서 비슷한 색 선택 · Shift 더하기 · 끌기: 문질러 선택에서 빼기 · Delete 지우기",
  bgpick: "클릭: 그곳과 이어진 배경 지우기",
  pen: "클릭: 직선 점 · 드래그: 곡선 · 첫 점: 닫기 · Enter: 선택 영역으로",
  brush: "[ ]: 크기 · Shift+[ ]: 경도 · X: 복원/지우기 전환",
  crop: "모서리를 끌어 영역 조절 · Enter: 적용 · Esc: 취소",
  eyedropper: "클릭: 배경색으로 지정",
};

export function StatusBar() {
  const image = useStore((s) => s.image);
  const zoom = useStore((s) => s.view.zoom);
  const orient = useStore((s) => s.doc.orient);
  const crop = useStore((s) => s.doc.crop);
  const cursor = useStore((s) => s.cursor);
  const tool = useStore((s) => s.tool);
  const server = useStore((s) => s.server);
  const zoomAt = useStore((s) => s.zoomAt);
  const fitView = useStore((s) => s.fitView);

  let dims = "";
  if (image) {
    const [W, H] = outputSize(image.w, image.h, orient);
    dims = crop ? `${Math.round(crop.w * W)} × ${Math.round(crop.h * H)} px (자름)` : `${W} × ${H} px`;
  }
  const dev = server?.device;
  const led = !server ? "warn" : !server.ok ? "err" : dev?.kind === "cpu" ? "warn" : "ok";
  const devText = !server
    ? "서버 확인 중…"
    : !server.ok
      ? "서버 연결 안 됨 (누끼 불가)"
      : `${dev?.label ?? ""}${dev?.gpu ? ` · ${dev.gpu}` : ""}`;

  return (
    <div className="statusbar">
      {image && (
        <>
          <div className="status-zoom">
            <button onClick={() => zoomAt(zoom / 1.25)} data-tip="축소" data-tip-pos="top"><Minus size={12} /></button>
            <button onClick={fitView} data-tip="화면 맞춤 (Ctrl+0)" data-tip-pos="top" style={{ minWidth: 48 }}>
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={() => zoomAt(zoom * 1.25)} data-tip="확대" data-tip-pos="top"><Plus size={12} /></button>
          </div>
          <span>{dims}</span>
          {cursor && cursor.x >= 0 && cursor.y >= 0 && cursor.x < image.w && cursor.y < image.h && (
            <span style={{ fontVariantNumeric: "tabular-nums" }}>X {cursor.x} · Y {cursor.y}</span>
          )}
          <span className="muted">{HINTS[tool]}</span>
        </>
      )}
      <div className="spacer" />
      <span className="build-tag" data-tip="화면 버전 (빌드 시각)" data-tip-pos="top">v{__BUILD__}</span>
      <div className="status-dev">
        <span className={`led ${led}`} />
        {devText}
      </div>
    </div>
  );
}
