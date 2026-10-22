// Auto-sensing the maximum model a device can run.
// scoreCapacity(profile) is PURE + isomorphic (unit-tested with device fixtures).
// probeBrowser() collects the profile in a real browser (WebGPU first, WebGL fallback).
// profile = { webgpu, maxBufferMB, maxStorageBindingMB, fp16, gpuName, vendor,
//             deviceMemoryGB, cores, storageFreeMB, benchGflops?, isMobile }

import { TIER_INFO } from "./catalog.mjs";

// Rough dedicated-VRAM / unified-memory budget inference. Browsers never expose
// true VRAM, so we infer from adapter limits + deviceMemory + GPU class.
export function estimateVramMB(p) {
  if (!p.webgpu && !p.webgl) return 0;
  const name = (p.gpuName || "").toLowerCase();
  // Known high-end dGPU families (browser still caps usable memory; be conservative)
  if (/rtx\s?(4090|4080|3090|5080|5090)|rx\s?79\d\d/.test(name)) return 12288;
  if (/rtx\s?(4070|3080|5070)|rx\s?78\d\d|arc\s?b580/.test(name)) return 8192;
  if (/rtx\s?(4060|3060|3070)|rx\s?7[67]\d\d/.test(name)) return 6144;
  if (/apple\s?m[34]\s?(pro|max|ultra)/.test(name)) return 8192;
  if (/apple\s?m[1-4]/.test(name)) return Math.max(4096, (p.deviceMemoryGB || 8) * 512); // unified: ~half RAM safe
  if (/iris|uhd|radeon\s?7[68]0m|snapdragon\s?x/.test(name)) return Math.max(2048, (p.deviceMemoryGB || 8) * 256);
  if (/adreno|mali|apple\s?a1[5-9]|powervr/.test(name) || p.isMobile) return 1024;
  // Generic: adapter limits are the best honest signal.
  const byLimit = Math.min(p.maxBufferMB || 0, p.maxStorageBindingMB || Infinity);
  if (byLimit >= 1024) return Math.min(8192, byLimit * 4);      // weights shard across buffers
  if (p.webgpu) return 2048;
  return 1024;
}

export function scoreCapacity(p) {
  const reasons = [];
  if (!p.webgpu && !p.webgl) { reasons.push("no WebGPU/WebGL — relay only"); return finish("T0", 0, 0, reasons, p); }
  if (!p.webgpu) reasons.push("WebGL only (no WebGPU) — WASM/small models");

  let vram = estimateVramMB(p);
  // Storage: weights must cache locally (Cache API / OPFS quota).
  if ((p.storageFreeMB ?? Infinity) < 600) { vram = Math.min(vram, 900); reasons.push("low free storage — capped to nano models"); }
  if ((p.deviceMemoryGB ?? 8) <= 2) { vram = Math.min(vram, 900); reasons.push("≤2 GB device RAM"); }
  if (!p.fp16 && p.webgpu) { vram = Math.round(vram * 0.7); reasons.push("no shader-f16 — de-rated 30%"); }
  if (typeof p.benchScore === "number") { // 0..1 matmul probe (browser-measured)
    if (p.benchScore < 0.25) { vram = Math.min(vram, 2048); reasons.push("slow GPU benchmark — capped at Small"); }
    else if (p.benchScore < 0.5) { vram = Math.min(vram, 4096); reasons.push("mid GPU benchmark — capped at Medium"); }
  }

  let tier = "T1";
  for (const t of ["T2", "T3", "T4", "T5"]) if (vram >= TIER_INFO[t].minVramMB) tier = t;
  if (!p.webgpu) tier = "T1"; // WASM path: only nano is honest
  reasons.push(`est. usable GPU memory ≈ ${vram} MB → ${tier} (${TIER_INFO[tier].name})`);
  const score = { T0: 0, T1: 15, T2: 35, T3: 55, T4: 78, T5: 100 }[tier];
  return finish(tier, score, vram, reasons, p);
}
function finish(tier, score, vramMB, reasons, profile) {
  return { tier, score, estVramMB: vramMB, reasons, profile, probedAt: new Date().toISOString() };
}

// ---- Browser probe (only call in a browser) ----
export async function probeBrowser() {
  const p = { webgpu: false, webgl: false, fp16: false, cores: navigator.hardwareConcurrency || 4,
              deviceMemoryGB: navigator.deviceMemory, isMobile: /android|iphone|ipad/i.test(navigator.userAgent),
              ua: navigator.userAgent };
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter) {
        p.webgpu = true;
        p.maxBufferMB = Math.round((adapter.limits.maxBufferSize || 0) / 1048576);
        p.maxStorageBindingMB = Math.round((adapter.limits.maxStorageBufferBindingSize || 0) / 1048576);
        p.fp16 = adapter.features?.has?.("shader-f16") ?? false;
        const info = adapter.info || (await adapter.requestAdapterInfo?.().catch(() => null)) || {};
        p.gpuName = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" ");
      }
    }
  } catch { /* fall through to WebGL */ }
  try {
    const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
    if (gl) { p.webgl = true;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext && !p.gpuName) p.gpuName = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "";
    }
  } catch {}
  try { const s = await navigator.storage?.estimate?.(); if (s) p.storageFreeMB = Math.round(((s.quota || 0) - (s.usage || 0)) / 1048576); } catch {}
  p.benchScore = await quickBench().catch(() => undefined);
  return { profile: p, capacity: scoreCapacity(p) };
}
// ~150ms CPU/GPU-proxy benchmark: typed-array matmul throughput, normalized 0..1.
async function quickBench() {
  const n = 256, a = new Float32Array(n * n).map(Math.random), b = new Float32Array(n * n).map(Math.random), c = new Float32Array(n * n);
  const t0 = performance.now(); let iters = 0;
  while (performance.now() - t0 < 150) { for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) { const aik = a[i * n + k]; for (let j = 0; j < n; j++) c[i * n + j] += aik * b[k * n + j]; } iters++; }
  const gflops = (iters * 2 * n ** 3) / ((performance.now() - t0) / 1000) / 1e9;
  return Math.max(0, Math.min(1, gflops / 12)); // 12 GFLOPS JS ≈ strong device
}

// Headless/CLI node profile: a CLI node can run native models (Ollama etc.) or relay.
export function cliProfile({ native = false, vramMB = 0, ramGB = 8 } = {}) {
  return scoreCapacity({ webgpu: native, webgl: false, fp16: true, gpuName: native ? "cli-native" : "", deviceMemoryGB: ramGB, maxBufferMB: vramMB / 4, storageFreeMB: 1e9, isMobile: false });
}
