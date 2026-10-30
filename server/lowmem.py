"""메모리 절약 모드: BiRefNet 의 변형 합성곱(deformable conv)을 조금씩 나눠 계산한다.

BiRefNet ONNX 에서 변형 합성곱 20개는 '모든 위치에서 49곳을 한꺼번에 뽑아 오는' 연산으로 풀려 있어서,
추론하는 순간 822MB 짜리 중간값이 여러 개 생기고 GPU·시스템 메모리를 5GB 넘게 쓴다.
메모리가 모자랄 때는 그 부분만 떼어 CPU 에서 몇 줄씩 나눠 계산하고(결과는 같음), 나머지는 GPU 에서 돌린다.
느려지는 대신 메모리는 수백 MB 면 된다.

변환은 모델마다 처음 한 번만 하고 models/<모델이름>.lowmem/ 에 저장해 둔다.
"""

from __future__ import annotations

import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

VERSION = 1


# ----------------------------------------------------------------------------
# 변형 합성곱 계산 (torchvision.ops.deform_conv2d 와 같은 규칙)
# ----------------------------------------------------------------------------

def deform_conv(x: np.ndarray, offset: np.ndarray, mask: np.ndarray, weight: np.ndarray, bias: np.ndarray,
                pad: int, rows: int = 16, pool: ThreadPoolExecutor | None = None) -> np.ndarray:
    """x [1,C,H,W], offset [1,2K,Ho,Wo] (점마다 dy,dx), mask [1,K,Ho,Wo], weight [Co,C,kh,kw] → [1,Co,Ho,Wo].

    출력을 rows 줄씩 나눠 계산해서 중간값이 작다 (C × rows × Wo 정도).
    """
    _, C, H, W = x.shape
    Co, _, kh, kw = weight.shape
    K = kh * kw
    Ho, Wo = offset.shape[2:]
    xf = np.ascontiguousarray(x[0].reshape(C, H * W), dtype=np.float32)
    wk = np.ascontiguousarray(weight.reshape(Co, C, K).transpose(2, 0, 1), dtype=np.float32)  # [K,Co,C]
    off = offset[0].astype(np.float32, copy=False)
    msk = mask[0].astype(np.float32, copy=False)
    out = np.empty((Co, Ho, Wo), np.float32)
    gx = np.arange(Wo, dtype=np.float32)[None, :] - pad

    def chunk(r0: int) -> None:
        r1 = min(Ho, r0 + rows)
        R = r1 - r0
        gy = np.arange(r0, r1, dtype=np.float32)[:, None] - pad
        acc = np.zeros((Co, R * Wo), np.float32)
        for k in range(K):
            ky, kx = divmod(k, kw)
            py = gy + ky + off[2 * k, r0:r1]
            px = gx + kx + off[2 * k + 1, r0:r1]
            y0 = np.floor(py)
            x0 = np.floor(px)
            ly = (py - y0).ravel()
            lx = (px - x0).ravel()
            y0 = y0.astype(np.int64).ravel()
            x0 = x0.astype(np.int64).ravel()
            m = msk[k, r0:r1].ravel()
            val = np.zeros((C, R * Wo), np.float32)
            for dy, dx, wgt in ((0, 0, (1 - ly) * (1 - lx)), (0, 1, (1 - ly) * lx),
                                (1, 0, ly * (1 - lx)), (1, 1, ly * lx)):
                yy = y0 + dy
                xx = x0 + dx
                ok = (yy >= 0) & (yy < H) & (xx >= 0) & (xx < W)
                idx = np.clip(yy, 0, H - 1) * W + np.clip(xx, 0, W - 1)
                val += xf[:, idx] * (wgt * ok * m).astype(np.float32)
            acc += wk[k] @ val
        out[:, r0:r1] = acc.reshape(Co, R, Wo)

    starts = range(0, Ho, rows)
    if pool is None:
        for r0 in starts:
            chunk(r0)
    else:
        list(pool.map(chunk, starts))
    out += bias.reshape(Co, 1, 1).astype(np.float32)
    return out[None]


# ----------------------------------------------------------------------------
# 모델 변환: 변형 합성곱의 '뽑아 오기' 부분을 떼어 내고, 나머지를 GPU 단계들로 나눈다
# ----------------------------------------------------------------------------

def _find_modules(m) -> list[dict]:
    """그래프에서 변형 합성곱 모듈들을 찾는다 (offset_conv / modulator_conv / regular_conv 구조)."""
    from onnx import numpy_helper

    nodes = list(m.graph.node)
    inits = {i.name: i for i in m.graph.initializer}
    consts = {n.output[0]: n for n in nodes if n.op_type == "Constant"}
    consumers: dict[str, list] = {}
    for n in nodes:
        for i in n.input:
            consumers.setdefault(i, []).append(n)
    prefixes = sorted({n.name.split("atrous_conv/")[0] + "atrous_conv/" for n in nodes
                       if "atrous_conv/" in n.name and n.op_type == "GatherND"})
    mods = []
    for p in prefixes:
        mine = [n for n in nodes if n.name.startswith(p)]
        by = {n.name[len(p):]: n for n in mine}
        off_conv = by["offset_conv/Conv"]
        mod_conv = by["modulator_conv/Conv"]
        sig = next(n for n in mine if n.op_type == "Sigmoid")
        mul = next(n for n in mine if n.op_type == "Mul" and sig.output[0] in n.input)
        final = by["Conv"]
        produced = {o for n in mine for o in n.output}
        outs = [o for o in produced if any(not c.name.startswith(p) for c in consumers.get(o, []))]
        assert len(outs) == 1, (p, outs)
        out = outs[0]
        add = next(n for n in mine if out in n.output)
        bias = np.zeros(inits[final.input[1]].dims[0], np.float32)
        if add.op_type == "Add":
            other = [i for i in add.input if i != final.output[0]][0]
            if other in consts:
                bias = numpy_helper.to_array(consts[other].attribute[0].t).astype(np.float32).ravel()
            elif other in inits:
                bias = numpy_helper.to_array(inits[other]).astype(np.float32).ravel()
        w = numpy_helper.to_array(inits[final.input[1]]).astype(np.float32)
        keep = {off_conv.name, mod_conv.name, sig.name, mul.name}
        keep |= {consts[i].name for n in (off_conv, mod_conv, sig, mul) for i in n.input if i in consts}
        mods.append({
            "prefix": p, "x": off_conv.input[0], "offset": off_conv.output[0], "mask": mul.output[0],
            "out": out, "weight": w, "bias": bias, "pad": (w.shape[-1] - 1) // 2,
            "remove": {n.name for n in mine if n.name not in keep},
        })
    return mods


def build(src: str | Path, dst: str | Path) -> None:
    """원래 모델을 GPU 단계 + 변형 합성곱(CPU) 단계로 나눠 dst 폴더에 저장한다."""
    import onnx
    from onnx import helper, shape_inference

    src, dst = Path(src), Path(dst)
    m = onnx.load(str(src))
    # 자료형만 알면 되므로 가중치 없는 뼈대로 추론 (모델을 통째로 한 벌 더 만들면 메모리가 1GB 더 든다)
    try:
        skel = helper.make_graph(
            list(m.graph.node), "skeleton",
            list(m.graph.input) + [helper.make_tensor_value_info(i.name, i.data_type, list(i.dims))
                                   for i in m.graph.initializer],
            list(m.graph.output))
        types = {v.name: v.type.tensor_type.elem_type for v in shape_inference.infer_shapes(
            helper.make_model(skel, opset_imports=m.opset_import, ir_version=m.ir_version)).graph.value_info}
        del skel
    except Exception:
        types = {}
    mods = _find_modules(m)
    removed = set().union(*(md["remove"] for md in mods))
    nodes = [n for n in m.graph.node if n.name not in removed]
    inits = {i.name: i for i in m.graph.initializer}
    g_out = [o.name for o in m.graph.output]
    g_in = [i.name for i in m.graph.input if i.name not in inits][0]

    # 단계 나누기: 짝수 = GPU(ONNX), 홀수 = 변형 합성곱(CPU). 각 연산은 입력이 다 준비된 가장 이른 단계로
    items = [("node", n) for n in nodes] + [("deform", md) for md in mods]
    stage_of_tensor: dict[str, int] = {g_in: 0}
    pending = items
    assigned: list[tuple[int, str, object]] = []
    # ONNX 노드 순서는 위상 정렬돼 있지만 변형 합성곱(가짜 노드)이 끼어들므로 준비된 것부터 반복 배치
    while pending:
        rest = []
        progressed = False
        for kind, obj in pending:
            ins = [i for i in (obj.input if kind == "node" else (obj["x"], obj["offset"], obj["mask"]))
                   if i and i not in inits]
            if any(i not in stage_of_tensor for i in ins):
                rest.append((kind, obj))
                continue
            s = max([stage_of_tensor[i] for i in ins] or [0])
            if (s % 2 == 1) != (kind == "deform"):
                s += 1
            outs = list(obj.output) if kind == "node" else [obj["out"]]
            for o in outs:
                stage_of_tensor[o] = s
            assigned.append((s, kind, obj))
            progressed = True
        if not progressed:
            raise RuntimeError("모델 구조를 나눌 수 없습니다 (순환 또는 누락된 입력).")
        pending = rest

    nstage = max(s for s, _, _ in assigned) + 1
    used_later: dict[str, int] = {}
    for s, kind, obj in assigned:
        ins = obj.input if kind == "node" else (obj["x"], obj["offset"], obj["mask"])
        for i in ins:
            if i:
                used_later[i] = max(used_later.get(i, -1), s)

    dst.mkdir(parents=True, exist_ok=True)
    meta = {"version": VERSION, "input": g_in, "output": g_out[0], "stages": []}
    for s in range(nstage):
        here = [(k, o) for st, k, o in assigned if st == s]
        if s % 2 == 0:
            ns = [o for k, o in here]
            produced = {t for n in ns for t in n.output}
            ins, seen = [], set()
            for n in ns:
                for i in n.input:
                    if i and i not in produced and i not in inits and i not in seen:
                        seen.add(i)
                        ins.append(i)
            outs = sorted(t for t in produced if used_later.get(t, -1) > s or t in g_out)
            its = list({i: inits[i] for n in ns for i in n.input if i in inits}.values())
            vi = lambda t: helper.make_tensor_value_info(t, types.get(t) or onnx.TensorProto.FLOAT, None)
            graph = helper.make_graph(ns, f"stage{s}", [vi(i) for i in ins], [vi(o) for o in outs], its)
            sm = helper.make_model(graph, opset_imports=m.opset_import, ir_version=m.ir_version)
            # 가중치는 따로 파일로 (1GB 가까운 덩어리를 한 번에 직렬화하면 메모리가 모자랄 수 있다)
            onnx.save_model(sm, str(dst / f"stage{s}.onnx"), save_as_external_data=True,
                            all_tensors_to_one_file=True, location=f"stage{s}.data", size_threshold=1024)
            del sm, graph, its
            meta["stages"].append({"kind": "gpu", "file": f"stage{s}.onnx", "inputs": ins, "outputs": outs})
        else:
            ops = []
            for _, md in here:
                j = len(list(dst.glob("deform*_w.npy")))
                np.save(dst / f"deform{j}_w.npy", md["weight"])
                np.save(dst / f"deform{j}_b.npy", md["bias"])
                ops.append({"x": md["x"], "offset": md["offset"], "mask": md["mask"], "out": md["out"],
                            "pad": md["pad"], "w": f"deform{j}_w.npy", "b": f"deform{j}_b.npy"})
            meta["stages"].append({"kind": "deform", "ops": ops})
    (dst / "lowmem.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")


def is_built(dst: str | Path) -> bool:
    f = Path(dst) / "lowmem.json"
    try:
        return json.loads(f.read_text(encoding="utf-8")).get("version") == VERSION
    except Exception:
        return False


# ----------------------------------------------------------------------------
# 실행
# ----------------------------------------------------------------------------

class _Input:
    def __init__(self, name: str) -> None:
        self.name = name


class LowMemSession:
    """InferenceSession 처럼 쓸 수 있는 묶음 (run / get_inputs / get_providers)."""

    def __init__(self, folder: str | Path, providers: list, session_options) -> None:
        import onnxruntime as ort

        self.dir = Path(folder)
        self.meta = json.loads((self.dir / "lowmem.json").read_text(encoding="utf-8"))
        self.stages = []
        for st in self.meta["stages"]:
            if st["kind"] == "gpu":
                sess = ort.InferenceSession(str(self.dir / st["file"]), sess_options=session_options, providers=providers)
                self.stages.append(("gpu", st, sess))
            else:
                ops = [dict(op, W=np.load(self.dir / op["w"]), B=np.load(self.dir / op["b"])) for op in st["ops"]]
                self.stages.append(("deform", st, ops))
        self._providers = self.stages[0][2].get_providers()
        # 계산 스레드는 4개까지: 스레드마다 중간값(수~수십 MB)을 따로 쥐므로 코어 수만큼 띄우면 메모리가 커진다
        self._pool: ThreadPoolExecutor | None = ThreadPoolExecutor(max(1, min(4, os.cpu_count() or 4)))
        self._lock = threading.Lock()
        # 텐서를 마지막으로 쓰는 단계 (그 뒤에는 버려 메모리를 아낀다)
        self._last: dict[str, int] = {}
        for k, (kind, st, obj) in enumerate(self.stages):
            names = st["inputs"] if kind == "gpu" else [t for op in obj for t in (op["x"], op["offset"], op["mask"])]
            for t in names:
                self._last[t] = k

    def close(self) -> None:
        """계산 스레드를 끝내고 단계 세션을 놓는다 (모델을 내릴 때 — 세션이 GC 되기를 기다리지 않게)."""
        pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)
        self.stages = []

    def get_inputs(self):
        return [_Input(self.meta["input"])]

    def get_providers(self):
        return self._providers

    def run(self, output_names, feeds: dict, run_options=None):
        if not self.stages:
            raise RuntimeError("메모리 절약 모드 세션이 이미 닫혔습니다.")
        vals = dict(feeds)
        out_name = self.meta["output"]
        for k, (kind, st, obj) in enumerate(self.stages):
            if kind == "gpu":
                res = obj.run(st["outputs"], {i: vals[i] for i in st["inputs"]}, run_options)
                vals.update(zip(st["outputs"], res))
            else:
                for op in obj:
                    vals[op["out"]] = deform_conv(vals[op["x"]], vals[op["offset"]], vals[op["mask"]],
                                                  op["W"], op["B"], op["pad"], pool=self._pool)
            for t in [t for t in vals if self._last.get(t, -1) <= k and t != out_name]:
                vals.pop(t, None)
        return [vals[out_name]]
