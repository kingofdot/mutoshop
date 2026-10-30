"""폴더 일괄 누끼: 폴더의 이미지 목록 · 읽기 · 결과 저장.

편집기(브라우저)가 파일마다 열기 → 누끼 → 외곽선 등 설정 → 내보내기를 그대로 돌리고, 이 모듈은
파일 입출력만 맡는다 (직접 작업한 것과 결과가 똑같이 나오도록). 원본은 건드리지 않고 결과 폴더에
복사본만 만든다.

보안: 서버는 127.0.0.1 에서만 듣지만 다른 웹사이트가 브라우저를 통해 요청을 보낼 수는 있다. 그래서
(1) Host/Origin 이 로컬 주소인지 확인하고 (DNS 리바인딩·다른 사이트 방지), (2) 폴더를 고른 뒤 받는
임의 토큰이 있어야만 그 폴더의 파일을 읽고 쓸 수 있으며, (3) 쓰기는 결과 폴더 안으로만 허용한다.
"""

from __future__ import annotations

import io
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

router = APIRouter(prefix="/api/batch")

IMAGE_EXTS = {".jpg", ".jpeg", ".jfif", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".heic", ".heif", ".avif"}
OUT_EXTS = {"png", "jpg", "webp"}
DEFAULT_OUT = "누끼"
MAX_FILES = 5000
# 편집기에서 여는 사진과 같은 한도 (actions.ts 의 MAX_SIDE / MAX_PIXELS)
MAX_SIDE = 12000
MAX_PIXELS = 40_000_000
_SUFFIX_BAD = re.compile(r'[\\/:*?"<>|]')


@dataclass
class Session:
    folder: Path
    out: Path
    rels: list[Path]  # 원본 폴더 기준 상대 경로
    stems: list[Path]  # 결과 폴더 기준 상대 경로 (확장자 없이, 이름 겹침 처리됨)
    inputs: set[str] = field(default_factory=set)  # 원본 파일들 (덮어쓰기 방지용, 정규화된 절대 경로)
    used: float = field(default_factory=time.time)


_sessions: dict[str, Session] = {}
_lock = threading.Lock()


def _local_only(request: Request) -> None:
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]")
    if host not in ("127.0.0.1", "localhost"):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    origin = request.headers.get("origin")
    if origin and not re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$", origin):
        raise HTTPException(403, "허용되지 않은 요청입니다.")


def _session(token: str) -> Session:
    s = _sessions.get(token)
    if s is None:
        raise HTTPException(404, "폴더 정보가 만료되었습니다. 폴더를 다시 불러와 주세요.")
    s.used = time.time()
    return s


def _norm(p: Path) -> str:
    return os.path.normcase(str(p.resolve()))


def _natural_key(p: Path):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.as_posix())]


def _out_stems(rels: list[Path]) -> list[Path]:
    """결과 파일 이름(확장자 제외). 같은 폴더에 이름만 같은 a.jpg / a.png 가 있으면 a_jpg / a_png 로 구분."""
    keys = [(r.parent / r.stem).as_posix().lower() for r in rels]
    count: dict[str, int] = {}
    for k in keys:
        count[k] = count.get(k, 0) + 1
    return [r.parent / (r.stem + (f"_{r.suffix[1:].lower()}" if count[k] > 1 else "")) for r, k in zip(rels, keys)]


def _target(s: Session, i: int, ext: str, suffix: str) -> Path:
    if not 0 <= i < len(s.rels):
        raise HTTPException(404, "파일 번호가 올바르지 않습니다.")
    if ext not in OUT_EXTS:
        raise HTTPException(400, "지원하지 않는 저장 형식입니다.")
    suffix = _SUFFIX_BAD.sub("", suffix)[:40]
    stem = s.stems[i]
    p = (s.out / stem.parent / f"{stem.name}{suffix}.{ext}").resolve()
    out = s.out.resolve()
    if out != p and out not in p.parents:  # 결과 폴더 밖으로는 쓰지 않는다
        raise HTTPException(400, "저장 경로가 올바르지 않습니다.")
    return p


# ----------------------------------------------------------------------------
# 폴더 고르기 (Windows 기본 폴더 선택 창)
# ----------------------------------------------------------------------------

_PICK = r"""
import sys, tkinter as tk
from tkinter import filedialog
r = tk.Tk()
r.withdraw()
r.attributes("-topmost", True)
r.lift()
r.focus_force()
p = filedialog.askdirectory(parent=r, initialdir=sys.argv[1] or None, title=sys.argv[2], mustexist=True)
sys.stdout.buffer.write((p or "").encode("utf-8"))
"""
_pick_lock = threading.Lock()


@router.post("/pick")
def pick(request: Request, initial: str = "", title: str = "폴더 선택") -> dict:
    _local_only(request)
    if not _pick_lock.acquire(blocking=False):
        raise HTTPException(409, "폴더 선택 창이 이미 열려 있습니다.")
    try:
        init = initial if initial and Path(initial).is_dir() else ""
        r = subprocess.run(
            [sys.executable, "-c", _PICK, init, title[:60]],
            capture_output=True, timeout=1800,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        path = r.stdout.decode("utf-8", "replace").strip()
        return {"path": str(Path(path)) if path else None}
    except subprocess.TimeoutExpired:
        return {"path": None}
    finally:
        _pick_lock.release()


# ----------------------------------------------------------------------------
# 폴더 읽기 → 세션
# ----------------------------------------------------------------------------

class ScanReq(BaseModel):
    folder: str
    recursive: bool = False
    out: str | None = None


@router.post("/scan")
def scan(request: Request, req: ScanReq) -> dict:
    _local_only(request)
    folder = Path(req.folder.strip().strip('"')).expanduser()
    if not folder.is_dir():
        raise HTTPException(400, "폴더를 찾을 수 없습니다.")
    folder = folder.resolve()
    out = Path(req.out.strip().strip('"')).expanduser().resolve() if req.out else folder / DEFAULT_OUT
    out_n = _norm(out) if out.exists() else os.path.normcase(str(out))

    rels: list[Path] = []
    if req.recursive:
        for root, dirs, files in os.walk(folder):
            rp = Path(root)
            # 결과 폴더·숨김 폴더는 들어가지 않는다
            dirs[:] = [d for d in dirs if not d.startswith(".") and os.path.normcase(str((rp / d).resolve())) != out_n]
            for f in files:
                if Path(f).suffix.lower() in IMAGE_EXTS:
                    rels.append((rp / f).relative_to(folder))
            if len(rels) > MAX_FILES:
                break
    else:
        for p in folder.iterdir():
            if p.is_file() and p.suffix.lower() in IMAGE_EXTS:
                rels.append(p.relative_to(folder))
    if len(rels) > MAX_FILES:
        raise HTTPException(400, f"이미지가 너무 많습니다 (최대 {MAX_FILES}장). 폴더를 나눠서 처리해 주세요.")
    rels.sort(key=_natural_key)

    s = Session(folder=folder, out=out, rels=rels, stems=_out_stems(rels),
                inputs={_norm(folder / r) for r in rels})
    token = secrets.token_urlsafe(18)
    with _lock:
        # 오래된 세션 정리
        for k in sorted(_sessions, key=lambda k: _sessions[k].used)[:-15]:
            _sessions.pop(k, None)
        _sessions[token] = s
    sizes = []
    for r in rels:
        try:
            sizes.append((folder / r).stat().st_size)
        except OSError:
            sizes.append(0)
    return {
        "token": token, "folder": str(folder), "out": str(out),
        "files": [{"rel": str(r), "size": z} for r, z in zip(rels, sizes)],
    }


class PlanReq(BaseModel):
    ext: str
    suffix: str = ""


@router.post("/{token}/plan")
def plan(request: Request, token: str, req: PlanReq) -> dict:
    """결과 파일이 이미 있는지 (이어서 하기 / 건너뛰기용)."""
    _local_only(request)
    s = _session(token)
    return {"exists": [_target(s, i, req.ext, req.suffix).exists() for i in range(len(s.rels))]}


@router.get("/{token}/done")
def done_list(request: Request, token: str) -> dict:
    """사진마다 결과 파일(어느 형식이든, 이름 뒤 붙임 없이)이 결과 폴더에 이미 있는지 — '하나씩 작업'의 완료 표시."""
    _local_only(request)
    s = _session(token)
    return {"done": [any(_target(s, i, ext, "").exists() for ext in OUT_EXTS) for i in range(len(s.rels))]}


_thumbs: dict[tuple[str, int, int], bytes] = {}
_thumb_lock = threading.Lock()


@router.get("/{token}/thumb/{i}")
def thumb(request: Request, token: str, i: int, s: int = 144) -> Response:
    """필름 줄에 보여 줄 작은 미리보기 (JPEG, 긴 변 s px). 한 번 만든 것은 기억해 둔다."""
    _local_only(request)
    from PIL import Image, ImageOps

    sess = _session(token)
    if not 0 <= i < len(sess.rels):
        raise HTTPException(404, "파일 번호가 올바르지 않습니다.")
    size = max(48, min(int(s), 320))
    key = (token, i, size)
    with _thumb_lock:
        data = _thumbs.get(key)
    if data is None:
        try:
            from pillow_heif import register_heif_opener

            register_heif_opener()
        except Exception:
            pass
        path = sess.folder / sess.rels[i]
        try:
            with Image.open(path) as im:
                im.draft("RGB", (size * 2, size * 2))  # JPEG 는 작게 풀어서 빠르게
                im = ImageOps.exif_transpose(im)
                im.thumbnail((size, size), Image.LANCZOS)
                if im.mode in ("RGBA", "LA", "P"):
                    im = im.convert("RGBA")
                    bgim = Image.new("RGB", im.size, (40, 41, 46))  # 투명한 곳은 어두운 회색으로
                    bgim.paste(im, mask=im.split()[-1])
                    im = bgim
                else:
                    im = im.convert("RGB")
                buf = io.BytesIO()
                im.save(buf, "JPEG", quality=82)
                data = buf.getvalue()
        except FileNotFoundError:
            raise HTTPException(404, "파일이 없습니다 (옮겨졌거나 삭제됨).")
        except Exception:
            raise HTTPException(415, "미리보기를 만들 수 없는 이미지입니다.")
        with _thumb_lock:
            if len(_thumbs) > 3000:  # 너무 많아지면 비운다 (장당 수 KB)
                _thumbs.clear()
            _thumbs[key] = data
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@router.get("/{token}/file/{i}")
def read_file(request: Request, token: str, i: int) -> Response:
    """원본을 RGBA 로 (회전 정보 반영, 너무 큰 사진은 편집기와 같은 한도로 줄임)."""
    _local_only(request)
    from PIL import Image, ImageOps

    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except Exception:
        pass
    s = _session(token)
    if not 0 <= i < len(s.rels):
        raise HTTPException(404, "파일 번호가 올바르지 않습니다.")
    path = s.folder / s.rels[i]
    try:
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            im = im.convert("RGBA")
    except FileNotFoundError:
        raise HTTPException(404, "파일이 없습니다 (옮겨졌거나 삭제됨).")
    except Exception:
        raise HTTPException(415, "열 수 없는 이미지입니다 (지원하지 않는 형식이거나 손상됨).")
    ow, oh = im.size
    scale = min(1.0, MAX_SIDE / max(ow, oh), (MAX_PIXELS / (ow * oh)) ** 0.5)
    if scale < 1:
        im = im.resize((max(1, round(ow * scale)), max(1, round(oh * scale))), Image.LANCZOS)
    return Response(im.tobytes(), media_type="application/octet-stream", headers={
        "X-Width": str(im.width), "X-Height": str(im.height), "X-Orig": f"{ow}x{oh}",
    })


@router.post("/{token}/save/{i}")
async def save_file(request: Request, token: str, i: int, ext: str, suffix: str = "", overwrite: int = 1) -> dict:
    _local_only(request)
    s = _session(token)
    p = _target(s, i, ext, suffix)
    if _norm(p) in s.inputs:
        raise HTTPException(409, "원본 파일과 같은 위치라 저장하지 않았습니다. 결과 폴더를 바꿔 주세요.")
    if p.exists() and not overwrite:
        return {"path": str(p), "skipped": True}
    body = await request.body()
    if not body:
        raise HTTPException(400, "저장할 내용이 없습니다.")
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".part")
        tmp.write_bytes(body)
        os.replace(tmp, p)
    except OSError as e:
        raise HTTPException(500, f"저장하지 못했습니다: {e.strerror or e}")
    return {"path": str(p), "skipped": False}


@router.post("/{token}/overwrite/{i}")
async def overwrite_original(request: Request, token: str, i: int) -> dict:
    """원본 파일에 그대로 덮어쓰기 (같은 이름 · 편집기가 원본 형식으로 만든 내용). 폴더 안의 원본만."""
    _local_only(request)
    s = _session(token)
    if not 0 <= i < len(s.rels):
        raise HTTPException(404, "파일 번호가 올바르지 않습니다.")
    p = (s.folder / s.rels[i]).resolve()
    if s.folder.resolve() not in p.parents:
        raise HTTPException(400, "저장 경로가 올바르지 않습니다.")
    body = await request.body()
    if not body:
        raise HTTPException(400, "저장할 내용이 없습니다.")
    try:
        tmp = p.with_name(p.name + ".part")
        tmp.write_bytes(body)
        os.replace(tmp, p)
    except OSError as e:
        raise HTTPException(500, f"덮어쓰지 못했습니다: {e.strerror or e}")
    with _thumb_lock:  # 미리보기도 새로
        for k in [k for k in _thumbs if k[0] == token and k[1] == i]:
            _thumbs.pop(k, None)
    return {"path": str(p)}


@router.post("/{token}/open")
def open_out(request: Request, token: str) -> dict:
    """결과 폴더를 탐색기로 연다."""
    _local_only(request)
    s = _session(token)
    target = s.out if s.out.exists() else s.folder
    if os.name == "nt":
        os.startfile(str(target))  # noqa: S606 - 로컬 탐색기 열기
    return {"ok": True}


# ----------------------------------------------------------------------------
# 서버에서 폴더 전체를 처리 (브라우저는 진행 상황만 본다)
# ----------------------------------------------------------------------------
# 예전에는 사진마다 편집기(브라우저 WebGL)에 열어 처리했는데, 큰 사진을 연달아 다루면 브라우저 메모리가
# 크게 불어나 메모리가 적은 PC 에서 'Out of Memory' 가 났다. 이제 읽기 → 누끼 → 외곽선·배경 → 저장을
# 모두 여기서 한 장씩 처리한다 (사진 한 장에 수백 MB).

_cutout_fn = None  # app.py 가 넣어 준다: (rgba, 설정, 진행 알림, 멈춤 확인) → (마스크, 전경색, 알림)
_release_fn = None  # app.py 가 넣어 준다: 폴더 작업이 끝난 뒤 AI 작업 프로세스를 끝내 메모리를 돌려준다

# 사진 한 장을 시작하기 전에 이만큼(MB)의 메모리 여유가 없으면 잠깐 기다린다 (다른 프로그램이 메모리 부족을 겪지 않게)
MIN_FREE_MB = 800
MEM_WAIT_MAX = 300  # 초: 그래도 안 되면 그냥 해 본다


def _despeckle(mask, size: int):
    """잔티 제거: 주요 객체와 떨어진 작은 덩어리(가로·세로 모두 size px 이하)를 지운다 (8방향 연결, 옅은 가장자리 포함)."""
    import cv2
    import numpy as np

    n, lab, stats, _ = cv2.connectedComponentsWithStats((mask > 8).astype(np.uint8), connectivity=8)
    if n <= 1:
        return mask, 0
    small = (stats[:, cv2.CC_STAT_WIDTH] <= size) & (stats[:, cv2.CC_STAT_HEIGHT] <= size)
    small[0] = False
    k = int(small.sum())
    if k:
        mask = mask.copy()
        mask[small[lab]] = 0
    return mask, k


def set_cutout(fn) -> None:
    global _cutout_fn
    _cutout_fn = fn


def set_release(fn) -> None:
    global _release_fn
    _release_fn = fn


def load_rgba(path: Path):
    """원본을 RGBA numpy 로 (회전 정보 반영, 너무 큰 사진은 편집기와 같은 한도로 줄임). 읽기 전용 배열."""
    import numpy as np
    from PIL import Image, ImageOps

    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except Exception:
        pass
    # 사진 한 장 크기의 사본이 겹치지 않게: 회전은 제자리에서, 다 쓴 이미지는 바로 닫는다
    im = None
    try:
        im = Image.open(path)
        im.load()
        ImageOps.exif_transpose(im, in_place=True)
        if im.mode != "RGBA":
            rgba = im.convert("RGBA")
            im.close()
            im = rgba
    except FileNotFoundError:
        raise ValueError("파일이 없습니다 (옮겨졌거나 삭제됨).")
    except MemoryError:
        if im is not None:
            im.close()
        raise  # 손상된 파일이 아니라 메모리 부족 (폴더 작업이 '메모리 부족'으로 알린다)
    except Exception:
        if im is not None:
            im.close()
        raise ValueError("열 수 없는 이미지입니다 (지원하지 않는 형식이거나 손상됨).")
    try:
        ow, oh = im.size
        scale = min(1.0, MAX_SIDE / max(ow, oh), (MAX_PIXELS / (ow * oh)) ** 0.5)
        if scale < 1:
            small = im.resize((max(1, round(ow * scale)), max(1, round(oh * scale))), Image.LANCZOS)
            im.close()
            im = small
        return np.asarray(im)  # 픽셀을 복사해 온다 (이미지를 닫아도 남음)
    finally:
        im.close()


@dataclass
class Run:
    total: int
    state: str = "running"  # running | done | stopped
    index: int = -1
    message: str = "준비 중"
    progress: float = 0.0
    items: list = field(default_factory=list)
    started: float = field(default_factory=time.time)
    finished: float = 0.0
    stop: bool = False

    def public(self) -> dict:
        return {"state": self.state, "index": self.index, "message": self.message, "progress": round(self.progress, 3),
                "items": self.items, "started": self.started, "finished": self.finished}


_runs: dict[str, Run] = {}


class RunReq(BaseModel):
    settings: dict


@router.post("/{token}/run")
def run_folder(request: Request, token: str, req: RunReq) -> dict:
    _local_only(request)
    s = _session(token)
    r = _runs.get(token)
    if r is not None and r.state == "running":
        raise HTTPException(409, "이미 처리 중입니다.")
    now = time.time()
    for k in [k for k, v in _runs.items() if v.state != "running" and v.finished and now - v.finished > 3600]:
        _runs.pop(k, None)  # 한 시간 넘게 지난 결과는 정리
    r = Run(total=len(s.rels), items=[{"status": "pending"} for _ in s.rels])
    _runs[token] = r
    threading.Thread(target=_process, args=(s, r, req.settings), daemon=True).start()
    return {"ok": True}


@router.get("/{token}/status")
def run_status(request: Request, token: str) -> dict:
    _local_only(request)
    r = _runs.get(token)
    if r is None:
        raise HTTPException(404, "진행 중인 작업이 없습니다.")
    return r.public()


@router.post("/{token}/stop")
def run_stop(request: Request, token: str) -> dict:
    _local_only(request)
    r = _runs.get(token)
    if r is not None:
        r.stop = True
    return {"ok": True}


def _wait_memory(run: Run, free_mb) -> None:
    """메모리 여유가 MIN_FREE_MB 밑이면 잠깐 기다린다 (최대 MEM_WAIT_MAX 초, 멈추면 바로). 그래도 안 되면 그냥 해 본다."""
    free = free_mb()
    if free is None or free >= MIN_FREE_MB:
        return
    end = time.monotonic() + MEM_WAIT_MAX
    while not run.stop and time.monotonic() < end:
        free = free_mb()
        if free is None or free >= MIN_FREE_MB:
            return
        run.message = f"메모리 여유를 기다리는 중 (여유 {free / 1024:.1f}GB) · 다른 프로그램을 닫으면 바로 이어서 해요"
        run.progress = 0.0
        time.sleep(2)


def _cut_settings(st: dict, kinds) -> tuple[str, str, bool]:
    """폴더 작업 설정의 종류·안쪽 처리·최고 품질. 예전 설정의 mode=item 은 아이템으로, 다른 예전 값은 무시한다."""
    kind = st.get("kind") or ("item" if st.get("mode") == "item" else "tree")
    if kind not in kinds:
        kind = "tree"
    inner = st.get("inner") if st.get("inner") in ("auto", "keep", "remove") else "auto"
    fine = bool(st.get("fine")) and kind == "person"
    return kind, inner, fine


def _release_ai(used_ai: bool) -> None:
    """폴더 작업 뒤 정리: 객체 보호용 AI(ISNet) 세션을 바로 내리고, 사진 AI 를 썼으면 작업 프로세스도 끝낸다."""
    import assetcut
    from heavy import HEAVY

    rel = getattr(assetcut, "release", None)
    # 편집기 누끼가 지금 쓰는 중이면 건드리지 않는다 (그쪽이 끝난 뒤 쉬는 시간이 지나면 알아서 내려간다)
    if callable(rel) and HEAVY.acquire(blocking=False):
        try:
            rel()
        except Exception as e:  # noqa: BLE001
            print("  AI 세션 정리 오류:", repr(e)[:200])
        finally:
            HEAVY.release()
    if used_ai and _release_fn is not None:
        try:
            _release_fn()
        except Exception as e:  # noqa: BLE001
            print("  AI 엔진 정리 오류:", repr(e)[:200])


def _process(sess: Session, run: Run, st: dict) -> None:
    import numpy as np

    import assetcut
    import matting
    import render
    from heavy import HEAVY, WAIT_MSG, acquire

    kind, inner, fine = _cut_settings(st, assetcut.KINDS)
    # 사진(배경이 단색이 아님)은 AI 작업 프로세스로: 인물은 인물 모델, 정밀은 항상, 최고 품질은 인물 + fine 일 때만.
    # 예전의 색 따기·틈새 지우기(흰 칼날·흰 옷을 지울 수 있음)는 쓰지 않는다
    ai = {"model": "portrait" if kind == "person" else "general", "strength": "ultra" if fine else "precise",
          "holes": False, "colorKey": False}
    helper = None  # 객체 보호용 AI 모델 경로 (처음 필요할 때 한 번 확인, 없으면 False)
    used_ai = False

    def progress(msg: str, frac: float) -> None:
        run.message, run.progress = msg, frac

    def cut_progress(_stage: str, frac: float, msg: str) -> None:
        progress(msg, frac)

    ext = "jpg" if st.get("format") == "jpeg" else st.get("format", "png")
    suffix = st.get("suffix", "")
    try:
        for i, rel in enumerate(sess.rels):
            if run.stop:
                break
            try:
                target = _target(sess, i, ext, suffix)
            except HTTPException as e:
                run.items[i] = {"status": "error", "msg": e.detail}
                continue
            if st.get("skipExisting", True) and target.exists():
                run.items[i] = {"status": "skipped", "msg": "이미 있음"}
                continue
            if _norm(target) in sess.inputs:
                run.items[i] = {"status": "error", "msg": "원본 파일과 같은 위치라 저장하지 않았어요."}
                continue
            run.index = i
            run.progress = 0.0
            run.items[i] = {"status": "running"}
            t0 = time.perf_counter()
            rgba = mask = fg = img = data = None  # 사진 한 장 크기의 배열들 (장마다 바로 놓는다)
            try:
                _wait_memory(run, matting.free_commit_mb)
                if run.stop:
                    run.items[i] = {"status": "stopped", "msg": "중지됨"}
                    break
                run.message = "여는 중"
                rgba = load_rgba(sess.folder / rel)
                note = None
                warn = False
                # 누끼 + 합성 + 형식 변환은 무거우니 편집기 누끼와 겹치지 않게 한 번에 하나만
                if not acquire(lambda: setattr(run, "message", WAIT_MSG), lambda: run.stop):
                    run.items[i] = {"status": "stopped", "msg": "중지됨"}
                    break
                try:
                    if st.get("keepAlpha", True) and rgba[..., 3].min() < 255:
                        mask, fg = rgba[..., 3].copy(), np.ascontiguousarray(rgba[..., :3])
                        note = "이미 투명한 이미지 · 투명도 그대로 사용"
                    else:
                        run.message = "배경 찾는 중"
                        bg = assetcut.detect_background(rgba[..., :3])  # 테두리만 본다 (복사 없이 view 로)
                        if bg is not None:
                            # 단색(에 가까운) 배경: 서버 본체에서 바로 (AI 는 객체 보호용으로 CPU 에서만)
                            if helper is None:
                                helper = matting.helper_model(download=kind != "tree", progress=cut_progress) or False
                            mask, fg, info = assetcut.cut(rgba, kind, bg, helper or None, cut_progress, inner=inner)
                            if isinstance(info, dict):
                                note = info.get("note")
                                warn = bool(info.get("warn"))
                            info = None
                            if not helper and kind != "tree":
                                note = note or "객체 확인용 AI 모델이 없어 색으로만 땄어요 (인터넷 연결 확인)"
                                warn = True
                        else:
                            used_ai = True
                            mask, fg, note = _cutout_fn(rgba, ai, progress, lambda: run.stop)
                            if note:
                                note, warn = "메모리 부족 · 가벼운 모델로 처리됨", True
                            else:
                                note = "배경이 한 가지 색이 아니어서 사진용 AI로 땄어요"
                    rgba = None
                    ds = int(st.get("despeckle", 5) or 0)
                    if ds > 0 and not (note or "").startswith("이미 투명한"):
                        mask, specks = _despeckle(mask, ds)
                        if specks:
                            note = f"{note} · 잔티 {specks}개 지움" if note else f"잔티 {specks}개 지움"
                    if run.stop:
                        run.items[i] = {"status": "stopped", "msg": "중지됨"}
                        break
                    run.message = "외곽선·배경 입히고 저장하는 중"
                    img, pad = render.compose(fg, mask, st)
                    fg = None
                    data, found = render.encode(img, mask, pad, st)
                    img = mask = None
                finally:
                    HEAVY.release()
                target.parent.mkdir(parents=True, exist_ok=True)
                tmp = target.with_name(target.name + ".part")
                tmp.write_bytes(data)
                os.replace(tmp, target)
                data = None
                ms = (time.perf_counter() - t0) * 1000
                if not found:
                    run.items[i] = {"status": "warn", "msg": "피사체를 찾지 못했어요 (빈 이미지로 저장됨)", "ms": ms}
                elif warn:
                    run.items[i] = {"status": "warn", "msg": note, "ms": ms}
                else:
                    run.items[i] = {"status": "done", "msg": note, "ms": ms} if note else {"status": "done", "ms": ms}
            except matting.Cancelled:
                run.items[i] = {"status": "stopped", "msg": "중지됨"}
                break
            except ValueError as e:
                run.items[i] = {"status": "error", "msg": str(e), "ms": (time.perf_counter() - t0) * 1000}
            except Exception as e:  # noqa: BLE001
                print("  폴더 작업 오류:", rel, repr(e)[:200])
                msg = str(e)
                if matting.is_oom(e):
                    msg = "메모리가 부족해 처리하지 못했어요. 큰 프로그램을 닫고 '남은 것 다시'를 눌러 주세요."
                run.items[i] = {"status": "error", "msg": msg[:200] or e.__class__.__name__,
                                "ms": (time.perf_counter() - t0) * 1000}
            finally:
                rgba = mask = fg = img = data = None
    finally:
        # 폴더 작업이 끝나면 쓰던 AI 를 바로 내려 메모리를 돌려준다 (다음 누끼 때 다시 올린다)
        _release_ai(used_ai)
        run.index = -1
        run.state = "stopped" if run.stop else "done"
        run.finished = time.time()
