"""MUTOSHOP 로컬 서버.

- /api/*  : 누끼 작업(잡 큐), 상태, 이미지 디코딩(HEIC 등 브라우저 미지원 포맷)
- /       : web/dist 의 편집기 화면

AI 엔진은 별도 작업 프로세스에서 돈다. ONNX Runtime 은 모델을 올리는 동안 파이썬 GIL 을
수십 초씩 붙잡기 때문에, 같은 프로세스에 두면 그동안 화면(정적 파일)과 API 가 모두 멈춘다.
이미지는 같은 PC 안에서만 오가므로 PNG 인코딩 없이 원시 RGBA 바이트로 주고받는다.

누끼 종류(나무·산·아이템·인물)를 고르면: 배경이 한 가지 색(미묘한 차이·그라데이션 포함)인 그림은 서버 본체에서
색으로 바로 따고(assetcut — GPU 작업 프로세스를 깨우지 않아 메모리를 적게 씀), 사진만 AI 작업 프로세스(BiRefNet)로
보낸다. 큰 사진을 다루는 무거운 일(에셋 누끼·폴더 작업의 한 장·디코딩)은 heavy.HEAVY 로 한 번에 하나씩만 돈다.
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

# numpy 에 들어 있는 OpenBLAS 는 import 하는 순간 CPU 코어마다 약 30MB 를 미리 확보(커밋)한다 — 16코어 PC 에서
# 0.5GB 를 서버 본체와 AI 작업 프로세스가 각각 (실측: 기본 492MB, 4스레드 106MB, 1스레드 10MB). Windows 는 이것을
# 실제 사용량으로 세므로 그만큼 메모리 여유가 줄어든다. 이 프로그램에서 numpy 행렬 곱을 많이 쓰는 곳은 메모리 절약
# 모드의 변형 합성곱뿐인데, 그것도 여러 스레드에서 나눠 부르므로 1스레드가 오히려 빠르다 (실측 556ms / 기본 2586ms).
# numpy 를 불러오기 전에 정해야 하며, AI 작업 프로세스는 이 환경 변수를 물려받는다. 사용자가 정해 두었으면 그대로.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import numpy as np  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.concurrency import run_in_threadpool  # noqa: E402
from fastapi.responses import HTMLResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assetcut  # noqa: E402
import batch  # noqa: E402
import heavy  # noqa: E402
import matting  # noqa: E402
from heavy import HEAVY  # noqa: E402
from matting import MODELS, Cancelled  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "web" / "dist"
DEFAULT_PORT = 8765
MAX_PIXELS = 60_000_000
# 끝난 작업의 결과(마스크·전경색, 사진 한 장에 수십 MB)를 들고 있는 시간. 편집기는 끝나자마자 받아 가고 지우므로
# 짧게 둔다 (창을 닫았거나 오류로 지우지 못한 결과가 메모리에 남지 않게). 상태·결과를 조회할 때마다 다시 센다.
DONE_TTL = 120
# 끝나지 않은 작업도 이만큼 지나면 정리 (멈춘 작업)
JOB_TTL = 30 * 60
PURGE_EVERY = 60
# 사진 누끼(AI 작업 프로세스): 이만큼(초) 아무 작업이 없으면 프로세스를 끝내 GPU·시스템 메모리를 모두 돌려준다.
# 모델은 작업 프로세스 안에서 matting.IDLE_UNLOAD(10분)에 먼저 내린다. 사진을 딸 때마다 모델을 처음부터 다시
# 올리면 한 번에 5GB 넘게 필요해 메모리가 적은 PC 에서 매번 막히므로, 쓰는 동안은 올려 둔다. 대신 쉬는 동안
# 메모리 여유가 matting.LOW_FREE_EXIT_MB(1.5GB) 밑으로 떨어지면 바로 끝낸다 (Unity 등 다른 프로그램에 양보).
WORKER_IDLE = int(os.environ.get("MUTOSHOP_WORKER_IDLE", "720"))
WATCH_EVERY = 15
INNER = ("auto", "keep", "remove")
# 종류를 골랐지만 배경이 한 가지 색이 아니라 사진용 AI 로 땄을 때의 알림
PHOTO_NOTE = "배경이 한 가지 색이 아니어서 사진용 AI로 땄어요."

app = FastAPI(title="MUTOSHOP", docs_url=None, redoc_url=None)
app.include_router(batch.router)


def _flag(v) -> bool:
    """쿼리의 켜짐/꺼짐 (1/0, true/false 모두)."""
    return str(v).strip().lower() in ("1", "true", "yes", "on")


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


def _worker_cutout(token: int, data: bytes, w: int, h: int, model: str, precise: bool, ultra: bool = False,
                   holes: bool = False, key: bool = False):
    """돌려주는 값: (마스크 bytes, 전경 RGBA bytes, 알림, 끝나면 작업 프로세스를 끝낼지)."""
    rgba = np.frombuffer(data, dtype=np.uint8).reshape(h, w, 4)

    def progress(stage: str, frac: float, msg: str) -> None:
        _w_queue.put(("progress", token, stage, frac, msg))

    mask, fg = _w_engine.cutout(rgba, model, precise, progress, _CancelFlag(token), ultra, holes, key)
    del rgba
    _w_queue.put(("device", _w_engine.device_info()))
    _w_queue.put(("loaded", _w_engine.loaded_id()))
    fg4 = np.empty((h, w, 4), dtype=np.uint8)
    fg4[..., :3] = fg
    fg4[..., 3] = 255
    del fg
    return mask.tobytes(), fg4.tobytes(), _w_engine.note, _w_engine.exit_hint


def _unpack(res) -> tuple[bytes, bytes, str | None, bool]:
    mask_b, fg_b, note = res[:3]
    return mask_b, fg_b, note, bool(res[3]) if len(res) > 3 else False


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
    note: str | None = None
    method: str | None = None  # asset: 단색 배경 에셋 누끼 / ai: 사진 AI 누끼
    photo: bool = False  # 종류를 골랐는데 사진이라 AI 로 보냄 (끝나면 그렇게 알림)
    mask: bytes | None = None
    fg: bytes | None = None
    created: float = field(default_factory=time.time)
    finished: float | None = None  # 끝난(완료·오류·취소) 때
    touched: float = field(default_factory=time.time)  # 마지막으로 조회한 때
    future: Future | None = None

    def public(self) -> dict:
        return {
            "id": self.id, "state": self.state, "stage": self.stage,
            "progress": round(self.progress, 3), "message": self.message, "error": self.error, "note": self.note,
            "method": self.method,
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
        self._busy = 0
        self._last = time.monotonic()
        self._exit_when_idle = False  # 지금 작업이 끝나면 프로세스를 끝낸다 (폴더 작업 뒤·메모리 부족을 겪은 뒤)
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._idle_watch, daemon=True).start()

    @property
    def alive(self) -> bool:
        return self._pool is not None

    def submit(self, fn, *args) -> Future:
        for attempt in range(2):
            with self._lock:  # 프로세스 정리(_idle_watch)와 엇갈리지 않게 제출과 '바쁨' 표시를 한 번에
                if self._pool is None:
                    self._pool = ProcessPoolExecutor(
                        max_workers=1, mp_context=self.ctx,
                        initializer=_worker_init, initargs=(self.queue, self.cancel),
                    )
                try:
                    f = self._pool.submit(fn, *args)
                except BrokenProcessPool:
                    self._reset_locked()
                    if attempt:
                        raise
                    continue
                self._busy += 1
                self._last = time.monotonic()
            f.add_done_callback(self._done)
            return f
        raise RuntimeError("unreachable")

    def _done(self, _f: Future) -> None:
        with self._lock:
            self._busy -= 1
            self._last = time.monotonic()
            go = self._exit_when_idle and self._busy == 0
        if go:  # 작업 프로세스의 관리 스레드에서 불리므로, 끝내기는 다른 스레드에서
            threading.Thread(target=self._exit_if_idle, daemon=True).start()

    def _exit_if_idle(self) -> None:
        with self._lock:
            if self._exit_when_idle and self._busy == 0:
                self._reset_locked()

    def request_exit(self) -> None:
        """하던 작업이 끝나면 작업 프로세스를 끝낸다 — 모델·CUDA 컨텍스트·조각난 메모리 풀까지 모두 돌려준다
        (프로세스가 끝나야만 돌아오는 것들). 다음 사진 누끼 때 다시 뜬다."""
        with self._lock:
            if self._pool is None:
                return
            self._exit_when_idle = True
            go = self._busy == 0
        if go:
            threading.Thread(target=self._exit_if_idle, daemon=True).start()

    def _idle_watch(self) -> None:
        while True:
            time.sleep(WATCH_EVERY)
            try:
                self._check_idle()
            except Exception as e:  # noqa: BLE001 - 감시는 멈추지 않는다
                print("  AI 엔진 감시 오류:", repr(e)[:200])

    def _check_idle(self) -> None:
        with self._lock:
            if self._pool is None or self._busy > 0:
                return
            idle_for = time.monotonic() - self._last
        free = matting.free_commit_mb()
        low = free is not None and free < matting.LOW_FREE_EXIT_MB
        if not low and idle_for < WORKER_IDLE:
            return
        with self._lock:
            if self._pool is None or self._busy > 0:  # 그 사이 새 작업이 들어왔음
                return
            self._reset_locked()
        if low:
            print(f"  메모리 여유가 적어 ({free / 1024:.1f}GB) AI 엔진을 껐어요 "
                  "(다른 프로그램에 메모리 양보 · 다음 사진 누끼 때 다시 켜짐)")
        else:
            print("  한동안 사진 누끼를 안 써서 AI 엔진을 쉬게 했어요 (메모리 반환 · 다음 사진 누끼 때 다시 켜짐)")

    def _reset_locked(self) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=False, cancel_futures=True)
        self._pool = None
        self.loaded = None
        self._exit_when_idle = False

    def reset(self) -> None:
        """작업 프로세스를 끝낸다 (비정상 종료 뒤 정리·메모리 반환). 다음 요청에서 새로 띄운다."""
        with self._lock:
            self._reset_locked()

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


# ----------------------------------------------------------------------------
# 작업 상태 · 결과 보관 (끝난 결과는 짧게만, 취소·삭제된 작업의 결과는 버린다)
# ----------------------------------------------------------------------------

def _register(job: Job) -> None:
    with jobs_lock:
        jobs[job.id] = job
        jobs_by_token[job.token] = job


def _alive(job: Job) -> bool:
    """아직 누가 결과를 기다리는 작업인지 (취소·삭제되지 않았고 끝나지 않음)."""
    return jobs.get(job.id) is job and job.state in ("queued", "running")


def _store_result(job: Job, mask: bytes, fg: bytes, note: str | None) -> None:
    with jobs_lock:
        if jobs.get(job.id) is not job or job.state not in ("queued", "running"):
            return  # 그 사이 취소·삭제됨 → 결과를 들고 있지 않는다
        job.mask, job.fg, job.note = mask, fg, note
        job.state, job.stage, job.progress, job.message = "done", "done", 1.0, "완료"
        job.finished = time.time()


def _fail(job: Job, msg: str) -> None:
    if job.state in ("queued", "running"):
        job.state, job.error = "error", msg
    job.finished = job.finished or time.time()


def _cancel(job: Job) -> None:
    """작업을 멈추고 결과를 놓는다 (jobs 에서 뺀 뒤에 부른다)."""
    if job.state in ("queued", "running"):
        job.state, job.message = "cancelled", "취소됨"
        f = job.future
        if f is not None:
            f.cancel()  # 아직 시작 전이면 바로 취소
        if job.method == "ai" and worker is not None:
            worker.cancel.value = job.token  # 진행 중이면 다음 확인 지점에서 중단
    job.finished = job.finished or time.time()
    job.mask = job.fg = None


def _purge_jobs() -> None:
    now = time.time()
    with jobs_lock:
        dead = [j for j in jobs.values()
                if (j.finished is not None and now - max(j.finished, j.touched) > DONE_TTL)
                or now - j.created > JOB_TTL]
        for j in dead:
            jobs.pop(j.id, None)
            jobs_by_token.pop(j.token, None)
    for j in dead:
        _cancel(j)


def _purge_loop() -> None:
    while True:
        time.sleep(PURGE_EVERY)
        try:
            _purge_jobs()
        except Exception as e:  # noqa: BLE001
            print("  작업 정리 오류:", repr(e)[:200])


def _get_job(jid: str) -> Job:
    job = jobs.get(jid)
    if job is None:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    job.touched = time.time()
    return job


def _finish(job: Job, f: Future) -> None:
    job.future = None  # 작업 ↔ Future 순환 참조 끊기 (결과 bytes 를 GC 까지 쥐고 있지 않게)
    if f.cancelled():
        if job.state in ("queued", "running"):
            job.state, job.message = "cancelled", "취소됨"
        job.finished = job.finished or time.time()
        return
    exc = f.exception()
    if exc is None:
        mask_b, fg_b, note, exit_hint = _unpack(f.result())
        if exit_hint and worker is not None:
            worker.request_exit()  # 메모리 부족을 겪었음 → 이 작업이 끝나면 프로세스째 메모리를 돌려준다
        _store_result(job, mask_b, fg_b, note or (PHOTO_NOTE if job.photo else None))
    elif isinstance(exc, Cancelled):
        if job.state in ("queued", "running"):
            job.state, job.message = "cancelled", "취소됨"
        job.finished = job.finished or time.time()
    elif isinstance(exc, BrokenProcessPool):
        _fail(job, "AI 엔진이 예기치 않게 종료되었습니다 (메모리 부족일 수 있어요). 다시 시도해 주세요.")
        if worker:
            threading.Thread(target=worker.reset, daemon=True).start()
    else:
        print("  누끼 오류:", repr(exc))
        _fail(job, _friendly_error(exc))


def _friendly_error(e: BaseException) -> str:
    msg = str(e)
    low = msg.lower()
    if matting.is_oom(e):
        return ("메모리가 부족해 누끼를 따지 못했어요. 큰 프로그램(Unity 등)을 닫거나, "
                "Windows 가상 메모리(페이지 파일)를 '시스템이 관리하는 크기'로 바꿔 주세요.")
    if isinstance(e, (OSError, ConnectionError)) and ("urlopen" in low or "connection" in low or "timed out" in low):
        return "모델을 내려받지 못했습니다. 인터넷 연결을 확인해 주세요."
    return msg or e.__class__.__name__


def _fg4_bytes(fg: np.ndarray) -> bytes:
    h, w = fg.shape[:2]
    fg4 = np.empty((h, w, 4), dtype=np.uint8)
    fg4[..., :3] = fg
    fg4[..., 3] = 255
    return fg4.tobytes()


# ----------------------------------------------------------------------------
# API
# ----------------------------------------------------------------------------

@app.get("/api/status")
def status() -> dict:
    free = matting.free_commit_mb()
    return {"app": "mutoshop", "device": worker.device, "models": matting.models_info(worker.loaded),
            "free_mb": None if free is None else int(free)}


@app.post("/api/cutout")
async def cutout(request: Request, w: int, h: int, kind: str = "", inner: str = "auto", fine: str = "0",
                 model: str = "general", precise: str = "1", ultra: str = "0", holes: str = "0", key: str = "0",
                 item: str = "0", quality: str = "", seeds: str = "", border: str = "1") -> dict:
    """누끼 작업 시작.

    kind(tree·mountain·item·person)를 주면: 배경이 한 가지 색이면 서버 본체에서 색으로(assetcut, inner 적용),
    사진이면 AI 작업 프로세스(인물은 인물 모델, fine 은 인물 사진의 최고 품질). 예전 값(model·precise·ultra·holes·
    key·item·quality)은 같이 와도 무시한다. kind 가 없으면 예전 방식 그대로.
    seeds="x,y;x,y…" (원본 px): '배경 찍기' — 찍은 자리와 이어진 배경을 지운다. border=1 이면 테두리 배경도 자동으로,
    0 이면 찍은 곳만. 찍기는 항상 색 방식(assetcut)이다 (사진이어도 찍은 자리 색 기준).
    """
    if w <= 0 or h <= 0 or w * h > MAX_PIXELS:
        raise HTTPException(400, "이미지 크기가 올바르지 않습니다.")
    kind = (kind or "").strip().lower()
    by_kind = kind in assetcut.KINDS
    if not by_kind and model not in MODELS:
        raise HTTPException(400, f"알 수 없는 모델: {model}")
    body = await request.body()
    if len(body) != w * h * 4:
        raise HTTPException(400, "이미지 데이터 크기가 맞지 않습니다.")
    _purge_jobs()
    job = Job(id=uuid.uuid4().hex[:12], token=next(_tokens), w=w, h=h)
    if by_kind:
        inner = inner if inner in INNER else "auto"
        rgba = np.frombuffer(body, dtype=np.uint8).reshape(h, w, 4)
        pts = _parse_seeds(seeds, w, h)
        use_border = not pts or _flag(border)
        # 테두리만 보는 가벼운 판정이지만 화면(이벤트 루프)을 막지 않도록 스레드에서. 복사 없이 view 를 넘긴다
        bg = None
        if use_border:
            try:
                bg = await run_in_threadpool(assetcut.detect_background, rgba[..., :3])
            except Exception as e:  # noqa: BLE001 - 판정이 실패하면 사진으로 보고 AI 로
                print("  배경 판정 오류 (AI 로 땁니다):", repr(e)[:200])
                bg = None
        if pts:
            # 찍은 자리 색이 테두리 배경과 다르면(테두리가 배경이 아닌 그림 등) 찍은 자리 색을 배경으로
            seed_bg = assetcut.background_from_seeds(rgba[..., :3], pts)
            if bg is None or (seed_bg is not None
                              and float(np.abs(np.asarray(bg["color"]) - seed_bg["color"]).max()) > 24):
                bg = seed_bg
        if bg is not None:
            job.method, job.message = "asset", "준비 중"
            _register(job)
            threading.Thread(target=_run_asset, args=(job, rgba, kind, bg, inner, pts, use_border), daemon=True).start()
            return {"id": job.id}
        del rgba
        # 사진: AI(BiRefNet). 정밀은 항상, 최고 품질은 인물 + fine 일 때만, 예전 색 따기·틈새 지우기는 쓰지 않는다
        # (흰 칼날·흰 옷을 배경으로 지울 수 있어서)
        args = ("portrait" if kind == "person" else "general", True, _flag(fine) and kind == "person", False, False)
        job.photo = True
    else:
        if _flag(item):
            # (예전 화면) 아이템 누끼는 AI 없이 색·연결만으로 → GPU 작업 프로세스를 깨우지 않고 여기서 바로
            job.method, job.message = "asset", "준비 중"
            _register(job)
            threading.Thread(target=_run_item, args=(job, body, _flag(holes)), daemon=True).start()
            return {"id": job.id}
        args = (model, _flag(precise), _flag(ultra), _flag(holes), _flag(key))
    job.method = "ai"
    if worker.warming:
        job.message = "AI 모델 준비 중 (처음 한 번만)"
    _register(job)
    try:
        job.future = worker.submit(_worker_cutout, job.token, body, w, h, *args)
    except Exception as e:  # noqa: BLE001
        _fail(job, f"AI 엔진을 시작하지 못했습니다: {e}")
        return {"id": job.id}
    job.future.add_done_callback(lambda f, j=job: _finish(j, f))
    return {"id": job.id}


def _heavy_for(job: Job) -> bool:
    """무거운 작업 자물쇠를 잡는다 (다른 누끼·폴더 작업이 돌고 있으면 기다리는 동안 그렇게 알림).
    기다리다 취소되면 False."""
    def waiting() -> None:
        job.stage, job.message = "wait", heavy.WAIT_MSG

    return heavy.acquire(waiting, lambda: not _alive(job))


def _parse_seeds(text: str, w: int, h: int) -> list[tuple[int, int]]:
    """'x,y;x,y' → [(x, y)] (사진 안의 점만, 최대 200개)."""
    out = []
    for part in (text or "").split(";"):
        try:
            xs, ys = part.split(",")
            x, y = int(round(float(xs))), int(round(float(ys)))
        except ValueError:
            continue
        if 0 <= x < w and 0 <= y < h:
            out.append((x, y))
    return out[:200]


def _run_asset(job: Job, rgba: np.ndarray, kind: str, bg: dict, inner: str,
               seeds: list[tuple[int, int]] | None = None, border: bool = True) -> None:
    """단색 배경 에셋 누끼 (서버 본체에서, AI 는 객체 보호용으로만 CPU 에서 가볍게)."""
    def progress(stage: str, frac: float, msg: str) -> None:
        if not _alive(job):
            raise Cancelled()  # 취소됐으면 다음 단계에서 멈춘다 (메모리·CPU 를 더 쓰지 않게)
        job.state, job.stage, job.progress, job.message = "running", stage, frac, msg

    if not _heavy_for(job):
        return
    try:
        if not _alive(job):
            return
        job.state, job.stage, job.message = "running", "asset", "배경 찾는 중"
        # 객체 보호용 AI 모델: 나무는 받지는 않고 이미 있으면만 넘긴다 (쓸지는 assetcut 이 정한다)
        model_path = matting.helper_model(download=kind != "tree", progress=progress)
        mask, fg, info = assetcut.cut(rgba, kind, bg, model_path, progress, inner=inner, seeds=seeds, border=border)
        note = info.get("note") if isinstance(info, dict) else None
        if not note and model_path is None and kind != "tree":
            note = "객체 확인용 AI 모델을 받지 못해 색으로만 땄어요 · 인터넷 연결을 확인한 뒤 다시 따 주세요."
        mask_b = mask.tobytes()
        del mask
        fg_b = _fg4_bytes(fg)
        del fg
    except Cancelled:
        return
    except Exception as e:  # noqa: BLE001
        print("  누끼 오류:", repr(e))
        _fail(job, _friendly_error(e))
        return
    finally:
        HEAVY.release()
    _store_result(job, mask_b, fg_b, note)


def _run_item(job: Job, body: bytes, holes: bool) -> None:
    """(예전 화면의) 아이템 누끼."""
    if not _heavy_for(job):
        return
    try:
        if not _alive(job):
            return
        job.state, job.stage, job.message = "running", "item", "아이템 윤곽 따는 중"
        rgba = np.frombuffer(body, dtype=np.uint8).reshape(job.h, job.w, 4)
        mask, fg = matting.item_cutout(rgba, holes)
        del rgba
        mask_b = mask.tobytes()
        del mask
        fg_b = _fg4_bytes(fg)
        del fg
    except ValueError as e:
        _fail(job, str(e))
        return
    except Exception as e:  # noqa: BLE001
        print("  아이템 누끼 오류:", repr(e))
        _fail(job, _friendly_error(e))
        return
    finally:
        HEAVY.release()
    _store_result(job, mask_b, fg_b, None)


def _batch_cutout(rgba: np.ndarray, st: dict, progress, stopped) -> tuple[np.ndarray, np.ndarray, str | None]:
    """폴더 작업의 AI 누끼: 편집기 누끼와 같은 작업 프로세스로 보내고 끝날 때까지 기다린다."""
    h, w = rgba.shape[:2]
    job = Job(id=uuid.uuid4().hex[:12], token=next(_tokens), w=w, h=h)
    with jobs_lock:
        jobs_by_token[job.token] = job
    strength = st.get("strength", "precise")
    try:
        fut = worker.submit(_worker_cutout, job.token, rgba.tobytes(), w, h, st.get("model", "general"),
                            strength != "basic", strength == "ultra", bool(st.get("holes", False)),
                            bool(st.get("colorKey", False)))
        while not fut.done():
            progress(job.message, job.progress)
            if stopped():
                worker.cancel.value = job.token
            time.sleep(0.25)
        try:
            res = fut.result()
        except BrokenProcessPool:
            worker.reset()
            raise RuntimeError("AI 엔진이 예기치 않게 종료되었습니다 (메모리 부족일 수 있어요).")
        except Exception as e:
            if isinstance(e, Cancelled):
                raise matting.Cancelled() from e
            raise RuntimeError(_friendly_error(e)) from e
        del fut
        mask_b, fg_b, note, exit_hint = _unpack(res)
        del res
        if exit_hint:
            worker.request_exit()
        mask = np.frombuffer(mask_b, np.uint8).reshape(h, w)
        fg = np.ascontiguousarray(np.frombuffer(fg_b, np.uint8).reshape(h, w, 4)[..., :3])
        return mask, fg, note
    finally:
        with jobs_lock:
            jobs_by_token.pop(job.token, None)


def _batch_release() -> None:
    """폴더 작업이 끝나면 AI 작업 프로세스를 끝내 모델·CUDA 메모리를 돌려준다 (다음 사진 누끼 때 다시 뜸)."""
    if worker is not None:
        worker.request_exit()


batch.set_cutout(_batch_cutout)
batch.set_release(_batch_release)


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
    if job is not None:
        _cancel(job)
    return {"ok": True}


def _decode(body: bytes) -> Response:
    from PIL import Image, ImageOps

    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except Exception:
        pass
    heavy.acquire()  # 큰 사진을 푸는 동안 다른 무거운 작업과 겹치지 않게 (기다리면 그 작업 한 장이 끝날 때까지)
    try:
        try:
            im = Image.open(io.BytesIO(body))
            im = ImageOps.exif_transpose(im)
            im = im.convert("RGBA")
        except Exception:
            raise HTTPException(415, "지원하지 않는 이미지 형식입니다.")
        if im.width * im.height > MAX_PIXELS:
            im.thumbnail((8000, 8000))
        data, w, h = im.tobytes(), im.width, im.height
        del im
    finally:
        HEAVY.release()
    return Response(data, media_type="application/octet-stream", headers={"X-Width": str(w), "X-Height": str(h)})


@app.post("/api/decode")
async def decode(request: Request) -> Response:
    """브라우저가 못 여는 포맷(HEIC/HEIF, TIFF 일부 등)을 RGBA 로 변환."""
    body = await request.body()
    return await run_in_threadpool(_decode, body)


# ----------------------------------------------------------------------------
# 정적 파일 (편집기)
# ----------------------------------------------------------------------------

@app.middleware("http")
async def _fresh_page(request: Request, call_next):
    """편집기 첫 화면(index.html)은 브라우저가 묵혀 두지 않게 — 업데이트 뒤 다시 켜면 바로 새 화면이 뜨도록.
    (assets/ 의 파일은 이름에 내용 해시가 붙어 있어 그대로 캐시해도 된다)"""
    resp = await call_next(request)
    p = request.url.path
    if p == "/" or p.endswith(".html"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


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
    """프로그램 창을 연다. WebView2 전용 창(pywebview, server/window.py)이 되면 그것으로 — 브라우저 창과 달리
    Ctrl+W 가 창을 닫지 않아 편집기에서 '사진 닫기'로 쓸 수 있다. 안 되면 Edge/Chrome '앱 모드', 그것도 없으면 기본 브라우저."""
    import importlib.util

    # 켤 때마다 주소를 조금 바꿔서 창이 예전에 저장해 둔 화면(업데이트 전)을 다시 쓰지 않게
    url = f"{url.rstrip('/')}/?v={int(time.time())}"
    if importlib.util.find_spec("webview") is not None:
        try:
            subprocess.Popen([sys.executable, str(Path(__file__).with_name("window.py")), url])
            return
        except Exception as e:  # noqa: BLE001
            print("  프로그램 창을 열지 못해 브라우저로 엽니다:", repr(e)[:120])
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

    # AI 작업 프로세스는 첫 사진 누끼 때 띄운다 (미리 띄우면 CUDA 와 모델만으로 1.5GB 넘게 쥐고 있어,
    # 메모리 여유가 적은 PC 에서 다른 프로그램·폴더 작업이 메모리 부족을 겪는다. 단색 배경 그림은 아예 안 씀)
    worker = AiWorker()
    # 끝난 작업의 결과를 오래 들고 있지 않게 (편집기가 지우지 못한 결과 포함)
    threading.Thread(target=_purge_loop, daemon=True).start()

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
