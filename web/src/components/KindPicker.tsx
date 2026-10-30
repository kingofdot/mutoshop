import { KINDS, type CutKind, type Inner } from "../kinds";
import { Segmented, Toggle } from "./controls";

/** 누끼 종류 고르기 (나무·산·아이템·인물). 누르면 종류만 바뀌고 누끼를 다시 돌리지는 않는다.
 *  설명은 말풍선 대신 아래 한 줄(KIND[kind].help)로 — 사이드 패널의 말풍선은 한 줄이라 잘린다 */
export function KindPicker({ value, onChange, disabled }: {
  value: CutKind;
  onChange: (v: CutKind) => void;
  disabled?: boolean;
}) {
  return (
    <div className="kind-grid" role="radiogroup" aria-label="누끼 종류">
      {KINDS.map((k) => (
        <button
          key={k.id}
          type="button"
          role="radio"
          aria-checked={value === k.id}
          className={`kind-card${value === k.id ? " on" : ""}`}
          disabled={disabled}
          onClick={() => onChange(k.id)}
        >
          <k.icon size={20} />
          <span>{k.label}</span>
        </button>
      ))}
    </div>
  );
}

const INNER_AUTO_HINT: Record<CutKind, string> = {
  tree: "나무: 잎 사이로 비치는 배경은 지우고, 무늬 있는 흰 부분은 남겨요.",
  mountain: "산: 안쪽은 남기고, 확실한 구멍만 지워요.",
  item: "아이템: 안쪽은 남기고, 확실한 구멍(고리 안쪽 등)만 지워요.",
  person: "인물: 안쪽은 남기고, 확실한 구멍(팔 사이 등)만 지워요.",
};

const INNER_HINT: Record<Exclude<Inner, "auto">, string> = {
  keep: "배경과 같은 색이어도 안쪽은 하나도 지우지 않아요.",
  remove: "피사체에 둘러싸인 배경색 구멍도 모두 지워요. 작은 하이라이트 점은 남겨요.",
};

/** 따기 옵션 (고급 설정 안). 편집기와 폴더 작업이 같이 쓴다 */
export function CutOptions({ kind, inner, fine, onInner, onFine }: {
  kind: CutKind;
  inner: Inner;
  fine: boolean;
  onInner: (v: Inner) => void;
  onFine: (v: boolean) => void;
}) {
  return (
    <>
      <div className="field-label">피사체 안쪽의 배경색</div>
      <Segmented
        value={inner}
        onChange={onInner}
        options={[
          { value: "auto", label: "종류대로", tip: "종류별 기본값" },
          { value: "keep", label: "남기기", tip: "안쪽은 안 지움" },
          { value: "remove", label: "지우기", tip: "갇힌 구멍도 지움" },
        ]}
      />
      <div className="hint mt8">{inner === "auto" ? INNER_AUTO_HINT[kind] : INNER_HINT[inner]}</div>
      {kind === "person" && (
        <div className="mt12">
          <Toggle on={fine} onChange={onFine} label="머리카락 최고 품질"
            desc="사진에서만 써요 · 훨씬 느리고 메모리를 많이 써요." />
        </div>
      )}
    </>
  );
}
