"""단색 배경 에셋 누끼 (나무 · 산 · 아이템 · 인물).

흰색·하늘색·크림색처럼 배경이 거의 한 가지 색(미묘한 얼룩·그라데이션 포함)인 그림(게임 에셋, 일러스트)을 위한
누끼. 경계는 색으로 픽셀 단위까지 따고, 애매하면 객체를 남긴다 (배경이 조금 남는 건 괜찮아도 객체가 지워지면
안 된다):

  0. 배경 모델: 자리마다의 배경색을 매끈한 곡면(2차식)으로 맞추고, 확실한 배경의 흔들림(잡음)에서 허용치 t0 를 잰다.
  1. 바깥 배경: 테두리에서 굴려 넣은 '공'이 닿는 배경색. 윤곽선이 조금 끊긴 틈으로는 들어가지 못한다.
     산·아이템·인물은 큰 공을 한 번 더 굴려, 좁은 입구 안쪽(칼날 속 등)은 '안쪽'으로 본다. 테두리에 걸친 칼끝처럼
     양쪽이 진한 색으로 막힌 짧은 배경 구간은 씨앗으로 쓰지 않는다.
  2. 객체 안에 갇힌 배경색 덩어리: 종류와 '안쪽' 설정(auto/keep/remove)에 따라. 진짜 구멍은 잡음까지 배경과 같고
     (bg_same) 둘레가 진한 색이다. 산·아이템·인물은 AI 도 '배경'이라고 해야 지운다.
  3. AI 보호 (산·아이템·인물): 바깥 배경과 이어져 색으로는 구분이 안 되는 흰 칼날·눈 덮인 봉우리를, AI(ISNet,
     CPU)가 객체라고 확신하면 되살린다. 메모리가 모자라면 AI 없이(안전 모드) 따고 note 로 알려 준다.
  4. 잡티: 진한 픽셀이 하나도 없는 작은 얼룩(미드저니 배경 얼룩·잡음)은 지운다.
  5. 알파: 지운 곳과 맞닿은 1~2px 만, 안쪽 색(F̂)과 배경색 사이에 놓인 만큼 반투명 + 배경색을 빼서 원래 색으로.
     흰 칼날·꽃잎처럼 배경과 비슷한 객체는 섞인 정도를 알 수 없으므로 불투명으로 둔다.

AI 는 CPU 에서 가볍게 돌린다 (한 장 약 1초, 추가 메모리 0.4~0.7GB). GPU 작업 프로세스를 쓰지 않는다. 배경이 한 가지
색이 아닌 사진은 detect_background 가 None 을 돌려주고, 기존 AI(BiRefNet)로 간다.
"""

from __future__ import annotations

import ctypes
import gc
import os
import struct
import threading
import time
from pathlib import Path

import cv2
import numpy as np

KINDS = ("tree", "mountain", "item", "person")
INNERS = ("auto", "keep", "remove")

NOTE_SAFE = "메모리가 부족해 AI 확인 없이 땄어요 · 배경과 같은 색인 부분이 지워지지 않았는지 확인해 주세요"
NOTE_NO_MODEL = "AI 모델이 없어 색으로만 땄어요 · 배경과 같은 색인 부분이 지워지지 않았는지 확인해 주세요"
NOTE_UNSURE = "AI 가 객체를 찾지 못해 색으로만 땄어요 · 배경과 같은 색인 부분이 지워지지 않았는지 확인해 주세요"

# 배경 흔들림 허용치 t0 의 상한. 실측(평가 이미지 31장)에서 확실한 배경의 99.5% 는 대부분 3~8 안이고,
# 크림 그라데이션 나무만 11 이었다. 산·아이템·인물은 흰 눈(배경과 차이 ~10)·옅은 칼날이 배경으로 넘어가지
# 않도록 10 으로, 나무는 얼룩진 배경까지 지우도록 12 로.
T0_CAP = {"tree": 12.0, "mountain": 10.0, "item": 10.0, "person": 10.0}

# AI 메모리 문턱 (MB, 시스템이 더 내줄 수 있는 커밋 메모리). 1024 입력 ≈ 상주 0.18GB + 실행 순간 0.47GB,
# 640 입력 ≈ 상주 0.18GB + 0.2GB (실측).
AI_FULL_MB = 2500
AI_MIN_MB = 1200
AI_IDLE = 60  # 초: 안 쓰면 AI 를 내린다

_debug: dict | None = None  # 시험용: dict 를 넣으면 중간 결과를 담는다
_K3 = np.ones((3, 3), np.uint8)
_K7 = np.ones((7, 7), np.uint8)
_LUMA = np.array([0.299, 0.587, 0.114], np.float32)


# ----------------------------------------------------------------------------
# 작은 도우미
# ----------------------------------------------------------------------------


def _disk(r: float) -> np.ndarray:
    r = max(1, int(round(r)))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def _u8(m: np.ndarray) -> np.ndarray:
    """bool 배열을 복사 없이 uint8 로 (cv2 용)."""
    if m.dtype == np.bool_ and m.flags.c_contiguous:
        return m.view(np.uint8)
    return np.ascontiguousarray(m, dtype=np.uint8)


def _bbox(m: np.ndarray) -> tuple[int, int, int, int] | None:
    rows = np.flatnonzero(m.any(axis=1))
    if rows.size == 0:
        return None
    cols = np.flatnonzero(m.any(axis=0))
    return int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1


def _local_std(gray: np.ndarray) -> np.ndarray:
    g = gray.astype(np.float32)
    m = cv2.blur(g, (5, 5))
    return np.sqrt(np.maximum(cv2.blur(g * g, (5, 5)) - m * m, 0.0))


def free_commit_mb() -> float | None:
    """Windows 가 더 내줄 수 있는 커밋 메모리(RAM + 페이지 파일 여유, MB). 다른 OS 는 None."""
    if os.name != "nt":
        return None

    class _MemStatus(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

    try:
        st = _MemStatus()
        st.dwLength = ctypes.sizeof(_MemStatus)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            return None
        return st.ullAvailPageFile / 2**20
    except Exception:  # noqa: BLE001
        return None


def _physical_cores() -> int:
    n = os.cpu_count() or 2
    if os.name == "nt":
        try:  # RelationProcessorCore(0) 기록 수 = 물리 코어 수
            k32 = ctypes.WinDLL("kernel32")
            size = ctypes.c_ulong(0)
            k32.GetLogicalProcessorInformationEx(0, None, ctypes.byref(size))
            buf = ctypes.create_string_buffer(size.value)
            if size.value and k32.GetLogicalProcessorInformationEx(0, buf, ctypes.byref(size)):
                cores, off = 0, 0
                while off + 8 <= size.value:
                    rel, sz = struct.unpack_from("<II", buf, off)
                    if sz == 0:
                        break
                    cores += rel == 0
                    off += sz
                if cores:
                    return cores
        except Exception:  # noqa: BLE001
            pass
    return max(1, n // 2)


# ----------------------------------------------------------------------------
# 배경 모델: 자리마다의 배경색 = 채널마다 2차 곡면 z = a + bu + cv + du² + euv + fv²
# ----------------------------------------------------------------------------


def _border(rgb: np.ndarray) -> np.ndarray:
    return np.concatenate([rgb[0], rgb[-1], rgb[1:-1, 0], rgb[1:-1, -1]]).astype(np.int16)


def _border_xy(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    """_border 와 같은 순서의 (y, x) 좌표."""
    mid = np.arange(1, h - 1)
    ys = np.concatenate([np.zeros(w, np.int64), np.full(w, h - 1), mid, mid])
    xs = np.concatenate([np.arange(w), np.arange(w), np.zeros(h - 2, np.int64), np.full(h - 2, w - 1)])
    return ys, xs


def _design(ys: np.ndarray, xs: np.ndarray, h: int, w: int, terms: int = 6) -> np.ndarray:
    u = (np.asarray(xs, np.float32) + 0.5) / w - 0.5
    v = (np.asarray(ys, np.float32) + 0.5) / h - 0.5
    cols = [np.ones_like(u), u, v, u * u, u * v, v * v][:terms]
    cols += [np.zeros_like(u)] * (6 - terms)
    return np.stack(cols, axis=-1)


def _fit(A: np.ndarray, vals: np.ndarray, base: np.ndarray, iters: int = 3) -> np.ndarray:
    """곡면 맞추기. 배경색(base)에서 벗어난 만큼만 맞춰서, 표본이 한쪽에만 있어도 엉뚱하게 휘지 않게 한다.
    곡면에서 많이 벗어난 점(배경색에 가까운 객체 등)은 빼고 다시 맞춘다."""
    dv = vals - base
    keep = np.ones(len(vals), bool)
    coef = np.zeros((6, 3), np.float32)
    for _ in range(iters):
        coef = np.linalg.lstsq(A[keep], dv[keep], rcond=None)[0].astype(np.float32)
        res = np.abs(A @ coef - dv).max(axis=1)
        new = res <= max(6.0, float(np.percentile(res[keep], 90)))
        if new.sum() < 32 or (new == keep).all():
            break
        keep = new
    coef[0] += base
    return coef


def _surface_px(coef: np.ndarray, ys: np.ndarray, xs: np.ndarray, h: int, w: int) -> np.ndarray:
    """원본 좌표들의 배경색 (n×3 float32)."""
    out = np.empty((len(ys), 3), np.float32)
    step = 1 << 20
    for i in range(0, len(ys), step):
        out[i:i + step] = _design(ys[i:i + step], xs[i:i + step], h, w) @ coef
    return np.clip(out, 0, 255, out=out)


def _surface_grid(coef: np.ndarray, gys: np.ndarray, gxs: np.ndarray, h: int, w: int) -> np.ndarray:
    """격자(행 좌표 gys × 열 좌표 gxs) 위의 배경색 (gh×gw×3 float32)."""
    u = ((np.asarray(gxs, np.float32) + 0.5) / w - 0.5)[None, :]
    v = ((np.asarray(gys, np.float32) + 0.5) / h - 0.5)[:, None]
    out = np.empty((len(gys), len(gxs), 3), np.float32)
    for c in range(3):
        a = coef[:, c]
        out[..., c] = a[0] + a[1] * u + a[2] * v + a[3] * u * u + a[4] * u * v + a[5] * v * v
    return np.clip(out, 0, 255, out=out)


def _grid_rc(h: int, w: int, long_side: int = 512) -> tuple[np.ndarray, np.ndarray]:
    """배경 지도 격자의 행·열 (원본 좌표). cv2.resize(INTER_LINEAR)가 키울 때 쓰는 칸 가운데와 맞춘다."""
    s = max(1.0, max(h, w) / long_side)
    fh, fw = max(2, int(round(h / s))), max(2, int(round(w / s)))
    rows = np.clip(np.round((np.arange(fh) + 0.5) * h / fh - 0.5), 0, h - 1).astype(np.int64)
    cols = np.clip(np.round((np.arange(fw) + 0.5) * w / fw - 0.5), 0, w - 1).astype(np.int64)
    return rows, cols


def _field_at(field: np.ndarray, ys: np.ndarray, xs: np.ndarray, h: int, w: int) -> np.ndarray:
    """배경 지도(작은 격자)에서 원본 좌표들의 배경색 (쌍선형, n×3 float32). 많으면 나눠서 (메모리)."""
    fh, fw = field.shape[:2]
    n = len(ys)
    out = np.empty((n, 3), np.float32)
    step = 1 << 19
    for i in range(0, n, step):
        fy = np.clip((np.asarray(ys[i:i + step], np.float32) + 0.5) * fh / h - 0.5, 0, fh - 1)
        fx = np.clip((np.asarray(xs[i:i + step], np.float32) + 0.5) * fw / w - 0.5, 0, fw - 1)
        y0, x0 = fy.astype(np.int32), fx.astype(np.int32)
        y1, x1 = np.minimum(y0 + 1, fh - 1), np.minimum(x0 + 1, fw - 1)
        wy, wx = (fy - y0)[:, None], (fx - x0)[:, None]
        top = field[y0, x0] * (1 - wx) + field[y0, x1] * wx
        bot = field[y1, x0] * (1 - wx) + field[y1, x1] * wx
        out[i:i + step] = top * (1 - wy) + bot * wy
    return out


def _dist_full(rgb: np.ndarray, field: np.ndarray) -> np.ndarray:
    """자리마다의 배경색과의 차이 (채널별 최댓값, uint8, 원본 크기). 배경 지도는 uint8 로 만든 뒤 채널 하나씩
    키워 cv2.absdiff 로 비교한다 (픽셀당 약 4바이트만 잠깐 씀)."""
    h, w = rgb.shape[:2]
    small = (np.clip(field, 0, 255) + 0.5).astype(np.uint8)
    d = np.zeros((h, w), np.uint8)
    for c in range(3):
        up = cv2.resize(np.ascontiguousarray(small[..., c]), (w, h), interpolation=cv2.INTER_LINEAR)
        np.maximum(d, cv2.absdiff(np.ascontiguousarray(rgb[..., c]), up), out=d)
        del up
    return d


def _border_connected(m: np.ndarray) -> np.ndarray:
    """테두리와 (4-연결로) 이어진 덩어리만."""
    n, lab = cv2.connectedComponents(_u8(m), connectivity=4)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    lut = np.zeros(n, bool)
    lut[edge[edge > 0]] = True
    return lut[lab]


def detect_background(rgb: np.ndarray) -> dict | None:
    """사진 테두리에서 배경을 찾는다. 객체가 테두리에 닿아 있어도 (땅·풀 등) 가장 그럴듯한 색 무리를 배경으로
    보고, 위→아래 그라데이션처럼 서서히 변하는 배경은 곡면으로 맞춘다. rgb 는 view 여도 된다.

    돌려주는 값: {"color", "t0", "share", "coef"} 또는 None(사진 → 기존 AI).
    """
    h, w = rgb.shape[:2]
    if h < 8 or w < 8:
        return None
    b = _border(rgb)
    by, bx = _border_xy(h, w)
    n_b = len(b)
    edges = (slice(0, w), slice(w, 2 * w), slice(2 * w, 2 * w + h - 2), slice(2 * w + h - 2, n_b))
    q = (b // 16).astype(np.int32)
    keys = q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]
    counts = np.bincount(keys)
    k = max(2, min(h, w) // 64)
    corner_px = [(k // 2, k // 2), (k // 2, w - 1 - k // 2), (h - 1 - k // 2, k // 2), (h - 1 - k // 2, w - 1 - k // 2)]
    corners = [np.median(cn.reshape(-1, 3), axis=0) for cn in
               (rgb[:k, :k], rgb[:k, -k:], rgb[-k:, :k], rgb[-k:, -k:])]
    vals = b.astype(np.float32)
    best = None
    # 테두리에서 많이 보이는 색 무리 몇 개를 후보로: 땅·풀이 아랫변을 다 덮어도 진짜 배경(윗변·귀퉁이)을 고른다
    for key in np.argsort(-counts)[:6]:
        if counts[key] < 0.05 * n_b:
            break
        c = np.median(b[keys == key], axis=0)
        for _ in range(2):  # 칸 경계에 걸친 색까지 모아 다시 가운데값
            m = np.abs(b - c).max(axis=1) <= 12
            c = np.median(b[m], axis=0)
        m = np.abs(b - c).max(axis=1) <= 12
        # 곡면 맞춤: 3변 이상에 배경이 있으면 2차, 2변이면 1차, 아니면 한 가지 색
        coef = np.zeros((6, 3), np.float32)
        coef[0] = c
        for _ in range(3):
            n_edges = sum(int(m[e].mean() >= 0.2) for e in edges)
            terms = 6 if n_edges >= 3 else 3 if n_edges == 2 else 1
            if terms == 1 or m.sum() < 32:
                break
            A = _design(by[m], bx[m], h, w, terms)
            coef = _fit(A, vals[m], c.astype(np.float32))
            res = np.abs(_design(by, bx, h, w) @ coef - vals).max(axis=1)
            m2 = res <= 12
            if (m2 == m).all():
                break
            m = m2
        dev = np.abs(_design(by, bx, h, w) @ coef - vals).max(axis=1)
        match = dev <= 12
        share = float(match.mean())
        top_share = float(match[edges[0]].mean())
        cs = _surface_px(coef, np.array([p[0] for p in corner_px]), np.array([p[1] for p in corner_px]), h, w)
        good = sum(int(np.abs(cn - cs[i]).max() <= 12) for i, cn in enumerate(corners))
        # 배경 자체가 얼룩덜룩하면(사진 배경) 색으로 따면 안 된다
        if share < 0.15 or float(np.percentile(dev[match], 90)) > 8:
            continue
        score = share + 0.6 * top_share + 0.15 * good
        if best is None or score > best[0]:
            best = (score, c, coef, dev, match, share, top_share, good)
    if best is None:
        return None
    _, c, coef, dev, match, share, top_share, good = best
    if share < 0.15 or (good < 2 and top_share < 0.4):
        return None
    t0 = float(np.clip(np.percentile(dev[match], 99) + 3, 4, 24))
    return {"color": np.asarray(c, np.float32), "t0": t0, "share": share, "coef": coef}


def background_from_seeds(rgb: np.ndarray, seeds: list[tuple[int, int]]) -> dict | None:
    """사용자가 찍은 배경 자리(원본 px, (x, y))의 색으로 배경 모델. 테두리가 배경이 아닌 그림에서도 쓸 수 있다."""
    h, w = rgb.shape[:2]
    px = []
    for x, y in seeds:
        if 0 <= x < w and 0 <= y < h:
            px.append(rgb[max(0, y - 2):y + 3, max(0, x - 2):x + 3].reshape(-1, 3))
    if not px:
        return None
    v = np.concatenate(px).astype(np.float32)
    c = np.median(v, axis=0)
    dev = np.abs(v - c).max(axis=1)
    t0 = float(np.clip(np.percentile(dev, 99) + 3, 4, 24))
    return {"color": c.astype(np.float32), "t0": t0, "share": 0.0, "seeded": True}


def _clip_seeds(seeds, h: int, w: int) -> list[tuple[int, int]]:
    out = []
    for xy in seeds or ():
        try:
            x, y = int(round(float(xy[0]))), int(round(float(xy[1])))
        except (TypeError, ValueError, IndexError):
            continue
        if 0 <= x < w and 0 <= y < h:
            out.append((x, y))
    return out[:200]


def _flood_user(rgb: np.ndarray, F: np.ndarray, seeds: list[tuple[int, int]], r: int, t0: float) -> np.ndarray:
    """사용자가 찍은 자리에서 이어진 배경 (bool HxW).

    공(반지름 r)이 들어가는 넓은 곳은 공으로 채운다 — 윤곽선의 작은 틈으로 칼날 안까지 새지 않게.
    공이 못 들어가는 좁은 곳(가드와 칼날 사이 홈 등)을 찍었으면 그 자리와 이어진 배경색만 (마술봉처럼).
    배경 모델과 다른 색(그림자·다른 배경색)을 찍었으면 그 자리 색을 기준으로.
    """
    h, w = F.shape
    ball = _disk(r)
    core = cv2.erode(_u8(F), ball)
    ys = np.array([y for _, y in seeds], np.int64)
    xs = np.array([x for x, _ in seeds], np.int64)
    _fill_from(core, ys, xs)
    reach = _u8(core == 2)
    del core
    out = (cv2.dilate(reach, ball) > 0) & F
    del reach
    for x, y in seeds:
        if out[y, x]:
            continue
        if F[y, x]:
            m = np.ascontiguousarray(F, dtype=np.uint8)
        else:
            c = np.median(rgb[max(0, y - 2):y + 3, max(0, x - 2):x + 3].reshape(-1, 3), axis=0)
            dd = np.zeros((h, w), np.uint8)
            for ch in range(3):
                np.maximum(dd, cv2.absdiff(np.ascontiguousarray(rgb[..., ch]), np.full((h, w), int(c[ch]), np.uint8)), out=dd)
            m = _u8(dd <= max(t0, 10.0)).copy()
            del dd
        cv2.floodFill(m, None, (int(x), int(y)), 2, flags=4)
        out |= m == 2
        del m
    return out


def _background(rgb: np.ndarray, bg: dict, kind: str) -> tuple[np.ndarray, np.ndarray, float, float]:
    """배경 지도(작은 격자, float32 fh×fw×3), 배경과의 차이 d(uint8, 원본 크기), 허용치 t0, 배경 잡음 σ.

    배경 지도 = 2차 곡면 + 곡면이 못 따라가는 완만한 얼룩(한쪽 가장자리만 살짝 어두운 비네팅 등). 둘 다 '테두리와
    이어진 확실한 배경'에서만 배우고, 얼룩 보정은 곡면과 거의 같은 칸(잡음 수준, 4 이내)만 쓴다 — 윤곽선 안의
    흰 눈·칼날이나 배경에 붙은 옅은 객체가 배경 쪽으로 끌려 들지 않게.
    t0 = max(3.5σ+3, 99.5% 값+2) — 배경 잡음은 꼬리가 길어(얼룩) σ 만으로는 모자라다 (실측).
    """
    h, w = rgb.shape[:2]
    c = np.asarray(bg["color"], np.float32)
    coef = bg.get("coef")
    if coef is None:
        coef = np.zeros((6, 3), np.float32)
        coef[0] = c
    coef = np.asarray(coef, np.float32)
    t_init = float(bg.get("t0", 12.0))
    rows, cols = _grid_rc(h, w)
    g = rgb[rows[:, None], cols[None, :]].astype(np.float32)
    fh, fw = g.shape[:2]
    field = _surface_grid(coef, rows, cols, h, w)
    far = None
    for _ in range(3):
        nearg = np.abs(g - field).max(axis=2) <= t_init
        far = _border_connected(cv2.erode(_u8(nearg), _K3) > 0)
        if far.sum() < 64:
            far = nearg if nearg.sum() >= 64 else None
            if far is None:
                break
        ys, xs = np.nonzero(far)
        if ys.size > 40000:
            pick = np.linspace(0, ys.size - 1, 40000).astype(np.int64)
            ys, xs = ys[pick], xs[pick]
        coef = _fit(_design(rows[ys], cols[xs], h, w), g[ys, xs], c)
        base = _surface_grid(coef, rows, cols, h, w)
        # 완만한 얼룩 보정: 확실한 배경 칸의 (잡음 수준) 잔차를 크게 번진 평균으로
        r = g - base
        rf = r[far]
        sig_r = float((1.4826 * np.median(np.abs(rf - np.median(rf, axis=0)), axis=0)).max())
        m = (far & (np.abs(r).max(axis=2) <= max(4.0, 3.0 * sig_r))).astype(np.float32)
        sc = max(fh, fw) / 16.0
        den = cv2.GaussianBlur(m, (0, 0), sc)
        corr = np.empty_like(r)
        for ch in range(3):
            corr[..., ch] = cv2.GaussianBlur(np.ascontiguousarray(r[..., ch]) * m, (0, 0), sc)
        corr *= (np.clip(den / 0.1, 0.0, 1.0) / np.maximum(den, 1e-3))[..., None]
        new = base + np.clip(corr, -12.0, 12.0)
        change = float(np.abs(new - field).max())
        field = new
        del r, corr, den, m, base
        if change < 0.5:
            break
    sig, t0 = 1.0, min(t_init, T0_CAP[kind])
    if far is not None:
        r = g[far] - field[far]
        sig = float((1.4826 * np.median(np.abs(r - np.median(r, axis=0)), axis=0)).max())
        q995 = float(np.percentile(np.abs(r).max(axis=1), 99.5))
        t0 = float(np.clip(max(3.5 * sig + 3.0, q995 + 2.0), 4.0, T0_CAP[kind]))
    del g
    field = np.clip(field, 0, 255).astype(np.float32)
    return field, _dist_full(rgb, field), t0, sig


# ----------------------------------------------------------------------------
# AI (ISNet, CPU) — 객체 보호용
# ----------------------------------------------------------------------------

_ai_lock = threading.Lock()
_ai_sess = None
_ai_size = 0
_ai_used = 0.0
_ai_watch = False
_MEAN = np.array([0.485, 0.456, 0.406], np.float32)


def _drop_locked() -> None:
    global _ai_sess, _ai_size
    _ai_sess, _ai_size = None, 0
    gc.collect()


def release() -> None:
    """ISNet 세션을 바로 내린다 (폴더 작업이 끝났을 때 등)."""
    with _ai_lock:
        _drop_locked()


def _ai_idle() -> None:
    global _ai_watch
    while True:
        time.sleep(10)
        with _ai_lock:
            if _ai_sess is None:
                _ai_watch = False
                return
            if time.monotonic() - _ai_used > AI_IDLE:
                _drop_locked()
                _ai_watch = False
                return


def _small_model(path: Path, size: int) -> Path:
    """입력 크기를 줄인 ISNet 파일 (처음 한 번 만들어 모델 옆에 둔다, 약 0.4초).

    이 ONNX 는 입력이 1024 로 고정이고, 안쪽 Resize 들도 목표 크기(32·64·…·1024)를 상수로 들고 있다.
    입력·출력 크기와 그 상수들을 같은 비율로 바꾸면 그대로 640 입력으로 돈다 (실행 메모리 약 0.4배).
    """
    out = path.with_name(f"{path.stem}.{size}{path.suffix}")
    if out.exists() and out.stat().st_size > 1_000_000:
        return out
    import onnx
    from onnx import numpy_helper

    m = onnx.load(str(path))
    g = m.graph
    prod = {o: n for n in g.node for o in n.output}
    k = size / 1024.0
    seen = set()
    for n in g.node:
        if n.op_type != "Resize" or len(n.input) < 4 or not n.input[3]:
            continue
        cat = prod.get(n.input[3])
        if cat is None or cat.op_type != "Concat" or len(cat.input) < 2:
            raise RuntimeError("예상과 다른 ISNet 구조")
        cst = prod.get(cat.input[1])
        if cst is None or cst.op_type != "Constant":
            raise RuntimeError("예상과 다른 ISNet 구조")
        if cst.output[0] in seen:
            continue
        seen.add(cst.output[0])
        t = cst.attribute[0].t
        arr = numpy_helper.to_array(t)
        t.CopyFrom(numpy_helper.from_array(np.array([int(round(v * k)) for v in arr], dtype=arr.dtype), t.name))
    for vi in list(g.input) + list(g.output):
        dims = vi.type.tensor_type.shape.dim
        if len(dims) == 4:
            for i in (2, 3):
                if dims[i].dim_value:
                    dims[i].dim_value = int(round(dims[i].dim_value * k))
    del g.value_info[:]
    tmp = out.with_name(out.name + ".part")
    onnx.save(m, str(tmp))
    del m, g, prod
    gc.collect()
    os.replace(tmp, out)
    return out


def _session_locked(path: Path, size: int):
    """ISNet 세션 (_ai_lock 안에서 부른다). 이미 올라와 있으면 그 크기를 그대로 쓴다 (다시 올리는 순간이 더 무겁다)."""
    global _ai_sess, _ai_size, _ai_watch
    if _ai_sess is not None:
        return _ai_sess, _ai_size
    import onnxruntime as ort

    src = path if size == 1024 else _small_model(path, size)
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.log_severity_level = 3
    # 메모리 풀을 끄면 추론이 끝날 때 바로 돌려준다 (켜 두면 2.8GB 를 계속 쥐고 있음 — 실측)
    so.enable_cpu_mem_arena = False
    so.enable_mem_pattern = False
    # 스레드는 4개까지, 쉬는 스레드가 CPU 를 붙잡고 돌지 않게 (Unity 등과 다투지 않게)
    so.intra_op_num_threads = max(1, min(4, _physical_cores()))
    so.inter_op_num_threads = 1
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.add_session_config_entry("session.intra_op.allow_spinning", "0")
    so.add_session_config_entry("session.inter_op.allow_spinning", "0")
    _ai_sess = ort.InferenceSession(str(src), sess_options=so, providers=["CPUExecutionProvider"])
    _ai_size = size
    if not _ai_watch:
        _ai_watch = True
        threading.Thread(target=_ai_idle, daemon=True, name="assetcut-ai-idle").start()
    return _ai_sess, _ai_size


def _square_tiles(x0: int, y0: int, x1: int, y1: int, size: int = 1024) -> list[tuple[int, int, int]]:
    """영역을 덮는 정사각 타일 (왼쪽 위 x, y, 한 변). 긴 변/짧은 변 > 1.8 이고 줄여야 할 만큼 크면 2~3장으로
    겹쳐 나눈다 (모델 입력보다 작으면 한 장에 그대로 담아도 잃는 것이 없다)."""
    bw, bh = max(1, x1 - x0), max(1, y1 - y0)
    lo, sh = max(bw, bh), min(bw, bh)
    if lo <= 1.8 * sh or lo <= 1.15 * size:
        return [(x0 + (bw - lo) // 2, y0 + (bh - lo) // 2, lo)]
    n = 2 if lo <= 2.8 * sh else 3
    side = max(sh, int(np.ceil(lo / (n - 0.15 * (n - 1)))))
    step = (lo - side) / (n - 1)
    out = []
    for i in range(n):
        a = int(round(i * step))
        out.append((x0 + a, y0 + (bh - side) // 2, side) if bw >= bh else (x0 + (bw - side) // 2, y0 + a, side))
    return out


def _ai_region(sess, size: int, rgb: np.ndarray, field: np.ndarray, region: tuple[int, int, int, int],
               out: np.ndarray) -> tuple[float, float]:
    """region(x0, y0, x1, y1) 을 정사각 타일로 나눠 ISNet 을 돌리고 확률(uint8)을 out(region 크기)에 겹쳐 쓴다.
    타일이 사진 밖으로 나가면 그 자리의 배경색으로 채운다. 돌려주는 값: (원래 확률의 최댓값, 모델 1픽셀의 크기)."""
    h, w = rgb.shape[:2]
    x0, y0, x1, y1 = region
    name_in = sess.get_inputs()[0].name
    name_out = sess.get_outputs()[0].name
    pmax, scale = 0.0, 0.0
    for tx, ty, side in _square_tiles(x0, y0, x1, y1, size):
        k = size / side
        ix0, iy0, ix1, iy1 = max(0, tx), max(0, ty), min(w, tx + side), min(h, ty + side)
        if ix1 <= ix0 or iy1 <= iy0:
            continue
        ox, oy = int(round((ix0 - tx) * k)), int(round((iy0 - ty) * k))
        cw = max(1, min(size - ox, int(round((ix1 - ix0) * k))))
        ch = max(1, min(size - oy, int(round((iy1 - iy0) * k))))
        bgc = _field_at(field, np.array([(iy0 + iy1) // 2]), np.array([(ix0 + ix1) // 2]), h, w)[0]
        canvas = np.empty((size, size, 3), np.uint8)
        canvas[:] = (bgc + 0.5).astype(np.uint8)
        crop = np.ascontiguousarray(rgb[iy0:iy1, ix0:ix1])
        canvas[oy:oy + ch, ox:ox + cw] = cv2.resize(
            crop, (cw, ch), interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_LINEAR)
        del crop
        x = canvas.astype(np.float32)
        x *= 1.0 / 255.0
        x -= _MEAN
        x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
        del canvas
        prob = sess.run([name_out], {name_in: x})[0]
        del x
        prob = prob.reshape(prob.shape[-2], prob.shape[-1])
        pmax = max(pmax, float(prob.max()))
        scale = max(scale, side / size)
        tile = cv2.resize(np.ascontiguousarray(prob[oy:oy + ch, ox:ox + cw]), (ix1 - ix0, iy1 - iy0),
                          interpolation=cv2.INTER_LINEAR)
        del prob
        tile = (np.clip(tile, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        # region 안쪽만 (겹치는 곳은 큰 값 — 객체 쪽으로)
        ax0, ay0, ax1, ay1 = max(ix0, x0), max(iy0, y0), min(ix1, x1), min(iy1, y1)
        if ax1 > ax0 and ay1 > ay0:
            dst = out[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0]
            np.maximum(dst, tile[ay0 - iy0:ay1 - iy0, ax0 - ix0:ax1 - ix0], out=dst)
    return pmax, scale


def _ai_probability(rgb: np.ndarray, field: np.ndarray, obj: np.ndarray, model_path: Path,
                    say) -> tuple[np.ndarray | None, float, str, str | None]:
    """ISNet 전경 확률 (원본 크기 uint8, 0~255). 돌려주는 값: (확률 또는 None, 모델 1픽셀 크기, 방식, note).

    1) 사진 전체를 (비율 그대로, 배경색으로 채운 정사각 타일로) 본다 — 객체 bbox 밖으로 이어진 흰 칼날도 보이게.
    2) 객체가 작으면 객체 둘레(+10%)만 크게 한 번 더 본다 (칼날 폭이 모델 안에서 몇 픽셀뿐이면 못 지킨다).
    메모리 여유: 2.5GB 이상 1024 입력, 1.2~2.5GB 640 입력, 그보다 적거나 오류면 AI 없이(안전 모드).
    """
    global _ai_used
    free = free_commit_mb()
    if free is not None and free < AI_MIN_MB:
        return None, 1.0, "safe", NOTE_SAFE
    want = 1024 if free is None or free >= AI_FULL_MB else 640
    h, w = rgb.shape[:2]
    say("ai", 0.35, "객체 모양 확인 중 (AI · CPU)")
    try:
        with _ai_lock:
            sess, size = _session_locked(model_path, want)
            p = np.zeros((h, w), np.uint8)
            pmax, scale = _ai_region(sess, size, rgb, field, (0, 0, w, h), p)
            _ai_used = time.monotonic()
            if pmax >= 0.6:
                bb = _bbox(obj | (p >= 128))
                if bb is not None:
                    y0, y1, x0, x1 = bb
                    mx, my = int(0.1 * (x1 - x0)) + 2, int(0.1 * (y1 - y0)) + 2
                    reg = (max(0, x0 - mx), max(0, y0 - my), min(w, x1 + mx), min(h, y1 + my))
                    side2 = max(_square_tiles(*reg, size)[0][2], 1)
                    free2 = free_commit_mb()
                    # 첫 번째가 사진을 줄여서 봤고, 객체 둘레만 보면 1.7배 이상 자세해질 때만
                    if scale > 1.0 and side2 / size < 0.6 * scale and (free2 is None or free2 >= AI_MIN_MB):
                        say("ai", 0.5, "객체 모양 자세히 확인 중 (AI · CPU)")
                        sub = np.zeros((reg[3] - reg[1], reg[2] - reg[0]), np.uint8)
                        pm2, sc2 = _ai_region(sess, size, rgb, field, reg, sub)
                        if pm2 >= 0.6:
                            p[reg[1]:reg[3], reg[0]:reg[2]] = sub
                            scale = sc2
                        del sub
                _ai_used = time.monotonic()
    except Exception as e:  # noqa: BLE001 — 메모리 부족(할당 실패) 포함: 객체를 지우느니 AI 없이
        print("  AI 확인 실패, 안전 모드로 땁니다:", repr(e)[:160])
        release()
        return None, 1.0, "safe", NOTE_SAFE
    if pmax < 0.6:
        return None, 1.0, "unsure", NOTE_UNSURE
    return p, scale, str(size), None


# ----------------------------------------------------------------------------
# 1단계: 바깥 배경
# ----------------------------------------------------------------------------


def _seed_runs(F: np.ndarray, d: np.ndarray, t_bound: float) -> tuple[np.ndarray, np.ndarray]:
    """테두리에서 씨앗으로 쓸 배경 구간의 좌표. 한 변의 배경 구간은 (그 변의 25% 이상) 이거나 (귀퉁이를 포함)
    하거나 (양 끝이 둘 다 진한 픽셀로 막혀 있지 않을) 때만 씨앗 — 테두리에 걸린 칼끝·잘린 인물 안으로
    배경이 밀려 들어가지 않게. 씨앗이 안 된 진짜 배경도 안쪽에서 이어져 있으면 지워진다."""
    h, w = F.shape
    lines = (
        (F[0], (d[:3] >= t_bound).any(axis=0), lambda a: (np.zeros_like(a), a)),
        (F[-1], (d[-3:] >= t_bound).any(axis=0), lambda a: (np.full_like(a, h - 1), a)),
        (F[:, 0], (d[:, :3] >= t_bound).any(axis=1), lambda a: (a, np.zeros_like(a))),
        (F[:, -1], (d[:, -3:] >= t_bound).any(axis=1), lambda a: (a, np.full_like(a, w - 1))),
    )
    ys, xs = [], []
    for line, bound, coords in lines:
        n = line.size
        step = np.diff(np.concatenate([[0], line.astype(np.int8), [0]]))
        for a, b in zip(np.flatnonzero(step == 1), np.flatnonzero(step == -1)):
            ok = (b - a) >= 0.25 * n or a == 0 or b == n
            if not ok:
                ok = not (bound[max(0, a - 2):a].any() and bound[b:b + 2].any())
            if ok:
                yy, xx = coords(np.arange(a, b))
                ys.append(yy)
                xs.append(xx)
    if not ys:
        return np.zeros(0, np.int64), np.zeros(0, np.int64)
    return np.concatenate(ys), np.concatenate(xs)


def _fill_from(img: np.ndarray, ys: np.ndarray, xs: np.ndarray) -> None:
    """img(uint8 0/1) 에서 씨앗 좌표와 4-연결로 이어진 1 을 2 로 (제자리)."""
    for y, x in zip(ys.tolist(), xs.tolist()):
        if img[y, x] == 1:
            cv2.floodFill(img, None, (x, y), 2, flags=4)


def _flood_outside(F: np.ndarray, ys: np.ndarray, xs: np.ndarray, r: int) -> tuple[np.ndarray, np.ndarray]:
    """테두리 씨앗에서 반지름 r 의 공을 굴려 닿는 배경(바깥). 공은 2r 보다 좁은 틈을 못 지나간다.
    테두리를 따라 난 얇은 배경 띠(땅 띠 아래 1~3px 흰 줄 등)는 공이 못 들어가도 바깥으로 본다."""
    ball = _disk(r)
    core = cv2.erode(_u8(F), ball)  # 사진 밖은 배경으로 침
    _fill_from(core, ys, xs)
    reach = _u8(core == 2)
    del core
    outside = cv2.dilate(reach, ball) > 0
    outside &= F
    del reach
    band = min(2 * r, max(1, min(F.shape) // 2))
    strip = np.zeros(F.shape, np.uint8)
    strip[:band] = F[:band]
    strip[-band:] = F[-band:]
    strip[:, :band] = F[:, :band]
    strip[:, -band:] = F[:, -band:]
    _fill_from(strip, ys, xs)
    thin = strip == 2
    del strip
    outside |= thin
    return outside, thin


# ----------------------------------------------------------------------------
# 5단계: 경계 알파
# ----------------------------------------------------------------------------

_N8 = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))


def _window_mean(rgb: np.ndarray, wmask: np.ndarray, ys: np.ndarray, xs: np.ndarray, k: int = 7):
    """(ys, xs) 자리마다 k×k 창 안에서 wmask 인 픽셀들의 평균색. 줄 띠 단위로 계산해 메모리를 아낀다."""
    n = ys.size
    out = np.zeros((n, 3), np.float32)
    cnt = np.zeros(n, np.float32)
    if n == 0:
        return out, cnt
    hh = wmask.shape[0]
    r = k // 2
    order = np.argsort(ys, kind="stable")
    ys_s = ys[order]
    step = 512
    for a in range(0, hh, step):
        b = min(hh, a + step)
        i0, i1 = np.searchsorted(ys_s, [a, b])
        if i0 == i1:
            continue
        sel = order[i0:i1]
        c0, c1 = max(0, a - r), min(hh, b + r)
        m = wmask[c0:c1].astype(np.float32)
        yy, xx = ys[sel] - c0, xs[sel]
        cnt[sel] = cv2.boxFilter(m, -1, (k, k), normalize=False, borderType=cv2.BORDER_CONSTANT)[yy, xx]
        for c in range(3):
            v = rgb[c0:c1, :, c].astype(np.float32)
            v *= m
            out[sel, c] = cv2.boxFilter(v, -1, (k, k), normalize=False, borderType=cv2.BORDER_CONSTANT)[yy, xx]
        del m
    nz = cnt > 0.5
    out[nz] /= cnt[nz, None]
    return out, cnt


def _edge_alpha(rgb: np.ndarray, kept: np.ndarray, dtk: np.ndarray, d: np.ndarray, ys: np.ndarray, xs: np.ndarray,
                B: np.ndarray, lo: float, hi: float, noise: float, t_f: float) -> tuple[np.ndarray, np.ndarray]:
    """지운 곳과 맞닿은 픽셀의 알파와 안쪽 기준색 F̂.

    I = αF̂ + (1-α)B 로 보고 α 를 (I-B)·(F̂-B)/|F̂-B|² 로 구한다. F̂ 는 2~4px 안쪽 픽셀들의 평균, 가는 가지처럼
    안쪽이 없으면 둘레 7×7 에서 가장 진한 픽셀의 색. 다음은 불투명(α=1): 안쪽 이웃까지 같은 색인 평평한 곳 /
    기준색을 못 찾음 / 기준색이 배경과 24 이내(흰 칼날·꽃잎: 섞인 정도를 알 수 없음) / 섞임으로 설명이 안 되는
    다른 색(차이 > 22). 기준색 반대쪽으로 살짝 벗어난 픽셀(샤프닝 헤일로)은 0.
    단, 배경 잡음과 거의 같은 픽셀(배경과의 차이 < t_f)은 이 '불투명 보호'를 받지 않는다: 기준색이 배경과 뚜렷이
    다르면 섞인 만큼(투영), 아니면 0 — 객체 가장자리에 붙은 배경 얼룩이 불투명 테두리로 남지 않게.
    """
    hh, ww = kept.shape
    n = ys.size
    I = rgb[ys, xs].astype(np.float32)
    I16 = I.astype(np.int16)
    same = np.zeros(n, np.int16)
    same_in = np.zeros(n, np.int16)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if dy == 0 and dx == 0:
                continue
            yy = np.clip(ys + dy, 0, hh - 1)
            xx = np.clip(xs + dx, 0, ww - 1)
            inside = (ys + dy >= 0) & (ys + dy < hh) & (xs + dx >= 0) & (xs + dx < ww)
            close = inside & kept[yy, xx] & (np.abs(rgb[yy, xx].astype(np.int16) - I16).max(axis=1) <= 6)
            if abs(dy) <= 1 and abs(dx) <= 1:
                same += close
            same_in += close & (dtk[yy, xx] >= lo + 0.5)
    # 평평한 곳: 둘레 8칸 중 3칸 이상이 같은 색이고, 같은 색이 안쪽(2~3px)까지 이어질 때만. 경계를 따라 늘어선
    # 옅은 안티앨리어싱 줄·덩어리는 서로 비슷하기만 할 뿐 안쪽은 진한 색이다
    plateau = (same >= 3) & (same_in >= 2)
    band = kept & (dtk >= lo) & (dtk <= hi)
    Fh, nb = _window_mean(rgb, band, ys, xs, 7)
    del band
    none = nb < 0.5
    if none.any():
        # 가는 가지·털: 둘레 7×7 의 남은 픽셀 중 가장 진한(배경과 가장 다른) 픽셀을 기준색으로
        iy, ix = ys[none], xs[none]
        best = d[iy, ix].astype(np.int16)
        by, bx = iy.copy(), ix.copy()
        for dy in range(-3, 4):
            for dx in range(-3, 4):
                yy = np.clip(iy + dy, 0, hh - 1)
                xx = np.clip(ix + dx, 0, ww - 1)
                v = np.where(kept[yy, xx], d[yy, xx].astype(np.int16), -1)
                up = v > best
                best = np.where(up, v, best)
                by = np.where(up, yy, by)
                bx = np.where(up, xx, bx)
        found = best >= d[iy, ix].astype(np.int16) + 10
        Fh[none] = np.where(found[:, None], rgb[by, bx].astype(np.float32), I[none])
        none[np.flatnonzero(none)[found]] = False
    Fh[none] = I[none]
    D = Fh - B
    E = I - B
    pale = np.abs(D).max(axis=1) < 24
    dot = (E * D).sum(axis=1)
    nrm = np.maximum((D * D).sum(axis=1), 1e-6)
    a = np.clip(dot / nrm, 0.0, 1.0)
    third = np.abs(E - a[:, None] * D).max(axis=1) > 22
    halo = (dot <= 0) & ~third
    a[third] = 1.0
    # 색역 보장: 배경색을 빼서 되돌린 색이 0~255 를 벗어나지 않을 만큼은 불투명하게. 배경 잡음만큼의 차이는 빼고
    # 본다 (흰 배경 252 에서 +3 잡음이 '255 를 넘는 색' 으로 읽혀 불투명해지는 것 방지)
    En = np.sign(E) * np.maximum(np.abs(E) - noise, 0.0)
    amin = np.where(En > 0, En / np.maximum(255.0 - B, 1.0), np.where(En < 0, -En / np.maximum(B, 1.0), 0.0)).max(axis=1)
    a = np.maximum(a, np.minimum(amin, 1.0))
    a[halo] = 0.0
    faint = d[ys, xs] < t_f
    a[(plateau | none | pale) & ~faint] = 1.0
    a[faint & (none | (np.abs(D).max(axis=1) < t_f))] = 0.0
    return a.astype(np.float32), Fh


def _edge_color(I: np.ndarray, B: np.ndarray, a: np.ndarray, Fh: np.ndarray) -> np.ndarray:
    """반투명 픽셀의 원래 색: α ≥ 0.6 이면 배경색을 빼서 되돌린 색, α < 0.35 면 안쪽 기준색 (잡음이 커지므로),
    그 사이는 둘을 섞는다."""
    U = np.clip(B + (I - B) / np.maximum(a, 1e-3)[:, None], 0.0, 255.0)
    t = np.clip((a - 0.35) / 0.25, 0.0, 1.0)[:, None]
    out = Fh * (1.0 - t) + U * t
    out[a >= 0.999] = I[a >= 0.999]
    return out


# ----------------------------------------------------------------------------
# 누끼
# ----------------------------------------------------------------------------


def cut(rgba: np.ndarray, kind: str, bg: dict, model_path: Path | None = None,
        progress=None, inner: str = "auto", seeds=None, border: bool = True) -> tuple[np.ndarray, np.ndarray, dict]:
    """단색(에 가까운) 배경 에셋 누끼. 돌려주는 값: (마스크 uint8 HxW, 전경색 uint8 HxWx3, 정보).

    inner: 객체 안에 갇힌 배경색 — auto(종류별 기본) / keep(하나도 안 지움) / remove(일정 크기 이상은 모두 지움).
    seeds: 사용자가 '배경 찍기'로 찍은 자리 [(x, y), ...] (원본 px) — 그 자리와 이어진 배경을 지운다.
    border: True 면 사진 테두리의 배경도 자동으로 (자동 누끼 + 찍기), False 면 찍은 곳만 지운다.
    info.get("note"): 사용자에게 보여 줄 한국어 알림 (안전 모드 등).
    """
    if kind not in KINDS:
        kind = "item"
    if inner not in INNERS:
        inner = "auto"
    say = progress or (lambda *_: None)
    rgb = rgba[..., :3]
    h, w = rgb.shape[:2]
    seeds = _clip_seeds(seeds, h, w)
    if not seeds:
        border = True
    elif not border:
        inner = "keep"  # 찍은 곳만: 갇힌 배경색은 찍어야 지운다 (고리 안쪽 등)
    long = max(h, w)
    info: dict = {"kind": kind, "method": "asset", "inner": inner, "bg": [int(v) for v in bg["color"]]}

    # 0) 배경 모델
    say("asset", 0.05, "배경 분석 중")
    field, d, t0, sig = _background(rgb, bg, kind)
    info["t0"], info["sigma"] = round(t0, 1), round(sig, 2)
    t_lo = max(3.0, round(0.6 * t0))
    t_hi = max(2.0 * t0, t0 + 12.0)
    t_strong = t0 + 20.0
    r = max(2, int(round(long * 0.0015)))
    R = max(3 * r, int(round(0.006 * long)))

    # 1) 바깥 배경. 진한 픽셀 바로 옆은 더 엄격하게(t_lo) 봐서 윤곽선 틈을 좁힌다
    F = d <= t0
    F &= ~((cv2.dilate(_u8(d >= t_strong), _K3) > 0) & (d > t_lo))
    if border:
        sy, sx = _seed_runs(F, d, t0 + 12.0)
    else:
        sy = sx = np.zeros(0, np.int64)
    outside, thin = _flood_outside(F, sy, sx, r)
    del sy, sx
    user = None
    if seeds:
        user = _flood_user(rgb, F, seeds, r, t0)
        outside |= user
        info["seeds"] = len(seeds)

    # AI (산·아이템·인물): 바깥으로 잡힌 흰 칼날 등을 되살리고, 갇힌 구멍을 지울지 정할 때 쓴다
    p = None
    s_ai = 1.0
    if kind != "tree":
        if model_path is None or not Path(model_path).exists():
            info["ai"], info["note"] = "none", NOTE_NO_MODEL
        else:
            p, s_ai, info["ai"], note = _ai_probability(rgb, field, ~outside, Path(model_path), say)
            if note:
                info["note"] = note
    ai_ok = p is not None

    # 작업 영역(ROI): 객체(+AI 가 객체라는 곳) 둘레만 — 나머지는 전부 바깥 배경. 배경에 홀로 떨어진 잡음
    # 1~2픽셀은 영역을 정할 때만 뺀다 (선은 끝점 말고는 이웃이 2개 이상이라 그대로 들어간다)
    obj = _u8(~outside)
    obj = (cv2.boxFilter(obj, -1, (3, 3), normalize=False, borderType=cv2.BORDER_CONSTANT) >= 3) & (obj > 0)
    if ai_ok:
        obj |= p >= 128
    bb = _bbox(obj)
    del obj
    if bb is None:
        info["empty"] = True
        return np.zeros((h, w), np.uint8), np.ascontiguousarray(rgb), info
    pad = 2 * R + 6
    y0, y1 = max(0, bb[0] - pad), min(h, bb[1] + pad)
    x0, x1 = max(0, bb[2] - pad), min(w, bb[3] + pad)
    sl = (slice(y0, y1), slice(x0, x1))
    d_r = d[sl].copy()
    F_r = F[sl].copy()
    out_r = outside[sl].copy()
    thin_r = thin[sl].copy()
    p_r = p[sl].copy() if ai_ok else None
    user_r = user[sl].copy() if user is not None else None
    del d, F, outside, thin, p, user
    rgb_r = rgb[sl]
    hh, ww = d_r.shape
    info["roi"] = [int(x0), int(y0), int(x1), int(y1)]

    def bg_at(yy: np.ndarray, xx: np.ndarray) -> np.ndarray:
        return _field_at(field, yy + y0, xx + x0, h, w)

    # 산·아이템·인물: 큰 공(반지름 R)으로 한 번 더. 작은 공만 들어간 좁은 입구 안쪽은 아래 '입구 검사'로
    dtF = cv2.distanceTransform(_u8(F_r), cv2.DIST_L2, 5)
    if kind != "tree" and border:
        core = _u8(dtF > R).copy()
        edge = np.zeros((hh, ww), bool)
        edge[0] = edge[-1] = True
        edge[:, 0] = edge[:, -1] = True
        ey, ex = np.nonzero(edge & out_r & (core == 1))
        del edge
        _fill_from(core, ey, ex)
        reach = core == 2
        del core
        if reach.any():
            base = cv2.distanceTransform(_u8(~reach), cv2.DIST_L2, 5) <= R
            base &= F_r
        else:
            base = np.zeros((hh, ww), bool)
        del reach
        base |= thin_r
    else:
        base = out_r
    del out_r, thin_r

    # 2) 바깥 공이 닿지 않은 배경색 덩어리 (4-연결): 입구 검사 → 갇힌 덩어리 판정
    rest = F_r & ~base
    removed = base
    n, lab = cv2.connectedComponents(_u8(rest), connectivity=4)
    info["enclosed"] = 0
    if n > 1:
        idx = lab[rest]
        area = np.bincount(idx, minlength=n)
        width = np.zeros(n, np.float32)
        np.maximum.at(width, idx, dtF[rest])
        width = 2.0 * width - 1.0  # 픽셀 폭 (1px 줄 = 1, 3px 줄 = 3)
        del idx
        mouth = np.bincount(lab[(cv2.dilate(_u8(base), _K3) > 0) & rest], minlength=n)
        # 둘레(3px): 진한 색이면 잎·가지·윤곽 사이로 비친 배경, 옅으면 흰 객체 속 하이라이트. 작은 구멍은 둘레의
        # 안쪽 1~2px 이 안티앨리어싱이라 옅게 나오므로 3px 까지 보고 35% 까지 옅어도 '진한 둘레'로 본다
        own = cv2.dilate(lab.astype(np.uint16 if n < 65535 else np.float32), _K7)
        rim = (own > 0) & ~rest & (d_r > t0)
        o = own[rim].astype(np.int64)
        dv = d_r[rim]
        # 옅은 색은 '평평한' 픽셀만 센다 (꽃잎·흰 객체). 진한 잎과 배경 사이 비탈(안티앨리어싱)은 옅어도 빼고 본다.
        # 평평함은 배경색이 아닌 이웃끼리만 비교한다 (구멍 바로 옆 꽃잎 픽셀도 구멍 때문에 비탈로 보이지 않게)
        dm = d_r.copy()
        dm[d_r <= t0] = 255
        flat = (cv2.subtract(cv2.dilate(d_r, _K3), cv2.erode(dm, _K3)) < 20)[rim]
        del dm
        rim_n = np.bincount(o, minlength=n).astype(np.float32)
        rim_dark = (rim_n > 0) & (np.bincount(o, weights=(dv < 30) & flat, minlength=n) <= 0.35 * rim_n)
        pale_frac = np.bincount(o, weights=(dv <= 45) & flat, minlength=n) / np.maximum(rim_n, 1)
        del flat
        # 벽 두께: 둘레의 절반 이상이 바깥 배경에서 T px 안이면 얇은 윤곽선으로만 바깥과 갈린 '모양의 속'
        # (속이 배경색인 칼날·꽃잎 그림). AI(ISNet)도 이런 속은 배경으로 보므로(실측) 구멍으로 지우지 않는다
        if kind != "tree":
            T = max(4, int(round(0.006 * long)))
            thin_w = cv2.distanceTransform(_u8(~base), cv2.DIST_L2, 5)[rim] <= T
            thick = np.bincount(o, weights=thin_w, minlength=n) < 0.5 * rim_n
            del thin_w
        del own, rim, o, dv
        # 입구 검사: 바깥과 맞닿은 입구가 덩어리 폭만큼 넓고 얕으면 바깥의 홈 (오목한 모서리·잎 사이 틈)
        notch = (mouth > 0) & (mouth >= 0.7 * width) & (area <= 6.0 * mouth * np.maximum(width, 1))
        if kind != "tree":
            notch &= rim_dark  # 옅은 객체 속 홈(칼날 가운데 흰 줄 등)은 남김
        notch[0] = False
        enclosed = ~notch
        enclosed[0] = False
        kill = notch.copy()
        info["notches"] = int(notch.sum())
        info["enclosed"] = int(enclosed.sum())
        if enclosed.any() and inner != "keep":
            if inner == "remove":
                kill |= enclosed & (area >= max(16, h * w * 2e-5))
            else:
                # bg_same: 잡음까지 배경과 같은가 (1px 깎은 안쪽에서, 작으면 전체에서)
                er = (cv2.erode(_u8(rest), _K3) > 0)
                er_n = np.bincount(lab[er], minlength=n)
                use = rest & ((er & (er_n >= 9)[lab]) | (er_n < 9)[lab])
                del er
                uy, ux = np.nonzero(use & enclosed[lab])
                del use
                li = lab[uy, ux]
                res = rgb_r[uy, ux].astype(np.float32) - bg_at(uy, ux)
                del uy, ux
                cnt = np.bincount(li, minlength=n).astype(np.float32)
                cored = er_n >= 9  # 1px 깎은 안쪽으로 쟀다 (작으면 가장자리 안티앨리어싱까지 섞여 흔들림은 못 봄)
                c1 = np.maximum(cnt, 1)
                mean = np.stack([np.bincount(li, weights=res[:, c], minlength=n) for c in range(3)], 1) / c1[:, None]
                sq = np.stack([np.bincount(li, weights=res[:, c] ** 2, minlength=n) for c in range(3)], 1) / c1[:, None]
                std = np.sqrt(np.maximum(sq - mean ** 2, 0))
                del res, li, sq
                # 허용치: 배경 곡면이 자리마다 1~3 쯤 어긋나는 것까지 (실측: 숲 띠의 진짜 구멍 평균 +1.5~+3).
                # 음영이 있는 흰 칼날·꽃잎은 평균이 4~15 벗어나 여기서 걸러진다
                tol_m = max(3.0, 0.5 * t0) + 2.5 * sig / np.sqrt(c1)
                bg_same = (cnt > 0) & (np.abs(mean).max(axis=1) <= tol_m) & (
                    ~cored | (std.max(axis=1) <= max(2.5, 2.0 * sig + 1.5)))
                rule = enclosed & bg_same & rim_dark
                if kind == "tree":
                    # 흰 꽃·하이라이트 속(둘레의 20% 이상이 평평한 옅은 색 = 꽃잎)은 남김. 크기와 무관하게 판정
                    kill |= rule & (pale_frac < 0.2)
                    # 6px 이하 바늘구멍은 둘레가 안티앨리어싱이라 '진한 둘레'로 안 나올 수 있다: 둘레의 절반
                    # 이상이 꽃잎만 아니면 지운다
                    kill |= enclosed & bg_same & (area <= 6) & (pale_frac < 0.5)
                elif ai_ok:
                    ai4 = np.bincount(lab[rest & (p_r >= 102)], minlength=n) < 0.1 * area  # AI 90% 값 < 0.4
                    ai5 = np.bincount(lab[rest & (p_r >= 128)], minlength=n) < 0.1 * area  # < 0.5
                    rule &= thick
                    if kind == "mountain":
                        kill |= rule & ai4
                    elif kind == "item":
                        kill |= rule & ai4 & (width >= 4)
                    else:
                        kill |= rule & ai5
                # AI 가 없으면 산·아이템·인물의 갇힌 덩어리는 모두 남긴다
        kill[0] = False
        info["holes"] = int((kill & enclosed).sum())
        if _debug is not None:
            _debug.update(lab=lab.copy(), dtF=dtF.copy(), d_r=d_r.copy(), field=field, t0=t0, sig=sig,
                          area=area, width=width, mouth=mouth, rim_dark=rim_dark, pale_frac=pale_frac,
                          enclosed=enclosed, kill=kill, roi=(y0, y1, x0, x1), locals={k: v for k, v in locals().items()
                                                                                    if k in ("bg_same", "mean", "std", "cnt", "thick")})
        removed = base | kill[lab]
    if inner == "remove" or (inner == "auto" and kind == "tree"):
        # 배경보다 조금 밝거나 어두운(미묘하게 다른) 갇힌 하늘 조각: 잎 사이로 비친 하늘은 배경과 2~6 다르고 결이 있어
        # 위 판정(잡음까지 배경과 같음)에 안 걸린다. '지우기'면 크기만 보고 지우고, 나무 기본값은 하늘 조각 전체의
        # 둘레가 진한 잎·가지일 때만 지운다 (둘레가 옅은 색이면 흰 꽃잎 덩어리일 수 있어 남김)
        t_soft = max(2.5 * t0, 16.0)
        soft = (d_r <= t_soft) & ~removed
        n3, lab3 = cv2.connectedComponents(_u8(soft), connectivity=4)
        if n3 > 1:
            a3 = np.bincount(lab3.ravel(), minlength=n3)
            big = a3 >= max(64, int(h * w * 4e-5))  # 작은 하이라이트 점은 남김
            big[0] = False
            if inner == "auto":
                own3 = cv2.dilate(lab3.astype(np.uint16 if n3 < 65535 else np.float32), _K7)
                rim3 = (own3 > 0) & ~soft & ~removed
                o3 = own3[rim3].astype(np.int64)
                dv3 = d_r[rim3]
                rn = np.bincount(o3, minlength=n3).astype(np.float32)
                pale3 = np.bincount(o3, weights=(dv3 <= 45), minlength=n3) / np.maximum(rn, 1)
                sy, sx = np.nonzero(soft & big[lab3])
                li3 = lab3[sy, sx]
                res3 = rgb_r[sy, sx].astype(np.float32) - bg_at(sy, sx)
                c3 = np.maximum(np.bincount(li3, minlength=n3), 1).astype(np.float32)
                m3 = np.stack([np.bincount(li3, weights=res3[:, c], minlength=n3) for c in range(3)], 1) / c3[:, None]
                q3 = np.stack([np.bincount(li3, weights=res3[:, c] ** 2, minlength=n3) for c in range(3)], 1) / c3[:, None]
                s3 = np.sqrt(np.maximum(q3 - m3 ** 2, 0)).max(axis=1)
                big &= (rn > 0) & (pale3 < 0.2) & (np.abs(m3).max(axis=1) <= max(8.0, 1.5 * t0)) & (s3 <= 8.0)
                del own3, rim3, o3, dv3, sy, sx, li3, res3
            removed = removed | big[lab3]
            info["soft_holes"] = int(big.sum())
        del soft, lab3
    if user_r is not None:
        removed = removed | user_r  # 찍은 곳은 확실히 지운다
    del lab, rest, dtF, base

    # 3) AI 복원 (산·아이템·인물): 바깥으로 잡혔지만 AI 가 객체라고 확신하는 곳 (윤곽선 없는 흰 칼날·눈 봉우리)
    restored = None
    if ai_ok:
        ro = max(2, int(round(0.002 * long)))
        hi = cv2.morphologyEx(_u8(p_r >= 204), cv2.MORPH_OPEN, _disk(ro))
        ext = cv2.dilate(hi, _disk(2 * s_ai + 2)) > 0
        del hi
        cand = removed & (p_r >= 128) & ext
        del ext
        if cand.any():
            n2, lab2 = cv2.connectedComponents(_u8(cand), connectivity=8)
            area2 = np.bincount(lab2[cand], minlength=n2)
            strong = ~removed & (d_r >= t_strong)
            touch = np.bincount(lab2[(cv2.dilate(_u8(strong), _K3) > 0) & cand], minlength=n2)
            del strong
            ok = (area2 >= max(30, 4 * ro * ro)) & (touch > 0)
            for sx_, sy_ in seeds:  # 사용자가 직접 찍은 자리는 AI 가 되살리지 않는다
                yy, xx = sy_ - y0, sx_ - x0
                if 0 <= yy < hh and 0 <= xx < ww:
                    ok[lab2[yy, xx]] = False
            ok[0] = False
            if ok.any():
                restored = ok[lab2]
                removed &= ~restored
                info["restored_px"] = int(restored.sum())
            del lab2
        del cand

    # 4) 잡티: 진한 픽셀(t_hi 이상)이 하나도 없는 작은 덩어리 = 배경 얼룩·잡음 (8-연결)
    kept = ~removed
    n3, lab3 = cv2.connectedComponents(_u8(kept), connectivity=8)
    if n3 > 1:
        area3 = np.bincount(lab3[kept], minlength=n3)
        hi3 = np.bincount(lab3[kept & (d_r >= t_hi)], minlength=n3)
        rs3 = np.bincount(lab3[restored], minlength=n3) if restored is not None else np.zeros(n3, np.int64)
        drop = (hi3 == 0) & (area3 < max(64, 2e-5 * h * w)) & (rs3 == 0)
        if ai_ok:
            drop &= np.bincount(lab3[kept & (p_r >= 128)], minlength=n3) < 0.1 * area3
            # 큰 얼룩도: 진한 픽셀이 없고 대부분 옅으며 AI 가 확실히 배경(0.2 미만)이라고 하면
            st3 = np.bincount(lab3[kept & (d_r >= t_strong)], minlength=n3)
            mid3 = np.bincount(lab3[kept & (d_r > t0 + 15)], minlength=n3)
            ai3 = np.bincount(lab3[kept & (p_r >= 51)], minlength=n3)
            drop |= (st3 == 0) & (mid3 <= 0.1 * area3) & (ai3 == 0) & (rs3 == 0)
        drop[0] = False
        if drop.any():
            removed |= drop[lab3]
            info["specks"] = int(drop.sum())
    del lab3
    kept = ~removed

    # 5) 알파: 지운 곳과 맞닿은 픽셀만 (안쪽은 불투명)
    say("edge", 0.8, "경계 다듬는 중")
    alpha = kept.astype(np.float32)
    dtk = cv2.distanceTransform(_u8(kept), cv2.DIST_L2, 5)
    no_color = restored if restored is not None else np.zeros((hh, ww), bool)
    fixes = []  # (ys, xs, 색) — 마지막에 전경색에 반영
    # 바깥 줄부터 한 줄씩. 두 번째 줄부터는 바로 바깥 줄이 꽤 투명했던 곳 뒤에서만 (번진 경계). 업스케일한 큰
    # 그림은 경계가 3~4px 번져 있어 줄 수를 늘린다
    rings = 2 if long <= 1200 else 3 if long <= 2600 else 4
    soft = None
    edge_px = 0
    for k in range(1, rings + 1):
        ring = kept & (dtk < k + 0.5) & (d_r > t_lo) & ~no_color
        if k > 1:
            ring &= (dtk >= k - 0.5) & (cv2.dilate(_u8(soft), _K3) > 0)
        ys, xs = np.nonzero(ring)
        del ring
        if ys.size == 0:
            break
        B = bg_at(ys, xs)
        a, Fh = _edge_alpha(rgb_r, kept, dtk, d_r, ys, xs, B, k + 1.0, k + 3.0, max(3.0, t_lo), t0 + 4.0)
        alpha[ys, xs] = a
        fixes.append((ys, xs, _edge_color(rgb_r[ys, xs].astype(np.float32), B, a, Fh)))
        edge_px += ys.size
        soft = np.zeros((hh, ww), bool)
        soft[ys[a < 0.9], xs[a < 0.9]] = True
    del soft
    info["edge_px"] = int(edge_px)
    if restored is not None:
        # 되살린 곳의 경계: 색으로는 알 수 없으므로 AI 확률로 1px 만 부드럽게
        re = restored & (dtk < 1.5)
        alpha[re] = np.clip((p_r[re].astype(np.float32) / 255.0 - 0.4) / 0.2, 0.0, 1.0)
        del re

    if kind == "tree":
        # 나무 밑에 옅게 그려진 그림자: 무늬 없이 배경보다 조금 어두운 부분이 바깥과 이어져 있고 객체 아래쪽에
        # 있으면, 불투명한 회색 띠 대신 배경색을 뺀 반투명 그림자로. 배경보다 밝은 옅은 줄(땅 위 안개·빛)은 배경으로
        obj_rows = np.flatnonzero(kept.any(axis=1))
        if obj_rows.size:
            yt, yb = int(obj_rows[0]), int(obj_rows[-1])
            z0 = max(yt, yb - (yb - yt) // 4)
            gray = cv2.cvtColor(np.ascontiguousarray(rgb_r[z0:]), cv2.COLOR_RGB2GRAY)
            dz = d_r[z0:]
            softish = kept[z0:] & (dz > t0) & (dz <= max(4 * t0, 40)) & (_local_std(gray) <= 5.0)
            del gray
            n4, lab4 = cv2.connectedComponents(_u8(softish), connectivity=8)
            if n4 > 1:
                touch4 = np.unique(lab4[(cv2.dilate(_u8(removed[z0:]), _K3) > 0) & softish])
                lut4 = np.zeros(n4, bool)
                lut4[touch4[touch4 > 0]] = True
                shadow = lut4[lab4]
                if shadow.any():
                    sy4, sx4 = np.nonzero(shadow)
                    sy4 += z0
                    I = rgb_r[sy4, sx4].astype(np.float32)
                    B = bg_at(sy4, sx4)
                    full = max(6 * t0, 64.0)
                    a = np.clip((d_r[sy4, sx4].astype(np.float32) - t0) / (full - t0), 0.0, 1.0)
                    a = np.where(I @ _LUMA >= B @ _LUMA - 1.0, 0.0, a).astype(np.float32)
                    alpha[sy4, sx4] = a
                    fixes.append((sy4, sx4, np.clip(B + (I - B) / np.maximum(a, 0.02)[:, None], 0, 255)))
                    info["shadow_px"] = int(shadow.sum())
                del shadow
            del lab4, softish

    # 원래 투명도가 있던 그림은 그만큼 곱한다
    src_a = rgba[..., 3]
    if src_a.min() < 255:
        alpha *= src_a[sl].astype(np.float32) / 255.0
    mask = np.zeros((h, w), np.uint8)
    mask[sl] = (alpha * 255.0 + 0.5).astype(np.uint8)
    del alpha
    fg = np.array(rgb)  # 원본(읽기 전용일 수 있음)은 건드리지 않는다
    fg_r = fg[sl]
    for yy, xx, cc in fixes:
        fg_r[yy, xx] = (cc + 0.5).astype(np.uint8)
    return mask, fg, info
