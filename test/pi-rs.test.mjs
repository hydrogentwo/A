import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPi, runPiTask, piEventText, detectRuntimes } from "../src/cluster/pi-runtime.mjs";
import { makeRpcHandler } from "../src/core/rpc.mjs";
import { discoverPi } from "../src/compat/discover.mjs";
import { startServer } from "../src/vps/server.mjs";
import { joinCluster, SIM_PROFILES } from "../src/cluster/node.mjs";

// A stand-in `pi` binary: speaks pi's print+JSON event protocol well enough
// to prove the delegation path (real TS Pi and Rust pi-rs share this protocol).
async function fakePi(dir) {
  const bin = join(dir, "pi");
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("fs");
if (process.argv.includes("--version")) { console.log("pi 9.9.9-rs (fake)"); process.exit(0); }
const prompt = process.argv[process.argv.length - 1];
fs.writeFileSync("pi-out.txt", "pi did: " + prompt + "\\n");
console.log(JSON.stringify({ type: "tool_execution_start", toolName: "write" }));
console.log(JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text: "pi finished the task" }] } }));
`);
  await chmod(bin, 0o755); return bin;
}

test("pi runtime: detect + run task via JSON-event protocol, in task cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a-pi-"));
  const bin = await fakePi(dir);
  const det = detectPi(bin);
  assert.ok(det.found && det.version.includes("9.9.9"));
  const events = [];
  const r = await runPiTask({ bin, cwd: dir, prompt: "build the thing", onEvent: (k, t) => events.push(t) });
  assert.equal(r.text, "pi finished the task");
  assert.equal(await readFile(join(dir, "pi-out.txt"), "utf8"), "pi did: build the thing\n");
  assert.ok(events.some(e => e.includes("pi tool")));
  await assert.rejects(() => runPiTask({ bin: join(dir, "no-such-pi"), prompt: "x" }), /pi binary not found/);
  assert.ok(detectRuntimes().some(x => x.bin === "pi"));
});

test("pi events: tolerant extraction across shapes", () => {
  assert.equal(piEventText({ type: "message_end", message: { content: [{ type: "text", text: "hi" }] } }), "hi");
  assert.equal(piEventText({ type: "tool_execution_start", toolName: "bash" }), "⚙ pi tool: bash");
  assert.equal(piEventText({ nonsense: 1 }), null);
});

test("rpc handler: ping, task events+result, bad input", async () => {
  const replies = [];
  const handle = makeRpcHandler(async ({ task, onEvent }) => { onEvent("text", "working"); return { text: `did ${task}`, usage: { inputTokens: 1 }, sessionId: "s1" }; });
  await handle('{"type":"ping","id":1}', o => replies.push(o));
  await handle('{"type":"task","id":2,"prompt":"x"}', o => replies.push(o));
  await handle("not json", o => replies.push(o));
  assert.deepEqual(replies.map(r => r.type), ["pong", "event", "result", "error"]);
  assert.equal(replies[2].text, "did x");
});

test("compat: discoverPi reports shared agent-dir structure without secrets", async () => {
  const pi = await discoverPi(process.cwd());
  assert.ok(pi.agentDir.endsWith(".pi/agent") && typeof pi.files === "object" && Array.isArray(pi.customProviders));
  assert.ok(!JSON.stringify(pi).includes("token"));
});

test("swarm e2e: task dispatched to a pi-rs runtime node completes via fake pi", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "a-pi-swarm-"));
  const work = await mkdtemp(join(tmpdir(), "a-pi-work-"));
  const bin = await fakePi(await mkdtemp(join(tmpdir(), "a-pi-bin-")));
  const srv = await startServer({ port: 0, host: "127.0.0.1", dataDir, token: "fleet-secret" });
  const port = srv.http.address().port, base = `http://127.0.0.1:${port}`;
  let node;
  try {
    node = joinCluster({ url: `ws://127.0.0.1:${port}/ws`, token: "fleet-secret", profile: SIM_PROFILES.laptop,
      kind: "cli", runtime: "pi-rs", piBin: bin, workRoot: work, name: "pi-rs-test" });
    for (let i = 0; i < 40 && !srv.nodes.size; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal([...srv.nodes.values()][0]?.runtime, "pi-rs");
    const sub = await fetch(base + "/api/tasks", { method: "POST",
      headers: { "content-type": "application/json", "x-a-token": "fleet-secret" },
      body: JSON.stringify({ prompt: "create something great" }) });
    assert.equal(sub.status, 200);
    const { taskIds } = await sub.json();
    let task;
    for (let i = 0; i < 60; i++) { task = srv.tasks.get(taskIds[0]); if (task?.status === "done" || task?.status === "failed") break; await new Promise(r => setTimeout(r, 150)); }
    assert.equal(task.status, "done", `task result: ${task.result}`);
    assert.ok(String(task.result).includes("pi finished"));
  } finally { try { node?.ws?.close(); } catch {} await srv.close(); }
});
