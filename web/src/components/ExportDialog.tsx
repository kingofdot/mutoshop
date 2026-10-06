import { useEffect, useMemo, useState } from "react";
import { Clipboard, Download, X } from "lucide-react";
import {
  EXT, baseName, copyToClipboard, measureSubject, plannedExportSize, renderExport, saveBlob,
  type ExportFormat, type ExportLayout, type ExportOptions,
} from "../actions";
import { useStore } from "../store";
import { Segmented, Slider } from "./controls";

const SIZES: { label: string; v: number | null }[] = [
  { label: "원본", v: null },
  { label: "3000", v: 3000 },
  { label: "2048", v: 2048 },
  { label: "1080", v: 1080 },
];

export function ExportDialog() {
  const open = useStore((s) => s.exportOpen);
  if (!open) return null;
  return <ExportInner />;
}

function ExportInner() {
  const set = useStore((s) => s.set);
  const bgMode = useStore((s) => s.doc.bg.mode);
  const hasMask = useStore((s) => !!s.doc.cutout);
  const markSaved = useStore((s) => s.markSaved);
  const toast = useStore((s) => s.toast);
  const transparent = hasMask && bgMode === "transparent";
  const layoutOk = hasMask && (bgMode === "transparent" || bgMode === "color");

  const [format, setFormat] = useState<ExportFormat>(transparent ? "png" : "jpeg");
  const [quality, setQuality] = useState(92);
  const [longSide, setLongSide] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const [layout, setLayout] = useState<ExportLayout>("as-is");
  const [padding, setPadding] = useState(8);
  const [name, setName] = useState(() => `${baseName()}_${transparent ? "누끼" : "편집"}`);
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasSubject, setHasSubject] = useState(false);

  useEffect(() => {
    if (layoutOk) setHasSubject(!!measureSubject());
  }, [layoutOk]);

  const customN = parseInt(custom, 10);
  const effLong = custom && customN > 0 ? customN : longSide;
  const opts: ExportOptions = useMemo(
    () => ({ format, quality: quality / 100, longSide: effLong, layout: layoutOk && hasSubject ? layout : "as-is", padding }),
    [format, quality, effLong, layout, padding, layoutOk, hasSubject],
  );
  const size = plannedExportSize(opts);

  // 미리보기 (작게 렌더)
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const blob = await renderExport({ ...opts, longSide: 720, format: "png", quality: 1 });
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        setPreview((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
      } catch {
        /* 미리보기 실패는 무시 */
      }
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [opts.layout, opts.padding]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => set({ exportOpen: false });

  const save = async () => {
    setSaving(true);
    try {
      const blob = await renderExport(opts);
      const ok = await saveBlob(blob, `${name || "image"}${EXT[format]}`, format);
      if (ok) {
        markSaved();
        toast(`저장했어요 · ${size?.[0]}×${size?.[1]} ${format.toUpperCase()} · ${(blob.size / 1024 / 1024).toFixed(1)}MB`, "success", 4000);
        close();
      }
    } catch (e) {
      toast(`저장하지 못했습니다: ${(e as Error).message}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-veil" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter" && !saving) save(); }}>
        <div className="modal-head">
          <h3>내보내기</h3>
          <button className="iconbtn" onClick={close}><X size={17} /></button>
        </div>
        <div className="modal-body">
          <div className="export-grid">
            <div className="export-preview checker-dark" style={opts.format !== "jpeg" ? {
              background: "repeating-conic-gradient(#2c2d32 0% 25%, #232428 0% 50%) 50% / 16px 16px",
            } : undefined}>
              {preview ? (
                <img src={preview} alt="미리보기" style={opts.format === "jpeg" ? { background: bgMode === "color" ? undefined : "#fff" } : undefined} />
              ) : (
                <span className="muted">미리보기 준비 중…</span>
              )}
            </div>
            <div className="col" style={{ gap: 14 }}>
              <div>
                <div className="field-label">파일 이름</div>
                <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              </div>
              <div>
                <div className="field-label">형식</div>
                <Segmented value={format} onChange={setFormat} options={[
                  { value: "png", label: "PNG" },
                  { value: "jpeg", label: "JPG" },
                  { value: "webp", label: "WEBP" },
                ]} />
                <div className="hint mt8">
                  {format === "png" && "무손실 · 투명 배경 유지"}
                  {format === "jpeg" && (transparent ? "JPG는 투명을 지원하지 않아 흰 배경으로 저장돼요." : "용량이 작아 사진 공유에 적합")}
                  {format === "webp" && "용량이 작고 투명 배경도 유지 (웹/쇼핑몰용)"}
                </div>
              </div>
              {format !== "png" && (
                <Slider label="품질" value={quality} min={50} max={100} def={92} format={(v) => `${v}`} onChange={setQuality} />
              )}
              <div>
                <div className="field-label">크기 (긴 변 px)</div>
                <div className="row">
                  <div style={{ flex: 1 }}>
                    <Segmented
                      value={custom ? "custom" : String(longSide)}
                      onChange={(v) => { setCustom(""); setLongSide(v === "null" ? null : Number(v)); }}
                      options={SIZES.map((s) => ({ value: String(s.v), label: s.label }))}
                    />
                  </div>
                  <input className="text-input" style={{ width: 72 }} placeholder="직접" value={custom}
                    onChange={(e) => setCustom(e.target.value.replace(/\D/g, ""))} onKeyDown={(e) => e.stopPropagation()} />
                </div>
              </div>
              {layoutOk && (
                <div>
                  <div className="field-label">피사체 배치</div>
                  <Segmented value={layout} onChange={setLayout} options={[
                    { value: "as-is", label: "그대로" },
                    { value: "trim", label: "딱 맞게 자르기", disabled: !hasSubject },
                    { value: "square", label: "정사각형 중앙", disabled: !hasSubject },
                  ]} />
                  {layout !== "as-is" && (
                    <div className="mt8">
                      <Slider label="여백" value={padding} min={0} max={40} def={8} format={(v) => `${v}%`} onChange={setPadding} />
                    </div>
                  )}
                </div>
              )}
              <div className="out-size">
                출력 크기 <b>{size ? `${size[0]} × ${size[1]} px` : "-"}</b>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => copyToClipboard({ layout: opts.layout, padding, longSide: effLong })}>
            <Clipboard size={14} /> 클립보드에 복사
          </button>
          <div className="spacer" />
          <button className="btn" onClick={close}>취소</button>
          <button className="btn primary" onClick={save} disabled={saving}>
            <Download size={15} /> {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
