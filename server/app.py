"""MUTOSHOP 로컬 서버.

- /api/*  : 누끼 작업(잡 큐), 상태, 이미지 디코딩(HEIC 등 브라우저 미지원 포맷)
- /       : web/dist 의 편집기 화면

AI 엔진은 별도 작업 프로세스에서 돈다. ONNX Runtime 은 모델을 올리는 동안 파이썬 GIL 을
수십 초씩 붙잡기 때문에, 같은 프로세스에 두면 그동안 화면(정적 파일)과 API 가 모두 멈춘다.
이미지는 같은 PC 안에서만 오가므로 PNG 인코딩 없이 원시 RGBA 바이트로 주고받는다.
"""

from __future__ import annotations

import argparse
import io
import itertools
import multiprocessing as mp
import os
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from concurrent.futures import Future, ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, str(Path(__file__).resolve().parent))
import matting  # noqa: E402
from matting import MODELS, Cancelled  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "web" / "dist"
DEFAULT_PORT = 8765
MAX_PIXELS = 60_000_000
JOB_TTL = 15 * 60

app = FastAPI(title="MUTOSHOP", docs_url=None, redoc_url=None)


# ----------------------------------------------------------------------------
# AI 작업 프로세스 쪽 (아래 _worker_* 함수들은 별도 프로세스에서 실행된다)
# ----------------------------------------------------------------------------

_w_engine = None
_w_queue = None
_w_cancel = None


def _worker_init(queue, cancel) -> None:
    global _w_engine, _w_queue, _w_cancel
    _w_queue, _w_cancel = queue, cancel
    _w_engine = matting.Engine()
    queue.put(("device", _w_engine.device_info()))


def _worker_warmup(model_id: str) -> bool:
    ok = _w_engine.warmup(model_id)
    _w_queue.put(("device", _w_engine.device_info()))
    if ok:
        _w_queue.put(("loaded", model_id))
    return ok


class _CancelFlag:
    def __init__(self, token: int) -> None:
        self.token = token

    def is_set(self) -> bool:
        return _w_cancel.value == self.token


def _worker_cutout(token: int, data: bytes, w: int, h: int, model: str, precise: bool):
    rgba = np.frombuffer(data, dtype=np.uint8).reshape(h, w, 4)

    def progress(stage: str, frac: float, msg: str) -> None:
        _w_queue.put(("progress", token, stage, frac, msg))

    mask, fg = _w_engine.cutout(rgba, model, precise, progress, _CancelFlag(token))
    _w_queue.put(("device", _w_engine.device_info()))
    _w_queue.put(("loaded", model))
    fg4 = np.empty((h, w, 4), dtype=np.uint8)
    fg4[..., :3] = fg
    fg4[..., 3] = 255
    return mask.tobytes(), fg4.tobytes()


# ----------------------------------------------------------------------------
# 서버 쪽
# ----------------------------------------------------------------------------

@dataclass
class Job:
    id: str
    token: int
    w: int
    h: int
    state: str = "queued"  # queued | running | done | error | cancelled
    stage: str = "queued"
    progress: float = 0.0
    message: str = "대기 중"
    error: str | None = None
    mask: bytes | None = None
    fg: bytes | None = None
    created: float = field(default_factory=time.time)
    future: Future | None = None

    def public(self) -> dict:
        return {
            "id": self.id, "state": self.state, "stage": self.stage,
            "progress": round(self.progress, 3), "message": self.message, "error": self.error,
        }


jobs: dict[str, Job] = {}
jobs_by_token: dict[int, Job] = {}
jobs_lock = threading.Lock()
_tokens = itertools.count(1)


class AiWorker:
    """AI 엔진을 띄운 작업 프로세스 하나를 관리한다. 진행률은 큐로 받는다."""

    def __init__(self) -> None:
        self.ctx = mp.get_context("spawn")
        self.queue = self.ctx.Queue()
        self.cancel = self.ctx.Value("q", 0)
        self.device = matting.detect_device()
        self.loaded: str | None = None
        self.warming = False
        self._pool: ProcessPoolExecutor | None = None
        self._lock = threading.Lock()
        threading.Thread(target=self._pump, daemon=True).start()

    def submit(self, fn, *args) -> Future:
        for attempt in range(2):
            with self._lock:
                if self._pool is None:
                    self._pool = ProcessPoolExecutor(
                        max_workers=1, mp_context=self.ctx,
                        initializer=_worker_init, initargs=(self.queue, self.cancel),
                    )
                pool = self._pool
            try:
                return pool.submit(fn, *args)
            except BrokenProcessPool:
                if attempt:
                    raise
                self.reset()
        raise RuntimeError("unreachable")

    def reset(self) -> None:
        """작업 프로세스가 비정상 종료됐을 때, 다음 요청에서 새로 띄우도록 정리."""
        with self._lock:
            if self._pool is not None:
                self._pool.shutdown(wait=False, cancel_futures=True)
            self._pool = None
            self.loaded = None

    def _pump(self) -> None:
        while True:
            try:
                msg = self.queue.get()
            except Exception:
                time.sleep(0.2)
                continue
            kind = msg[0]
            if kind == "device":
                self.device = msg[1]
            elif kind == "loaded":
                self.loaded = msg[1]
            elif kind == "progress":
                _, token, stage, frac, text = msg
                job = jobs_by_token.get(token)
                if job is not None and job.state in ("queued", "running"):
                    job.state, job.stage, job.progress, job.message = "running", stage, frac, text


# main() 에서 만든다 — 작업 프로세스가 이 모듈을 다시 import 하므로 모듈 수준에서 만들면 안 된다.
worker: AiWorker | None = None


def _purge_jobs() -> None:
    now = time.time()
    with jobs_lock:
        for j in [j for j in jobs.values() if now - j.created > JOB_TTL]:
            jobs.pop(j.id, None)
            jobs_by_token.pop(j.token, None)


def _get_job(jid: str) -> Job:
    job = jobs.get(jid)
    if job is None:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return job


def _finish(job: Job, f: Future) -> None:
    if f.cancelled():
        job.state, job.message = "cancelled", "취소됨"
        return
    exc = f.exception()
    if exc is None:
        job.mask, job.fg = f.result()
        job.state, job.stage, job.progress, job.message = "done", "done", 1.0, "완료"
    elif isinstance(exc, Cancelled):
        job.state, job.message = "cancelled", "취소됨"
    elif isinstance(exc, BrokenProcessPool):
        job.state, job.error = "error", "AI 엔진이 예기치 않게 종료되었습니다. 다시 시도해 주세요."
        if worker:
            worker.reset()
    else:
        print("  누끼 오류:", repr(exc))
        job.state, job.error = "error", _friendly_error(exc)


def _friendly_error(e: BaseException) -> str:
    msg = str(e)
    low = msg.lower()
    if "out of memory" in low or "failed to allocate" in low:
        return "GPU 메모리가 부족합니다. 다른 프로그램을 닫거나 '빠름' 모델을 사용해 보세요."
    if isinstance(e, (OSError, ConnectionError)) and ("urlopen" in low or "connection" in low or "timed out" in low):
        return "모델을 내려받지 못했습니다. 인터넷 연결을 확인해 주세요."
    return msg or e.__class__.__name__


# ----------------------------------------------------------------------------
# API
# ----------------------------------------------------------------------------

@app.get("/api/status")
def status() -> dict:
    return {"app": "mutoshop", "device": worker.device, "models": matting.models_info(worker.loaded)}


@app.post("/api/cutout")
async def cutout(request: Request, w: int, h: int, model: str = "general", precise: int = 1) -> dict:
    if model not in MODELS:
        raise HTTPException(400, f"알 수 없는 모델: {model}")
    if w <= 0 or h <= 0 or w * h > MAX_PIXELS:
        raise HTTPException(400, "이미지 크기가 올바르지 않습니다.")
    body = await request.body()
    if len(body) != w * h * 4:
        raise HTTPException(400, "이미지 데이터 크기가 맞지 않습니다.")
    _purge_jobs()
    job = Job(id=uuid.uuid4().hex[:12], token=next(_tokens), w=w, h=h)
    if worker.warming:
        job.message = "AI 모델 준비 중 (처음 한 번만)"
    with jobs_lock:
        jobs[job.id] = job
        jobs_by_token[job.token] = job
    try:
        job.future = worker.submit(_worker_cutout, job.token, body, w, h, model, bool(precise))
    except Exception as e:  # noqa: BLE001
        job.state, job.error = "error", f"AI 엔진을 시작하지 못했습니다: {e}"
        return {"id": job.id}
    job.future.add_done_callback(lambda f, j=job: _finish(j, f))
    return {"id": job.id}


@app.get("/api/jobs/{jid}")
def job_status(jid: str) -> dict:
    return _get_job(jid).public()


@app.get("/api/jobs/{jid}/mask")
def job_mask(jid: str) -> Response:
    job = _get_job(jid)
    if job.mask is None:
        raise HTTPException(409, "아직 결과가 없습니다.")
    return Response(job.mask, media_type="application/octet-stream",
                    headers={"X-Width": str(job.w), "X-Height": str(job.h)})


@app.get("/api/jobs/{jid}/fg")
def job_fg(jid: str) -> Response:
    job = _get_job(jid)
    if job.fg is None:
        raise HTTPException(409, "아직 결과가 없습니다.")
    return Response(job.fg, media_type="application/octet-stream",
                    headers={"X-Width": str(job.w), "X-Height": str(job.h)})


@app.delete("/api/jobs/{jid}")
def job_delete(jid: str) -> dict:
    with jobs_lock:
        job = jobs.pop(jid, None)
        if job is not None:
            jobs_by_token.pop(job.token, None)
    if job is not None and job.state in ("queued", "running"):
        if job.future is not None:
            job.future.cancel()  # 아직 시작 전이면 바로 취소
        worker.cancel.value = job.token  # 진행 중이면 다음 확인 지점에서 중단
    return {"ok": True}


@app.post("/api/decode")
async def decode(request: Request) -> Response:
    """브라우저가 못 여는 포맷(HEIC/HEIF, TIFF 일부 등)을 RGBA 로 변환."""
    from PIL import Image, ImageOps

    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except Exception:
        pass
    body = await request.body()
    try:
        im = Image.open(io.BytesIO(body))
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGBA")
    except Exception:
        raise HTTPException(415, "지원하지 않는 이미지 형식입니다.")
    if im.width * im.height > MAX_PIXELS:
        im.thumbnail((8000, 8000))
    return Response(im.tobytes(), media_type="application/octet-stream",
                    headers={"X-Width": str(im.width), "X-Height": str(im.height)})


# ----------------------------------------------------------------------------
# 정적 파일 (편집기)
# ----------------------------------------------------------------------------

if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
else:
    @app.get("/", response_class=HTMLResponse)
    def no_build() -> str:
        return ("<meta charset=utf-8><body style='font-family:sans-serif;background:#16171a;color:#ddd;padding:40px'>"
                "<h2>편집기 화면이 아직 빌드되지 않았습니다</h2>"
                "<p><code>web</code> 폴더에서 <code>npm install</code> 후 <code>npm run build</code> 를 실행하세요.</p>")


# ----------------------------------------------------------------------------
# 실행
# ----------------------------------------------------------------------------

def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _is_mutoshop(port: int) -> bool:
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=1) as r:
            return json.load(r).get("app") == "mutoshop"
    except Exception:
        return False


def _open_window(url: str) -> None:
    """Edge/Chrome 의 '앱 모드'로 주소창 없는 프로그램 창을 연다. 없으면 기본 브라우저."""
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    local = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        Path(pf86) / "Microsoft/Edge/Application/msedge.exe",
        Path(pf) / "Microsoft/Edge/Application/msedge.exe",
        Path(pf) / "Google/Chrome/Application/chrome.exe",
        Path(pf86) / "Google/Chrome/Application/chrome.exe",
        Path(local) / "Google/Chrome/Application/chrome.exe",
    ]
    for exe in candidates:
        if exe.exists():
            subprocess.Popen([str(exe), f"--app={url}", "--window-size=1600,1000"])
            return
    webbrowser.open(url)


def _disable_quick_edit() -> None:
    """콘솔 창을 클릭해도 프로그램이 멈추지 않도록 '빠른 편집(선택) 모드'를 끈다."""
    if os.name != "nt":
        return
    try:
        import ctypes

        k32 = ctypes.windll.kernel32
        handle = k32.GetStdHandle(-10)  # STD_INPUT_HANDLE
        mode = ctypes.c_uint32()
        if k32.GetConsoleMode(handle, ctypes.byref(mode)):
            k32.SetConsoleMode(handle, (mode.value & ~0x0040) | 0x0080)  # QUICK_EDIT 끔, EXTENDED_FLAGS 켬
    except Exception:
        pass


def main() -> None:
    global worker
    _disable_quick_edit()
    # 한국어 Windows 콘솔(cp949)에서 표현 못 하는 문자가 있어도 출력 때문에 죽지 않도록
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="MUTOSHOP")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-window", action="store_true", help="프로그램 창을 자동으로 열지 않음")
    args = ap.parse_args()
    # 이미 실행 중이면 창만 열고, 다른 프로그램이 포트를 쓰고 있으면 다음 포트로
    while _port_open(args.port):
        if _is_mutoshop(args.port):
            url = f"http://127.0.0.1:{args.port}"
            print(f"MUTOSHOP 이 이미 실행 중입니다: {url}")
            if not args.no_window:
                _open_window(url)
            return
        args.port += 1
    url = f"http://127.0.0.1:{args.port}"

    if not args.no_window:
        def opener() -> None:
            for _ in range(200):
                if _port_open(args.port):
                    _open_window(url)
                    return
                time.sleep(0.1)

        threading.Thread(target=opener, daemon=True).start()

    worker = AiWorker()
    worker.warming = True

    def warmed(f: Future) -> None:
        worker.warming = False
        exc = f.exception()
        if exc is not None:
            print("  AI 모델 예열 실패 (누끼 시 다시 시도합니다):", exc)
        elif f.result():
            print("  AI 모델 준비 완료 (첫 누끼도 바로 처리됩니다)")

    worker.submit(_worker_warmup, "general").add_done_callback(warmed)

    dev = worker.device
    print("=" * 56)
    print("  MUTOSHOP 실행 중")
    print(f"  주소   : {url}")
    print(f"  처리   : {dev['label']}" + (f" · {dev['gpu']}" if dev.get("gpu") else ""))
    print("  이 창은 최소화해 두세요. 닫으면 프로그램이 종료됩니다.")
    print("=" * 56)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
