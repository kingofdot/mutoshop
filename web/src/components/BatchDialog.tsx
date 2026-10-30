import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CircleCheck, CircleX, FolderOpen, Folders, LoaderCircle, Play, RotateCcw, SkipForward, Square, TriangleAlert, X,
} from "lucide-react";
import {
  ADVANCED_KEYS, advancedDefaults, etaSeconds, outExt, outlineWidth, perImageSec, scanFolder, startBatch, stopBatch,
  useBatch, type BatchItem, type BatchSettings,
} from "../batch";
import { KIND, fineFor } from "../kinds";
import { batchOpenOut, batchPick } from "../lib/api";
import { useStore } from "../store";
import { ColorField, Section, Segmented, Slider, Toggle } from "./controls";
import { DespeckleRow } from "./DespeckleRow";
import { CutOptions, KindPicker } from "./KindPicker";
import { OutlineControls } from "./OutlineControls";

const SIZES: { label: string; v: number | null }[] = [
  { label: "원본", v: null },
  { label: "3000", v: 3000 },
  { label: "2048", v: 2048 },
  { label: "1080", v: 1080 },
];

const FORMAT_LABEL: Record<BatchSettings["format"], string> = { png: "PNG", webp: "WEBP", jpeg: "JPG" };
const LAYOUT_LABEL: Record<BatchSettings["layout"], string> = { "as-is": "그대로", trim: "딱 맞게 자르기", square: "정사각형 중앙" };

const fmtTime = (sec: number) => {
  if (sec < 60) return `${Math.max(1, Math.round(sec))}초`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  if (m < 60) return s ? `${m}분 ${s}초` : `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
};
const fmtMB = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)}GB` : `${Math.max(0.1, b / 1e6).toFixed(1)}MB`);

/** 4. 저장의 요약 한 줄: PNG · 투명 배경 · 원본 크기 (+ 기본값과 다른 것만) */
function saveSummary(st: BatchSettings) {
  const bg = st.bg === "color" ? `배경 ${st.bgColor.toUpperCase()}` : st.format === "jpeg" ? "흰 배경 (JPG는 투명 불가)" : "투명 배경";
  const parts = [FORMAT_LABEL[st.format], bg, st.longSide ? `긴 변 ${st.longSide}px` : "원본 크기"];
  if (st.layout !== "as-is") parts.push(LAYOUT_LABEL[st.layout]);
  if (st.suffix) parts.push(`이름 뒤 ${st.suffix}`);
  if (!st.skipExisting) parts.push("덮어쓰기");
  return parts.join(" · ");
}

export function BatchDialog() {
  const open = useBatch((s) => s.open);
  if (!open) return null;
  return <BatchInner />;
}

function BatchInner() {
  const phase = useBatch((s) => s.phase);
  const set = useBatch((s) => s.set);
  const close = () => phase !== "running" && set({ open: false });

  return (
    <div className="modal-veil" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal batch" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }}>
        <div className="modal-head">
          <Folders size={18} />
          <h3>폴더 작업 · 일괄 누끼</h3>
          <button className="iconbtn" onClick={close} disabled={phase === "running"}><X size={17} /></button>
        </div>
        {phase === "setup" ? <Setup /> : <Progress />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 설정 화면: 1. 폴더 → 2. 종류 → 3. 외곽선 → 4. 저장. 자주 안 쓰는 설정은 '고급 설정' 안에

function Setup() {
  const st = useBatch((s) => s.settings);
  const scan = useBatch((s) => s.scan);
  const scanning = useBatch((s) => s.scanning);
  const error = useBatch((s) => s.error);
  const setSettings = useBatch((s) => s.setSettings);
  const setOutline = useBatch((s) => s.setOutline);
  const set = useBatch((s) => s.set);
  const server = useStore((s) => s.server);
  const serverOk = server?.ok;

  // 열 때, 그리고 폴더·하위 폴더·저장 위치가 바뀌면 다시 읽기 (폴더 내용이 바뀌었을 수 있으므로)
  useEffect(() => {
    if (!st.folder.trim()) return;
    const t = setTimeout(scanFolder, 300);
    return () => clearTimeout(t);
  }, [st.folder, st.recursive, st.out]);

  const pickFolder = async () => {
    try {
      const p = await batchPick(st.folder, "누끼를 딸 사진이 있는 폴더 선택");
      if (p) setSettings({ folder: p });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  };
  const pickOut = async () => {
    try {
      const p = await batchPick(st.out || scan?.out || st.folder, "결과를 저장할 폴더 선택");
      if (p) setSettings({ out: p });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  };
  const fromEditor = () => {
    const d = useStore.getState().doc.outline;
    setSettings({ outline: { ...d, enabled: true }, widthUnit: "px" });
  };

  const n = scan?.files.length ?? 0;
  const total = scan?.files.reduce((a, f) => a + f.size, 0) ?? 0;
  const sameAsSrc = !!scan && scan.out.toLowerCase() === scan.folder.toLowerCase();
  const portrait = server?.models?.find((m) => m.id === "portrait");
  const adv = advancedDefaults();
  // 머리카락 최고 품질은 인물일 때만 보이고 쓰인다
  const advModified = ADVANCED_KEYS.some((k) => (k === "fine" ? fineFor(st.kind, st.fine) : st[k] !== adv[k]));
  const pct = st.widthUnit === "pct";
  const auto = st.widthUnit === "auto";

  return (
    <>
      <div className="modal-body col" style={{ gap: 12 }}>
        <div className="bsec">
          <div className="bsec-title">1. 폴더</div>
          <div className="row">
            <input className="text-input" placeholder="사진이 있는 폴더 (붙여넣기 가능)" value={st.folder}
              onChange={(e) => setSettings({ folder: e.target.value })}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") scanFolder(); }} />
            <button className="btn" onClick={pickFolder}><FolderOpen size={14} /> 찾아보기</button>
          </div>
          <div className={`batch-found mt8${error ? " err" : ""}`}>
            {scanning ? "폴더 읽는 중…"
              : error ? `⚠ ${error}`
                : scan ? (n ? <>이미지 <b>{n}장</b> · {fmtMB(total)}{st.recursive && " · 하위 폴더 포함"}</>
                  : "이 폴더에는 이미지가 없어요 (JPG·PNG·WEBP·HEIC 등).")
                  : "폴더를 고르면 안의 사진을 모두 찾아요."}
          </div>
          {scan && n > 0 && (
            <div className="batch-names ellipsis" title={scan.files.slice(0, 20).map((f) => f.rel).join("\n")}>
              {scan.files.slice(0, 3).map((f) => f.rel).join(", ")}
              {n > 3 && ` 외 ${n - 3}장`}
            </div>
          )}
        </div>

        <div className="bsec">
          <div className="bsec-title">2. 종류</div>
          <KindPicker value={st.kind} onChange={(v) => v !== st.kind && setSettings({ kind: v, inner: "auto" })} />
          <DespeckleRow size={st.despeckle} onChange={(v) => setSettings({ despeckle: v })} />
          <div className="hint mt8">
            {KIND[st.kind].help}
            {st.kind === "person" && portrait && !portrait.downloaded &&
              ` · 사진이면 처음 한 번 인물용 AI 모델(약 ${Math.max(1, Math.round(portrait.size / 1e6))}MB)을 내려받아요.`}
          </div>
        </div>

        <div className="bsec">
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="bsec-title grow" style={{ marginBottom: 0 }}>3. 외곽선</div>
            <button className="btn sm ghost" onClick={fromEditor} data-tip="편집기 누끼 탭의 외곽선 설정 그대로" data-tip-pos="left">
              편집기 설정 가져오기
            </button>
          </div>
          <OutlineControls
            value={st.outline}
            long={2400}
            set={setOutline}
            commit={() => undefined}
            moreId="batch.outline.more"
            summaryExtra={pct ? "비례 두께" : auto ? "자동 두께" : undefined}
            thick={pct ? st.widthPct > 2.5 : undefined}
            moreExtra={
              <div style={{ marginBottom: 12 }}>
                <div className="field-label">두께 정하는 방법</div>
                <Segmented value={st.widthUnit} onChange={(v) => setSettings({ widthUnit: v })} options={[
                  { value: "auto", label: "자동", tip: "1024×1024 이하 사진은 1px, 그보다 크면 2px" },
                  { value: "px", label: "직접 (px)", tip: "모든 사진에 같은 두께" },
                  { value: "pct", label: "크기 비례 (%)", tip: "사진 긴 변의 몇 %" },
                ]} />
              </div>
            }
            widthOverride={auto ? (
              <div className="hint">두께 <b>자동</b> · 1024×1024 이하 사진은 1px, 그보다 크면 2px (바꾸려면 더보기 › 두께 정하는 방법)</div>
            ) : pct ? (
              <>
                <Slider label="두께 (긴 변 기준)" value={st.widthPct} min={0.1} max={10} step={0.1} def={0.5}
                  format={(v) => `${v.toFixed(1)}%`} onChange={(v) => setSettings({ widthPct: v })} />
                <div className="hint">예: 2000px 사진이면 {outlineWidth(st, 2000, 2000)}px</div>
              </>
            ) : undefined}
          />
        </div>

        <div className="bsec">
          <div className="bsec-title">4. 저장</div>
          <div className="row">
            <input className="text-input" value={st.out} placeholder={scan ? scan.out : "고른 폴더 안의 ‘누끼’ 폴더"}
              onChange={(e) => setSettings({ out: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
            <button className="btn" onClick={pickOut}>변경</button>
            {st.out && (
              <button className="btn ghost" data-tip="기본 위치로" data-tip-pos="left" onClick={() => setSettings({ out: "" })}>
                <RotateCcw size={13} />
              </button>
            )}
          </div>
          <div className="hint mt8">
            {saveSummary(st)} — 원본은 그대로 두고 복사본으로 저장해요.
            {sameAsSrc && " (원본과 이름이 같은 파일은 건너뛰어요)"}
          </div>
        </div>

        <div className="bsec adv">
          <Section id="batch.adv" title="고급 설정" defaultOpen={false} modified={advModified}
            onReset={advModified ? () => setSettings(advancedDefaults()) : undefined}>
            <div className="adv-group">폴더</div>
            <div className="col" style={{ gap: 10 }}>
              <Toggle on={st.recursive} onChange={(v) => setSettings({ recursive: v })} label="하위 폴더까지 포함"
                desc="폴더 구조 그대로 결과 폴더에 만들어요." />
              <Toggle on={st.skipExisting} onChange={(v) => setSettings({ skipExisting: v })} label="이미 만든 결과는 건너뛰기"
                desc="중간에 멈췄다 이어서 할 때 편해요. 끄면 덮어써요." />
              <Toggle on={st.keepAlpha} onChange={(v) => setSettings({ keepAlpha: v })} label="이미 투명한 PNG는 그대로"
                desc="누끼를 다시 따지 않고 외곽선·저장만 적용해요." />
            </div>

            <div className="adv-group mt16">따기 옵션</div>
            <CutOptions kind={st.kind} inner={st.inner} fine={st.fine}
              onInner={(v) => setSettings({ inner: v })} onFine={(v) => setSettings({ fine: v })} />

            <div className="adv-group mt16">저장 형식</div>
            <div className="field-label">배경</div>
            <div className="row">
              <div style={{ flex: 1 }}>
                <Segmented value={st.bg} onChange={(v) => setSettings({ bg: v })} options={[
                  { value: "transparent", label: "투명" },
                  { value: "color", label: "단색" },
                ]} />
              </div>
              {st.bg === "color" && (
                <div style={{ width: 150 }}>
                  <ColorField value={st.bgColor} onChange={(v) => setSettings({ bgColor: v })} />
                </div>
              )}
            </div>
            <div className="field-label mt12">형식</div>
            <Segmented value={st.format} onChange={(v) => setSettings({ format: v })} options={[
              { value: "png", label: "PNG" },
              { value: "webp", label: "WEBP" },
              { value: "jpeg", label: "JPG" },
            ]} />
            <div className="hint mt8">
              {st.format === "png" && "무손실 · 투명 배경 유지"}
              {st.format === "webp" && "용량이 작고 투명 배경도 유지 (웹·쇼핑몰용)"}
              {st.format === "jpeg" && (st.bg === "transparent" ? "JPG는 투명을 지원하지 않아 흰 배경으로 저장돼요." : "용량이 작아 공유에 적합")}
            </div>
            {st.format !== "png" && (
              <div className="mt8">
                <Slider label="품질" value={st.quality} min={50} max={100} def={92} format={(v) => `${v}`}
                  onChange={(v) => setSettings({ quality: v })} />
              </div>
            )}
            <div className="field-label mt12">크기 (긴 변 px)</div>
            <Segmented value={String(st.longSide)} onChange={(v) => setSettings({ longSide: v === "null" ? null : Number(v) })}
              options={SIZES.map((s) => ({ value: String(s.v), label: s.label }))} />
            <div className="field-label mt12">피사체 배치</div>
            <Segmented value={st.layout} onChange={(v) => setSettings({ layout: v })} options={[
              { value: "as-is", label: LAYOUT_LABEL["as-is"] },
              { value: "trim", label: LAYOUT_LABEL.trim },
              { value: "square", label: LAYOUT_LABEL.square },
            ]} />
            {st.layout !== "as-is" && (
              <div className="mt8">
                <Slider label="여백" value={st.padding} min={0} max={40} def={8} format={(v) => `${v}%`}
                  onChange={(v) => setSettings({ padding: v })} />
              </div>
            )}
            <div className="field-label mt12">파일 이름 뒤에 붙이기</div>
            <input className="text-input" placeholder="예: _누끼 (비우면 원래 이름 그대로)" value={st.suffix}
              onChange={(e) => setSettings({ suffix: e.target.value.replace(/[\\/:*?"<>|]/g, "") })}
              onKeyDown={(e) => e.stopPropagation()} />
            <div className="hint mt8">
              예: 사진1.jpg → <b>사진1{st.suffix}.{outExt(st.format)}</b>
            </div>
          </Section>
        </div>
      </div>
      <div className="modal-foot">
        <span className="hint">
          {!serverOk ? "⚠ 서버에 연결되지 않았어요."
            : n ? <>{n}장 · 예상 약 <b>{fmtTime(n * perImageSec(st))}</b></> : ""}
        </span>
        <div className="spacer" />
        <button className="btn" onClick={() => set({ open: false })}>닫기</button>
        <button className="btn primary" disabled={!n || scanning || !serverOk} onClick={startBatch}>
          <Play size={14} /> 시작
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 진행 / 결과 화면

const ICON: Record<BatchItem["status"], ReactNode> = {
  pending: <span className="bdot" />,
  running: <LoaderCircle size={14} className="spin" />,
  done: <CircleCheck size={14} color="var(--ok)" />,
  warn: <TriangleAlert size={14} color="#f5a524" />,
  skipped: <SkipForward size={14} className="muted" />,
  error: <CircleX size={14} color="#ef4444" />,
  stopped: <Square size={13} className="muted" />,
};

function Progress() {
  const b = useBatch();
  const listRef = useRef<HTMLDivElement>(null);
  const scan = b.scan!;
  const n = scan.files.length;
  const count = (k: BatchItem["status"][]) => b.items.filter((x) => k.includes(x.status)).length;
  const done = count(["done", "warn"]);
  const skipped = count(["skipped"]);
  const failed = count(["error"]);
  const processed = done + skipped + failed + count(["stopped"]);
  const running = b.phase === "running";
  const frac = n ? (processed + (running && b.index >= 0 ? b.progress : 0)) / n : 0;
  const elapsed = ((b.finished || Date.now()) - b.started) / 1000;
  const eta = running ? etaSeconds(b) : null;
  const kindLabel = KIND[b.settings.kind].label;

  // 진행 중인 파일이 보이도록 스크롤
  useEffect(() => {
    if (b.index < 0) return;
    listRef.current?.querySelector(`[data-i="${b.index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [b.index]);

  // 경과 시간 갱신
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  return (
    <>
      <div className="modal-body">
        <div className="batch-head">
          <div className="row">
            <b className="grow">
              {kindLabel} · {running ? (b.stopping ? "멈추는 중…" : `${Math.min(n, processed + 1)} / ${n} 처리 중`) : b.stopping ? "중지됨" : "완료"}
            </b>
            <span className="muted">{Math.round(frac * 100)}%</span>
          </div>
          <div className="progress mt8"><div style={{ width: `${Math.max(2, frac * 100)}%` }} /></div>
          {running && b.index >= 0 && (
            <div className="hint mt8 ellipsis">
              {scan.files[b.index].rel} · {b.message || "준비 중"}
            </div>
          )}
          <div className="batch-stats mt8">
            <span><CircleCheck size={13} color="var(--ok)" /> 저장 {done}</span>
            {skipped > 0 && <span><SkipForward size={13} /> 건너뜀 {skipped}</span>}
            {failed > 0 && <span><CircleX size={13} color="#ef4444" /> 실패 {failed}</span>}
            <span className="grow" />
            <span>경과 {fmtTime(elapsed)}</span>
            {eta !== null && eta > 0 && <span>· 남은 시간 약 {fmtTime(eta)}</span>}
          </div>
        </div>
        <div className="batch-list mt12" ref={listRef}>
          {scan.files.map((f, i) => {
            const it = b.items[i] ?? { status: "pending" };
            return (
              <div key={f.rel} data-i={i} className={`batch-row ${it.status}`}>
                <span className="bicon">{ICON[it.status]}</span>
                <span className="grow ellipsis" title={f.rel}>{f.rel}</span>
                {it.msg && <span className="bmsg ellipsis" title={it.msg}>{it.msg}</span>}
                {it.ms !== undefined && <span className="muted btime">{(it.ms / 1000).toFixed(1)}초</span>}
              </div>
            );
          })}
        </div>
        <div className="hint mt8">결과: {scan.out}</div>
      </div>
      <div className="modal-foot">
        {running ? (
          <>
            <span className="hint">처리 중에는 PC가 절전 모드로 들어가지 않아요. 프로그램(검은 창)을 닫지 마세요.</span>
            <div className="spacer" />
            <button className="btn danger" disabled={b.stopping} onClick={stopBatch}><Square size={13} /> 중지</button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => batchOpenOut(scan.token)}><FolderOpen size={14} /> 결과 폴더 열기</button>
            <div className="spacer" />
            <button className="btn" onClick={() => b.set({ phase: "setup" })}>설정으로</button>
            {(failed > 0 || count(["stopped", "pending"]) > 0) && (
              <button className="btn" onClick={() => { b.setSettings({ skipExisting: true }); startBatch(); }}
                data-tip="이미 저장한 사진은 건너뛰고 나머지만 다시">
                <RotateCcw size={13} /> 남은 것 다시
              </button>
            )}
            <button className="btn primary" onClick={() => b.set({ open: false })}>닫기</button>
          </>
        )}
      </div>
    </>
  );
}
