// Headless cluster node: `a join ws://vps/ws` turns any machine (no browser
// needed) into a swarm worker. Also powers `a simnode` — simulated devices
// (phone/laptop/dGPU profiles) for testing the swarm without 5 computers.
import WebSocket from "ws";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { msg, parse } from "./protocol.mjs";
import { scoreCapacity } from "./capacity.mjs";
import { Kernel } from "../core/kernel.mjs";
import { coreTools, Guardrails } from "../core/tools.mjs";
import { Session, runAgent } from "../core/agent.mjs";
import { providerFromEnv } from "../core/providers.mjs";
import { scanAll, contextAppendix } from "../compat/discover.mjs";

export const SIM_PROFILES = {
  phone:   { webgpu: true, webgl: true, fp16: false, gpuName: "Adreno 740", deviceMemoryGB: 8, isMobile: true, storageFreeMB: 8000, benchScore: 0.15 },
  chromebook: { webgpu: true, webgl: true, fp16: true, gpuName: "Intel UHD", deviceMemoryGB: 4, storageFreeMB: 20000, benchScore: 0.3 },
  laptop:  { webgpu: true, webgl: true, fp16: true, gpuName: "Apple M3", deviceMemoryGB: 16, storageFreeMB: 80000, benchScore: 0.65 },
  desktop: { webgpu: true, webgl: true, fp16: true, gpuName: "NVIDIA GeForce RTX 4070", deviceMemoryGB: 32, storageFreeMB: 500000, benchScore: 1 },
  ancient: { webgpu: false, webgl: false, deviceMemoryGB: 2, storageFreeMB: 1000 },
};

export function joinCluster({ url, token = "", profile, name, kind = "cli", runtime = "a", piBin, workRoot = join(process.cwd(), ".a-cluster-work"), provider = providerFromEnv() }) {
  const capacity = scoreCapacity(profile);
  const id = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
  const ws = new WebSocket(`${url}${url.includes("?") ? "&" : "?"}role=node${token ? `&token=${token}` : ""}`);
  const state = { id, ws, busy: false };
  ws.on("open", () => {
    ws.send(msg("hello", { node: { id, kind, runtime, name: name || `${hostname()} (${kind}${runtime !== "a" ? "/" + runtime : ""})`, capacity, profile,
      model: null, stats: { tokS: Math.round(5 + (capacity.score || 0) / 2), tasksDone: 0 } } }));
    state.hb = setInterval(() => ws.readyState === 1 && ws.send(msg("heartbeat", { status: state.busy ? "busy" : "idle", stats: {} })), 10_000); state.hb.unref?.();
    console.log(`⬢ joined cluster as ${id} · tier ${capacity.tier} (${capacity.reasons.join("; ")})`);
  });
  ws.on("message", async raw => {
    const m = parse(raw); if (!m) return;
    if (m.type === "welcome") console.log(`  ← assigned model: ${m.model?.label || m.model?.id || m.model}`);
    if (m.type === "model:set" || m.type === "policy:update") console.log(`  ← model now: ${m.model?.label || m.model?.id || "(policy updated)"}`);
    if (m.type === "operator:message") console.log(`  ← operator: ${m.text}`);
    if (m.type !== "task:assign") return;
    const task = m.task; state.busy = true;
    const cwd = join(workRoot, task.id); await mkdir(cwd, { recursive: true });
    const progress = (ev, ctx) => { const text = ev === "text" ? ctx.text : ev === "tool" ? `⚙ ${ctx.name} ${JSON.stringify(ctx.args).slice(0, 120)} → ${ctx.result}` : null;
      if (text) ws.send(msg("task:progress", { taskId: task.id, text })); };
    try {
      if (runtime === "pi" || runtime === "pi-rs") {   // delegate to the pi binary (TS Pi or Rust pi-rs — same protocol)
        const { runPiTask } = await import("./pi-runtime.mjs");
        const r = await runPiTask({ bin: piBin, cwd, prompt: task.prompt,
          onEvent: (k, text) => ws.send(msg("task:progress", { taskId: task.id, text })) });
        ws.send(msg("task:done", { taskId: task.id, result: r.text || "(pi done)",
          artifact: `# ${task.prompt}\n\n${r.text}\n\n(via ${runtime} runtime)` }));
        state.busy = false; return;
      }
      const kernel = new Kernel();
      for (const t of coreTools({ cwd, guardrails: new Guardrails({ mode: "allow" }) })) kernel.registerTool(t);
      const scan = await scanAll(process.cwd(), { global: false }).catch(() => null);
      const r = await runAgent({ kernel, provider, session: new Session({ cwd }), task: task.prompt, role: task.role,
        systemExtra: scan ? contextAppendix(scan) : "", onEvent: progress });
      ws.send(msg("task:done", { taskId: task.id, result: r.text || "(done)", artifact: `# ${task.prompt}\n\n${r.text}\n\nusage: ${JSON.stringify(r.usage)}` }));
    } catch (e) { ws.send(msg("task:failed", { taskId: task.id, error: e.message })); }
    state.busy = false;
  });
  ws.on("error", e => console.error("cluster ws error:", e.message));
  return state;
}
