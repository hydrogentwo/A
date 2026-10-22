import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreCapacity } from "../src/cluster/capacity.mjs";
import { SIM_PROFILES } from "../src/cluster/node.mjs";
import { resolveModelForNode, DEFAULT_POLICY } from "../src/cluster/catalog.mjs";
import { scanAll } from "../src/compat/discover.mjs";
import { MCPClient } from "../src/compat/mcp.mjs";
import { Kernel } from "../src/core/kernel.mjs";
import { coreTools, Guardrails } from "../src/core/tools.mjs";
import { Session, runAgent, compact } from "../src/core/agent.mjs";
import { demoProvider } from "../src/core/providers.mjs";
import { loadPluginsIntoKernel } from "../src/compat/plugins.mjs";
import { Scheduler } from "../src/cluster/scheduler.mjs";

test("capacity: devices land in expected tiers and get their specified models", () => {
  const t = p => scoreCapacity(SIM_PROFILES[p]).tier;
  assert.equal(t("ancient"), "T0"); assert.equal(t("phone"), "T1"); assert.equal(t("chromebook"), "T2");
  assert.ok(["T3", "T4"].includes(t("laptop"))); assert.ok(["T4", "T5"].includes(t("desktop")));
  const node = { id: "n1", tier: undefined, capacity: scoreCapacity(SIM_PROFILES.chromebook) };
  node.tier = node.capacity.tier;
  assert.equal(resolveModelForNode(node, DEFAULT_POLICY).id, "openbmb/MiniCPM5-2B"); // the HF-reference class
});

test("scheduler: best-fit keeps big nodes free, fastest picks them", () => {
  const nodes = [
    { id: "small", status: "idle", capacity: { tier: "T2", score: 35 }, model: "openbmb/MiniCPM5-2B", stats: {} },
    { id: "big", status: "idle", capacity: { tier: "T5", score: 100 }, model: "Qwen/Qwen3.5-9B", stats: {} }];
  const s = new Scheduler(DEFAULT_POLICY);
  s.strategy = "fastest"; assert.equal(s.pick(nodes, { role: "build" }).id, "big");
  s.strategy = "capability"; assert.equal(s.pick(nodes, { role: "build" }).id, "small");
  assert.equal(s.pick(nodes, { role: "build", minTier: "T4" }).id, "big");
});

test("compat: discovers every harness's assets in examples/demo", async () => {
  const scan = await scanAll(new URL("../examples/demo", import.meta.url).pathname);
  assert.deepEqual(scan.skills.map(s => s.name).sort(), ["greeting", "reverse"]);
  assert.deepEqual(scan.mcp.map(m => m.name).sort(), ["codex-echo", "echo", "remote-docs"]);
  assert.ok(scan.plugins.some(p => p.kind === "pi-extension") && scan.plugins.some(p => p.kind === "opencode-tool"));
  assert.equal(scan.agents[0].name, "reviewer"); assert.equal(scan.commands[0].name, "ship");
  assert.ok(scan.context[0].file === "AGENTS.md");
});

test("plugins: Pi TS extension + OpenCode tool run unmodified in the kernel", async () => {
  const k = new Kernel();
  const loaded = await loadPluginsIntoKernel(k, new URL("../examples/demo", import.meta.url).pathname);
  assert.ok(loaded.some(l => l.startsWith("pi:")) && loaded.some(l => l.startsWith("opencode:")));
  assert.equal(await k.tools.get("shout").execute({ text: "hi" }), "HI!");
  assert.equal(await k.tools.get("wordcount").execute({ text: "one two three" }), "3 words");
});

test("mcp: stdio client lists + calls tools", async () => {
  const dir = new URL("../examples", import.meta.url).pathname;
  const c = await new MCPClient({ name: "echo", transport: "stdio", command: "node", args: [join(dir, "mcp-echo-server.mjs")], env: {} }).start();
  assert.deepEqual((await c.tools()).map(t => t.name), ["echo", "add"]);
  assert.equal(await c.call("add", { a: 19, b: 23 }), "42");
  c.stop();
});

test("agent: demo provider drives write tool end-to-end; guardrails deny secrets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "a-test-"));
  const k = new Kernel();
  const g = new Guardrails({ mode: "allow" });
  assert.equal((await g.check("write", ".env")).decision, "deny");
  for (const t of coreTools({ cwd, guardrails: g })) k.registerTool(t);
  const r = await runAgent({ kernel: k, provider: demoProvider(), session: new Session({ cwd }), task: "create hi.txt saying hello A" });
  assert.equal(await readFile(join(cwd, "hi.txt"), "utf8"), "hello A");
  assert.ok(r.usage.inputTokens > 0);
});

test("compact: preserves system + tail, shrinks middle", () => {
  const msgs = [{ role: "system", content: "sys" }, ...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(4000) + i }))];
  const out = compact(msgs, { keepLast: 4, maxChars: 10_000 });
  assert.ok(out.length < msgs.length && out[0].content === "sys" && out.some(m => String(m.content).includes("compacted")));
});
