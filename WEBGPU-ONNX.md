# WebGPU, ONNX & friends — what actually runs on a browser node

Four different things get conflated. Separating them makes every design decision obvious:

```
  MODEL FILE (format)        ENGINE (runs the graph)      HARDWARE API
  ───────────────────        ───────────────────────      ─────────────
  ONNX (.onnx)        ──►    ONNX Runtime Web      ──►    WebGPU (GPU)  ← our browser nodes
        ▲                         ▲                        └─ WASM (CPU fallback)
        │                         │
   optimum export           Transformers.js (HF library on top:
   + A-Quant recipes         tokenizers, pipelines, caching)

  GGUF (.gguf)        ──►    llama.cpp / Ollama    ──►    CUDA/Metal/Vulkan/CPU ← CLI + VPS nodes
  MLC weights         ──►    WebLLM (TVM)          ──►    WebGPU (alternative browser engine)
```

- **WebGPU** is not a model format or an AI library. It's the browser's GPU API
  (the successor to WebGL): JavaScript can submit *compute shaders* to the GPU.
  It answers "how do I run math on the GPU from a tab?" — nothing about models.
- **ONNX** is a neutral file format for a computation graph (+ weights).
  Think "PDF for neural nets": PyTorch/HF models are *exported* to ONNX once
  (`optimum-cli export onnx`), then any ONNX engine can run them anywhere.
- **ONNX Runtime Web** is the engine that executes an ONNX graph inside the
  browser, dispatching ops to **WebGPU** when available (fast) or **WASM/CPU**
  when not (works everywhere, slow). **Transformers.js** is HuggingFace's
  friendly layer on top (what the MiniCPM5-2B-WebGPU-Pi space uses).
- **GGUF** is llama.cpp's own format. Browsers can't run it through ONNX
  Runtime; it would need llama.cpp itself compiled to WASM/WebGPU (possible,
  not the mainstream path). GGUF is perfect for our CLI/VPS nodes — wrong tool
  for tabs.
- **WebLLM/MLC** is a second browser engine: models are *compiled* by TVM into
  MLC weights (usually `q4f16_1`) + a WASM library. Fast, but converting your
  own model is a heavier toolchain than ONNX export.

## So "quantizing for node devices" means ONNX quantization
The weights inside the ONNX graph are quantized per-tensor — same idea as GGUF
quants, different container and op names:

| Browser dtype (Transformers.js) | File | What it is | Use |
|---|---|---|---|
| `q4f16` | `onnx/model_q4f16.onnx` | 4-bit block-32 weights (**MatMulNBits**), fp16 activations/scales | **flagship WebGPU build** |
| `q4` | `onnx/model_q4.onnx` | 4-bit incl. embedding (GatherBlockQuantized) | smallest; phones/T1 |
| `q8` | `onnx/model_quantized.onnx` | dynamic INT8 | WASM/CPU path, weak GPUs |
| `fp16` | `onnx/model_fp16.onnx` | half precision | big GPUs/T4+, quality reference |

A model repo Transformers.js can load looks like:
```
<model>/  config.json · tokenizer.json · tokenizer_config.json · generation_config.json
          onnx/model.onnx (fp32 master) · model_q4f16.onnx · model_q4.onnx …
```
The browser fetches only the dtype file it needs and caches it (Cache API) —
that's the "1.84 GB first download, saved in this browser" card in the reference UI.

## Unsloth-Dynamic ideas, translated to ONNX (what A-Quant does)
Unsloth's protective layer selection has direct ONNX analogues, encoded in our
`A-WEB-*` recipes: MatMulNBits leaves **Gather (embedding) untouched** and we
exclude the **lm_head** MatMul from 4-bit (the `protectEmbed` flag → fp16/fp32
head), block-size 32 with `accuracy_level=4` (fp16 accumulation — the WebGPU
fast path), and Transformers.js can even mix **per-module dtypes**
(embed fp16 + decoder q4) at load time. Smaller block size ≡ more scales ≡
GGUF's finer K-quant super-blocks.

## Which of our nodes runs what (the whole fleet at a glance)
| Node kind | Format | Engine | Fallback |
|---|---|---|---|
| Browser, WebGPU | ONNX `q4f16` (or `q4` on T1) | Transformers.js / ORT-WebGPU | → WASM |
| Browser, no WebGPU | ONNX `q8` (small models only) | ORT-WASM | → **VPS relay (T0)** |
| CLI (`a join`) / VPS | GGUF `A-UD-*` or any API model | llama.cpp / Ollama / providers | — |

A-Quant therefore produces **both** artifact families from one source model and
registers each variant against a capacity tier; the Swarm Console assigns
browser tiers ONNX variants and CLI nodes GGUF ones.
