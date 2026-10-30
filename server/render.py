"""폴더 작업용 합성: 누끼 결과(마스크·전경색)에 외곽선·배경을 입히고 배치·크기·형식대로 인코딩한다.

편집기의 합성 셰이더(web/src/gl/shaders.ts 의 FS_COMP 외곽선 부분)와 같은 식을 numpy 로 옮긴 것.
폴더 작업을 브라우저(WebGL)가 아니라 서버에서 돌려, 큰 사진을 연달아 처리해도 메모리를 적게 쓴다.

메모리: 예전에는 사진 전체를 float 로(외곽선을 켜면 float64 로) 바꿔 계산해서 12MP 사진 한 장에 1~2GB 를 썼다.
  - 투명 배경 + 외곽선 없음: 전경색과 마스크를 붙이기만 한다 (uint8, 결과는 예전과 비트 단위로 같음)
  - 단색 배경 + 외곽선 없음: 피사체 상자 안에서만 섞고 바깥은 배경색으로 채운다 (결과 같음)
  - 외곽선: 거리 계산은 피사체 상자 + 외곽선 두께 안에서만, 색 계산은 몇 줄씩 나눠 float32 로 (차이 1/255 이내)
"""

from __future__ import annotations

import io

import cv2
import numpy as np

# 색 계산을 이만큼(픽셀 수)씩 나눠서 한다 — 큰 사진에서도 임시 배열이 수십 MB 를 넘지 않게
_CHUNK_PX = 1 << 18
# 투명한 픽셀의 RGB 를 가장 가까운 피사체 색으로 채우는 거리 (px)
BLEED_RADIUS = 16
# 예전 식과 같은 '안쪽' 기준 (마스크/255 ≥ 0.5 를 float32 로 계산한 것)
_INSIDE = (np.arange(256, dtype=np.float32) / 255.0) >= 0.5


def _hex(c: str) -> np.ndarray:
    c = c.lstrip("#")
    return np.array([int(c[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0


def _smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / max(e1 - e0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def outline_width(s: dict, w: int, h: int) -> float:
    ol = s["outline"]
    if s.get("widthUnit") == "auto":  # 가로·세로 모두 1024 이하면 1px, 그보다 크면 2px
        return 1.0 if max(w, h) <= 1024 else 2.0
    if s.get("widthUnit") == "pct":
        return max(1.0, round(max(w, h) * float(s.get("widthPct", 0.5)) / 100))
    return max(1.0, float(ol.get("width", 2)))


def _span(flags: np.ndarray) -> tuple[int, int] | None:
    idx = np.flatnonzero(flags)
    return None if idx.size == 0 else (int(idx[0]), int(idx[-1]) + 1)


def _bbox(a: np.ndarray, thr: int) -> tuple[int, int, int, int] | None:
    """a > thr 인 픽셀을 감싸는 상자 (x0, y0, x1, y1 — 끝은 미포함). 없으면 None.
    줄·칸별 최댓값만 보므로 사진 크기의 임시 배열을 만들지 않는다."""
    ys = _span(a.max(axis=1) > thr)
    if ys is None:
        return None
    xs = _span(a.max(axis=0) > thr)
    return xs[0], ys[0], xs[1], ys[1]


class _Outline:
    """외곽선 설정값 (예전 compose 와 같은 식)."""

    def __init__(self, s: dict, ol: dict, w: int, h: int) -> None:
        self.pos = pos = ol.get("position", "center")
        self.W = W = outline_width(s, w, h)
        soft = float(ol.get("soft", 0))
        self.pad = int(np.ceil(W + soft if pos == "outside" else W / 2 + soft if pos == "center" else 0))
        self.ob = W if pos == "outside" else W * 0.5 if pos == "center" else 0.0
        self.ib = self.ob - W
        self.sm = max(soft, 0.6)
        self.grad = ol.get("fill") == "gradient"
        self.c1 = np.array([*_hex(ol.get("color", "#000000")), float(ol.get("alpha1", 100)) / 100], np.float32)
        self.c2 = (np.array([*_hex(ol.get("color2", "#000000")), float(ol.get("alpha2", 0)) / 100], np.float32)
                   if self.grad else self.c1)
        self.opacity = float(ol.get("opacity", 100))
        # 피사체 상자 밖으로 외곽선이 닿는 거리 (안쪽 외곽선은 마스크가 있는 곳에만 그려진다).
        # 이보다 먼 곳은 외곽선이 정확히 0 이라 외곽선이 없을 때와 결과가 같다.
        self.margin = (2 if pos == "inside" else int(np.ceil(self.ob + self.sm + 0.5))) + 2


def _comp(fg8: np.ndarray, m8: np.ndarray, sd: np.ndarray | None, bg: np.ndarray | None,
          o: _Outline | None) -> np.ndarray:
    """예전 compose 의 픽셀 식 그대로 (float32): 전경색 (...,3) + 마스크 (...) [+ 경계까지 거리] → RGBA uint8."""
    m = m8.astype(np.float32) / 255.0
    F = fg8.astype(np.float32) / 255.0
    shp = m.shape
    # 배경 (곱셈된 색 Pb, 불투명도 Ab)
    if bg is not None:
        Pb = np.empty(shp + (3,), np.float32)
        Pb[:] = bg
        Ab = np.ones(shp, np.float32)
    else:
        Pb = np.zeros(shp + (3,), np.float32)
        Ab = np.zeros(shp, np.float32)
    sA = sC = None
    if o is not None:
        if o.grad:
            t = np.clip((o.ob - sd) / max(o.W, 1e-3), 0.0, 1.0)[..., None]
            c = o.c1 * (1 - t) + o.c2 * t
        else:
            c = o.c1  # 단색: c1·(1−t) + c1·t = c1
        outer = 1.0 if o.pos == "inside" else 1.0 - _smoothstep(o.ob - o.sm, o.ob + o.sm, sd)
        inner = 1.0 if o.pos == "outside" else _smoothstep(o.ib - o.sm, o.ib + o.sm, sd)
        sA = c[..., 3] * outer * inner * o.opacity / 100
        if o.pos == "inside":
            sA = sA * m
        sC = c[..., :3]
        if o.pos == "outside":  # 바깥 외곽선은 피사체 뒤에
            Pb = sC * sA[..., None] + Pb * (1 - sA[..., None])
            Ab = sA + Ab * (1 - sA)
    P = F * m[..., None] + Pb * (1 - m[..., None])
    A = m + Ab * (1 - m)
    if sA is not None and o.pos != "outside":  # 가운데·안쪽 외곽선은 피사체 위에
        P = sC * sA[..., None] + P * (1 - sA[..., None])
        A = sA + A * (1 - sA)
    out = np.empty(shp + (4,), np.float32)
    out[..., :3] = np.where(A[..., None] > 1e-4, P / np.maximum(A, 1e-4)[..., None], F)
    out[..., 3] = A
    return (np.clip(out, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def _signed_dist(mask: np.ndarray) -> np.ndarray:
    """피사체 경계까지의 거리 (+ 바깥, - 안쪽; float32). 예전 식과 같은 값을 임시 배열 없이 제자리에서 만든다:
    where(inside, -max(0, d_in - 0.5), max(0, d_out - 0.5))"""
    inside = _INSIDE[mask]
    d_out = cv2.distanceTransform((~inside).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    d_in = cv2.distanceTransform(inside.astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    np.subtract(d_out, 0.5, out=d_out)
    np.maximum(d_out, 0.0, out=d_out)
    np.subtract(d_in, 0.5, out=d_in)
    np.maximum(d_in, 0.0, out=d_in)
    np.negative(d_in, out=d_in)
    np.copyto(d_out, d_in, where=inside)
    return d_out


def compose(fg: np.ndarray, mask: np.ndarray, s: dict) -> tuple[np.ndarray, int]:
    """전경색 HxWx3 uint8 + 마스크 HxW uint8 → 합성 결과 RGBA uint8 (비곱셈) 와 외곽선 여백(px)."""
    h, w = mask.shape
    bg = _hex(s.get("bgColor", "#ffffff")) if s.get("bg") == "color" else None
    ol = s.get("outline") or {}
    o = _Outline(s, ol, w, h) if ol.get("enabled") else None
    pad = 0 if o is None else o.pad
    if bg is None:
        # 투명 배경: 마스크가 0 인 곳은 (전경색, 투명) 그대로 — 외곽선이 없으면 이것이 결과 전부
        out = np.dstack([fg, mask])
        if o is None:
            return out, 0
    else:
        out = np.empty((h, w, 4), np.uint8)
        out[:] = _comp(np.zeros((1, 3), np.uint8), np.zeros(1, np.uint8), None, bg, None)[0]
    b = _bbox(mask, 0)
    if b is None:  # 피사체가 없음 (외곽선도 생기지 않음)
        return out, pad
    sd = None
    if o is not None:
        b = (max(0, b[0] - o.margin), max(0, b[1] - o.margin), min(w, b[2] + o.margin), min(h, b[3] + o.margin))
    x0, y0, x1, y1 = b
    if o is not None:
        sd = _signed_dist(mask[y0:y1, x0:x1])
    step = max(1, _CHUNK_PX // max(1, x1 - x0))
    for r0 in range(y0, y1, step):
        r1 = min(y1, r0 + step)
        out[r0:r1, x0:x1] = _comp(fg[r0:r1, x0:x1], mask[r0:r1, x0:x1],
                                  None if sd is None else sd[r0 - y0:r1 - y0], bg, o)
    return out, pad


def subject_bounds(mask: np.ndarray, pad: int) -> tuple[int, int, int, int] | None:
    """피사체 영역 (편집기와 같은 기준: 마스크 > 6, 외곽선 두께만큼 넓힘). (x, y, w, h)"""
    b = _bbox(mask, 6)
    if b is None:
        return None
    h, w = mask.shape
    x0, y0 = max(0, b[0] - pad), max(0, b[1] - pad)
    x1, y1 = min(w, b[2] + pad), min(h, b[3] + pad)
    return x0, y0, x1 - x0, y1 - y0


def bleed(rgba: np.ndarray, radius: int = BLEED_RADIUS) -> None:
    """투명한 픽셀(α < 1/255)의 RGB 를 가장 가까운 피사체 픽셀(α ≥ 0.5)의 색으로 채운다 (radius px 까지, 제자리).

    투명한 곳에는 원래 배경색(흰색·하늘색)이 남아 있어서, 게임 엔진이 텍스처를 확대·축소(쌍선형·밉맵)하면 그 색이
    가장자리로 번져 매트가 완벽해도 흰 테두리가 생긴다. 보이는 픽셀(α > 0)은 바꾸지 않는다.
    가까운 피사체는 한 줄 띠(위아래 radius+1 줄 여유)에서만 찾으면 되므로 몇 줄씩 나눠 메모리를 적게 쓴다.
    """
    a = rgba[..., 3]
    if a.size == 0 or a.min() > 0:
        return
    b = _bbox(a, 127)
    if b is None:
        return
    h, w = a.shape
    R = int(radius)
    x0, y0, x1, y1 = max(0, b[0] - R), max(0, b[1] - R), min(w, b[2] + R), min(h, b[3] + R)
    halo = R + 1
    step = max(8, _CHUNK_PX // max(1, x1 - x0))
    for r0 in range(y0, y1, step):
        r1 = min(y1, r0 + step)
        e0, e1 = max(y0, r0 - halo), min(y1, r1 + halo)
        sub = a[e0:e1, x0:x1]
        tgt = sub[r0 - e0:r1 - e0] == 0
        if not tgt.any():
            continue
        src = sub >= 128
        if not src.any():
            continue
        # 라벨 k (1부터) = 래스터 순서로 k번째 기준 픽셀 (DIST_LABEL_PIXEL)
        dist, lab = cv2.distanceTransformWithLabels((~src).astype(np.uint8), cv2.DIST_L2, 5,
                                                    labelType=cv2.DIST_LABEL_PIXEL)
        tgt &= dist[r0 - e0:r1 - e0] <= R
        ys, xs = np.nonzero(tgt)
        if ys.size == 0:
            continue
        colors = rgba[e0:e1, x0:x1, :3][src]
        rgba[r0 + ys, x0 + xs, :3] = colors[lab[r0 - e0:r1 - e0][ys, xs] - 1]


def encode(img: np.ndarray, mask: np.ndarray, pad: int, s: dict) -> tuple[bytes, bool]:
    """배치(그대로/딱 맞게/정사각형)·크기·형식을 적용해 파일 바이트로. 두 번째 값: 피사체를 찾았는지.

    img: compose 결과 RGBA uint8 (투명한 픽셀의 색을 채우느라 제자리에서 바뀔 수 있다).
    """
    from PIL import Image

    rgba8 = img if img.dtype == np.uint8 else (np.clip(img, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    b = subject_bounds(mask, pad)
    layout = s.get("layout", "as-is")
    if b is not None and layout != "as-is":
        x, y, bw, bh = b
        p = int(round(max(bw, bh) * float(s.get("padding", 8)) / 100))
        cw, ch = (bw + 2 * p, bh + 2 * p) if layout == "trim" else (max(bw, bh) + 2 * p,) * 2
        canvas = np.zeros((ch, cw, 4), np.uint8)
        if s.get("bg") == "color":
            canvas[..., :3] = (_hex(s.get("bgColor", "#ffffff")) * 255 + 0.5).astype(np.uint8)
            canvas[..., 3] = 255
        ox, oy = (cw - bw) // 2, (ch - bh) // 2
        canvas[oy:oy + bh, ox:ox + bw] = rgba8[y:y + bh, x:x + bw]
        rgba8 = canvas
    fmt = s.get("format", "png")
    keep_alpha = fmt != "jpeg"
    ih, iw = rgba8.shape[:2]
    long_side = s.get("longSide")
    if long_side and max(iw, ih) > int(long_side):
        sc = int(long_side) / max(iw, ih)
        size = (max(1, round(iw * sc)), max(1, round(ih * sc)))
        # 투명한 부분의 색이 번지지 않도록 곱셈된 알파로 줄인다
        im = Image.fromarray(rgba8).convert("RGBa").resize(size, Image.LANCZOS).convert("RGBA")
        rgba8 = None
        if keep_alpha:
            arr = np.array(im)
            del im
            bleed(arr)
            im = Image.fromarray(arr)
    else:
        if keep_alpha:
            bleed(rgba8)
        im = Image.fromarray(rgba8)
    q = int(s.get("quality", 92))
    buf = io.BytesIO()
    if fmt == "jpeg":
        base = Image.new("RGB", im.size, tuple(int(v * 255 + 0.5) for v in _hex(
            s.get("bgColor", "#ffffff") if s.get("bg") == "color" else "#ffffff")))
        base.paste(im, mask=im.getchannel("A"))
        base.save(buf, "JPEG", quality=q, optimize=True)
    elif fmt == "webp":
        # exact: 투명한 픽셀의 색(위에서 채운 피사체 색)을 버리지 않게 (버리면 가장자리 번짐이 되살아남)
        im.save(buf, "WEBP", quality=q, method=4, exact=True)
    else:
        im.save(buf, "PNG", compress_level=6)
    return buf.getvalue(), b is not None
