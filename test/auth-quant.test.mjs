import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, hashPassword, verifyPassword, roleRank } from "../src/vps/auth.mjs";
import { RECIPES, recipeById, tensorRules, tensorTypeArgs, estimateSizeMB, paramsFromModelId, archHints } from "../src/quant/recipes.mjs";
import { planQuant, QuantJobs } from "../src/quant/suite.mjs";
import { startServer } from "../src/vps/server.mjs";

const memStore = () => { const m = new Map(); return {
  async readJSON(n, f) { return m.has(n) ? structuredClone(m.get(n)) : structuredClone(f); },
  async writeJSON(n, v) { m.set(n, structuredClone(v)); }, async event() {} }; };

test("auth: scrypt hash/verify, roles ranked", () => {
  const pw = hashPassword("correct horse battery");
  assert.ok(verifyPassword("correct horse battery", pw));
  assert.ok(!verifyPassword("wrong horse", pw));
  assert.ok(roleRank("admin") > roleRank("operator") && roleRank("operator") > roleRank("viewer"));
});

test("auth: setup once (becomes admin), then setup closes; login + rate limit", async () => {
  const a = await new Auth(memStore(), { env: {} }).init();
  assert.ok(a.needsSetup());
  const s = await a.setup("commander", "password-1");
  assert.equal(s.user.role, "admin"); assert.ok(a.userFromToken(s.token));
  await assert.rejects(() => a.setup("second", "password-1"), /setup closed/);
  await assert.rejects(() => a.login("commander", "nope-nope"), /invalid/);
  const ok = await a.login("commander", "password-1"); assert.ok(ok.token);
  for (let i = 0; i < 5; i++) await assert.rejects(() => a.login("commander", "bad-pass-" + i)).catch(() => {});
  await assert.rejects(() => a.login("commander", "password-1"), /too many attempts/);
  await assert.rejects(() => a.createUser(s.user, "newuser", "short", "viewer"), /minimum 8/);
  const v = await a.createUser(s.user, "watcher", "password-2", "viewer"); assert.equal(v.role, "viewer");
});

test("quant recipes: Dynamic 2.0 rules protect sensitive tensors; sizes sane", () => {
  const r = recipeById("A-UD-Q4_K_XL");
  const rules = tensorRules(r, {});
  const get = p => rules.find(x => x.pattern === p)?.type;
  assert.equal(get("token_embd"), "q8_0");                       // embedding protected
  assert.ok(["q6_k", "q8_0"].includes(get("ffn_down")));       // down-proj upcast above base q4_k
  assert.equal(get("ffn_up"), "q4_k");                          // bulk stays at base
  const moe = tensorRules(r, { moe: true });
  assert.ok(moe.some(x => x.pattern === "ffn_down_exps") && moe.some(x => x.pattern === "ffn_gate_inp")); // MoE: down + router
  assert.ok(tensorTypeArgs(r, {})[1].includes("token_embd=q8_0"));
  const s2 = estimateSizeMB(7, recipeById("A-UD-Q2_K_XL")), s4 = estimateSizeMB(7, r), s8 = estimateSizeMB(7, recipeById("A-UD-Q8-ref"));
  assert.ok(s2 < s4 && s4 < s8 && s4 > 3000 && s4 < 5500);
  assert.equal(paramsFromModelId("Qwen/Qwen3.6-35B-A3B"), 35);
  assert.equal(paramsFromModelId("HuggingFaceTB/SmolLM2-360M"), 0.36);
  assert.ok(archHints("Qwen/Qwen3.6-35B-A3B").moe && !archHints("Qwen/Qwen2.5-Coder-7B").moe);
  assert.ok(RECIPES.every(x => x.tier && x.base));              // every recipe maps to a capacity tier
});

test("quant plan: fetch→convert→imatrix→quantize→eval, variants carry tiers", () => {
  const plan = planQuant({ model: "Qwen/Qwen2.5-Coder-7B-Instruct", recipeIds: ["A-UD-Q4_K_XL"], tools: { convertScript: "llama.cpp/convert_hf_to_gguf.py" } });
  const names = plan.stages.map(s => s.name);
  assert.deepEqual(names, ["fetch", "convert", "imatrix", "quantize:A-UD-Q4_K_XL", "eval:A-UD-Q4_K_XL"]);
  assert.equal(plan.paramsB, 7); assert.equal(plan.variants[0].tier, "T3");
  const noImx = planQuant({ model: "x/Y-1B", imatrix: false, tools: { convertScript: "c.py" } });
  assert.ok(!noImx.stages.some(s => s.name === "imatrix"));
});

test("quant jobs: dry-run completes as planned, registers nothing", async () => {
  const jobs = await new QuantJobs(memStore()).init();
  const job = await jobs.create({ model: "openbmb/MiniCPM5-2B", recipeIds: ["A-UD-Q3_K_XL"], dryRun: true }, "test");
  for (let i = 0; i < 50 && !["planned", "done", "failed"].includes(job.status); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(job.status, "planned");
  assert.ok(job.log.some(l => l.includes("llama-quantize")) && job.results[0].status === "planned");
  assert.equal((await jobs.registry()).length, 0);
});

test("server: Swarm APIs are login-gated; commander flow works; cluster token still commands", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "a-auth-"));
  const srv = await startServer({ port: 0, host: "127.0.0.1", dataDir, token: "fleet-secret" });
  const base = `http://127.0.0.1:${srv.http.address().port}`;
  const J = { "content-type": "application/json" };
  try {
    assert.equal((await fetch(base + "/api/state")).status, 401);                                   // anonymous: locked out
    assert.equal((await fetch(base + "/api/tasks", { method: "POST", headers: J, body: "{}" })).status, 401);
    const me = await (await fetch(base + "/api/auth/me")).json(); assert.ok(me.needsSetup && !me.user);
    const setup = await fetch(base + "/api/auth/setup", { method: "POST", headers: J, body: JSON.stringify({ username: "admiral", password: "password-1" }) });
    assert.equal(setup.status, 200);
    const cookie = (setup.headers.get("set-cookie") || "").split(";")[0]; assert.ok(cookie.startsWith("a_session="));
    assert.equal((await fetch(base + "/api/auth/setup", { method: "POST", headers: J, body: JSON.stringify({ username: "late", password: "password-1" }) })).status, 400); // setup closed
    assert.equal((await fetch(base + "/api/state", { headers: { cookie } })).status, 200);          // commander in
    assert.equal((await fetch(base + "/api/tasks", { method: "POST", headers: { ...J, cookie }, body: JSON.stringify({ prompt: "create x.txt saying hi" }) })).status, 200);
    // viewer: can watch, cannot command
    await fetch(base + "/api/auth/users", { method: "POST", headers: { ...J, cookie }, body: JSON.stringify({ username: "watcher", password: "password-2", role: "viewer" }) });
    const vlogin = await fetch(base + "/api/auth/login", { method: "POST", headers: J, body: JSON.stringify({ username: "watcher", password: "password-2" }) });
    const vcookie = (vlogin.headers.get("set-cookie") || "").split(";")[0];
    assert.equal((await fetch(base + "/api/state", { headers: { cookie: vcookie } })).status, 200);
    assert.equal((await fetch(base + "/api/control", { method: "POST", headers: { ...J, cookie: vcookie }, body: JSON.stringify({ action: "pause-all" }) })).status, 401);
    // quant dry-run job through the gated API
    const q = await fetch(base + "/api/quant/jobs", { method: "POST", headers: { ...J, cookie }, body: JSON.stringify({ model: "openbmb/MiniCPM5-2B", recipeIds: ["A-UD-Q3_K_XL"], dryRun: true }) });
    assert.equal(q.status, 200);
    // machines/scripts: cluster token commands without a login
    assert.equal((await fetch(base + "/api/tasks", { method: "POST", headers: { ...J, "x-a-token": "fleet-secret" }, body: JSON.stringify({ prompt: "ping" }) })).status, 200);
    // snapshot carries quant studio data
    const state = await (await fetch(base + "/api/state", { headers: { cookie } })).json();
    assert.ok(state.quant.recipes.length >= 7 && "tools" in state.quant);
  } finally { await srv.close(); }
});
