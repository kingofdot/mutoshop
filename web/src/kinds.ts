// 누끼 종류 표 (편집기와 폴더 작업이 같이 씀). 종류 id 는 server/assetcut.py 의 KINDS 와 같다.
// 종류는 사용자가 직접 고른다 — 앱이 추측해서 바꾸지 않고, 카드를 눌러도 누끼를 다시 돌리지 않는다.
import { Mountain, Sword, TreePine, UserRound, type LucideIcon } from "lucide-react";
import type { CutKind, Inner } from "./types";

export type { CutKind, Inner };

export interface KindInfo {
  id: CutKind;
  /** 이름: 나무 */
  label: string;
  /** 조사 붙은 이름: 나무로 */
  ro: string;
  icon: LucideIcon;
  /** 한 줄 설명 (사이드 패널 폭에 한 줄) */
  help: string;
  /** 장당 대략 걸리는 시간 (초, 단색 배경 그림 기준) */
  sec: number;
}

export const KINDS: KindInfo[] = [
  { id: "tree", label: "나무", ro: "나무로", icon: TreePine, help: "나무·숲·풀 · 잎 사이 배경까지 지워요", sec: 1 },
  { id: "mountain", label: "산", ro: "산으로", icon: Mountain, help: "산·바위·땅 · 흰 눈·밝은 바위도 지켜요", sec: 2 },
  { id: "item", label: "아이템", ro: "아이템으로", icon: Sword, help: "칼·방패·아이콘 · 흰 칼날도 지켜요", sec: 2 },
  { id: "person", label: "인물", ro: "인물로", icon: UserRound, help: "사람·캐릭터 · 머리카락까지 섬세하게", sec: 5 },
];

export const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k])) as Record<CutKind, KindInfo>;

export const isKind = (v: unknown): v is CutKind =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(KIND, v);

export const isInner = (v: unknown): v is Inner => v === "auto" || v === "keep" || v === "remove";

/** '머리카락 최고 품질'은 인물에서만 쓴다 (느리고 메모리를 많이 씀 — 기본은 끔, 저장하지 않음) */
export const fineFor = (kind: CutKind, fine: boolean) => kind === "person" && fine;

/** 장당 대략 걸리는 시간 (초) */
export const kindSec = (kind: CutKind, fine: boolean) => (fineFor(kind, fine) ? 18 : KIND[kind].sec);
