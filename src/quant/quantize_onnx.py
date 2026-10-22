#!/usr/bin/env python3
"""A-Quant ONNX quantizer — produces Transformers.js / ONNX-Runtime-Web builds.

Translates Unsloth-Dynamic protective quantization to the ONNX world:
  * 4-bit: MatMulNBits (block-32). Embeddings are Gather ops and stay full
    precision naturally; --protect-embed additionally excludes lm_head MatMuls.
  * q4f16: quantize with accuracy_level=4 (fp16 accumulation, WebGPU path).
  * 8-bit: classic dynamic INT8 (WASM-friendly model_quantized.onnx).
  * fp16:  weight conversion via onnxconverter-common.
Requires: pip install onnx onnxruntime>=1.20 onnxconverter-common
Mirrors the community recipe used by onnx-community conversions.
"""
import argparse, inspect, sys
from pathlib import Path


def quantize_nbits(inp: Path, out: Path, bits: int, block: int, symmetric: bool,
                   accuracy: int, protect: bool) -> None:
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
    kwargs = dict(model=str(inp), bits=bits, block_size=block,
                  is_symmetric=symmetric, accuracy_level=accuracy)
    sig = inspect.signature(MatMulNBitsQuantizer.__init__).parameters
    if protect and "nodes_to_exclude" in sig:
        import onnx
        graph = onnx.load(str(inp), load_external_data=False).graph
        heads = [n.name for n in graph.node
                 if n.op_type == "MatMul" and ("lm_head" in n.name or n.name.endswith("/lm_head/MatMul"))]
        if heads:
            kwargs["nodes_to_exclude"] = heads
            print(f"protecting lm_head nodes from {bits}-bit: {heads}")
    q = MatMulNBitsQuantizer(**{k: v for k, v in kwargs.items() if k in sig or k == "model"})
    q.process()
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        q.model.save_model_to_file(str(out), use_external_data_format=True)
    except TypeError:
        q.model.save_model_to_file(str(out))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--bits", type=int, default=4)
    ap.add_argument("--block-size", type=int, default=32)
    ap.add_argument("--accuracy-level", type=int, default=0)
    ap.add_argument("--symmetric", action="store_true")
    ap.add_argument("--protect-embed", action="store_true")
    a = ap.parse_args()
    inp, out = Path(a.input), Path(a.output)
    if not inp.exists():
        print(f"input not found: {inp}", file=sys.stderr); return 2

    if a.bits == 4:
        quantize_nbits(inp, out, 4, a.block_size, a.symmetric, a.accuracy_level, a.protect_embed)
    elif a.bits == 8:
        from onnxruntime.quantization import quantize_dynamic, QuantType
        out.parent.mkdir(parents=True, exist_ok=True)
        quantize_dynamic(str(inp), str(out), weight_type=QuantType.QInt8,
                         use_external_data_format=True)
    elif a.bits == 16:
        import onnx
        from onnxconverter_common import float16
        model = onnx.load(str(inp))
        model16 = float16.convert_float_to_float16(model, keep_io_types=True)
        out.parent.mkdir(parents=True, exist_ok=True)
        onnx.save_model(model16, str(out), save_as_external_data=True,
                        all_tensors_to_one_file=True, location=out.name + "_data")
    else:
        print(f"unsupported bits: {a.bits}", file=sys.stderr); return 2

    size = out.stat().st_size
    data = Path(str(out) + "_data")
    if data.exists():
        size += data.stat().st_size
    print(f"wrote {out} ({size / 1048576:.1f} MB incl. external data)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
