// Model catalog + capacity tiers. Isomorphic: runs in browser, CLI and VPS.
// Sizes are q4 WebGPU builds (download / approx VRAM), 2026 browser-realistic.
// "Specified model-per-capacity" = DEFAULT_POLICY below; admins override it
// live from the Swarm Console (stored on the VPS, pushed to every node).

export const TIERS = ["T0", "T1", "T2", "T3", "T4", "T5"];

export const TIER_INFO = {
  T0: { name: "Relay",  desc: "No usable local GPU — VPS/cloud model over relay",        minVramMB: 0 },
  T1: { name: "Nano",   desc: "Phones, weak iGPUs, <4 GB RAM devices",                   minVramMB: 512 },
  T2: { name: "Small",  desc: "Most laptops — the MiniCPM5-2B class (HF Pi reference)", minVramMB: 2048 },
  T3: { name: "Medium", desc: "Good iGPU / entry dGPU / Apple Silicon base",             minVramMB: 3584 },
  T4: { name: "Large",  desc: "Solid dGPU / Apple Silicon Pro-Max",                      minVramMB: 6144 },
  T5: { name: "XL",     desc: "High-end dGPU (browser ceiling) + optional cloud-assist planner", minVramMB: 10240 },
};

// Each model: id (HF / engine id), params, downloadMB, vramMB (q4 + KV headroom),
// engines: transformersjs | webllm, roles it suits, coding score 0..10 (rough).
export const CATALOG = [
  { id: "relay/default",               label: "VPS / Cloud relay (configured on VPS)", params: "—",   downloadMB: 0,    vramMB: 0,    tier: "T0", engine: "relay",          roles: ["plan","build","explore","review","chat"], coding: 9 },
  { id: "HuggingFaceTB/SmolLM2-360M-Instruct", label: "SmolLM2 360M",      params: "0.36B", downloadMB: 204,  vramMB: 376,  tier: "T1", engine: "transformersjs", roles: ["explore","chat"], coding: 3 },
  { id: "Qwen/Qwen3-0.6B",             label: "Qwen3 0.6B",                params: "0.6B",  downloadMB: 390,  vramMB: 700,  tier: "T1", engine: "webllm",         roles: ["explore","chat"], coding: 4 },
  { id: "openbmb/MiniCPM5-2B",         label: "MiniCPM5 2B (reference)",   params: "2B",    downloadMB: 1840, vramMB: 2300, tier: "T2", engine: "transformersjs", roles: ["build","chat","explore"], coding: 6 },
  { id: "Qwen/Qwen2.5-Coder-1.5B-Instruct", label: "Qwen2.5-Coder 1.5B",   params: "1.5B",  downloadMB: 986,  vramMB: 1600, tier: "T2", engine: "webllm",         roles: ["build","explore"], coding: 6 },
  { id: "meta-llama/Llama-3.2-1B-Instruct", label: "Llama 3.2 1B",         params: "1B",    downloadMB: 695,  vramMB: 879,  tier: "T2", engine: "webllm",         roles: ["chat","explore"], coding: 4 },
  { id: "Qwen/Qwen3-4B",               label: "Qwen3 4B",                  params: "4B",    downloadMB: 2263, vramMB: 3432, tier: "T3", engine: "webllm",         roles: ["plan","build","review"], coding: 7 },
  { id: "Qwen/Qwen2.5-Coder-3B-Instruct", label: "Qwen2.5-Coder 3B",       params: "3B",    downloadMB: 1600, vramMB: 2500, tier: "T3", engine: "webllm",         roles: ["build","review"], coding: 7 },
  { id: "meta-llama/Llama-3.1-8B-Instruct", label: "Llama 3.1 8B",         params: "8B",    downloadMB: 4517, vramMB: 5001, tier: "T4", engine: "webllm",         roles: ["plan","build","review","chat"], coding: 8 },
  { id: "Qwen/Qwen2.5-Coder-7B-Instruct", label: "Qwen2.5-Coder 7B",       params: "7B",    downloadMB: 4200, vramMB: 5200, tier: "T4", engine: "webllm",         roles: ["build","review","plan"], coding: 8 },
  { id: "Qwen/Qwen3.5-9B",             label: "Qwen3.5 9B (browser ceiling)", params: "9B", downloadMB: 5038, vramMB: 6433, tier: "T5", engine: "webllm",        roles: ["plan","build","review","chat"], coding: 9 },
];

// The specified model-per-capacity mapping (editable in Swarm Console).
export const DEFAULT_POLICY = {
  version: 1,
  tiers: {   // tier -> model id, auto-assigned when a node joins
    T0: "relay/default",
    T1: "Qwen/Qwen3-0.6B",
    T2: "openbmb/MiniCPM5-2B",
    T3: "Qwen/Qwen3-4B",
    T4: "Qwen/Qwen2.5-Coder-7B-Instruct",
    T5: "Qwen/Qwen3.5-9B",
  },
  roles: {   // optional per-role preference; scheduler prefers nodes whose model serves the role
    plan:    ["Qwen/Qwen3.5-9B", "Qwen/Qwen3-4B", "relay/default"],
    build:   ["Qwen/Qwen2.5-Coder-7B-Instruct", "openbmb/MiniCPM5-2B", "Qwen/Qwen2.5-Coder-1.5B-Instruct"],
    explore: ["Qwen/Qwen3-0.6B", "HuggingFaceTB/SmolLM2-360M-Instruct"],
    review:  ["Qwen/Qwen3.5-9B", "Qwen/Qwen2.5-Coder-7B-Instruct"],
    chat:    [],
  },
  overrides: {},        // nodeId -> model id (pins a specific device)
  allowCloudAssistOnT5: true,
  preferLocal: true,    // scheduler: prefer local nodes over relay when capable
};

export function modelById(id) { return CATALOG.find(m => m.id === id) || null; }
export function modelsForTier(tier) { return CATALOG.filter(m => m.tier === tier); }
export function resolveModelForNode(node, policy = DEFAULT_POLICY) {
  if (policy.overrides?.[node.id]) return modelById(policy.overrides[node.id]) || policy.overrides[node.id];
  const tier = node.capacity?.tier || node.tier || "T0";
  const id = policy.tiers?.[tier] || DEFAULT_POLICY.tiers[tier] || "relay/default";
  return modelById(id) || id;
}

// Which artifact format a node kind can actually execute (see WEBGPU-ONNX.md).
export function formatForNode({ kind = "browser", webgpu = true } = {}) {
  if (kind === "cli" || kind === "vps") return { format: "gguf", engine: "llama.cpp / Ollama / API providers", dtype: null };
  if (webgpu) return { format: "onnx", engine: "Transformers.js (ONNX Runtime WebGPU)", dtype: "q4f16" };
  return { format: "onnx", engine: "Transformers.js (ONNX Runtime WASM)", dtype: "q8", fallback: "vps-relay" };
}
