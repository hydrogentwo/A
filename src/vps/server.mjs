// A VPS coordinator — run this on your VPS. Every browser/CLI that opens the
// URL becomes a cluster node; the VPS holds long-term storage (sessions,
// events, artifacts, policy), schedules the swarm, and relays a hosted model
// for T0 devices that can't run one locally. `a serve [--port 8787]`
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Store } from "./store.mjs";
import { Scheduler } from "../cluster/scheduler.mjs";
import { CATALOG, TIER_INFO, resolveModelForNode } from "../cluster/catalog.mjs";
import { msg, parse, newTaskId } from "../cluster/protocol.mjs";
import { providerFromEnv } from "../core/providers.mjs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const SRC = join(dirname(fileURLToPath(import.meta.url)), ".."); // serve isomorphic modules to browser
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

export async function startServer({ port = 8787, host = "0.0.0.0", token = process.env.A_CLUSTER_TOKEN || "", dataDir } = {}) {
  const store = await new Store(dataDir).init();
  const scheduler = new Scheduler(store.policy);
  const nodes = new Map();        // id -> node record (+ .ws runtime-only)
  const tasks = new Map();        // id -> task
  const uis = new Set();
  const relay = providerFromEnv(); // model for T0 nodes (demo unless configured)
  await store.event("vps:start", { port, relay: relay.id });

  const pub = n => ({ ...n, ws: undefined });
  const snapshot = () => ({ nodes: [...nodes.values()].map(pub), tasks: [...tasks.values()].slice(-100),
    policy: store.policy, catalog: CATALOG, tiers: TIER_INFO, strategy: scheduler.strategy,
    maxConcurrentPerNode: scheduler.maxConcurrentPerNode, relay: relay.id });
  const toUIs = (type, data) => { const s = msg(type, data); for (const ws of uis) try { ws.send(s); } catch {} };
  const broadcastState = () => toUIs("snapshot", snapshot());

  function tryDispatch() {
    for (const task of tasks.values()) {
      if (task.status !== "queued") continue;
      const node = scheduler.pick([...nodes.values()], task);
      if (!node) continue;
      task.status = "assigned"; task.nodeId = node.id; task.assignedAt = Date.now();
      node.assigned = (node.assigned || 0) + 1; node.status = "busy"; node.currentTask = task.id;
      try { node.ws?.send(msg("task:assign", { task })); } catch {}
      store.event("task:assigned", { taskId: task.id, nodeId: node.id, role: task.role });
    }
    broadcastState();
  }
  function finishTask(task, status, result, node) {
    task.status = status; task.result = result; task.finishedAt = Date.now();
    if (node) { node.assigned = Math.max(0, (node.assigned || 1) - 1); if (!node.assigned) { node.status = "idle"; node.currentTask = null; }
      node.stats = node.stats || {}; node.stats.tasksDone = (node.stats.tasksDone || 0) + (status === "done" ? 1 : 0);
      if (status === "failed") node.stats.failures = (node.stats.failures || 0) + 1; }
    store.event(status === "done" ? "task:done" : "task:failed", { taskId: task.id, nodeId: task.nodeId, ms: task.finishedAt - (task.createdAt || task.finishedAt) });
    if (status === "failed" && (task.retries ?? 1) > 0 && !task.groupId) { task.retries--; task.status = "queued"; task.nodeId = null; }
    tryDispatch();
  }
  const authed = req => !token || req.headers["x-a-token"] === token || new URL(req.url, "http://x").searchParams.get("token") === token;

  const http = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x"); const send = (code, body, type = "application/json") =>
      { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
    const body = async () => { let b = ""; for await (const c of req) b += c; try { return JSON.parse(b || "{}"); } catch { return {}; } };
    try {
      if (url.pathname.startsWith("/api/") && !authed(req)) return send(401, { error: "bad cluster token" });
      if (url.pathname === "/api/state") return send(200, { ...snapshot(), store: await store.stats(), events: await store.events(50) });
      if (url.pathname === "/api/tasks" && req.method === "POST") {
        const b = await body(); const now = Date.now(); const created = [];
        if (b.mode === "broadcast") { // Orca fan-out: N agents, same prompt, compare results
          const gid = newTaskId(); const picks = scheduler.pickN([...nodes.values()], b, Math.min(b.n || 3, 8));
          const count = Math.max(picks.length, 1);
          for (let i = 0; i < count; i++) { const t = { id: newTaskId(), groupId: gid, prompt: b.prompt, role: b.role || "build", minTier: b.minTier, status: "queued", createdAt: now, retries: 0 };
            tasks.set(t.id, t); created.push(t.id); }
        } else { const t = { id: newTaskId(), prompt: b.prompt, role: b.role || "build", minTier: b.minTier, nodeId: b.nodeId || null,
            status: "queued", createdAt: now, retries: b.retries ?? 1, budget: b.budget }; tasks.set(t.id, t); created.push(t.id); }
        await store.event("task:submitted", { ids: created, mode: b.mode || "single" }); tryDispatch();
        return send(200, { taskIds: created });
      }
      if (url.pathname === "/api/policy" && req.method === "POST") {
        const p = await store.savePolicy(await body()); scheduler.policy = p;
        for (const n of nodes.values()) { n.model = resolveModelForNode(n, p); try { n.ws?.send(msg("policy:update", { policy: p, model: n.model })); } catch {} }
        await store.event("policy:update", { version: p.version }); broadcastState(); return send(200, p);
      }
      if (url.pathname === "/api/control" && req.method === "POST") {
        const b = await body(); await store.event("control", b);
        if (b.action === "strategy") scheduler.strategy = b.value;
        if (b.action === "concurrency") scheduler.maxConcurrentPerNode = Math.max(1, Math.min(8, b.value | 0));
        if (b.action === "cancel-task") { const t = tasks.get(b.taskId); if (t) { const n = nodes.get(t.nodeId); try { n?.ws?.send(msg("task:cancel", { taskId: t.id })); } catch {} finishTask(t, "failed", "cancelled by operator", n); } }
        if (b.action === "node-message") { const n = nodes.get(b.nodeId); try { n?.ws?.send(msg("operator:message", { text: b.text })); } catch {} }
        if (b.action === "broadcast-message") for (const n of nodes.values()) try { n.ws?.send(msg("operator:message", { text: b.text })); } catch {}
        if (b.action === "node-model") { const n = nodes.get(b.nodeId); if (n) { store.policy.overrides = { ...(store.policy.overrides || {}), [n.id]: b.model }; await store.savePolicy(store.policy);
          n.model = resolveModelForNode(n, store.policy); try { n.ws?.send(msg("model:set", { model: n.model })); } catch {} } }
        if (b.action === "pause-all" || b.action === "resume-all") for (const n of nodes.values()) { n.paused = b.action === "pause-all"; if (n.paused) n.status = "paused"; else if (n.status === "paused") n.status = "idle"; }
        broadcastState(); return send(200, { ok: true });
      }
      if (url.pathname === "/api/chat" && req.method === "POST") { // relay inference for T0 / pre-download nodes
        const b = await body(); const r = await relay.chat({ messages: b.messages || [], tools: b.tools || [] });
        return send(200, { ...r, via: `vps-relay:${relay.id}` });
      }
      if (url.pathname === "/api/artifact" && req.method === "POST") { const b = await body();
        await store.putArtifact(b.taskId || "misc", b.name || "output.md", b.content || ""); return send(200, { ok: true }); }
      // static web app + isomorphic src modules
      let file = url.pathname === "/" || url.pathname === "/swarm" ? join(WEB, "index.html")
        : url.pathname.startsWith("/src/") ? join(SRC, url.pathname.slice(5))
        : join(WEB, url.pathname.replace(/^\//, ""));
      if (!file.startsWith(WEB) && !file.startsWith(SRC)) return send(403, "forbidden", "text/plain");
      const data = await readFile(file).catch(() => null);
      if (!data) return send(404, "not found", "text/plain");
      return send(200, data.toString(), MIME[extname(file)] || "application/octet-stream");
    } catch (e) { return send(500, { error: e.message }); }
  });

  const wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (ws, req) => {
    if (!authed(req)) { ws.close(4401, "bad token"); return; }
    const role = new URL(req.url, "http://x").searchParams.get("role") || "node";
    if (role === "ui") { uis.add(ws); ws.send(msg("snapshot", snapshot())); ws.on("close", () => uis.delete(ws)); return; }
    let node = null;
    ws.on("message", async raw => {
      const m = parse(raw); if (!m) return;
      if (m.type === "hello") {
        node = { ...m.node, ws, status: "idle", assigned: 0, joinedAt: Date.now(), lastSeen: Date.now(), stats: m.node.stats || {} };
        node.model = resolveModelForNode(node, store.policy); nodes.set(node.id, node);
        await store.event("node:join", { nodeId: node.id, kind: node.kind, tier: node.capacity?.tier, model: node.model?.id || node.model });
        ws.send(msg("welcome", { nodeId: node.id, policy: store.policy, model: node.model }));
        tryDispatch(); return;
      }
      if (!node) return; node.lastSeen = Date.now();
      if (m.type === "heartbeat") { Object.assign(node.stats, m.stats || {}); if (node.status !== "busy" && node.status !== "paused") node.status = m.status || "idle"; }
      if (m.type === "task:progress") toUIs("event", { kind: "task-progress", nodeId: node.id, taskId: m.taskId, text: m.text, log: m.log });
      if (m.type === "task:done" || m.type === "task:failed") { const t = tasks.get(m.taskId);
        if (m.artifact) await store.putArtifact(m.taskId, "result.md", m.artifact);
        if (t) finishTask(t, m.type === "task:done" ? "done" : "failed", m.result || m.error || "", node); broadcastState(); }
      if (m.type === "session:line") await store.appendSession(m.sessionId, m.line);
    });
    ws.on("close", async () => { if (!node) return; node.status = "offline"; await store.event("node:leave", { nodeId: node.id });
      for (const t of tasks.values()) if (t.nodeId === node.id && ["assigned"].includes(t.status)) { t.status = "queued"; t.nodeId = null; }
      node.assigned = 0; setTimeout(() => { if (nodes.get(node.id)?.status === "offline") nodes.delete(node.id); broadcastState(); }, 60_000); tryDispatch(); });
  });
  setInterval(() => { const now = Date.now(); for (const n of nodes.values()) if (n.status !== "offline" && now - (n.lastSeen || 0) > 45_000) n.status = "offline"; broadcastState(); }, 15_000);

  await new Promise(r => http.listen(port, host, r));
  console.log(`⬢ A VPS coordinator → http://${host}:${port}  (open in any browser to join the cluster; /swarm = console)`);
  if (!token) console.log("⚠  A_CLUSTER_TOKEN unset — open cluster (dev/LAN only). Set it on a public VPS.");
  return { http, wss, store, nodes, tasks };
}
