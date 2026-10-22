import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEB_RECIPES, webRecipeById, onnxFileName, estimateWebSizeMB } from "../src/quant/recipes.mjs";
import { planQuant, planOnnxQuant, QuantJobs } from "../src/quant/suite.mjs";
import { formatForNode } from "../src/cluster/catalog.mjs";
import { startServer } from "../src/vps/server.mjs";

const memStore = () => { const m = new Map(); return {
  async readJSON(n, f) { return m.has(n) ? structuredClone(m.get(n)) : structuredClone(f); },
  async writeJSON(n, v) { m.set(n, structuredClone(v)); }, async event() {} }; };

test("web recipes: flagship q4f16 protects embed/head; sizes browser-sane", () => {
  const r = webRecipeById("A-WEB-Q4F16-XL");
  assert.equal(r.dtype, "q4f16"); assert.equal(r.blockSize, 32); assert.ok(r.protectEmbed && r.accuracyLevel === 4);
  const mb = estimateWebSizeMB(2, r); assert.ok(mb > 900 && mb < 1500, `2B q4f16 ≈ ${mb}MB`);
  assert.ok(estimateWebSizeMB(2, webRecipeById("A-WEB-Q4")) < mb);
  assert.ok(estimateWebSizeMB(2, webRecipeById("A-WEB-FP16")) > mb * 2);
  assert.equal(onnxFileName(r), "model_q4f16.onnx");
  assert.equal(onnxFileName(webRecipeById("A-WEB-Q8")), "model_quantized.onnx"); // Transformers.js q8 convention
  assert.ok(WEB_RECIPES.every(x => x.engine === "onnx-web" && x.tier));
});

test("onnx plan: fetch→export→layout→quantize with MatMulNBits script + flags", () => {
  const plan = planOnnxQuant({ model: "openbmb/MiniCPM5-2B" });
  assert.deepEqual(plan.stages.map(s => s.name), ["fetch", "onnx-export", "onnx-layout", "onnx-quantize:A-WEB-Q4F16-XL"]);
  const q = plan.stages.at(-1).argv.join(" ");
  assert.ok(q.includes("quantize_onnx.py") && q.includes("model_q4f16.onnx") && q.includes("--protect-embed") && q.includes("--accuracy-level 4"));
  assert.equal(plan.variants[0].engine, "onnx-web"); assert.equal(plan.variants[0].dtype, "q4f16");
  assert.ok(plan.webRoot.endsWith("MiniCPM5-2B-ONNX"));
  const viaDispatch = planQuant({ model: "openbmb/MiniCPM5-2B", target: "onnx-web", tools: { convertScript: "x" } });
  assert.equal(viaDispatch.target, "onnx-web");
});

test("quant jobs: onnx-web dry-run plans without registering", async () => {
  const jobs = await new QuantJobs(memStore()).init();
  const job = await jobs.create({ model: "openbmb/MiniCPM5-2B", target: "onnx-web", dryRun: true }, "test");
  for (let i = 0; i < 50 && !["planned", "done", "failed"].includes(job.status); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(job.status, "planned"); assert.equal(job.target, "onnx-web");
  assert.ok(job.log.some(l => l.includes("optimum-cli")));
  assert.equal((await jobs.registry()).length, 0);
});

test("formatForNode: browsers get ONNX, CLI/VPS get GGUF", () => {
  assert.equal(formatForNode({ kind: "browser", webgpu: true }).dtype, "q4f16");
  assert.equal(formatForNode({ kind: "browser", webgpu: false }).fallback, "vps-relay");
  assert.equal(formatForNode({ kind: "cli" }).format, "gguf");
});

test("server: /models serves registered ONNX repos to browser nodes (no login needed), blocks traversal", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "a-models-"));
  const modelDir = join(dataDir, "q", "Test-ONNX");
  await mkdir(join(modelDir, "onnx"), { recursive: true });
  await writeFile(join(modelDir, "onnx", "model_q4f16.onnx"), "FAKE-ONNX-BYTES");
  await writeFile(join(modelDir, "config.json"), "{}");
  await writeFile(join(dataDir, "quant-registry.json"), JSON.stringify([
    { id: "local/Test-ONNX-q4f16", repo: "local/Test-ONNX", engine: "onnx-web", dtype: "q4f16", path: modelDir, tier: "T2" }]));
  const srv = await startServer({ port: 0, host: "127.0.0.1", dataDir, token: "" });
  const base = `http://127.0.0.1:${srv.http.address().port}`;
  try {
    const r = await fetch(base + "/models/local/Test-ONNX/onnx/model_q4f16.onnx");
    assert.equal(r.status, 200); assert.equal(await r.text(), "FAKE-ONNX-BYTES");
    assert.equal((await fetch(base + "/models/local/Test-ONNX/config.json")).status, 200);
    assert.equal((await fetch(base + "/models/local/Nope/onnx/model_q4f16.onnx")).status, 404);
    assert.equal((await fetch(base + "/models/local/Test-ONNX/onnx/missing.onnx")).status, 404);
  } finally { await srv.close(); }
});
