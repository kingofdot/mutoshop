// 사진 폴더마다 '결과를 어디에 저장할지' 기억한다 (폴더 열기 · 폴더 작업 공용).
// 예전에는 저장 위치가 하나로만 기억돼서, 다른 사진 폴더로 바꿔도 같은 곳에 섞여 저장됐다.

const KEY = "mutoshop.outs.v1";

const norm = (p: string) => p.trim().replace(/[\\/]+$/, "").toLowerCase();

function load(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** 이 사진 폴더에 마지막으로 정한 저장 위치 (없으면 null = 기본: 그 폴더 안의 '누끼') */
export function outFor(folder: string): string | null {
  if (!folder.trim()) return null;
  return load()[norm(folder)] ?? null;
}

export function rememberOut(folder: string, out: string) {
  if (!folder.trim()) return;
  const m = load();
  if (out.trim()) m[norm(folder)] = out.trim();
  else delete m[norm(folder)];
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* 무시 */
  }
}

/** 화면에 보여 줄 짧은 경로: 끝의 두 단계 (예: 직박구리\\누끼) */
export function shortDir(p: string) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("\\");
}
