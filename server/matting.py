"""MUTOSHOP 누끼 엔진.

BiRefNet(ONNX)으로 피사체 마스크를 예측한 뒤, 고해상도 사진에서도 경계가 또렷하도록
다음 단계를 거친다.

1. 1차 추론: 전체 사진을 1024x1024로 줄여 피사체 위치와 대략의 마스크를 얻는다.
2. 정밀 추론: 피사체 영역만 잘라 다시 추론해 실효 해상도를 높인다(머리카락·털 등 세부).
3. 색 오염 제거: 경계 픽셀에 섞인 배경색을 걷어낸 전경색(F)을 추정한다(blur-fusion).

(가이디드 필터 업샘플링도 시험했으나 제품 사진에서 그림자를 경계로 끌어들이는
부작용이 있어 쓰지 않는다.)
"""

from __future__ import annotations

import os
import threading
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cv2
import numpy as np


def _add_nvidia_dll_dirs() -> None:
    """pip로 설치된 CUDA/cuDNN DLL 폴더를 검색 경로에 추가 (cuDNN 하위 DLL 지연 로드 대응)."""
    import glob
    import sys

    if os.name != "nt":
        return
    dirs = sorted(glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")))
    for d in dirs:
        try:
            os.add_dll_directory(d)
        except OSError:
            pass
    if dirs:
        os.environ["PATH"] = os.pathsep.join(dirs) + os.pathsep + os.environ.get("PATH", "")


_add_nvidia_dll_dirs()

try:
    import onnxruntime as ort

    ort.set_default_logger_severity(3)
except ImportError:  # pragma: no cover - requirements.txt 에 포함
    ort = None

MODELS_DIR = Path(os.environ.get("MUTOSHOP_MODELS", Path(__file__).resolve().parent / "models"))
INPUT_SIZE = 1024
# 최고 품질 모드의 고해상도 타일: 피사체 긴 변을 몇 장으로 나눌지, 이웃 타일끼리 얼마나 겹칠지
TILES_ACROSS = 3
TILE_OVERLAP = 0.25
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
_RELEASE = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/"

Progress = Callable[[str, float, str], None]


class Cancelled(Exception):
    pass


@dataclass(frozen=True)
class ModelSpec:
    id: str
    name: str
    desc: str
    file: str
    size: int
    std: tuple[float, float, float] = (0.229, 0.224, 0.225)  # 입력 정규화 (평균은 공통)
    kind: str = "logits"  # 출력: logits(→시그모이드) / prob(→최소·최대로 0~1)
    hidden: bool = False  # 모델 고르기 목록에 보이지 않음 (내부용)

    @property
    def url(self) -> str:
        return _RELEASE + self.file

    @property
    def path(self) -> Path:
        return MODELS_DIR / self.file


MODELS: dict[str, ModelSpec] = {
    m.id: m
    for m in (
        ModelSpec("general", "정밀", "머리카락·털·복잡한 경계까지 가장 섬세하게 (권장)",
                  "BiRefNet-general-epoch_244.onnx", 972_666_916),
        ModelSpec("portrait", "인물", "사람 사진 특화 — 머리카락 결과가 더 자연스러움",
                  "BiRefNet-portrait-epoch_150.onnx", 972_666_916),
        ModelSpec("lite", "빠름", "가벼운 모델 — 속도 우선, 단순한 제품 사진에 적합",
                  "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx", 224_005_088),
        # 흰 배경 그림을 색으로 딸 때 '안쪽'만 정하는 도우미. BiRefNet 은 변형 합성곱 때문에 추론 순간
        # GPU·시스템 메모리를 5GB 넘게 쓰지만, 이 모델은 1GB 미만에 7배 빠르다.
        ModelSpec("helper", "도우미", "흰 배경 그림용 가벼운 모델", "isnet-general-use.onnx", 178_648_008,
                  std=(1.0, 1.0, 1.0), kind="prob", hidden=True),
    )
}
HELPER = "helper"
# 초: 이만큼 사진 누끼를 안 쓰면 모델을 내려 GPU·시스템 메모리를 돌려준다. 사진을 딸 때마다 처음부터 다시 올리면
# (냉시작) 한 번에 5GB 넘게 필요해 메모리가 적은 PC 에서 매번 막히므로, 쓰는 동안은 올려 둔다. 대신 메모리 여유가
# LOW_FREE_EXIT_MB 밑으로 떨어지면 바로 내린다 (다른 프로그램에 양보).
IDLE_UNLOAD = int(os.environ.get("MUTOSHOP_IDLE_UNLOAD", "600"))


def detect_device() -> dict:
    """세션을 만들지 않고 쓸 수 있는 실행 장치를 추정 (서버 프로세스에서 상태 표시용)."""
    kind = "cpu"
    if ort is not None:
        avail = ort.get_available_providers()
        if "CUDAExecutionProvider" in avail:
            kind = "cuda"
        elif "DmlExecutionProvider" in avail:
            kind = "dml"
    label = {"cuda": "GPU 가속 (CUDA)", "dml": "GPU 가속 (DirectML)", "cpu": "CPU"}[kind]
    return {"kind": kind, "label": label, "gpu": _detect_gpu_name() if kind != "cpu" else None, "confirmed": False}


_dl_locks = {}
_dl_guard = threading.Lock()


def ensure_model_file(spec: ModelSpec, progress: Progress, cancel) -> Path:
    """모델 파일이 없으면 내려받는다 (처음 한 번). 서버 본체·작업 프로세스 어디서든 쓸 수 있다."""
    with _dl_guard:
        lock = _dl_locks.setdefault(spec.id, threading.Lock())
    with lock:
        if spec.path.exists() and spec.path.stat().st_size == spec.size:
            return spec.path
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        part = spec.path.with_suffix(".part")
        req = urllib.request.Request(spec.url, headers={"User-Agent": "mutoshop/1.0"})
        mb = 1024 * 1024
        with urllib.request.urlopen(req, timeout=60) as resp, open(part, "wb") as f:
            total = int(resp.headers.get("Content-Length") or spec.size)
            done = 0
            last = 0.0
            while True:
                if cancel is not None and cancel.is_set():
                    f.close()
                    part.unlink(missing_ok=True)
                    raise Cancelled()
                chunk = resp.read(mb)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                now = time.monotonic()
                if now - last > 0.2:
                    last = now
                    progress("download", done / total, f"AI 모델 다운로드 중 (최초 1회) {done // mb} / {total // mb} MB")
        if part.stat().st_size != spec.size:
            part.unlink(missing_ok=True)
            raise RuntimeError("모델 다운로드가 완료되지 않았습니다. 인터넷 연결을 확인하고 다시 시도하세요.")
        os.replace(part, spec.path)
        return spec.path


def models_info(loaded: str | None = None) -> list[dict]:
    return [
        {
            "id": m.id, "name": m.name, "desc": m.desc, "size": m.size,
            "downloaded": m.path.exists() and m.path.stat().st_size == m.size,
            "loaded": m.id == loaded,
        }
        for m in MODELS.values() if not m.hidden
    ]


_helper_fail = -1e9


def helper_model(download: bool = True, progress: Progress | None = None) -> Path | None:
    """객체 보호용 도우미 AI(ISNet) 모델 파일. 이미 받아 두었으면 그 경로, 없으면 download 일 때만 받는다.

    받지 못하면 None — 그 뒤 10분 동안은 다시 받으려 하지 않는다 (인터넷이 안 될 때 누끼마다 1분씩 기다리지 않게).
    """
    global _helper_fail
    spec = MODELS[HELPER]
    if spec.path.exists() and spec.path.stat().st_size == spec.size:
        return spec.path
    if not download or time.monotonic() - _helper_fail < 600:
        return None
    try:
        return ensure_model_file(spec, progress or (lambda *_: None), None)
    except Cancelled:
        raise
    except Exception as e:  # noqa: BLE001 - 인터넷이 안 되면 AI 보호 없이 (색으로만) 딴다
        _helper_fail = time.monotonic()
        print("  도우미 모델을 받지 못해 색으로만 땁니다:", repr(e)[:120])
        return None


# ----------------------------------------------------------------------------
# 이미지 처리 유틸
# ----------------------------------------------------------------------------

def _resize(img: np.ndarray, w: int, h: int) -> np.ndarray:
    """축마다 축소/확대에 맞는 보간을 골라 리사이즈 (축소는 INTER_AREA로 앨리어싱 방지)."""
    ih, iw = img.shape[:2]
    if iw != w:
        img = cv2.resize(img, (w, ih), interpolation=cv2.INTER_AREA if w < iw else cv2.INTER_LINEAR)
    if ih != h:
        img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA if h < ih else cv2.INTER_LINEAR)
    return img


def _edge_weights(h: int, w: int, ramp: int, top: bool, bottom: bool, left: bool, right: bool) -> np.ndarray:
    """가장자리에서 0 → 안쪽 ramp px 에서 1 로 오르는 섞기 가중치 (지정한 변만)."""
    ramp = max(1, min(ramp, h // 2, w // 2))
    wy = np.ones(h, np.float32)
    wx = np.ones(w, np.float32)
    r = np.linspace(0.0, 1.0, ramp, dtype=np.float32)
    if top:
        wy[:ramp] = np.minimum(wy[:ramp], r)
    if bottom:
        wy[-ramp:] = np.minimum(wy[-ramp:], r[::-1])
    if left:
        wx[:ramp] = np.minimum(wx[:ramp], r)
    if right:
        wx[-ramp:] = np.minimum(wx[-ramp:], r[::-1])
    return wy[:, None] * wx[None, :]


def _tiles_needed(box: tuple[int, int, int, int]) -> bool:
    """앞 단계가 이미 원본에 가까운 해상도로 분석한 작은 영역이면 타일 분석은 이득이 없다."""
    return max(box[2] - box[0], box[3] - box[1]) >= INPUT_SIZE * 1.3


def _local_mean(img: np.ndarray, weight: np.ndarray, radius: int) -> tuple[np.ndarray, np.ndarray]:
    """weight 가 있는 픽셀들만의 반경 radius 안 평균색, 그리고 그 근처 weight 합(0이면 근거 없음).
    매끄러운 값이므로 줄인 해상도에서 계산한다."""
    h, w = weight.shape
    s = max(1, radius // 8)
    lw, lh = -(-w // s), -(-h // s)
    small = lambda a: cv2.resize(a, (lw, lh), interpolation=cv2.INTER_AREA) if s > 1 else a
    k = max(3, (2 * radius) // s + 1)
    wl = cv2.blur(small(weight), (k, k))
    cl = cv2.blur(small(img * weight[..., None]), (k, k)) / np.maximum(wl, 1e-4)[..., None]
    big = lambda a: cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR) if s > 1 else a
    return big(cl), big(wl)


def _color_guard(rgb: np.ndarray, coarse: np.ndarray, fine: np.ndarray, radius: int,
                 free: np.ndarray) -> np.ndarray:
    """타일 결과가 사진 색과 맞을 때만 크게 바꾸도록 제한한다 (free=1 인 곳은 제한 없음).

    타일은 주변을 못 보고 피사체 일부(바닥 띠·어두운 문 안쪽 등)를 배경으로 오판할 때가 있다.
    그 픽셀 색을 근처의 확실한 피사체 색·배경 색과 비교해서, 배경처럼 보이는 곳만 지우고
    피사체처럼 보이는 곳만 되살린다. 근거가 없으면 작은 변화(경계 다듬기)만 허용한다.
    """
    img = rgb.astype(np.float32)
    f_mean, f_w = _local_mean(img, (coarse > 0.98).astype(np.float32), radius)
    b_mean, b_w = _local_mean(img, (coarse < 0.02).astype(np.float32), radius)
    df = np.linalg.norm(img - f_mean, axis=2)
    db = np.linalg.norm(img - b_mean, axis=2)
    # +1: 배경색에 가까움, -1: 피사체색에 가까움 (한쪽 기준이 근처에 없으면 판단 보류)
    e = np.where((f_w > 1e-3) & (b_w > 1e-3), (df - db) / (df + db + 1.0), 0.0).astype(np.float32)
    change = fine - coarse
    likely = np.where(change < 0, e, -e)  # 이 변화가 색으로 뒷받침되는 정도
    # 윤곽 바로 옆이라도 색이 분명히 반대면(흰 배경 앞의 초록 바닥 줄 등) 크게 바꾸지 않는다:
    # 옮겨 가려는 쪽 색과 절대적으로 멀고(색 차 60~100 이상), 반대쪽 색에 더 가까울 때
    far = np.where(change < 0, db, df)
    strong = np.clip((far - 60.0) / 40.0, 0.0, 1.0) * np.clip((-likely - 0.3) / 0.3, 0.0, 1.0)
    free = free * (1.0 - strong)
    limit = 0.2 + np.maximum(np.clip((likely + 0.1) / 0.3, 0.0, 1.0), free)
    return coarse + np.clip(change, -limit, limit)


def _tile_starts(n: int, t: int) -> list[int]:
    """길이 n 을 크기 t 타일로 TILE_OVERLAP 이상 겹치게 고르게 덮는 시작 위치들."""
    if n <= t:
        return [0]
    count = int(np.ceil((n - t) / (t * (1 - TILE_OVERLAP)))) + 1
    return [int(round(v)) for v in np.linspace(0, n - t, count)]


def _bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """img(HxWxC) 를 실수 좌표 (x, y) 들에서 쌍선형 보간으로 읽는다."""
    h, w = img.shape[:2]
    x = np.clip(x, 0, w - 1)
    y = np.clip(y, 0, h - 1)
    x0 = x.astype(np.int32)
    y0 = y.astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    top = img[y0, x0] * (1 - fx) + img[y0, x1] * fx
    bot = img[y1, x0] * (1 - fx) + img[y1, x1] * fx
    return top * (1 - fy) + bot * fy


def estimate_foreground(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """경계(0<α<1) 픽셀의 배경색 번짐을 제거한 전경색. 경계 밖은 원본 그대로.

    Approximate Fast Foreground Colour Estimation (Forte & Pitié, 2021):
      F = F̄ + α·(I − α·F̄ − (1−α)·B̄),  F̄ = blur(F·α)/blur(α),  B̄ = blur(B·(1−α))/blur(1−α)
    를 큰 반경 → 작은 반경으로 두 번 적용한다.

    흐린 항(F̄, B̄)은 매끄러우므로 축소 해상도에서 계산하고, 사진의 세부가 담긴
    보정항(I, α)만 원본 해상도의 경계 픽셀에서 계산한다 → 대형 사진도 빠르다.
    """
    h, w = alpha.shape
    band = (alpha > 0.004) & (alpha < 0.996)
    ys, xs = np.nonzero(band)
    if ys.size == 0:
        return rgb.copy()
    r1 = int(np.clip(round(max(h, w) / 25), 20, 160))
    r2 = max(3, r1 // 15)
    s = max(1, r2 // 3)  # 작은 반경이 축소 해상도에서도 3px 이상 되도록
    lw, lh = -(-w // s), -(-h // s)
    k1, k2 = max(1, round(r1 / s)), max(1, round(r2 / s))
    eps = 1e-5

    I = (cv2.resize(rgb, (lw, lh), interpolation=cv2.INTER_AREA) if s > 1 else rgb).astype(np.float32) * (1 / 255)
    a = cv2.resize(alpha.astype(np.float32), (lw, lh), interpolation=cv2.INTER_AREA) if s > 1 else alpha.astype(np.float32)
    a3 = a[..., None]
    na3 = 1.0 - a3
    # 1단계 (큰 반경): F = B = I 로 시작
    ba = cv2.blur(a, (k1, k1))[..., None]
    bF = cv2.blur(I * a3, (k1, k1)) / (ba + eps)
    bB = cv2.blur(I * na3, (k1, k1)) / ((1 - ba) + eps)
    F = np.clip(bF + a3 * (I - a3 * bF - na3 * bB), 0, 1)
    # 2단계 (작은 반경)
    ba = cv2.blur(a, (k2, k2))[..., None]
    bF = cv2.blur(F * a3, (k2, k2)) / (ba + eps)
    bB = cv2.blur(bB * na3, (k2, k2)) / ((1 - ba) + eps)

    # 최종 식은 원본 해상도의 경계 픽셀에서만
    sx = (xs + 0.5) / s - 0.5
    sy = (ys + 0.5) / s - 0.5
    fF = _bilinear(bF, sx, sy)
    fB = _bilinear(bB, sx, sy)
    Ib = rgb[ys, xs].astype(np.float32) * (1 / 255)
    ab = alpha[ys, xs].astype(np.float32)[:, None]
    Fb = np.clip(fF + ab * (Ib - ab * fF - (1 - ab) * fB), 0, 1)
    out = rgb.copy()
    out[ys, xs] = (Fb * 255 + 0.5).astype(np.uint8)
    return out


HOLE_TOL = 24  # 배경색과 채널별 차이가 이 이하인 평평한 곳을 '배경이 비치는 구멍' 후보로


def uniform_light_bg(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray | None:
    """AI 가 배경으로 본 곳이 흰색·밝은 단색이면 그 색(RGB float32), 아니면 None.
    (편집기의 detectBackground 와 같은 기준)"""
    h, w = alpha.shape
    step = max(1, int(np.sqrt(h * w / 150_000)))
    a = alpha[::step, ::step]
    c = rgb[::step, ::step][a < 0.03].astype(np.float32)
    if len(c) < 200:
        return None
    med = np.median(c, axis=0)
    mad = np.median(np.abs(c - med).sum(axis=1))
    luma = 0.2126 * med[0] + 0.7152 * med[1] + 0.0722 * med[2]
    if mad < 18 and luma > 200 and med.max() - med.min() < 30:
        return med
    return None


def border_key_bg(rgb: np.ndarray) -> np.ndarray | None:
    """AI 를 돌리기 전에, 사진 테두리만 보고 '깨끗한 흰·밝은 단색 배경'인지 (key_background 와 같은 기준)."""
    img = rgb.astype(np.float32)
    border = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
    med = np.median(border, axis=0)
    luma = 0.2126 * med[0] + 0.7152 * med[1] + 0.0722 * med[2]
    if luma <= 200 or med.max() - med.min() >= 30:
        return None
    if (np.abs(border - med).max(axis=1) <= 12).mean() < 0.95:
        return None
    return med


def key_background(rgb: np.ndarray, ai: np.ndarray) -> np.ndarray | None:
    """색으로 따도 될 만큼 깨끗한 단색 배경이면 그 색. (흰 캔버스에 그린 그림·제품 사진 등)

    사진의 흰 벽·흐린 배경은 단색처럼 보여도 얼룩·그라데이션이 있어 색만으로 가르면 배경 물건까지
    남으므로, 사진 테두리가 거의 전부(95% 이상) 그 배경색일 때만 인정한다.
    """
    bg = uniform_light_bg(rgb, ai)
    if bg is None:
        return None
    img = rgb.astype(np.float32)
    border = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
    if (np.abs(border - bg).max(axis=1) <= 12).mean() < 0.95:
        return None
    return bg


def color_key(rgb: np.ndarray, ai: np.ndarray, bg: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray] | None:
    """흰·밝은 단색 배경: 배경색이 아닌 것은 전부 피사체로, 경계는 색으로 픽셀 단위까지.

    AI(BiRefNet)는 '주인공 하나'를 고르는 모델이라, 다리+큰 나무만 남기고 옆의 나무·먼 숲을 지우거나
    애매한 곳을 뭉툭한 덩어리로 만든다. 배경이 단색이면 색이 훨씬 정확하므로:
      - 배경색과 다른 픽셀은 모두 남기고 (잎 하나, 난간 한 가닥까지)
      - 배경 바로 옆 픽셀은 '근처의 진한 색 대비 얼마나 옅은지'로 투명도를 매기며
      - 잎 사이로 비치는 작은 배경 조각(흰 점)은 투명하게
      - AI 가 확신한 안쪽(흰 옷·흰 꽃처럼 배경색과 같은 부분)은 지킨다.
    배경이 깨끗한 단색이 아니면 None.  돌려주는 값: (알파, 배경색)
    """
    if bg is None:
        bg = key_background(rgb, ai)
    if bg is None:
        return None
    h, w = ai.shape
    img = rgb.astype(np.float32)
    d = np.abs(img - bg).max(axis=2)
    disk = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    # 배경 잡음 수준: AI 가 배경으로 본 곳 중 실제로 배경색에 가까운 픽셀들의 흔들림
    sure = cv2.erode((ai < 0.02).astype(np.uint8), np.ones((15, 15), np.uint8)) > 0
    ds = d[sure][::7]
    ds = ds[ds < 30]
    t0 = float(np.clip(np.percentile(ds, 99) + 3, 6, 24)) if ds.size > 100 else 10.0
    rc = max(2, int(round(max(h, w) * 0.0008)))
    d_near = cv2.dilate(d, disk(2 * rc))  # 근처에서 배경과 가장 먼 색 = 그 경계의 원래 색 진하기

    # 잎 사이로 비치는 작은 배경 조각: 배경색에 가깝거나 주변보다 훨씬 옅은 작은 덩어리
    cand = ((d <= t0 + 12) | ((d < 0.5 * d_near) & (d <= 80))).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(cand, connectivity=8)
    area = stats[:, cv2.CC_STAT_AREA].copy()
    area[0] = 1 << 30
    speck = area[lab] <= max(64, int(h * w * 1.5e-5))
    # AI 가 확신한 안쪽은 지킨다 — 다만 1~2px 짜리 점은 그 안에서도 배경이 비친 것으로 본다
    er = max(2, int(round(max(h, w) * 0.003)))
    core = cv2.erode((ai > 0.95).astype(np.uint8), disk(er)) > 0
    speck &= ~(core & (area[lab] > 16))

    seen = (d <= t0) | speck
    near = cv2.dilate(seen.astype(np.uint8), disk(rc)) > 0
    a_edge = np.clip((d - t0) / np.maximum(d_near - t0, 24.0), 0.0, 1.0)
    a_in = np.clip((d - t0) / 12.0, 0.0, 1.0)
    alpha = np.where(near, a_edge, a_in)
    alpha = np.maximum(alpha, core & ~speck)
    return alpha.astype(np.float32), bg


def item_cutout(rgba: np.ndarray, holes: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """아이템·스프라이트용 누끼: 사진 테두리와 이어진 배경색 영역만 지우고, 그 안쪽은 전부 남긴다.

    흰 칼날·흰 보석처럼 배경과 같은 색이 아이템 안에 있어도 테두리 쪽 배경과 이어져 있지 않으면 지우지
    않는다. AI 를 쓰지 않아 GPU 가 필요 없고 바로 끝난다. 배경은 어떤 색이든 단색이면 된다.
    holes: 아이템 안에 갇힌 배경색 틈(고리 안쪽 등)도 투명하게.
    돌려주는 값: (마스크 uint8, 배경색을 빼 되살린 전경색 uint8)
    """
    rgb = np.ascontiguousarray(rgba[..., :3])
    h, w = rgb.shape[:2]
    img = rgb.astype(np.float32)
    border = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
    bg = np.median(border, axis=0)
    bd = np.abs(border - bg).max(axis=1)
    if (bd <= 16).mean() < 0.9:
        raise ValueError("아이템 누끼는 배경이 한 가지 색일 때만 쓸 수 있어요. 화면을 새로 고친 뒤(F5) 종류를 골라 "
                         "'누끼 따기'를 눌러 주세요 — 사진이면 자동으로 AI가 따요.")
    t0 = float(np.clip(np.percentile(bd[bd <= 16], 99) + 3, 4, 24))
    d = np.abs(img - bg).max(axis=2)
    near = d <= t0
    # 1) 바깥 = 사진 테두리에서 굴려 넣은 '공'(반지름 r)이 닿는 배경색. 공은 r*2 보다 좁은 틈을 못 지나가므로,
    #    밝은 칼날처럼 윤곽선이 1~3px 끊긴 곳으로 바깥 배경이 스며들어 '안쪽'까지 지우는 일이 없다.
    r = max(2, int(round(max(h, w) * 0.0015)))
    ball = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    core = cv2.erode(near.astype(np.uint8), ball, borderType=cv2.BORDER_REPLICATE)
    n, lab = cv2.connectedComponents(core, connectivity=4)
    edge_labels = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    edge_labels = edge_labels[edge_labels > 0]
    outside = (cv2.dilate(np.isin(lab, edge_labels).astype(np.uint8), ball) > 0) & near
    # 2) 남은 배경색 덩어리: 바깥과 맞닿아 있으면서 어디서나 좁은 것(가드 사이 홈 등)은 바깥으로,
    #    좁은 틈 너머로 넓게 퍼진 것(칼날 안의 흰 부분)이나 갇힌 것은 '안쪽'으로 보고 남긴다.
    rest = (near & ~outside).astype(np.uint8)
    n, lab = cv2.connectedComponents(rest, connectivity=4)
    if n > 1:
        width = np.zeros(n, np.float32)  # 덩어리마다 가장 넓은 곳의 반폭 (아이템 색까지 거리)
        dt = cv2.distanceTransform(near.astype(np.uint8), cv2.DIST_L2, 3)
        np.maximum.at(width, lab[rest > 0], dt[rest > 0])
        touch = np.unique(lab[(cv2.dilate(outside.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & (rest > 0)])
        kill = touch[(touch > 0) & (width[touch] <= r + 1)]
        outside |= np.isin(lab, kill)
        edge_labels = np.concatenate([kill, [0]])  # 아래 '갇힌 틈' 처리에서 제외할 것
    if holes:
        # 갇힌 배경색 틈: 아주 작은 점(하이라이트)은 남기고 어느 정도 큰 것만 (위 1단계의 '안쪽' 덩어리 중에서)
        area = np.bincount(lab.ravel(), minlength=n)
        big = np.flatnonzero(area >= max(16, int(h * w * 2e-5)))
        big = big[(big > 0) & ~np.isin(big, edge_labels)]
        outside |= np.isin(lab, big)
    alpha = (~outside).astype(np.float32)
    # 배경 바로 옆 두 줄만: 근처 아이템 색(가장 진한 색)과 비교해 배경색이 섞인 만큼 반투명.
    # 어두운 가드는 밝은 테두리 없이, 밝은 칼날은 칼날 색 기준으로 — 안쪽은 건드리지 않는다
    # (배경색 픽셀은 바깥이면 이미 0, 아니면 '안쪽'이므로 건드리지 않는다 — 윤곽선 안쪽의 흰 칼날이 깎이지 않게)
    ring = (cv2.dilate(outside.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & ~outside & ~near
    d_near = cv2.dilate(np.where(outside, 0, d).astype(np.float32), np.ones((5, 5), np.uint8))
    alpha[ring] = np.clip((d[ring] - t0) / np.maximum(d_near[ring] - t0, 12.0), 0.0, 1.0)
    src_a = rgba[..., 3]
    if src_a.min() < 255:
        alpha = alpha * (src_a.astype(np.float32) / 255.0)
    fg = unmix_foreground(rgb, alpha, bg, rgb.copy())
    return (np.clip(alpha, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), fg


def unmix_foreground(rgb: np.ndarray, alpha: np.ndarray, bg: np.ndarray, fg: np.ndarray) -> np.ndarray:
    """배경색을 아는 경우: 반투명 픽셀에서 배경색을 정확히 빼 원래 색을 되돌린다 (I = αF + (1-α)B)."""
    band = (alpha > 0.02) & (alpha < 0.98)
    ys, xs = np.nonzero(band)
    if ys.size == 0:
        return fg
    i = rgb[ys, xs].astype(np.float32)
    a = alpha[ys, xs, None]
    out = fg.copy()
    out[ys, xs] = (np.clip(bg + (i - bg) / a, 0, 255) + 0.5).astype(np.uint8)
    return out


def remove_bg_holes(rgb: np.ndarray, alpha: np.ndarray, min_alpha: float = 0.5) -> np.ndarray:
    """흰·밝은 단색 배경에서, 피사체에 둘러싸여 AI 가 피사체로 착각한 배경(가지 사이로 보이는 하늘 등)을 지운다.

    배경색과 아주 가깝고 평평한(질감 없는) 넓은 덩어리만 구멍으로 본다 — 작은 반사광이나 질감 있는
    흰 부분은 건드리지 않는다. 구멍 둘레에서 배경색 쪽으로 옅어지는 안개는 색 거리만큼 반투명하게.
    """
    bg = uniform_light_bg(rgb, alpha)
    if bg is None:
        return alpha
    h, w = alpha.shape
    img = rgb.astype(np.float32)
    d = np.abs(img - bg).max(axis=2)
    g = img.mean(axis=2)
    var = cv2.blur(g * g, (5, 5)) - cv2.blur(g, (5, 5)) ** 2
    cand = ((d <= HOLE_TOL) & (var <= 2.5 ** 2) & (alpha > min_alpha)).astype(np.uint8)
    cand = cv2.morphologyEx(cand, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(cand, connectivity=8)
    if n <= 1:
        return alpha
    area = stats[:, cv2.CC_STAT_AREA]
    big = np.flatnonzero(area >= max(256, int(h * w * 2e-4)))
    big = big[big > 0]
    if big.size == 0:
        return alpha
    # 큰 구멍이 있으면 그 근처(긴 변의 5%)의 작은 조각도 같은 배경이 비치는 곳으로 본다
    near_r = max(h, w) * 0.05
    dist = cv2.distanceTransform((~np.isin(lab, big)).astype(np.uint8), cv2.DIST_L2, 3)
    touched = np.unique(lab[(dist <= near_r) & (lab > 0)])
    ids = np.union1d(big, touched[area[touched] >= 48])
    holes = np.isin(lab, ids)
    dist = cv2.distanceTransform((~holes).astype(np.uint8), cv2.DIST_L2, 3)
    # 구멍 둘레: 배경색 쪽으로 옅어지는 안개를 색 거리만큼 반투명하게
    rad = max(4.0, max(h, w) * 0.006)
    zw = np.clip(2.0 - dist / rad, 0.0, 1.0)
    ca = np.clip((d - HOLE_TOL) / (HOLE_TOL * 2.5), 0.0, 1.0).astype(np.float32)
    ca[holes] = 0.0
    out = alpha * (1.0 - zw) + np.minimum(alpha, ca) * zw
    # 더 넓은 이웃: 배경색 그대로인 점(도트 그림의 디더링, 잎 사이 틈)만 투명하게
    nw = np.clip((near_r - dist) / (near_r * 0.25), 0.0, 1.0)
    ca2 = np.clip((d - HOLE_TOL) / HOLE_TOL, 0.0, 1.0)
    out = out * (1.0 - nw) + np.minimum(out, ca2) * nw
    return out.astype(np.float32)


# ----------------------------------------------------------------------------
# 엔진
# ----------------------------------------------------------------------------

class Engine:
    def __init__(self) -> None:
        self._infer_lock = threading.Lock()
        self._sessions: dict[str, "ort.InferenceSession"] = {}
        self._providers = self._pick_providers()
        first = self._providers[0] if self._providers else None
        first = first[0] if isinstance(first, tuple) else first
        # GPU 실행 장치가 있는지. 메모리 부족 등으로 한 번 실패해도 바꾸지 않는다 (예전엔 그 뒤로 계속 CPU 였다)
        self._cuda = first == "CUDAExecutionProvider"
        self._gpu = first in ("CUDAExecutionProvider", "DmlExecutionProvider")
        self._cuda_ready = False  # 이 프로세스에서 CUDA 를 이미 띄웠는지 (컨텍스트는 프로세스가 끝날 때까지 남는다)
        self._active: str | None = None  # 큰 모델이 실제로 쓴 실행 장치
        self._gpu_run_opts = None
        if ort is not None:
            # 추론이 끝날 때마다 GPU 메모리 풀을 비운다. 6GB급 GPU에서 메모리를 계속 쥐고 있으면
            # 다음 추론 때 부족분이 시스템 RAM으로 밀려나(페이징) 2배 가까이 느려진다.
            self._gpu_run_opts = ort.RunOptions()
            self._gpu_run_opts.add_run_config_entry("memory.enable_memory_arena_shrinkage", "gpu:0")
        self._unshrunk = False  # 메모리 풀을 비우지 않은 추론 뒤 (바로 이어지는 추론이 있을 때만 그렇게 한다)
        self._gpu_name = _detect_gpu_name()
        self._sess_spec: dict[int, ModelSpec] = {}
        self.note: str | None = None  # 마지막 누끼에 대한 알림 (예: 메모리 부족으로 가벼운 모델 사용)
        # 마지막 누끼가 메모리 부족을 겪었음 → 끝나면 작업 프로세스를 끝내 메모리를 모두 돌려주자 (CUDA 컨텍스트와
        # 조각난 메모리 풀은 프로세스가 끝나야만 돌아온다)
        self.exit_hint = False
        self._wait_failed = -1e9  # 메모리 여유를 기다렸지만 끝내 모자랐던 때
        self._last_used = time.monotonic()
        threading.Thread(target=self._idle_loop, daemon=True).start()

    def _release(self) -> None:
        """올려 둔 모델을 모두 내린다 (GPU 메모리·시스템 커밋 메모리 반환)."""
        import gc

        for s in list(self._sessions.values()):
            close = getattr(s, "close", None)  # 메모리 절약 모드 묶음: 계산용 스레드도 정리
            if close is not None:
                try:
                    close()
                except Exception:
                    pass
        self._sessions.clear()
        self._sess_spec.clear()
        self._unshrunk = False
        gc.collect()

    def _idle_loop(self) -> None:
        """IDLE_UNLOAD 초 동안 안 쓰면 모델을 내린다. (메모리 여유가 아주 적어지면 서버 본체가 이 작업 프로세스를
        통째로 끝낸다 — 모델뿐 아니라 CUDA 컨텍스트까지 돌려주도록. app.AiWorker._check_idle)"""
        while True:
            time.sleep(min(15, max(1, IDLE_UNLOAD / 4)))
            if not self._sessions or time.monotonic() - self._last_used < IDLE_UNLOAD:
                continue
            if self._infer_lock.acquire(blocking=False):
                try:
                    if self._sessions and time.monotonic() - self._last_used >= IDLE_UNLOAD:
                        self._release()
                finally:
                    self._infer_lock.release()

    # -- 장치 ---------------------------------------------------------------

    @staticmethod
    def _pick_providers() -> list:
        if ort is None:
            return []
        avail = ort.get_available_providers()
        if "CUDAExecutionProvider" in avail:
            if hasattr(ort, "preload_dlls"):
                try:  # pip로 설치된 CUDA/cuDNN DLL을 미리 로드
                    ort.preload_dlls()
                except Exception:
                    pass
            return [
                ("CUDAExecutionProvider", {
                    "device_id": 0,
                    "arena_extend_strategy": "kSameAsRequested",
                    "cudnn_conv_algo_search": "DEFAULT",
                }),
                "CPUExecutionProvider",
            ]
        if "DmlExecutionProvider" in avail:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]
        return ["CPUExecutionProvider"]

    def loaded_id(self) -> str | None:
        """지금 올라와 있는 큰 모델 (도우미 모델 제외)."""
        for k in list(self._sessions):
            base = k.split(":")[0]
            if base != HELPER:
                return base
        return None

    def device_info(self) -> dict:
        first = self._active
        if first is None and self._providers:
            p = self._providers[0]
            first = p[0] if isinstance(p, tuple) else p
        kind = {"CUDAExecutionProvider": "cuda", "DmlExecutionProvider": "dml"}.get(first or "", "cpu")
        label = {"cuda": "GPU 가속 (CUDA)", "dml": "GPU 가속 (DirectML)", "cpu": "CPU"}[kind]
        return {
            "kind": kind,
            "label": label,
            "gpu": self._gpu_name if kind != "cpu" else None,
            "confirmed": self._active is not None,
        }


    # -- 모델 준비 -----------------------------------------------------------

    def ensure_model(self, spec: ModelSpec, progress: Progress, cancel: threading.Event) -> Path:
        return ensure_model_file(spec, progress, cancel)

    @staticmethod
    def _lowmem_dir(spec: ModelSpec) -> Path:
        return spec.path.with_suffix(".lowmem")

    def _ensure_lowmem(self, spec: ModelSpec, progress: Progress) -> bool:
        """메모리 절약 모드용으로 나눈 모델을 준비한다 (처음 한 번). 못 하면 False."""
        try:
            import lowmem

            d = self._lowmem_dir(spec)
            if not lowmem.is_built(d):
                # 나누는 동안 모델 전체를 한 번 읽어 2GB 넘게 쓴다 — 여유가 없으면 이번엔 건너뛴다 (다른 프로그램 보호)
                free = free_commit_mb()
                if free is not None and free < LOWMEM_BUILD_MB:
                    print(f"  메모리 여유가 적어 ({free / 1024:.1f}GB) 메모리 절약 모드 준비를 다음으로 미뤘어요")
                    return False
                progress("load", 0.05, "메모리 절약 모드 준비 중 (처음 한 번, 몇 초)")
                lowmem.build(spec.path, d)
            return True
        except Exception as e:  # onnx 미설치·메모리 부족 등
            print("  메모리 절약 모드 준비 실패:", repr(e)[:200])
            return False

    def _session_options(self, cpu: bool) -> "ort.SessionOptions":
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        so.log_severity_level = 3
        if cpu:
            # CPU 세션: 메모리 풀·메모리 패턴을 끄면 추론이 끝날 때 바로 돌려준다
            # (켜 두면 추론에 쓴 수 GB 를 세션이 살아 있는 동안 계속 쥐고 있다 — ISNet 실측 2.8GB)
            so.enable_cpu_mem_arena = False
            so.enable_mem_pattern = False
        elif not self._cuda:  # DirectML 은 메모리 패턴·병렬 실행을 지원하지 않는다
            so.enable_mem_pattern = False
            so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        return so

    def _new_session(self, path: Path, cpu: bool):
        providers = ["CPUExecutionProvider"] if cpu else self._providers
        return ort.InferenceSession(str(path), sess_options=self._session_options(cpu), providers=providers)

    def _session(self, spec: ModelSpec, low: bool = False, cpu: bool = False) -> "ort.InferenceSession":
        """모델 세션 (한 번에 하나의 모델만 메모리에 둔다). cpu: GPU 를 쓰지 않는다 (가벼운 도우미 모델).

        메모리 부족으로 못 올리면 예외를 그대로 던진다 — 부르는 쪽이 더 아끼는 방식으로 다시 시도한다.
        메모리가 아닌 이유(드라이버 등)로 GPU 에 못 올리면 이번 세션만 CPU 로 (다음엔 다시 GPU 부터).
        """
        if ort is None:
            raise RuntimeError("onnxruntime 이 설치되지 않았습니다.")
        key = spec.id + (":lowmem" if low else "") + (":cpu" if cpu else "")
        sess = self._sessions.get(key)
        if sess is not None:
            return sess
        # VRAM 절약: 한 번에 하나의 모델만 메모리에 둔다
        self._release()
        on_cpu = cpu or not self._gpu
        if low:
            import lowmem

            sess = lowmem.LowMemSession(self._lowmem_dir(spec),
                                        ["CPUExecutionProvider"] if on_cpu else self._providers,
                                        self._session_options(on_cpu))
        else:
            try:
                sess = self._new_session(spec.path, on_cpu)
            except Exception as e:
                if on_cpu or _is_oom(e):
                    raise
                print("  GPU 로 모델을 올리지 못해 이번에는 CPU 로 돌려요:", repr(e)[:200])
                sess = self._new_session(spec.path, True)
                on_cpu = True
            if not on_cpu and sess.get_providers()[0] == "CPUExecutionProvider":
                # GPU 실행 장치를 못 불러와 조용히 CPU 로 올라갔으면 CPU 용 설정(메모리 풀 끔)으로 다시 올린다
                sess = None
                sess = self._new_session(spec.path, True)
        first = sess.get_providers()[0]
        if first == "CUDAExecutionProvider":
            self._cuda_ready = True
        if spec.id != HELPER:
            self._active = first
        self._sessions[key] = sess
        self._sess_spec[id(sess)] = spec
        return sess

    def warmup(self, model_id: str = "general") -> bool:
        """모델을 미리 올리고 GPU 초기화를 끝내 둔다 (첫 누끼가 오래 걸리지 않도록)."""
        spec = MODELS.get(model_id)
        if spec is None or not (spec.path.exists() and spec.path.stat().st_size == spec.size):
            return False
        with self._infer_lock:
            sess = self._session(spec)
            x = np.zeros((1, 3, INPUT_SIZE, INPUT_SIZE), dtype=np.float32)
            sess.run(None, {sess.get_inputs()[0].name: x}, self._opts_for(sess))
            self._last_used = time.monotonic()
        return True

    # -- 추론 ----------------------------------------------------------------

    def _opts_for(self, sess, shrink: bool = True):
        """CUDA 세션이면 추론 뒤 GPU 메모리 풀을 비우는 실행 옵션. shrink=False 는 같은 누끼 안에서 바로 다음
        추론이 이어질 때만 (비웠다가 곧바로 같은 크기를 다시 잡지 않게)."""
        if self._gpu_run_opts is None or sess.get_providers()[0] != "CUDAExecutionProvider":
            return None
        return self._gpu_run_opts if shrink else None

    def _run(self, sess, feeds: dict, shrink: bool = True):
        opts = self._opts_for(sess, shrink)
        out = sess.run(None, feeds, opts)
        self._unshrunk = not shrink and sess.get_providers()[0] == "CUDAExecutionProvider"
        return out

    def _predict(self, sess, rgb: np.ndarray, flips: tuple[bool, ...] = (False,), shrink: bool = True) -> np.ndarray:
        """RGB uint8 → 같은 크기의 전경 확률 맵 [0,1] float32.

        flips: (False, True) 이면 좌우 반전한 사진도 분석해 평균 낸다 (잔털·수염이 더 매끄럽고 잡티가 줄어듦).
        shrink: 마지막 추론 뒤 GPU 메모리 풀을 비울지 (반전 분석 사이에서는 비우지 않는다).
        """
        h, w = rgb.shape[:2]
        spec = self._sess_spec.get(id(sess)) or MODELS["general"]
        x = _resize(rgb, INPUT_SIZE, INPUT_SIZE).astype(np.float32) / 255.0
        x = ((x - _MEAN) / np.array(spec.std, dtype=np.float32)).transpose(2, 0, 1)
        name = sess.get_inputs()[0].name
        prob = None
        for k, flip in enumerate(flips):
            xi = np.ascontiguousarray((x[:, :, ::-1] if flip else x)[None])
            out = self._run(sess, {name: xi}, shrink and k == len(flips) - 1)[0]
            raw = out.reshape(out.shape[-2], out.shape[-1]).astype(np.float32)
            del out
            if spec.kind == "prob":
                lo, hi = float(raw.min()), float(raw.max())
                p = (raw - lo) / max(hi - lo, 1e-6)
            else:
                p = 1.0 / (1.0 + np.exp(-np.clip(raw, -30, 30)))
            if flip:
                p = p[:, ::-1]
            prob = p if prob is None else prob + p
        prob = prob * (1.0 / len(flips))
        return cv2.resize(np.ascontiguousarray(prob), (w, h), interpolation=cv2.INTER_LINEAR)

    @staticmethod
    def _subject_box(prob: np.ndarray) -> tuple[int, int, int, int] | None:
        h, w = prob.shape
        for th in (0.5, 0.2):
            m = prob > th
            rows = np.flatnonzero(m.any(axis=1))
            if rows.size:
                cols = np.flatnonzero(m.any(axis=0))
                break
        else:
            return None
        x0, x1, y0, y1 = cols[0], cols[-1] + 1, rows[0], rows[-1] + 1
        bw, bh = x1 - x0, y1 - y0
        margin = max(16, int(0.08 * max(bw, bh)))
        x0, y0, x1, y1 = x0 - margin, y0 - margin, x1 + margin, y1 + margin
        # 너무 작은 영역은 과도한 확대를 피하고, 극단적인 종횡비는 2:1 이내로 맞춘다
        min_side = int(min(INPUT_SIZE * 0.75, w, h))
        cw, ch = x1 - x0, y1 - y0
        cw2 = max(cw, min_side, (ch + 1) // 2)
        ch2 = max(ch, min_side, (cw2 + 1) // 2)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        x0, x1 = int(round(cx - cw2 / 2)), int(round(cx + cw2 / 2))
        y0, y1 = int(round(cy - ch2 / 2)), int(round(cy + ch2 / 2))
        # 이미지 경계 안으로 밀어 넣기
        if x0 < 0:
            x1, x0 = min(w, x1 - x0), 0
        if x1 > w:
            x0, x1 = max(0, x0 - (x1 - w)), w
        if y0 < 0:
            y1, y0 = min(h, y1 - y0), 0
        if y1 > h:
            y0, y1 = max(0, y0 - (y1 - h)), h
        return x0, y0, x1, y1

    @staticmethod
    def _paste(prob: np.ndarray, p2: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
        """정밀 추론 결과를 이음새 없이 합친다 (이미지 경계가 아닌 쪽 가장자리만 서서히 섞음)."""
        x0, y0, x1, y1 = box
        h, w = prob.shape
        ch, cw = p2.shape
        wt = _edge_weights(ch, cw, max(8, min(cw, ch) // 16), y0 > 0, y1 < h, x0 > 0, x1 < w)
        out = prob.copy()
        out[y0:y1, x0:x1] = prob[y0:y1, x0:x1] * (1.0 - wt) + p2 * wt
        return out

    def _tile_refine(self, sess, rgb: np.ndarray, prob: np.ndarray, box: tuple[int, int, int, int],
                     progress: Progress, check: Callable[[], None]) -> np.ndarray:
        """최고 품질: 피사체 영역을 겹치는 타일로 나눠 더 높은 해상도로 다시 분석한다.

        타일 하나는 피사체 전체를 보지 못하므로, 확실한 안쪽·바깥은 앞 단계 결과를 그대로 두고
        앞 단계가 뭉개 놓은 경계 띠(머리카락·털·잔가지)에서만 고해상도 결과로 바꾼다.
        경계가 지나가지 않는 타일은 건너뛴다.
        """
        x0, y0, x1, y1 = box
        bw, bh = x1 - x0, y1 - y0
        side = max(bw, bh)
        h, w = prob.shape
        scale = side / INPUT_SIZE  # 앞 단계에서 모델 1px 이 덮던 원본 px 수

        # 불확실한 띠: 앞 단계의 반투명 경계를 (모델 해상도 기준 약 5px 만큼) 넓힌 영역.
        # 단, 실제 피사체 윤곽(0.5 경계) 근처만 — 피사체 한가운데의 작은 얼룩까지 넓히면
        # 전체를 못 보는 타일이 그 자리를 배경으로 오판해 구멍을 낸다.
        sub = prob[y0:y1, x0:x1]
        unsure = ((sub > 0.02) & (sub < 0.98)).astype(np.uint8)
        if not unsure.any():
            return prob
        r = max(6, int(round(5 * scale)))
        disk = lambda rad: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * rad + 1, 2 * rad + 1))
        core = (sub > 0.5).astype(np.uint8)
        outline = cv2.morphologyEx(core, cv2.MORPH_GRADIENT, disk(1))
        band = cv2.dilate(unsure, disk(r)) & cv2.dilate(outline, disk(3 * r))
        if not band.any():
            return prob
        band_w = np.minimum(1.0, cv2.GaussianBlur(band.astype(np.float32), (0, 0), r / 3) * 1.6)

        # 타일 배치: 긴 변을 TILES_ACROSS 장이 OVERLAP 만큼 겹치며 덮도록 (원본보다 확대하지는 않음)
        t = int(max(INPUT_SIZE, np.ceil(side / (1 + (TILES_ACROSS - 1) * (1 - TILE_OVERLAP)))))
        tw, th = min(t, bw), min(t, bh)
        xs = _tile_starts(bw, tw)
        ys = _tile_starts(bh, th)
        ramp = max(8, int(min(tw, th) * TILE_OVERLAP / 2))
        tiles = [(tx, ty) for ty in ys for tx in xs if band[ty:ty + th, tx:tx + tw].any()]

        acc = np.zeros((bh, bw), np.float32)
        wsum = np.zeros((bh, bw), np.float32)
        for i, (tx, ty) in enumerate(tiles):
            check()
            progress("tiles", 0.5 + 0.33 * i / len(tiles), f"고해상도 정밀 분석 중 ({i + 1}/{len(tiles)})")
            ax, ay = x0 + tx, y0 + ty
            # 타일 사이에서는 GPU 메모리 풀을 비우지 않는다 (마지막 타일 뒤에만)
            pt = self._predict(sess, rgb[ay:ay + th, ax:ax + tw], shrink=i == len(tiles) - 1)
            # 타일 가장자리는 주변을 못 봐서 덜 정확하다 → 사진 끝이 아닌 쪽은 서서히 섞음
            wt = _edge_weights(th, tw, ramp, ay > 0, ay + th < h, ax > 0, ax + tw < w)
            acc[ty:ty + th, tx:tx + tw] += pt * wt
            wsum[ty:ty + th, tx:tx + tw] += wt
        # 앞 단계 윤곽 바로 옆(모델 해상도 약 2px)은 경계를 날카롭게 다듬는 곳이라 제한 없이,
        # 그보다 안쪽·바깥쪽을 크게 바꾸는 것은 색으로 확인될 때만
        d0 = max(3.0, 2.0 * scale)
        dist = cv2.distanceTransform(1 - outline, cv2.DIST_L2, 3)
        free = np.clip(2.0 - dist / d0, 0.0, 1.0)
        fine = _color_guard(rgb[y0:y1, x0:x1], sub, acc / np.maximum(wsum, 1e-6), 4 * r, free)
        m = band_w * np.minimum(wsum, 1.0)
        out = prob.copy()
        out[y0:y1, x0:x1] = sub + m * (fine - sub)
        return out

    def _need_mb(self, spec: ModelSpec, low: bool) -> float:
        """지금 상태(모델이 올라와 있는지, 이 프로세스가 CUDA 를 띄웠는지)에서 이 모델로 한 번 따는 데 더 필요한
        커밋 메모리 (MB) = 빠진 것(CUDA 컨텍스트·가중치) + 추론 한 번 + 여유."""
        need = MEM_MARGIN_MB + (RUN_LOW_MB if low else RUN_FULL_MB)
        if spec.id + (":lowmem" if low else "") not in self._sessions:
            # 가중치 (모델 파일 크기). 다른 모델이 올라와 있으면 먼저 내리므로 그만큼은 돌아온다 (넉넉히 80% 만 셈)
            freed = sum(self._sess_spec[id(s)].size for s in self._sessions.values() if id(s) in self._sess_spec)
            need += max(0.0, (spec.size - 0.8 * freed) / 2**20 + 50)
            if self._gpu and not self._cuda_ready:
                need += CUDA_CTX_MB
        return need

    def _pick_tier(self, spec: ModelSpec, progress: Progress, check: Callable[[], None]) -> str:
        """지금 메모리 여유로 큰 모델을 어떻게 돌릴지: full(빠름) / low(메모리 절약, 느림) / helper(가벼운 모델).
        모델이 이미 올라와 있어도 매번 확인한다 (추론 한 번에 약 3GB 가 더 필요하다)."""
        waited = 0.0
        # 조금 전에 기다려도 안 됐으면 (폴더 작업 등) 이번엔 기다리지 않는다 — 장마다 기다리지 않게
        limit = 0 if time.monotonic() - self._wait_failed < 300 else MEM_WAIT_MAX
        while True:
            free = free_commit_mb()
            if free is None or free >= self._need_mb(spec, False):
                return "full"
            need_low = self._need_mb(spec, True)
            if free >= need_low:
                return "low"
            if waited >= limit:
                self._wait_failed = time.monotonic()
                return "helper"
            # 메모리가 너무 모자라면 잠시 기다린다 (다른 프로그램이 메모리를 돌려주거나 사용자가 닫으면 바로 시작)
            progress("wait", 0.05, f"메모리 여유를 기다리는 중 (여유 {free / 1024:.1f}GB / 필요 {need_low / 1024:.1f}GB) · "
                                   "다른 프로그램을 닫으면 바로 시작해요")
            check()
            time.sleep(1)
            waited += 1

    def _infer(self, spec: ModelSpec, rgb: np.ndarray, precise: bool, ultra: bool, key: bool,
               progress: Progress, check: Callable[[], None], low: bool = False, cpu: bool = False,
               msg: str | None = None) -> tuple[np.ndarray, bool]:
        """AI 추론만: (전경 확률 맵, 색으로 딸 수 있는 배경인지). _infer_lock 안에서 부른다.
        low: 메모리 절약 모드 (같은 모델·같은 결과, 대신 느림). 이때는 최고 품질의 추가 분석은 생략.
        cpu: GPU 를 쓰지 않는다 (가벼운 도우미 모델)."""
        h, w = rgb.shape[:2]
        if (spec.id + (":lowmem" if low else "") + (":cpu" if cpu else "")) not in self._sessions:
            progress("load", 0.05, "AI 모델 불러오는 중")
        sess = self._session(spec, low, cpu)
        check()
        ultra = ultra and precise and not low
        both = (False, True)  # 최고 품질: 기준이 되는 추론은 좌우 반전 평균
        progress("infer", 0.15, msg or ("메모리 절약 모드로 천천히 분석 중 (품질은 같아요)" if low else "피사체 분석 중"))
        prob = self._predict(sess, rgb)
        check()
        keyed = key and key_background(rgb, prob) is not None
        if keyed:
            ultra = False
        if precise:
            sub = self._subject_box(prob)
            box = sub or (0, 0, w, h)
            # 피사체가 화면을 거의 채우면 2차 추론으로 얻는 해상도 이득이 없으므로 생략
            if sub is not None and max(w, h) / max(sub[2] - sub[0], sub[3] - sub[1]) > 1.15:
                sx0, sy0, sx1, sy1 = sub
                progress("refine", 0.35, "세부 경계 정밀 분석 중")
                p2 = self._predict(sess, rgb[sy0:sy1, sx0:sx1], both if ultra else (False,))
                prob = self._paste(prob, p2, sub)
                del p2
            elif ultra:
                progress("refine", 0.35, "반전 비교 분석 중")
                prob = (prob + self._predict(sess, rgb, (True,))) * 0.5
            if ultra and _tiles_needed(box):
                check()
                prob = self._tile_refine(sess, rgb, prob, box, progress, check)
        return prob, keyed

    def _run_tiers(self, spec: ModelSpec, rgb: np.ndarray, precise: bool, ultra: bool, key: bool, light: bool,
                   progress: Progress, cancel, check: Callable[[], None]) -> tuple[np.ndarray, bool]:
        """메모리 여유에 따라 빠른 모드 → 메모리 절약 모드(같은 품질, 느림) → 가벼운 모델 순으로 시도한다.
        _infer_lock 안에서 부른다."""
        tier = "helper" if light else self._pick_tier(spec, progress, check)
        if tier == "helper" and not light:
            self.exit_hint = True  # 메모리가 모자란 상태 → 끝나면 작업 프로세스를 끝내 메모리를 모두 돌려준다
        self.ensure_model(MODELS[HELPER] if tier == "helper" else spec, progress, cancel)
        check()
        order = {"full": ["full", "low", "helper"], "low": ["low", "helper"], "helper": ["helper"]}[tier]
        for i, t in enumerate(order):
            failed = False
            try:
                if t == "helper":
                    self.ensure_model(MODELS[HELPER], progress, cancel)
                    # 마지막 방법도 여유가 거의 없으면 돌리지 않는다 — 시스템 메모리가 바닥나면 Unity 같은 다른
                    # 프로그램이 먼저 죽을 수 있다
                    free = free_commit_mb()
                    if free is not None and free < HELPER_MIN_MB:
                        raise MemoryError(f"out of memory: 메모리 여유 {free / 1024:.1f}GB")
                    # 가벼운 도우미 모델은 CPU 로 (메모리 풀 끔): GPU 로 돌리면 CUDA 를 띄우느라 1GB 넘게 더 쓴다
                    prob, keyed = self._infer(MODELS[HELPER], rgb, False, False, key, progress, check, cpu=True,
                                              msg="흰 배경 그림 · 가벼운 모델로 분석 중" if light
                                              else "메모리가 모자라 가벼운 모델로 분석 중")
                    if not light:
                        self.note = _LOW_MEM_NOTE
                else:
                    if t == "low":
                        # 빠른 모드가 메모리 부족으로 실패한 뒤라면, 절약 모드도 여유가 될 때만 (아니면 바로 가벼운 모델로)
                        free = free_commit_mb() if i > 0 else None
                        if free is not None and free < self._need_mb(spec, True):
                            continue
                        if not self._ensure_lowmem(spec, progress):
                            continue
                    prob, keyed = self._infer(spec, rgb, precise, ultra, key, progress, check, low=t == "low")
                return prob, keyed
            except Exception as e:
                if isinstance(e, Cancelled) or i == len(order) - 1:
                    raise
                # 메모리 절약 모드는 어떤 이유로 실패해도 다음 방식으로 넘어간다 (오류로 멈추지 않게)
                if not _is_oom(e) and t != "low":
                    raise
                if t == "low" and not _is_oom(e):
                    print("  메모리 절약 모드 실패 → 가벼운 모델로:", repr(e)[:200])
                failed = True
            if failed:
                # 메모리 부족: 올려 둔 것을 모두 내리고 한 단계 아래 방식으로. except 블록 밖에서 내려야 실패한 세션을
                # 붙잡고 있던 traceback 이 먼저 사라져 메모리가 실제로 풀린다
                self.exit_hint = True
                self._release()
                progress("load", 0.1, "메모리가 모자라 더 아껴 쓰는 방식으로 다시 시도하는 중")
        raise RuntimeError("AI 모델을 실행하지 못했습니다.")

    def cutout(self, rgba: np.ndarray, model_id: str, precise: bool,
               progress: Progress, cancel: threading.Event, ultra: bool = False,
               holes: bool = False, key: bool = False) -> tuple[np.ndarray, np.ndarray]:
        """RGBA uint8 (HxWx4) → (마스크 HxW uint8, 색 오염 제거된 전경 HxWx3 uint8).

        ultra(최고 품질, precise 일 때만): 좌우 반전 평균 + 경계 띠 고해상도 타일 분석.
        holes: 흰·밝은 단색 배경이면 피사체 사이로 비치는 배경도 지운다.
        key: 흰·밝은 단색 배경이면 경계를 AI 대신 색으로 정한다 (color_key). 이때는 AI 가 안쪽만
             정하면 되므로 최고 품질의 반전 평균·타일 분석은 건너뛴다.
        """
        spec = MODELS.get(model_id)
        if spec is None:
            raise ValueError(f"알 수 없는 모델: {model_id}")

        def check() -> None:
            if cancel.is_set():
                raise Cancelled()

        rgb = np.ascontiguousarray(rgba[..., :3])
        # 흰 배경 그림: 경계는 색으로 정하므로 AI 는 안쪽만 판단하면 된다 → 가벼운 도우미 모델
        # (큰 모델은 추론 순간 메모리를 5GB 넘게 써서 다른 프로그램과 함께 쓰면 메모리가 넘친다)
        light = key and border_key_bg(rgb) is not None
        self.note = None
        self.exit_hint = False
        # 단계 고르기(메모리 확인)부터 추론까지 한 번에: 그 사이 쉬는 동안 정리(_idle_loop)가 모델을 내리지 않게
        with self._infer_lock:
            self._last_used = time.monotonic()
            try:
                prob, keyed = self._run_tiers(spec, rgb, precise, ultra, key, light, progress, cancel, check)
            except BaseException:
                if self._unshrunk:  # 메모리 풀을 비우기 전에 멈췄으면 모델째 내려 메모리를 돌려준다
                    self._release()
                raise
            finally:
                self._last_used = time.monotonic()
        # 테두리가 깨끗한 단색이면 AI 의 배경 판단과 상관없이 색으로 딴다 (예전엔 여기서 큰 모델로 다시 돌려
        # 메모리 부족이 났다)
        border_bg = border_key_bg(rgb) if key else None
        keyed = keyed or border_bg is not None
        check()
        alpha = prob
        src_a = rgba[..., 3]
        if src_a.min() < 255:
            alpha = alpha * (src_a.astype(np.float32) / 255.0)
        bg = None
        if keyed:
            progress("key", 0.6, "배경색 기준으로 경계를 정밀하게 따는 중")
            r = color_key(rgb, alpha, key_background(rgb, alpha) if border_bg is None else border_bg)
            if r is not None:
                alpha, bg = r
            check()
        if holes:
            progress("holes", 0.8, "피사체 사이로 보이는 배경 찾는 중")
            # 색으로 딴 경우엔 배경색에 가까운 안개가 이미 반투명이라, 그런 곳도 구멍 후보로 본다
            alpha = remove_bg_holes(rgb, alpha, 0.05 if bg is not None else 0.5)
        # 아주 미세한 잡티(배경에 남는 0.3% 미만 값)는 정리
        alpha = np.where(alpha < 0.003, 0.0, alpha)
        check()
        progress("color", 0.85, "경계의 배경색 번짐 제거 중")
        fg = estimate_foreground(rgb, alpha)
        if bg is not None:
            fg = unmix_foreground(rgb, alpha, bg, fg)
        mask = (np.clip(alpha, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        return mask, fg


# 메모리 여유 판단 (시스템 커밋 메모리, MB). 메모리 감사의 실측·추정치:
#   작업 프로세스 import ≈ 0.5GB (이 확인은 작업 프로세스 안에서 하므로 이미 쓰고 있는 몫)
#   CUDA 컨텍스트 + cuDNN/cuBLAS ≈ 0.9GB (한 번 띄우면 프로세스가 끝날 때까지 남는다)
#   BiRefNet 가중치 ≈ 0.97GB (모델 파일 크기)
#   BiRefNet 추론 한 번에 더 쓰는 양 ≈ 3GB (변형 합성곱 중간값; 실측 피크 5~6GB − 상주 2.4GB)
# 필요량 = 지금 빠진 것(CUDA·가중치) + 추론 한 번 + 여유 0.5GB. 처음(냉시작) 약 5.4GB, 모델이 올라와 있으면 3.5GB.
CUDA_CTX_MB = int(os.environ.get("MUTOSHOP_CUDA_CTX_MB", "900"))
RUN_FULL_MB = int(os.environ.get("MUTOSHOP_RUN_MB", "3000"))
# 메모리 절약 모드(변형 합성곱만 CPU 에서 나눠 계산)의 추론 한 번 — 실측 전 추정이라 넉넉히
RUN_LOW_MB = int(os.environ.get("MUTOSHOP_RUN_LOW_MB", "2000"))
MEM_MARGIN_MB = 500
# 메모리 절약 모드용으로 모델을 처음 나눌 때 필요한 여유 (모델 전체를 한 번 읽는다)
LOWMEM_BUILD_MB = 3000
MEM_WAIT_MAX = 15  # 초: 메모리 절약 모드로도 모자라면 이만큼만 기다렸다가 가벼운 모델로
# 가벼운 모델(ISNet, CPU)조차 이보다 여유가 적으면 돌리지 않는다 (추론 순간 약 0.65GB)
HELPER_MIN_MB = 900
# 쉬는 동안 메모리 여유가 이보다 적어지면 모델을 내리고 작업 프로세스도 끝낸다 (Unity 등 다른 프로그램에 양보)
LOW_FREE_EXIT_MB = int(os.environ.get("MUTOSHOP_LOW_FREE_MB", "1500"))
_LOW_MEM_NOTE = ("메모리가 부족해 가벼운 모델로 대신 땄어요 (경계가 덜 섬세할 수 있어요). "
                 "Unity 같은 큰 프로그램을 닫거나 Windows 가상 메모리를 늘리면 정밀 모델로 딸 수 있어요.")


def free_commit_mb() -> float | None:
    """Windows 가 더 내줄 수 있는 커밋 메모리(RAM + 페이지 파일 여유, MB). GPU 메모리를 잡을 때도 여기서 빠진다."""
    if os.name != "nt":
        return None
    import ctypes

    class MemStatus(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

    st = MemStatus()
    st.dwLength = ctypes.sizeof(MemStatus)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
        return None
    return st.ullAvailPageFile / 2**20


_OOM_WORDS = ("failed to allocate", "out of memory", "smaller than requested", "bad allocation", "bad_alloc",
              "unable to allocate", "cudaerrormemoryallocation")


def _is_oom(e: BaseException) -> bool:
    """메모리 부족 오류인지 (ONNX Runtime·CUDA·numpy·C++ bad_alloc)."""
    if isinstance(e, MemoryError):
        return True
    msg = str(e).lower()
    return any(w in msg for w in _OOM_WORDS)


is_oom = _is_oom


def _detect_gpu_name() -> str | None:
    import subprocess

    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        name = out.stdout.strip().splitlines()[0].strip() if out.returncode == 0 and out.stdout.strip() else None
        return name.replace("NVIDIA ", "") if name else None
    except Exception:
        return None
