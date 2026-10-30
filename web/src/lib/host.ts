// 프로그램 창(server/window.py, pywebview)과 이야기하기. 브라우저 창으로 열었으면 아무 일도 안 한다.

interface HostApi {
  activate?: () => Promise<boolean>;
}

const host = () => (window as unknown as { pywebview?: { api?: HostApi } }).pywebview?.api;

/** 창을 맨 앞으로 + 활성화 — 탐색기에서 사진을 끌어다 놓은 뒤 MUTOSHOP 이 바로 활성 창이 되게 */
export function activateWindow() {
  try {
    host()?.activate?.()?.catch(() => undefined);
  } catch {
    /* 브라우저 창이면 무시 */
  }
  window.focus();
}
