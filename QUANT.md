# A-Quant — the quantization suite (built on Unsloth's work)

A's browser/CLI nodes live or die by fitting the best model into each device's
memory tier. A-Quant produces those builds, encoding **Unsloth Dynamic
quantization** as programmable, model-agnostic recipes — with full credit to the
Unsloth team, whose Dynamic 1.x/2.0 line of work this follows:

- **DeepSeek-R1 Dynamic 1.58-bit**: proved per-tensor selective quantization
  (important layers at 8/16-bit, bulk MoE weights crushed) beats uniform bits.
- **Dynamic 2.0**: every layer/tensor gets its own quantization type,
  model-specific, works on dense + MoE; headline metrics are 5-shot MMLU and
  **KL-divergence vs full precision**. Naming: `UD-Q4_K_XL` etc.
- **Calibration**: imatrix from a hand-curated 300K–1.5M-token chat/coding set —
  importance weighting that matches real use instead of generic text.
- Sources: unsloth.ai/docs/basics/unsloth-dynamic-2.0-ggufs · /blog/dynamic-v2

## How a recipe works
A recipe = a llama.cpp base quant + **dynamic `--tensor-type` overrides**
(`src/quant/recipes.mjs`, the same mechanism Unsloth's GGUF export uses):

| Tensor class | Treatment | Why |
|---|---|---|
| `token_embd` | **q8_0 (protect)** | vocab projection, degrades first |
| `output` (LM head) | base +2 | final logits |
| `attn_v` | base +2 | carries content |
| `attn_q/k`, `attn_output` | base +1 | moderate sensitivity |
| `ffn_down` | base +2 | the R1 lesson: down-proj is error-sensitive |
| `ffn_gate/up` | base | bulk of params, tolerant |
| MoE `ffn_down_exps` | base +1 | keep above other experts |
| MoE `ffn_gate/up_exps` | base −1 | compress hardest |
| MoE router `ffn_gate_inp` | q8_0 | tiny but critical |
| first 2 / last 2 blocks | base +2 | sensitive ends |

Fleet recipes (`a quant recipes`): `A-UD-Q8-ref` (T5/eval baseline) ·
`Q6_K_XL` (T5) · `Q5_K_XL` (T4) · `Q4_K_XL` (T3 flagship) · `Q3_K_XL` (T2) ·
`Q2_K_XL` + `IQ2_M` (T1). Sizes/bpw are estimated in the plan (e.g. a 7B at
Q4_K_XL ≈ 5.05 bpw ≈ 4.2 GB — in line with published UD-Q4_K_XL ≈ 4.88 bpw).

## Pipeline (`a quant plan|run`, or Swarm Console → Quant Studio)
1. **fetch** HF weights — or point at your Unsloth fine-tune output.
2. **convert** to a BF16 GGUF master (always quantize from full precision).
3. **imatrix** over calibration data. Bundled `examples/calibration/` is a
   smoke-test sample (code+chat+tool-calls); production wants 300K+ tokens of
   your real workload. *Your* calibration set is where your builds beat generic ones.
4. **quantize** per recipe (base + dynamic overrides + `--imatrix`).
5. **evaluate**: `llama-perplexity` vs the BF16 master (PPL stored on the
   variant); add `--kl-divergence-base` for Unsloth's KL metric, and MMLU for
   release candidates. Ship nothing that regresses vs the upstream UD build.
6. **register**: the variant enters the model catalog (`quant-registry.json` on
   the VPS) — the Swarm Console can then **assign it to a capacity tier**, and
   nodes pick it up live via policy push. Quantize → assign → fleet upgrades.

Jobs are commander-only (they execute shell tooling on the quant host),
persisted, streamed to the console, and audited in the event log. Without the
toolchain, jobs produce the complete **dry-run plan** plus install commands —
never fake artifacts.

## Toolchain install (once, on the quant host)
```bash
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
cmake -B build -DGGML_CUDA=ON        # or -DGGML_METAL=ON, or CPU-only
cmake --build build -j --target llama-quantize llama-imatrix llama-perplexity
export PATH="$PWD/build/bin:$PATH" A_LLAMA_CPP="$PWD"
pip install -U "huggingface_hub[cli]" unsloth   # hf CLI (+ fine-tune path)
```

## Fine-tune → quantize (the full Unsloth loop)
Train/QLoRA/QAT with Unsloth itself, export (or just save the merged HF dir),
then point A-Quant at that directory as `model` — the same recipes produce your
fleet builds. A-Quant deliberately doesn't reimplement training; Unsloth is best at it.

## Browser-node builds (`--target onnx-web`) — the node fleet's own pipeline
GGUF can't run in a tab, so A-Quant also emits **ONNX** repos in the exact
layout Transformers.js loads (`onnx/model_q4f16.onnx` etc.): optimum export →
layout → MatMulNBits quantization via `src/quant/quantize_onnx.py`, with the
Dynamic protection rules translated (embedding/LM-head excluded from 4-bit,
block-32, accuracy-level 4 for the WebGPU fp16 path). Finished variants are
served by the VPS at `/models/<repo>/…` and cached on-device. Concepts +
the full format/engine map: [WEBGPU-ONNX.md](WEBGPU-ONNX.md).

## Honest scope notes
- GGUF serves **CLI/VPS native nodes** (llama.cpp, Ollama); ONNX (`A-WEB-*`)
  serves **browser nodes**. WebLLM/MLC compilation remains a roadmap item —
  the ONNX path covers the runtime our nodes actually embed today.
- Unsloth's published UD builds remain the quality bar — A-Quant's edge is
  *your* calibration data and *your* fleet tiers, not a claim to out-quantize its source.
- Recipes are heuristics from Unsloth's published principles, not copies of
  their proprietary per-model layer maps (Dynamic 2.0/3.0 selection is partly
  closed). Everything here is inspectable in `src/quant/recipes.mjs`.
