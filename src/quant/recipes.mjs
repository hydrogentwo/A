// A-Quant recipes — building on Unsloth's Dynamic quantization work.
//
// What Unsloth Dynamic 2.0 taught the field (and what these recipes encode):
//  1. PER-TENSOR selection, not uniform bits: every layer/tensor gets its own
//     GGUF type, chosen by sensitivity — implemented through llama.cpp's
//     `--tensor-type <pattern>=<type>` overrides on top of a base quant.
//  2. PROTECT the sensitive tensors: token embedding + output head, attention
//     V, FFN down-projection (esp. MoE `ffn_down_exps` — the DeepSeek-R1
//     1.58-bit lesson), and the first/last blocks get upcast; the bulky,
//     tolerant FFN gate/up and MoE expert weights absorb the compression.
//  3. IMATRIX calibration on real chat/code data (Unsloth use a hand-curated
//     300K–1.5M-token set) so importance weighting matches actual use.
//  4. VALIDATE with KL-divergence / perplexity vs the BF16 reference, not vibes.
// `UD` = Unsloth Dynamic; our builds are named `A-UD-*` in their honor.
// Sources: unsloth.ai/docs/basics/unsloth-dynamic-2.0-ggufs, /blog/dynamic-v2.

// GGUF type ladder, low→high precision, with typical bits-per-weight.
export const TYPE_LADDER = ["iq1_m", "iq2_m", "q2_k", "iq3_m", "q3_k", "iq4_xs", "q4_k", "q5_k", "q6_k", "q8_0"];
export const TYPE_BPW = { iq1_m: 1.75, iq2_m: 2.7, q2_k: 3.06, iq3_m: 3.4, q3_k: 3.91, iq4_xs: 4.32,
                          q4_k: 4.85, q5_k: 5.62, q6_k: 6.59, q8_0: 8.5, bf16: 16, f16: 16 };
export const up = (t, n = 1) => TYPE_LADDER[Math.min(TYPE_LADDER.length - 1, TYPE_LADDER.indexOf(t) + n)];
export const down = (t, n = 1) => TYPE_LADDER[Math.max(0, TYPE_LADDER.indexOf(t) - n)];

// One flagship recipe per capacity tier (src/cluster/catalog.mjs tiers).
// base = llama.cpp quantize target type; the dynamic overrides do the magic.
export const RECIPES = [
  { id: "A-UD-Q8-ref",  label: "Q8 reference (≈lossless, eval baseline)", base: "q8_0", tier: "T5", dynamic: false, imatrix: false, roles: ["plan", "review"] },
  { id: "A-UD-Q6_K_XL", label: "Dynamic 6-bit XL",  base: "q6_k", tier: "T5", dynamic: true, imatrix: true, roles: ["plan", "build", "review"] },
  { id: "A-UD-Q5_K_XL", label: "Dynamic 5-bit XL",  base: "q5_k", tier: "T4", dynamic: true, imatrix: true, roles: ["build", "review", "plan"] },
  { id: "A-UD-Q4_K_XL", label: "Dynamic 4-bit XL (flagship — UD-Q4_K_XL class)", base: "q4_k", tier: "T3", dynamic: true, imatrix: true, roles: ["build", "plan", "review", "chat"] },
  { id: "A-UD-Q3_K_XL", label: "Dynamic 3-bit XL",  base: "q3_k", tier: "T2", dynamic: true, imatrix: true, roles: ["build", "chat", "explore"] },
  { id: "A-UD-Q2_K_XL", label: "Dynamic 2-bit XL",  base: "q2_k", tier: "T1", dynamic: true, imatrix: true, roles: ["chat", "explore"] },
  { id: "A-UD-IQ2_M",   label: "Dynamic IQ2_M (imatrix-critical, phones)", base: "iq2_m", tier: "T1", dynamic: true, imatrix: true, roles: ["chat", "explore"] },
];
export const recipeById = id => RECIPES.find(r => r.id === id) || null;
export const recipesForTier = t => RECIPES.filter(r => r.tier === t);

// Generate llama.cpp --tensor-type overrides for a recipe (the Dynamic 2.0 rules).
// Patterns are matched against GGUF tensor names (substring/regex by llama.cpp).
export function tensorRules(recipe, { moe = false, layers = 0 } = {}) {
  if (!recipe.dynamic) return [];
  const b = recipe.base, hi = up(b, 2), mid = up(b, 1), lo = down(b, 1);
  const rules = [
    { pattern: "token_embd", type: "q8_0", why: "vocab embedding — protect (Dynamic: important layers upcast)" },
    { pattern: "output", type: hi, why: "LM head — protect" },
    { pattern: "attn_v", type: hi, why: "attention V carries content — upcast" },
    { pattern: "attn_k", type: mid, why: "attention K — slight upcast" },
    { pattern: "attn_q", type: mid, why: "attention Q — slight upcast" },
    { pattern: "attn_output", type: mid, why: "attention out-proj — slight upcast" },
    { pattern: "ffn_down", type: hi, why: "FFN down-proj is error-sensitive — upcast (key R1 lesson)" },
    { pattern: "ffn_gate", type: b, why: "FFN gate — base" },
    { pattern: "ffn_up", type: b, why: "FFN up — base (bulk params absorb compression)" },
  ];
  if (moe) rules.push(
    { pattern: "ffn_down_exps", type: mid, why: "MoE expert down-proj — keep higher than other experts" },
    { pattern: "ffn_gate_exps", type: lo, why: "MoE expert gate — compress hardest" },
    { pattern: "ffn_up_exps", type: lo, why: "MoE expert up — compress hardest" },
    { pattern: "ffn_gate_inp", type: "q8_0", why: "MoE router — tiny but critical, keep precise" });
  if (layers >= 8) { // sensitive ends: first 2 + last 2 blocks
    for (const i of [0, 1, layers - 2, layers - 1])
      rules.push({ pattern: `blk\\.${i}\\.`, type: hi, why: `block ${i} (sensitive ${i < 2 ? "first" : "last"} block) — upcast` });
  }
  return rules;
}
export function tensorTypeArgs(recipe, opts = {}) {
  const rules = tensorRules(recipe, opts);
  return rules.length ? ["--tensor-type", rules.map(r => `${r.pattern}=${r.type}`).join(",")] : [];
}

// Effective bpw of a dynamic recipe ≈ base, nudged up by the protected tensors
// (matches published UD averages, e.g. UD-Q4_K_XL ≈ 4.88 bpw vs Q4_K base 4.85).
export function estimateBpw(recipe, { moe = false } = {}) {
  const base = TYPE_BPW[recipe.base] || 4.85;
  if (!recipe.dynamic) return base;
  return +(base + (moe ? 0.12 : 0.2)).toFixed(2); // upcasts protect ~5-10% of weights; MoE experts claw some back
}
export function estimateSizeMB(paramsB, recipe, opts = {}) {
  if (!paramsB) return null;
  return Math.round(paramsB * 1e9 * estimateBpw(recipe, opts) / 8 / 1048576 * 1.02); // +2% GGUF overhead
}
export function estimateVramMB(paramsB, recipe, { ctxK = 8 } = {}) {
  const w = estimateSizeMB(paramsB, recipe);
  return w ? Math.round(w * 1.05 + ctxK * 24) : null; // weights + rough KV/act headroom @ctxK
}

// Parse "Qwen2.5-Coder-7B-Instruct" → 7, "Qwen3.6-35B-A3B" → 35 (total), "SmolLM2-360M" → 0.36
export function paramsFromModelId(id) {
  const s = String(id || "");
  const b = s.match(/(\d+(?:\.\d+)?)\s*B(?![a-z])/i); if (b) return parseFloat(b[1]);
  const m = s.match(/(\d+(?:\.\d+)?)\s*M(?![a-z])/i); if (m) return parseFloat(m[1]) / 1000;
  return null;
}
export function archHints(id) {
  const s = String(id || "").toLowerCase();
  return { moe: /moe|mixtral|-a\d+(\.\d+)?b|deepseek-(v3|r1)|scout|maverick/.test(s),
           vision: /vl|vision|llava|pixtral|minicpm-v/.test(s) };
}
export function ggufFileName(modelId, recipe) {
  const base = String(modelId).split("/").pop().replace(/[^\w.\-]/g, "-");
  return `${base}-${recipe.id}.gguf`;
}
