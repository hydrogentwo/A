// A-Quant suite: turns a HuggingFace model into tier-ready Dynamic GGUFs,
// following the Unsloth Dynamic 2.0 pipeline: BF16 convert → imatrix
// calibration → per-tensor dynamic quantize → perplexity/KL validation →
// register into the model catalog so the Swarm Console can assign each
// variant to a capacity tier. The heavy lifting is llama.cpp (as it is for
// Unsloth's own GGUF export); A-Quant is the orchestrator + recipe brain.
// Missing tools ⇒ precise install instructions, never fake results.
import { spawn, execFileSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { recipeById, tensorTypeArgs, tensorRules, estimateSizeMB, estimateVramMB, estimateBpw, paramsFromModelId, archHints, ggufFileName } from "./recipes.mjs";

export function detectTools(env = process.env) {
  const has = b => { try { return !!execFileSync("bash", ["-lc", `command -v ${b}`], { encoding: "utf8" }).trim(); } catch { return false; } };
  const llamaDir = env.A_LLAMA_CPP || "llama.cpp";
  return { hf: has("hf") || has("huggingface-cli"), python: has("python3"),
    quantize: has("llama-quantize"), imatrix: has("llama-imatrix"), perplexity: has("llama-perplexity"),
    llamaDir, convertScript: `${llamaDir}/convert_hf_to_gguf.py` };
}
export const INSTALL_HINT = `llama.cpp toolchain not found. Install once on the quant host:
  git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
  cmake -B build -DGGML_CUDA=ON   # or -DGGML_METAL=ON / plain CPU
  cmake --build build -j --target llama-quantize llama-imatrix llama-perplexity
  export PATH="$PWD/build/bin:$PATH" A_LLAMA_CPP="$PWD"
  pip install -U "huggingface_hub[cli]"   # provides: hf download
Optional (fine-tune-then-quant path): pip install unsloth`;

// Pure plan builder (unit-tested). Returns ordered stages with argv commands.
export function planQuant({ model, recipeIds = ["A-UD-Q4_K_XL"], paramsB, layers = 0, imatrix = true,
                            calibration = "examples/calibration/code-chat.txt", evalPPL = true,
                            evalText = "examples/calibration/eval.txt", outDir = "quant-out", tools = detectTools() } = {}) {
  if (!model) throw new Error("model required (HF repo id, e.g. Qwen/Qwen2.5-Coder-7B-Instruct)");
  const recipes = recipeIds.map(id => recipeById(id) || (() => { throw new Error(`unknown recipe ${id}`); })());
  const P = paramsB ?? paramsFromModelId(model);
  const arch = archHints(model);
  const safe = String(model).replace(/[^\w.\-]/g, "_");
  const work = resolvePath(join(outDir, safe));           // absolute: stage cwd is the work dir
  calibration = resolvePath(calibration); evalText = resolvePath(evalText);
  const bf16 = join(work, "model-BF16.gguf"), imx = join(work, "model.imatrix.gguf"), src = join(work, "hf");
  const useImx = imatrix && recipes.some(r => r.imatrix);
  const stages = [
    { name: "fetch", argv: ["hf", "download", model, "--local-dir", src], why: "Download HF weights (or point at an Unsloth fine-tune output dir)" },
    { name: "convert", argv: ["python3", tools.convertScript, src, "--outfile", bf16, "--outtype", "bf16"], why: "Convert to BF16 GGUF master (quantize from full precision, never re-quantize)" },
  ];
  if (useImx) stages.push({ name: "imatrix", argv: ["llama-imatrix", "-m", bf16, "-f", calibration, "--chunk", "512", "-o", imx, "-ngl", "99"],
    why: "Importance matrix from calibration data — use 300K+ tokens of real chat/code for production (Unsloth scale); the bundled sample is smoke-test size" });
  const variants = [];
  for (const r of recipes) {
    const out = join(work, ggufFileName(model, r));
    const argv = ["llama-quantize", ...(useImx && r.imatrix ? ["--imatrix", imx] : []),
      ...tensorTypeArgs(r, { moe: arch.moe, layers }), bf16, out, r.base];
    stages.push({ name: `quantize:${r.id}`, argv, why: `${r.label} — ${tensorRules(r, { moe: arch.moe, layers }).length} dynamic tensor rules` });
    if (evalPPL) stages.push({ name: `eval:${r.id}`, argv: ["llama-perplexity", "-m", out, "-f", evalText, "--chunk", "512"],
      why: "Perplexity vs BF16 reference (add llama-perplexity --kl-divergence-base for KL, Unsloth's headline metric)" });
    variants.push({ recipe: r.id, file: out, tier: r.tier, engine: "gguf",
      estSizeMB: estimateSizeMB(P, r, { moe: arch.moe }), estVramMB: estimateVramMB(P, r), bpw: estimateBpw(r, { moe: arch.moe }) });
  }
  return { model, paramsB: P, arch, workDir: work, stages, variants,
    notes: [arch.moe ? "MoE detected — expert tensors compressed hardest, down-proj + router protected" : "Dense model",
      P ? `≈${P}B params` : "params unknown — pass --params for size estimates",
      "GGUF targets CLI/VPS native nodes (llama.cpp/Ollama). Browser nodes still need ONNX/WebLLM builds — see QUANT.md roadmap."] };
}

// Persistent job manager. store = VPS Store (or a local adapter with same API).
export class QuantJobs {
  constructor(store, { onChange = () => {} } = {}) { this.store = store; this.onChange = onChange; this.jobs = new Map(); this.running = false; }
  async init() { const saved = await this.store.readJSON("quant-jobs.json", []);
    for (const j of saved) { if (j.status === "running") j.status = "interrupted"; this.jobs.set(j.id, j); } return this; }
  async save() { await this.store.writeJSON("quant-jobs.json", [...this.jobs.values()].slice(-50)); }
  list() { return [...this.jobs.values()].reverse().map(j => ({ ...j, logTail: (j.log || []).slice(-30) })); }
  async registry() { return this.store.readJSON("quant-registry.json", []); }
  async registerVariant(v) { const reg = await this.registry();
    const entry = { ...v, registeredAt: new Date().toISOString() };
    const i = reg.findIndex(x => x.id === v.id); if (i >= 0) reg[i] = entry; else reg.push(entry);
    await this.store.writeJSON("quant-registry.json", reg); return entry; }

  async create(opts, createdBy = "cli") {
    const plan = planQuant(opts);
    const job = { id: "q_" + Math.random().toString(36).slice(2, 9), createdAt: Date.now(), createdBy,
      model: plan.model, recipes: opts.recipeIds, dryRun: !!opts.dryRun, status: "queued", stage: null,
      plan, log: [], results: [] };
    this.jobs.set(job.id, job); await this.save();
    await this.store.event("quant:job:create", { jobId: job.id, model: plan.model, dryRun: job.dryRun, by: createdBy });
    this.onChange(); this._pump(); return job;
  }
  async _pump() {
    if (this.running) return;
    const job = [...this.jobs.values()].find(j => j.status === "queued"); if (!job) return;
    this.running = true;
    try { await this._run(job); } finally { this.running = false; this._pump(); }
  }
  _log(job, line) { job.log.push(line); if (job.log.length > 400) job.log = job.log.slice(-400); this.onChange(); }
  async _run(job) {
    job.status = "running"; await mkdir(job.plan.workDir, { recursive: true }).catch(() => {});
    if (job.dryRun) {
      for (const s of job.plan.stages) { job.stage = s.name; this._log(job, `[dry-run] would run: ${s.argv.join(" ")}`); }
      job.results = job.plan.variants.map(v => ({ ...v, status: "planned" }));
      job.status = "planned"; job.stage = null; await this.save(); this.onChange();
      await this.store.event("quant:job:planned", { jobId: job.id }); return;
    }
    const tools = detectTools();
    const missing = [["hf", tools.hf], ["python3", tools.python], ["llama-quantize", tools.quantize],
      ["llama-imatrix", tools.imatrix], ["llama-perplexity", tools.perplexity]].filter(([, ok]) => !ok).map(([n]) => n);
    if (missing.length) { job.status = "failed"; job.error = `missing tools: ${missing.join(", ")}`; this._log(job, INSTALL_HINT);
      await this.save(); await this.store.event("quant:job:failed", { jobId: job.id, error: job.error }); this.onChange(); return; }
    try {
      for (const s of job.plan.stages) {
        job.stage = s.name; this._log(job, `$ ${s.argv.join(" ")}`); this.onChange();
        const out = await this._exec(job, s.argv);
        if (s.name.startsWith("eval:")) { const m = out.match(/PPL\s*=\s*([\d.]+)/); const v = job.results.find(r => s.name === `eval:${r.recipe}`); if (v && m) v.ppl = parseFloat(m[1]); }
        if (s.name.startsWith("quantize:")) {
          const recipe = s.name.slice(9); const v = job.plan.variants.find(x => x.recipe === recipe);
          const sizeMB = await stat(v.file).then(x => Math.round(x.size / 1048576)).catch(() => v.estSizeMB);
          const entry = { id: `local/${ggufFileName(job.model, { id: recipe }).replace(/\.gguf$/, "")}`,
            label: `${job.model.split("/").pop()} ${recipe}`, params: job.plan.paramsB ? `${job.plan.paramsB}B` : "?",
            downloadMB: sizeMB, vramMB: v.estVramMB || sizeMB, tier: v.tier, engine: "gguf",
            roles: recipeById(recipe)?.roles || ["build"], coding: 7, path: v.file, bpw: v.bpw, baseModel: job.model };
          await this.registerVariant(entry);
          job.results.push({ ...v, status: "done", sizeMB, registryId: entry.id });
        }
        await this.save();
      }
      job.status = "done"; job.stage = null; job.finishedAt = Date.now();
      await this.store.event("quant:job:done", { jobId: job.id, variants: job.results.length });
    } catch (e) { job.status = "failed"; job.error = e.message; this._log(job, `✗ ${e.message}`);
      await this.store.event("quant:job:failed", { jobId: job.id, error: e.message }); }
    await this.save(); this.onChange();
  }
  _exec(job, argv) {
    return new Promise((resolve, reject) => {
      const p = spawn(argv[0], argv.slice(1), { cwd: job.plan.workDir });
      let out = ""; const on = d => { const s = String(d); out += s; for (const line of s.split("\n")) if (line.trim()) this._log(job, line.slice(0, 300)); };
      p.stdout.on("data", on); p.stderr.on("data", on);
      p.on("error", reject);
      p.on("close", code => code === 0 ? resolve(out) : reject(new Error(`${argv[0]} exited ${code}`)));
    });
  }
}
