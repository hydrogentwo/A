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
import { Auth, roleRank, sessionTokenFromRequest, sessionCookie, clearCookie } from "./auth.mjs";
import { QuantJobs, detectTools } from "../quant/suite.mjs";
import { RECIPES, WEB_RECIPES } from "../quant/recipes.mjs";
import { createReadStream } from "node:fs";
import { stat as fsStat } from "node:fs/promises";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const SRC = join(dirname(fileURLToPath(import.meta.url)), ".."); // serve isomorphic modules to browser
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm" };

export async function startServer({ port = 8787, host = "0.0.0.0", token = process.env.A_CLUSTER_TOKEN || "", dataDir } = {}) {
  const store = await new Store(dataDir).init();
  const scheduler = new Scheduler(store.policy);
  const nodes = new Map();        // id -> node record (+ .ws runtime-only)
  const tasks = new Map();        // id -> task
  const uis = new Set();
  const relay = providerFromEnv(); // model for T0 nodes (demo unless configured)
  await store.event("vps:start", { port, relay: relay.id });

  const auth = await new Auth(store).init();              // commander login for the Swarm Console
  const quantTools = detectTools();
  let registryCache = [];
  const pub = n => ({ ...n, ws: undefined });
  const snapshot = () => ({ nodes: [...nodes.values()].map(pub), tasks: [...tasks.values()].slice(-100),
    policy: store.policy, catalog: [...CATALOG, ...registryCache], tiers: TIER_INFO, strategy: scheduler.strategy,
    maxConcurrentPerNode: scheduler.maxConcurrentPerNode, relay: relay.id,
    authEnabled: auth.enabled, quant: { recipes: { gguf: RECIPES, web: WEB_RECIPES }, jobs: quant.list(), registry: registryCache, tools: quantTools } });
  const toUIs = (type, data) => { const s = msg(type, data); for (const ws of uis) try { ws.send(s); } catch {} };
  const broadcastState = () => toUIs("snapshot", snapshot());
  const quant = await new QuantJobs(store, { onChange: async () => { registryCache = await quant.registry().catch(() => registryCache); broadcastState(); } }).init();
  registryCache = await quant.registry().catch(() => []);
  const resolveAnyModel = node => { const m = resolveModelForNode(node, store.policy);
    const id = typeof m === "string" ? m : m?.id; return registryCache.find(r => r.id === id) || m; };
  // Identity for commander APIs: cluster-token (machines/scripts) or a login session.
  function identity(req) {
    const tok = req.headers["x-a-token"] || new URL(req.url, "http://x").searchParams.get("token");
    if (token && tok === token) return { username: "(cluster-token)", role: "admin", via: "token" };
    const u = auth.userFromToken(sessionTokenFromRequest(req));
    return u ? { ...auth.publicUser(u), _user: u, via: "session" } : null;
  }

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
      // ---- commander auth gate (Swarm Console APIs) ----
      const P = url.pathname, isPost = req.method === "POST";
      const nodeAPI = P === "/api/chat" || P === "/api/artifact";       // workers: cluster-token rules only
      if (nodeAPI && !authed(req)) return send(401, { error: "bad cluster token" });
      if (P.startsWith("/api/") && !P.startsWith("/api/auth/") && !nodeAPI) {
        const needRole = (isPost && ["/api/tasks", "/api/policy", "/api/control"].includes(P)) || (P === "/api/quant/jobs" && isPost) ? "operator" : "viewer";
        if (auth.enabled) { const id = identity(req);
          if (!id || roleRank(id.role) < roleRank(needRole)) return send(401, { error: `login required (${needRole}+)`, needsSetup: auth.needsSetup() });
          req._id = id;
        } else if (!authed(req)) return send(401, { error: "bad cluster token" });
      }
      // ---- auth endpoints ----
      if (P === "/api/auth/me") { const id = identity(req);
        return send(200, { authEnabled: auth.enabled, needsSetup: auth.needsSetup(), user: id ? { username: id.username, role: id.role } : null }); }
      if (P === "/api/auth/setup" && isPost) { const b = await body();
        try { const s = await auth.setup(b.username, b.password, b.setupToken); res.setHeader("set-cookie", sessionCookie(s.token, req)); return send(200, { user: s.user }); }
        catch (e) { return send(400, { error: e.message }); } }
      if (P === "/api/auth/login" && isPost) { const b = await body();
        try { const s = await auth.login(b.username, b.password, req.socket.remoteAddress || "?"); res.setHeader("set-cookie", sessionCookie(s.token, req)); return send(200, { user: s.user }); }
        catch (e) { return send(401, { error: e.message }); } }
      if (P === "/api/auth/logout" && isPost) { await auth.logout(sessionTokenFromRequest(req)); res.setHeader("set-cookie", clearCookie()); return send(200, { ok: true }); }
      if (P === "/api/auth/password" && isPost) { const id = identity(req); if (!id?._user) return send(401, { error: "login required" });
        const b = await body(); try { await auth.setPassword(id._user, b.oldPassword, b.newPassword); return send(200, { ok: true }); } catch (e) { return send(400, { error: e.message }); } }
      if (P === "/api/auth/users") { const id = identity(req); if (!id || roleRank(id.role) < roleRank("admin")) return send(401, { error: "admin login required" });
        if (!isPost) return send(200, { users: auth.listUsers() });
        const b = await body(); try {
          if (b.action === "delete") { await auth.deleteUser(id, b.username); return send(200, { ok: true }); }
          return send(200, { user: await auth.createUser(id, b.username, b.password, b.role || "operator") });
        } catch (e) { return send(400, { error: e.message }); } }
      // ---- quant suite endpoints (commander) ----
      if (P === "/api/quant/jobs") {
        if (!isPost) return send(200, { jobs: quant.list(), recipes: { gguf: RECIPES, web: WEB_RECIPES }, tools: quantTools });
        const b = await body();
        try { const job = await quant.create({ model: b.model, recipeIds: b.recipeIds, paramsB: b.paramsB, layers: b.layers,
          imatrix: b.imatrix !== false, calibration: b.calibration, dryRun: !!b.dryRun, target: b.target || "gguf", outDir: b.outDir || join(store.dir, "quant-out") }, req._id?.username || "operator");
          return send(200, { jobId: job.id, status: job.status }); }
        catch (e) { return send(400, { error: e.message }); } }
      if (P === "/api/quant/registry") return send(200, { registry: registryCache });
      // Locally-quantized ONNX repos, served for browser-node loading
      // (Transformers.js fetches {origin}/models/<repo>/onnx/model_<dtype>.onnx).
      // Model weights are public artifacts; only registered dirs are exposed.
      if (P.startsWith("/models/")) {
        const entry = registryCache.find(r => r.engine === "onnx-web" && P.startsWith(`/models/${r.repo || r.id}/`));
        if (!entry) return send(404, { error: "unknown local model" });
        const rel = decodeURIComponent(P.slice(`/models/${entry.repo || entry.id}/`.length));
        const file = join(entry.path, rel);
        if (!file.startsWith(entry.path)) return send(403, { error: "forbidden" });
        const st = await fsStat(file).catch(() => null);
        if (!st?.isFile()) return send(404, { error: "not found" });
        res.writeHead(200, { "content-type": file.endsWith(".json") ? "application/json" : "application/octet-stream",
          "content-length": st.size, "cache-control": "public, max-age=31536000, immutable" });
        createReadStream(file).pipe(res); return;
      }
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
        for (const n of nodes.values()) { n.model = resolveAnyModel(n); try { n.ws?.send(msg("policy:update", { policy: p, model: n.model })); } catch {} }
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
          n.model = resolveAnyModel(n); try { n.ws?.send(msg("model:set", { model: n.model })); } catch {} } }
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
    const role = new URL(req.url, "http://x").searchParams.get("role") || "node";
    if (role === "ui" && auth.enabled) { if (!identity(req)) { ws.close(4401, "login required"); return; } }
    else if (!authed(req)) { ws.close(4401, "bad token"); return; }
    if (role === "ui") { uis.add(ws); ws.send(msg("snapshot", snapshot())); ws.on("close", () => uis.delete(ws)); return; }
    let node = null;
    ws.on("message", async raw => {
      const m = parse(raw); if (!m) return;
      if (m.type === "hello") {
        node = { ...m.node, ws, status: "idle", assigned: 0, joinedAt: Date.now(), lastSeen: Date.now(), stats: m.node.stats || {} };
        node.model = resolveAnyModel(node); nodes.set(node.id, node);
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
      node.assigned = 0; setTimeout(() => { if (nodes.get(node.id)?.status === "offline") nodes.delete(node.id); broadcastState(); }, 60_000).unref?.(); tryDispatch(); });
  });
  const hbTimer = setInterval(() => { const now = Date.now(); for (const n of nodes.values()) if (n.status !== "offline" && now - (n.lastSeen || 0) > 45_000) n.status = "offline"; broadcastState(); }, 15_000);
  hbTimer.unref?.();

  await new Promise(r => http.listen(port, host, r));
  console.log(`⬢ A VPS coordinator → http://${host}:${port}  (open in any browser to join the cluster; /swarm = console)`);
  if (!token) console.log("⚠  A_CLUSTER_TOKEN unset — open cluster (dev/LAN only). Set it on a public VPS.");
  const close = async () => { clearInterval(hbTimer); for (const ws of [...uis]) try { ws.close(); } catch {}
    try { for (const n of nodes.values()) n.ws?.close(); } catch {}
    http.closeIdleConnections?.();
    await Promise.race([new Promise(r => wss.close(() => r())), new Promise(r => setTimeout(r, 1500))]);
    await Promise.race([new Promise(r => http.close(() => r())), new Promise(r => setTimeout(r, 1500))]); };
  return { http, wss, store, nodes, tasks, auth, quant, close };
}
