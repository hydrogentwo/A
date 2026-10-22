#!/usr/bin/env node
// A — one harness: Pi's minimal core · Octomind's efficiency · jcode's swarm/memory
// · OpenCode's provider freedom · DeepSeek's everything-is-a-plugin + event log.
// Compatible with the skills / MCP / plugins / agents / context of all of them
// (and Claude Code / Codex / Gemini CLI / Cursor). Run `a help`.
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Kernel } from "../src/core/kernel.mjs";
import { coreTools, loadGuardrails } from "../src/core/tools.mjs";
import { Session, runAgent } from "../src/core/agent.mjs";
import { Memory } from "../src/core/memory.mjs";
import { providerFromEnv } from "../src/core/providers.mjs";
import { scanAll, contextAppendix, discoverSkills } from "../src/compat/discover.mjs";
import { discoverMCP, MCPClient, loadMCPIntoKernel } from "../src/compat/mcp.mjs";
import { loadPluginsIntoKernel } from "../src/compat/plugins.mjs";
import { scoreCapacity } from "../src/cluster/capacity.mjs";
import { CATALOG, DEFAULT_POLICY, TIER_INFO } from "../src/cluster/catalog.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? (rest[i + 1]?.startsWith("--") ? true : rest[i + 1]) : d; };
const has = n => rest.includes(`--${n}`);
const VALUE_FLAGS = new Set(["cwd", "mode", "role", "port", "host", "url", "token", "n", "provider", "recipes", "params", "layers", "user", "target", "runtime", "pi-bin"]);
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) { if (VALUE_FLAGS.has(rest[i].slice(2))) i++; continue; }
  positional.push(rest[i]);
}
// dir arg position differs per command: `compat scan [dir]`, `mcp list [dir]`, `skills [dir]`, `a run --cwd`
const cwdOf = () => resolve(flag("cwd",
  cmd === "compat" ? (positional[1] || process.cwd())
  : cmd === "mcp" ? ((positional[0] === "list" || !positional[0]) ? (positional[1] || process.cwd()) : process.cwd())
  : cmd === "run" ? process.cwd()
  : (positional[0] || process.cwd())));

async function approverFactory() {
  if (has("yes") || flag("mode") === "allow") return async () => true;
  if (!process.stdin.isTTY) return async () => false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return ({ action, detail }) => new Promise(r => rl.question(`allow ${action} ${detail}? [y/N] `, a => r(/^y/i.test(a))));
}
async function buildKernel(cwd, { withMCP = has("mcp") } = {}) {
  const kernel = new Kernel();
  const guard = await loadGuardrails(cwd, { approver: await approverFactory(), mode: has("yes") ? "allow" : flag("mode", "ask") });
  for (const t of coreTools({ cwd, guardrails: guard, sandbox: !!process.env.A_SANDBOX })) kernel.registerTool(t);
  const scan = await scanAll(cwd);
  kernel.skills = scan.skills;
  // Skill invocation tool = progressive disclosure (body loads only when invoked)
  kernel.registerTool({ name: "skill", description: "Load a skill's full instructions by name (see skill index in system prompt).",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    execute: async ({ name }) => scan.skills.find(s => s.name === name)?.body || `unknown skill ${name}` }, "a:skills");
  const loaded = await loadPluginsIntoKernel(kernel, cwd, { onEvent: (e, c) => e === "plugin:error" && console.error(`  plugin ${c.plugin}: ${c.error}`) });
  let mcpClients = [];
  if (withMCP) mcpClients = await loadMCPIntoKernel(kernel, scan.mcp, { onEvent: (e, c) => e === "mcp:error" && console.error(`  mcp ${c.server}: ${c.error}`) });
  return { kernel, scan, loaded, mcpClients };
}

const HELP = `A — the one harness (Pi × Octomind × jcode × OpenCode × DeepSeek)

  a run "<task>" [--yes] [--json] [--mcp] [--role build|plan]   agent loop; --json = pi-style JSON event stream
  a compat scan [dir] [--json]         what A found from EVERY harness (skills/MCP/plugins/agents/context)
  a skills [dir]                       list discovered SKILL.md skills (all harnesses)
  a mcp list [dir] | tools <srv> | call <srv> <tool> '<json>'
  a serve [--port 8787]                VPS coordinator: cluster + storage + swarm console + web node UI
  a join [ws://vps:8787/ws] [--runtime a|pi-rs]   headless swarm node (pi-rs = delegate to the Rust pi binary)
  a runtimes                           detect external agent CLIs (pi/pi-rs, claude, codex, opencode…)
  a pi-rs [check] | run "<task>"       pi/pi-rs integration status, or run one task on pi
  a rpc [--yes]                        pi-style RPC mode: NDJSON tasks on stdin, events+results on stdout
  a simnode <phone|chromebook|laptop|desktop|ancient> [--url …]   simulated device (capacity probing demo)
  a capacity                           show device→tier→model table for sample devices
  a policy                             show model-per-capacity policy + catalog
  a swarm submit "<prompt>" --url http://vps:8787 [--mode broadcast --n 3]
  a init [dir]                         scaffold .a/ + AGENTS.md

  Models: A_PROVIDER=demo|openai|deepseek|anthropic|ollama|openrouter|lmstudio  A_MODEL=…  A_API_KEY=…`;

async function main() {
  if (!cmd || cmd === "help") return console.log(HELP);

  if (cmd === "run") {
    const task = positional.join(" "); if (!task) return console.error('usage: a run "<task>"');
    const cwd = cwdOf(); const { kernel, scan, mcpClients } = await buildKernel(cwd);
    const jsonMode = has("json"); const say = o => process.stdout.write(JSON.stringify(o) + "\n");
    if (jsonMode) say({ type: "start", summary: scan.summary, tools: [...kernel.tools.keys()] });
    else console.log(`⬢ A · ${scan.summary} · tools: ${[...kernel.tools.keys()].join(", ")}`);
    const p = providerFromEnv(); if (!jsonMode) console.log(`  provider: ${p.id}${p.model ? "/" + p.model : ""} · session log → .a/sessions/`);
    const r = await runAgent({ kernel, provider: p, session: new Session({ cwd }), task,
      systemExtra: contextAppendix(scan), memory: new Memory(cwd), role: flag("role", "build"),
      onEvent: jsonMode
        ? (ev, c) => { if (ev === "text") say({ type: "text", text: c.text }); if (ev === "tool") say({ type: "tool", name: c.name, args: c.args, result: c.result }); }
        : (ev, c) => { if (ev === "text") console.log("\n" + c.text); if (ev === "tool") console.log(`  ⚙ ${c.name} ${JSON.stringify(c.args).slice(0, 110)} → ${c.result}`); } });
    if (jsonMode) say({ type: "result", text: r.text, usage: r.usage, sessionId: r.sessionId });
    else console.log(`\n✓ done · tokens in/out: ${r.usage.inputTokens}/${r.usage.outputTokens} · session ${r.sessionId}`);
    mcpClients.forEach(c => c.stop()); process.exit(0);
  }
  if (cmd === "compat") {
    const cwd = cwdOf(); const scan = await scanAll(cwd);
    if (has("json")) return console.log(JSON.stringify({ ...scan, contextParts: undefined }, (k, v) => k === "body" || k === "prompt" ? (v ? v.slice(0, 80) + "…" : v) : v, 2));
    console.log(`⬢ A compat scan — ${cwd}\n  ${scan.summary}\n`);
    const show = (title, items, f) => { console.log(title); items.forEach(i => console.log("  · " + f(i))); if (!items.length) console.log("  · (none)"); console.log(); };
    show("SKILLS (SKILL.md, progressive disclosure)", scan.skills, s => `${s.name} — ${s.description}  [${s.source}]`);
    show("MCP SERVERS (normalized from every config format)", scan.mcp, m => `${m.name} (${m.transport}) ${m.command || m.url}  [${m.source}]`);
    show("PLUGINS / EXTENSIONS", scan.plugins, p => `${p.name} (${p.kind})`);
    show("AGENTS", scan.agents, a => `${a.name} [${a.source}]`);
    show("COMMANDS / PROMPT TEMPLATES", scan.commands, c => `/${c.name} [${c.source}]`);
    show("CONTEXT FILES", scan.context, c => `${c.file} (${c.chars} chars)`);
    if (scan.pi) console.log(`PI / PI-RS (shared ~/.pi/agent)\n  · ${Object.entries(scan.pi.files).map(([f, ok]) => f + (ok ? "✓" : "—")).join(" ")} · custom providers: ${scan.pi.customProviders.join(", ") || "(none)"} · project settings: ${scan.pi.projectSettings ? "✓" : "—"}\n`);
    if (has("load")) { const { kernel, loaded } = await buildKernel(cwd); console.log("Loaded into kernel:", loaded.join(", ") || "(core only)");
      console.log("Kernel now has tools:", [...kernel.tools.keys()].join(", ")); process.exit(0); }
    return;
  }
  if (cmd === "skills") { const s = await discoverSkills(cwdOf()); s.forEach(x => console.log(`· ${x.name} — ${x.description} [${x.source}]`)); return console.log(`${s.length} skills`); }
  if (cmd === "mcp") {
    const servers = await discoverMCP(cwdOf());
    if (!positional[0] || positional[0] === "list") { servers.forEach(s => console.log(`· ${s.name} (${s.transport}) [${s.source}]`)); return; }
    const srv = servers.find(s => s.name === positional[1]); if (!srv) return console.error("unknown server:", positional[1]);
    const c = await new MCPClient(srv).start();
    if (positional[0] === "tools") console.log(JSON.stringify(await c.tools(), null, 2));
    if (positional[0] === "call") console.log(await c.call(positional[2], JSON.parse(positional[3] || "{}")));
    c.stop(); process.exit(0);
  }
  if (cmd === "serve") { const { startServer } = await import("../src/vps/server.mjs");
    await startServer({ port: +(flag("port", process.env.PORT || 8787)), host: flag("host", "0.0.0.0") }); return; }
  if (cmd === "join" || cmd === "simnode") {
    const { joinCluster, SIM_PROFILES } = await import("../src/cluster/node.mjs");
    const url = flag("url", positional.find(a => a.includes("://")) || "ws://127.0.0.1:8787/ws");
    if (cmd === "simnode") { const name = positional.find(a => SIM_PROFILES[a]) || "laptop";
      joinCluster({ url, token: flag("token", process.env.A_CLUSTER_TOKEN || ""), profile: SIM_PROFILES[name], kind: "sim", name: `sim:${name}` }); }
    else joinCluster({ url, token: flag("token", process.env.A_CLUSTER_TOKEN || ""),
      runtime: flag("runtime", "a"), piBin: flag("pi-bin"),
      profile: { webgpu: false, webgl: false, deviceMemoryGB: +(process.env.A_NODE_RAM_GB || 8) } }); // CLI node: relay unless native provider set
    return new Promise(() => {});
  }
  if (cmd === "capacity") { const { SIM_PROFILES } = await import("../src/cluster/node.mjs");
    for (const [n, p] of Object.entries(SIM_PROFILES)) { const c = scoreCapacity(p);
      console.log(`${n.padEnd(11)} → ${c.tier} ${TIER_INFO[c.tier].name.padEnd(7)} model: ${DEFAULT_POLICY.tiers[c.tier]}  (${c.reasons.join("; ")})`); } return; }
  if (cmd === "policy") { console.log("Model-per-capacity (default policy — operators edit live in Swarm Console):\n");
    for (const t of Object.keys(TIER_INFO)) console.log(`  ${t} ${TIER_INFO[t].name.padEnd(7)} ${DEFAULT_POLICY.tiers[t]}  — ${TIER_INFO[t].desc}`);
    console.log("\nCatalog:"); CATALOG.forEach(m => console.log(`  ${m.tier} · ${m.label} · ${m.params} · ${m.downloadMB}MB dl / ${m.vramMB}MB VRAM · ${m.engine}`)); return; }
  if (cmd === "swarm" && positional[0] === "submit") {
    const base = flag("url", "http://127.0.0.1:8787");
    const r = await fetch(base + "/api/tasks", { method: "POST", headers: { "content-type": "application/json", ...(process.env.A_CLUSTER_TOKEN ? { "x-a-token": process.env.A_CLUSTER_TOKEN } : {}) },
      body: JSON.stringify({ prompt: positional.slice(1).join(" "), role: flag("role", "build"), mode: flag("mode", "single"), n: +(flag("n", 3)) }) });
    console.log(JSON.stringify(await r.json())); return; }
  if (cmd === "init") { const { mkdir, writeFile } = await import("node:fs/promises"); const { join } = await import("node:path");
    const dir = cwdOf(); await mkdir(join(dir, ".a/skills"), { recursive: true }); await mkdir(join(dir, ".a/plugins"), { recursive: true });
    await writeFile(join(dir, ".a/config.json"), JSON.stringify({ provider: "demo", mode: "ask" }, null, 2));
    await writeFile(join(dir, ".a/guardrails.json"), JSON.stringify({ rules: [{ action: "bash", match: "git push", decision: "ask", reason: "pushes need approval" }] }, null, 2));
    await writeFile(join(dir, "AGENTS.md"), "# Project instructions (AGENTS.md — read by A, Codex, OpenCode, Pi…)\n\nDescribe build/test commands and conventions here.\n");
    return console.log("✓ scaffolded .a/ + AGENTS.md in", dir); }
  if (cmd === "login") {
    const { mkdir, writeFile } = await import("node:fs/promises"); const { join } = await import("node:path"); const { homedir } = await import("node:os");
    const base = flag("url", "http://127.0.0.1:8787"), user = flag("user", positional[0]);
    if (!user) return console.error("usage: a login --url http://vps:8787 --user <name>  (password via A_PASSWORD)");
    const password = process.env.A_PASSWORD || await new Promise(r => createInterface({ input: process.stdin, output: process.stdout }).question("password: ", a => r(a)));
    const res = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user, password }) });
    const cookie = res.headers.get("set-cookie") || ""; const m = cookie.match(/a_session=([^;]+)/);
    if (!res.ok || !m) return console.error("login failed:", (await res.text()).slice(0, 200)), process.exit(1);
    const dir = join(homedir(), ".a"); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "credentials.json"), JSON.stringify({ url: base, user, token: decodeURIComponent(m[1]) }, null, 2), { mode: 0o600 });
    return console.log(`✓ logged in as ${user} → ${base} (token in ~/.a/credentials.json)`);
  }
  if (cmd === "quant") {
    const { RECIPES, WEB_RECIPES, estimateSizeMB, estimateWebSizeMB, estimateBpw } = await import("../src/quant/recipes.mjs");
    const { planQuant, QuantJobs, detectTools, INSTALL_HINT, ONNX_INSTALL_HINT } = await import("../src/quant/suite.mjs");
    const sub = positional[0];
    if (sub === "recipes" || !sub) { const P = +(flag("params", 7));
      console.log(`A-Quant Dynamic recipes (Unsloth Dynamic 2.0 style) — sizes for a ${P}B model:\n`);
      RECIPES.forEach(r => console.log(`  ${r.id.padEnd(16)} tier ${r.tier}  base ${r.base.padEnd(7)} ≈${estimateBpw(r)} bpw  ≈${(estimateSizeMB(P, r) / 1024).toFixed(2)} GB  ${r.label}`));
      console.log(`\nBrowser-node ONNX recipes (Transformers.js / WebGPU \u2014 what tabs actually run):\n`);
      WEB_RECIPES.forEach(r => console.log(`  ${r.id.padEnd(16)} tier ${r.tier}  dtype ${r.dtype.padEnd(6)} \u2248${r.bpw} bpw  \u2248${(estimateWebSizeMB(P, r) / 1024).toFixed(2)} GB  ${r.label}`));
      const t = detectTools(); console.log(`\ntoolchain: hf=${t.hf} llama-quantize=${t.quantize} llama-imatrix=${t.imatrix} llama-perplexity=${t.perplexity} optimum-cli=${t.optimum} onnxruntime-py=${t.ortPy} (A_LLAMA_CPP=${t.llamaDir})`);
      return; }
    const { readFile, writeFile, mkdir } = await import("node:fs/promises"); const { join } = await import("node:path");
    const dir = join(process.cwd(), ".a"); await mkdir(dir, { recursive: true });
    const lstore = { async readJSON(n, f) { try { return JSON.parse(await readFile(join(dir, n), "utf8")); } catch { return f; } },
      async writeJSON(n, v) { await writeFile(join(dir, n), JSON.stringify(v, null, 2)); }, async event() {} };
    if (sub === "list") { const reg = await lstore.readJSON("quant-registry.json", []);
      reg.forEach(r => console.log(`· ${r.id} · tier ${r.tier} · ${r.downloadMB}MB · ${r.path}`)); return console.log(`${reg.length} variants (VPS registry lives in A_DATA; GUI shows both once served from here)`); }
    const model = positional[1]; if (!model) return console.error("usage: a quant plan|run <hf-model> [--target onnx-web|gguf]");
    const opts = { model, target: flag("target", "gguf"), recipeIds: flag("recipes") ? String(flag("recipes")).split(",") : undefined, paramsB: flag("params") ? +flag("params") : undefined,
      layers: +(flag("layers", 0)), imatrix: !has("no-imatrix"), dryRun: has("dry-run") };
    if (sub === "plan") { const plan = planQuant(opts);
      if (has("json")) return console.log(JSON.stringify(plan, null, 2));
      console.log(`⬢ A-Quant plan — ${plan.model} (${plan.notes.join(" · ")})\n`);
      plan.stages.forEach((s, i) => console.log(`${i + 1}. [${s.name}] ${s.argv.join(" ")}\n   ${s.why}`));
      console.log("\nVariants:"); plan.variants.forEach(v => console.log(`  · ${v.file.split("/").pop()} → tier ${v.tier} · ≈${v.estSizeMB} MB · ≈${v.bpw} bpw`));
      const t = detectTools(); if (plan.target === "onnx-web" ? !t.optimum : !t.quantize) console.log("\n" + (plan.target === "onnx-web" ? ONNX_INSTALL_HINT : INSTALL_HINT));
      return; }
    if (sub === "run") { const jobs = await new QuantJobs(lstore).init();
      const job = await jobs.create(opts, "cli");
      while (!["planned", "done", "failed"].includes(job.status)) await new Promise(r => setTimeout(r, 500));
      console.log(job.log.join("\n")); console.log(`\njob ${job.id}: ${job.status}${job.error ? " — " + job.error : ""}`);
      job.results.forEach(r => console.log(`  · ${r.recipe}: ${r.status}${r.sizeMB ? ` (${r.sizeMB} MB${r.ppl ? `, PPL ${r.ppl}` : ""}) → ${r.registryId}` : ""}`));
      process.exit(job.status === "failed" ? 1 : 0); }
    return console.error("usage: a quant recipes|plan|run|list");
  }
  if (cmd === "runtimes" || cmd === "pi-rs") {
    const { detectPi, detectRuntimes, runPiTask, PI_INSTALL_HINT } = await import("../src/cluster/pi-runtime.mjs");
    if (cmd === "runtimes") { detectRuntimes().forEach(r => console.log(`${r.found ? "✓" : "·"} ${r.bin.padEnd(10)} ${r.label}${r.version ? " — " + r.version : ""}`)); return; }
    const pi = detectPi(flag("pi-bin"));
    if (positional[0] === "run") {
      if (!pi.found) { console.error(PI_INSTALL_HINT); process.exit(1); }
      const cwd = resolve(flag("cwd", process.cwd()));
      const r = await runPiTask({ bin: pi.bin, cwd, prompt: positional.slice(1).join(" "), onEvent: (k, t) => console.log(" ", t) });
      console.log("\n" + r.text); return;
    }
    console.log(pi.found ? `✓ pi found: ${pi.path} ${pi.version}\n  ${pi.flavor}\n  swarm node:  a join --runtime pi-rs\n  one-off:     a pi-rs run "<task>"` : PI_INSTALL_HINT);
    const scan = await scanAll(process.cwd()).catch(() => null);
    if (scan?.pi) console.log(`  ~/.pi/agent: ${Object.entries(scan.pi.files).map(([f, ok]) => f + (ok ? "✓" : "—")).join(" ")} · custom providers: ${scan.pi.customProviders.join(", ") || "(none)"} · default model: ${scan.pi.defaultModel || "(unset)"}`);
    return;
  }
  if (cmd === "rpc") {
    const { makeRpcHandler } = await import("../src/core/rpc.mjs");
    const handle = makeRpcHandler(async ({ task, cwd: tcwd, role, onEvent }) => {
      const cwd = tcwd ? resolve(tcwd) : process.cwd();
      const { kernel, scan, mcpClients } = await buildKernel(cwd);
      try { return await runAgent({ kernel, provider: providerFromEnv(), session: new Session({ cwd }), task,
        systemExtra: contextAppendix(scan), memory: new Memory(cwd), role,
        onEvent: (ev, c) => { if (ev === "text") onEvent("text", c.text); if (ev === "tool") onEvent("tool", `${c.name} ${JSON.stringify(c.args).slice(0, 120)} \u2192 ${c.result}`); } }); }
      finally { mcpClients.forEach(c => c.stop()); }
    });
    const reply = o => process.stdout.write(JSON.stringify(o) + "\n");
    for await (const line of createInterface({ input: process.stdin })) if (line.trim()) await handle(line, reply);
    return;
  }
  console.error("unknown command:", cmd, "\n\n" + HELP); process.exit(1);
}
main().catch(e => { console.error("A error:", e.message); process.exit(1); });
