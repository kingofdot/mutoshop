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
    )
}


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


def models_info(loaded: str | None = None) -> list[dict]:
    return [
        {
            "id": m.id, "name": m.name, "desc": m.desc, "size": m.size,
            "downloaded": m.path.exists() and m.path.stat().st_size == m.size,
            "loaded": m.id == loaded,
        }
        for m in MODELS.values()
    ]


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


# ----------------------------------------------------------------------------
# 엔진
# ----------------------------------------------------------------------------

class Engine:
    def __init__(self) -> None:
        self._infer_lock = threading.Lock()
        self._dl_locks = {k: threading.Lock() for k in MODELS}
        self._sessions: dict[str, "ort.InferenceSession"] = {}
        self._providers = self._pick_providers()
        self._active: str | None = None  # 실제로 쓰인 실행 장치
        self._gpu_run_opts = None
        if ort is not None:
            # 추론이 끝날 때마다 GPU 메모리 풀을 비운다. 6GB급 GPU에서 메모리를 계속 쥐고 있으면
            # 다음 추론 때 부족분이 시스템 RAM으로 밀려나(페이징) 2배 가까이 느려진다.
            self._gpu_run_opts = ort.RunOptions()
            self._gpu_run_opts.add_run_config_entry("memory.enable_memory_arena_shrinkage", "gpu:0")
        self._gpu_name = _detect_gpu_name()

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
        with self._dl_locks[spec.id]:
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
                    if cancel.is_set():
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
                        progress("download", done / total,
                                 f"AI 모델 다운로드 중 (최초 1회) {done // mb} / {total // mb} MB")
            if part.stat().st_size != spec.size:
                part.unlink(missing_ok=True)
                raise RuntimeError("모델 다운로드가 완료되지 않았습니다. 인터넷 연결을 확인하고 다시 시도하세요.")
            os.replace(part, spec.path)
            return spec.path

    def _session(self, spec: ModelSpec) -> "ort.InferenceSession":
        if ort is None:
            raise RuntimeError("onnxruntime 이 설치되지 않았습니다.")
        sess = self._sessions.get(spec.id)
        if sess is not None:
            return sess
        # VRAM 절약: 한 번에 하나의 모델만 메모리에 둔다
        self._sessions.clear()
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        so.log_severity_level = 3
        try:
            sess = ort.InferenceSession(str(spec.path), sess_options=so, providers=self._providers)
        except Exception:
            # GPU 초기화 실패 시 CPU로 재시도
            self._providers = ["CPUExecutionProvider"]
            sess = ort.InferenceSession(str(spec.path), sess_options=so, providers=self._providers)
        self._active = sess.get_providers()[0]
        self._sessions[spec.id] = sess
        return sess

    def warmup(self, model_id: str = "general") -> bool:
        """모델을 미리 올리고 GPU 초기화를 끝내 둔다 (첫 누끼가 오래 걸리지 않도록)."""
        spec = MODELS.get(model_id)
        if spec is None or not (spec.path.exists() and spec.path.stat().st_size == spec.size):
            return False
        with self._infer_lock:
            sess = self._session(spec)
            x = np.zeros((1, 3, INPUT_SIZE, INPUT_SIZE), dtype=np.float32)
            sess.run(None, {sess.get_inputs()[0].name: x}, self._run_opts)
            self._active = sess.get_providers()[0]
        return True

    # -- 추론 ----------------------------------------------------------------

    @property
    def _run_opts(self):
        return self._gpu_run_opts if self._active == "CUDAExecutionProvider" else None

    def _predict(self, sess, rgb: np.ndarray) -> np.ndarray:
        """RGB uint8 → 같은 크기의 전경 확률 맵 [0,1] float32."""
        h, w = rgb.shape[:2]
        x = _resize(rgb, INPUT_SIZE, INPUT_SIZE).astype(np.float32) / 255.0
        x = (x - _MEAN) / _STD
        x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
        out = sess.run(None, {sess.get_inputs()[0].name: x}, self._run_opts)[0]
        logits = out.reshape(out.shape[-2], out.shape[-1]).astype(np.float32)
        prob = 1.0 / (1.0 + np.exp(-np.clip(logits, -30, 30)))
        return cv2.resize(prob, (w, h), interpolation=cv2.INTER_LINEAR)

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
        ramp = max(8, min(cw, ch) // 16)
        wy = np.ones(ch, np.float32)
        wx = np.ones(cw, np.float32)
        r = np.linspace(0.0, 1.0, ramp, dtype=np.float32)
        if y0 > 0:
            wy[:ramp] = np.minimum(wy[:ramp], r)
        if y1 < h:
            wy[-ramp:] = np.minimum(wy[-ramp:], r[::-1])
        if x0 > 0:
            wx[:ramp] = np.minimum(wx[:ramp], r)
        if x1 < w:
            wx[-ramp:] = np.minimum(wx[-ramp:], r[::-1])
        wt = wy[:, None] * wx[None, :]
        out = prob.copy()
        out[y0:y1, x0:x1] = prob[y0:y1, x0:x1] * (1.0 - wt) + p2 * wt
        return out

    def cutout(self, rgba: np.ndarray, model_id: str, precise: bool,
               progress: Progress, cancel: threading.Event) -> tuple[np.ndarray, np.ndarray]:
        """RGBA uint8 (HxWx4) → (마스크 HxW uint8, 색 오염 제거된 전경 HxWx3 uint8)."""
        spec = MODELS.get(model_id)
        if spec is None:
            raise ValueError(f"알 수 없는 모델: {model_id}")

        def check() -> None:
            if cancel.is_set():
                raise Cancelled()

        self.ensure_model(spec, progress, cancel)
        check()
        rgb = np.ascontiguousarray(rgba[..., :3])
        h, w = rgb.shape[:2]

        with self._infer_lock:
            if spec.id not in self._sessions:
                progress("load", 0.05, "AI 모델 불러오는 중")
            sess = self._session(spec)
            check()
            progress("infer", 0.15, "피사체 분석 중")
            prob = self._predict(sess, rgb)
            check()
            if precise:
                sub = self._subject_box(prob)
                if sub is not None:
                    sx0, sy0, sx1, sy1 = sub
                    # 피사체가 화면을 거의 채우면 2차 추론으로 얻는 해상도 이득이 없으므로 생략
                    if max(w, h) / max(sx1 - sx0, sy1 - sy0) > 1.15:
                        progress("refine", 0.45, "세부 경계 정밀 분석 중")
                        p2 = self._predict(sess, rgb[sy0:sy1, sx0:sx1])
                        prob = self._paste(prob, p2, sub)
        check()
        alpha = prob
        src_a = rgba[..., 3]
        if src_a.min() < 255:
            alpha = alpha * (src_a.astype(np.float32) / 255.0)
        # 아주 미세한 잡티(배경에 남는 0.3% 미만 값)는 정리
        alpha = np.where(alpha < 0.003, 0.0, alpha)
        check()
        progress("color", 0.85, "경계의 배경색 번짐 제거 중")
        fg = estimate_foreground(rgb, alpha)
        mask = (np.clip(alpha, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        return mask, fg


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
