"""MUTOSHOP 프로그램 창 — Edge WebView2 (pywebview).

브라우저(Edge '앱 모드') 창은 Ctrl+W 를 브라우저가 먼저 가로채 창을 닫아 버린다. 이 창에서는 키가 편집기로
가므로 Ctrl+W = '사진 닫기'로 쓸 수 있다. 사용법: python window.py http://127.0.0.1:8765/
"""
from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path

import webview

_win = None


def _hwnd() -> int:
    """이 창의 Win32 핸들 (WinForms 창)."""
    try:
        return int(_win.native.Handle.ToInt64())
    except Exception:  # noqa: BLE001
        return int(ctypes.windll.user32.FindWindowW(None, "MUTOSHOP") or 0)


def _bring_to_front() -> bool:
    """창을 맨 앞으로 + 활성화. 탐색기에서 사진을 끌어다 놓은 뒤에도 MUTOSHOP 이 바로 활성 창이 되게.

    Windows 는 다른 창이 활성일 때 SetForegroundWindow 를 막으므로, 지금 활성 창의 입력 스레드에 잠깐
    붙었다가(AttachThreadInput) 활성화한다. 그래도 안 되면 Alt 키를 눌렀다 뗀 것처럼 해서 잠금을 푼다.
    """
    if os.name != "nt":
        return False
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    hwnd = _hwnd()
    if not hwnd:
        return False
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    fg = user32.GetForegroundWindow()
    if fg == hwnd:
        return True
    me = kernel32.GetCurrentThreadId()
    other = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    attached = bool(other and other != me and user32.AttachThreadInput(me, other, True))
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        user32.SetActiveWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(me, other, False)
    if user32.GetForegroundWindow() != hwnd:
        user32.keybd_event(0x12, 0, 0, 0)  # VK_MENU 누름
        user32.keybd_event(0x12, 0, 2, 0)  # 뗌
        user32.SetForegroundWindow(hwnd)
    return user32.GetForegroundWindow() == hwnd


class Api:
    """편집기(JS)에서 window.pywebview.api.* 로 부르는 함수들."""

    def activate(self) -> bool:
        return _bring_to_front()


def main() -> None:
    global _win
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
    # 설정(종류·브러시·접힌 칸 등 localStorage)이 창을 닫아도 남도록 저장 폴더를 고정
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "MUTOSHOP" / "webview"
    base.mkdir(parents=True, exist_ok=True)
    webview.settings["ALLOW_DOWNLOADS"] = True  # 저장 위치 고르기가 안 되는 경우 다운로드 폴더로 저장
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    _win = webview.create_window("MUTOSHOP", url, width=1600, height=1000, min_size=(960, 640),
                                 background_color="#16171a", js_api=Api())
    webview.start(gui="edgechromium", private_mode=False, storage_path=str(base))


if __name__ == "__main__":
    main()
