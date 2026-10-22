// A in the browser — two faces of the same page:
//  · "This device"  = Pi-style coding agent (MiniCPM WebGPU reference): auto-probe
//    capacity → assigned model per tier → local WebGPU inference or VPS relay →
//    tools run in a browser workspace (virtual FS + mini shell).
//  · "Swarm console" = Orca-style fleet command: every open browser/CLI is a node;
//    fan out tasks, compare broadcast results, control everything live.
import { probeBrowser } from "/src/cluster/capacity.mjs";
import { TIERS, TIER_INFO, CATALOG, modelById } from "/src/cluster/catalog.mjs";

const $ = s => document.querySelector(s);
const TOKEN = new URLSearchParams(location.search).get("token") || "";
const api = (path, opts = {}) => fetch(path, { ...opts, headers: { "content-type": "application/json", ...(TOKEN ? { "x-a-token": TOKEN } : {}), ...(opts.headers || {}) } });
const wsURL = role => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?role=${role}${TOKEN ? `&token=${TOKEN}` : ""}`;

// ---------- virtual FS + browser tools (saved on this device) ----------
const VFS_KEY = "a-vfs-v1";
let vfs = {}; try { vfs = JSON.parse(localStorage.getItem(VFS_KEY) || "{}"); } catch {}
if (!vfs["README.md"]) vfs["README.md"] = "# Browser workspace\nFiles live on this device (localStorage). Ask A to create/edit files, or run: ls · cat <f> · echo hi > f.txt\n";
const saveVFS = () => { localStorage.setItem(VFS_KEY, JSON.stringify(vfs)); renderFiles(); };
function renderFiles() { const el = $("#file-list"); if (el) el.innerHTML = Object.keys(vfs).sort().map(f => `<div data-f="${f}">📄 ${f}</div>`).join("") || "<div class=dim>(empty)</div>";
  el?.querySelectorAll("div[data-f]").forEach(d => d.onclick = () => addMsg("tool", `📄 ${d.dataset.f}\n${vfs[d.dataset.f]}`)); }
const TOOLS = [
  { name: "read", description: "Read a file in the browser workspace", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: ({ path }) => path in vfs ? vfs[path] : `error: no such file ${path}` },
  { name: "write", description: "Create/overwrite a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    execute: ({ path, content }) => { vfs[path] = content; saveVFS(); return `wrote ${path} (${content.length} bytes)`; } },
  { name: "edit", description: "Replace exact unique text in a file", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] },
    execute: ({ path, oldText, newText }) => { if (!(path in vfs)) return `error: no such file ${path}`; const n = vfs[path].split(oldText).length - 1;
      if (n !== 1) return `error: oldText occurs ${n} times`; vfs[path] = vfs[path].replace(oldText, newText); saveVFS(); return `edited ${path}`; } },
  { name: "bash", description: "Tiny shell: ls, cat, echo > file, rm, pwd, help", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: ({ command }) => miniShell(command) },
];
function miniShell(cmd) {
  const m = cmd.trim(); let r;
  if (m === "ls") return Object.keys(vfs).sort().join("\n") || "(empty)";
  if (m === "pwd") return "/browser-workspace";
  if (m === "help") return "ls · cat <f> · echo <txt> > <f> · rm <f> · pwd";
  if ((r = m.match(/^cat\s+(.+)$/))) return vfs[r[1]] ?? `cat: ${r[1]}: no such file`;
  if ((r = m.match(/^echo\s+(.*?)\s*(>>?)\s*(\S+)$/))) { vfs[r[3]] = r[2] === ">>" ? (vfs[r[3]] || "") + r[1] + "\n" : r[1] + "\n"; saveVFS(); return ""; }
  if ((r = m.match(/^rm\s+(.+)$/))) { delete vfs[r[1]]; saveVFS(); return ""; }
  return `bash(in-browser subset): cannot run '${m}' — this device runs VFS tools; use a CLI node (a join) for a real shell.`;
}
const toolSchemas = () => TOOLS.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

// ---------- inference: local WebGPU (Transformers.js) or VPS relay ----------
let localPipe = null, myModel = null, myCapacity = null;
async function loadLocalModel() {
  const rec = typeof myModel === "object" && myModel ? myModel : modelById(myModel);
  const id = rec?.id || myModel;
  const st = $("#model-status"), bar = $("#dl-progress");
  if (!id || String(id).startsWith("relay/")) { st.textContent = "Tier T0 \u2014 using VPS relay model (nothing to download)."; return; }
  // Format gate (see WEBGPU-ONNX.md): browsers execute ONNX via Transformers.js.
  if (rec?.engine === "gguf") { st.textContent = "Assigned model is a GGUF build \u2014 that\u2019s for CLI/VPS nodes (llama.cpp). Browsers can\u2019t load GGUF here, so this device uses the VPS relay. Assign an ONNX (onnx-web) variant to this tier for on-device inference."; return; }
  if (rec?.engine === "webllm") { st.textContent = "Assigned model is a WebLLM/MLC build; this page\u2019s local engine is Transformers.js (ONNX) \u2014 using VPS relay for now."; return; }
  const dtype = rec?.dtype || "q4f16";
  const repoId = rec?.repo || id;
  const attempt = async (device, dt) => {
    const tj = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js");
    if (String(id).startsWith("local/") && tj.env) {   // quantized by A-Quant, served by your VPS
      tj.env.remoteHost = location.origin + "/models/";
      tj.env.remotePathTemplate = "{model}/";
    }
    return tj.pipeline("text-generation", repoId, { dtype: dt, device,
      progress_callback: p => { if (p.status === "progress") bar.firstElementChild.style.width = `${Math.round(p.progress || 0)}%`; } });
  };
  try {
    st.textContent = `Loading ${repoId} (${dtype}) via Transformers.js \u2014 cached in this browser after first download\u2026`; bar.classList.remove("hidden");
    if (navigator.gpu) {
      try { localPipe = await attempt("webgpu", dtype); $("#inference-mode").textContent = `On your GPU (WebGPU \u00b7 ONNX ${dtype})`; }
      catch (gpuErr) { st.textContent = `WebGPU load failed (${String(gpuErr).slice(0, 100)}) \u2014 retrying on WASM/CPU (q8)\u2026`;
        localPipe = await attempt("wasm", "q8"); $("#inference-mode").textContent = "On your CPU (WASM \u00b7 ONNX q8)"; }
    } else { localPipe = await attempt("wasm", "q8"); $("#inference-mode").textContent = "On your CPU (WASM \u00b7 ONNX q8)"; }
    bar.classList.add("hidden"); st.textContent = `\u2713 ${repoId} running on this device.`;
  } catch (e) { bar.classList.add("hidden"); st.textContent = `Local load failed (${String(e).slice(0, 140)}) \u2014 using VPS relay instead.`; }
}
async function chatOnce(messages) {
  if (localPipe) { // small local models: prompt-level tool protocol
    const sys = `You are A, a coding agent in a browser. Tools: read(path), write(path,content), edit(path,oldText,newText), bash(command). To call one reply ONLY with a block:\n\`\`\`tool\n{"name":"write","args":{"path":"a.txt","content":"hi"}}\n\`\`\`\nOtherwise answer normally.`;
    const prompt = sys + "\n\n" + messages.map(m => `${m.role}: ${m.content}`).join("\n") + "\nassistant:";
    const out = await localPipe(prompt, { max_new_tokens: 512 });
    const text = (out?.[0]?.generated_text || "").slice(prompt.length).trim();
    const m = text.match(/```tool\s*([\s\S]*?)```/);
    if (m) { try { const j = JSON.parse(m[1]); return { text: "", toolCalls: [{ name: j.name, args: j.args }] }; } catch {} }
    return { text, toolCalls: [] };
  }
  const r = await api("/api/chat", { method: "POST", body: JSON.stringify({ messages, tools: toolSchemas() }) });
  if (!r.ok) throw new Error(`relay ${r.status}`);
  return r.json();
}

// ---------- browser agent loop ----------
let history = [{ role: "system", content: "You are A, a coding agent. Use tools to act; read before assuming. Be brief." }];
async function runBrowserAgent(task, { onProgress = () => {}, fresh = false } = {}) {
  const msgs = fresh ? [history[0], { role: "user", content: task }] : (history.push({ role: "user", content: task }), history);
  let final = "";
  for (let step = 0; step < 10; step++) {
    const res = await chatOnce(msgs);
    if (res.text) { final = res.text; msgs.push({ role: "assistant", content: res.text }); onProgress("text", res.text); }
    if (!res.toolCalls?.length) break;
    msgs.push({ role: "assistant", content: "", toolCalls: res.toolCalls });
    for (const c of res.toolCalls) {
      const t = TOOLS.find(x => x.name === c.name);
      let out; try { out = t ? await t.execute(c.args || {}) : `unknown tool ${c.name}`; } catch (e) { out = `error: ${e.message}`; }
      msgs.push({ role: "tool", content: String(out) }); onProgress("tool", `⚙ ${c.name} ${JSON.stringify(c.args).slice(0, 140)}\n→ ${String(out).slice(0, 300)}`);
    }
  } return final || "(done)";
}

// ---------- node identity + probe + cluster join ----------
const nodeId = localStorage.getItem("a-node-id") || (() => { const id = "browser-" + Math.random().toString(36).slice(2, 8); localStorage.setItem("a-node-id", id); return id; })();
const nodeName = localStorage.getItem("a-node-name") || (() => { const n = `${navigator.platform || "browser"} · ${nodeId.slice(-4)}`; localStorage.setItem("a-node-name", n); return n; })();
let nodeWS = null, busy = false;
function addMsg(cls, text) { const d = document.createElement("div"); d.className = `msg ${cls}`; d.textContent = text; $("#messages").appendChild(d); d.scrollIntoView({ behavior: "smooth" }); return d; }

async function bootNode() {
  renderFiles();
  const { profile, capacity } = await probeBrowser(); myCapacity = capacity;
  $("#probe").textContent =
`GPU        ${profile.gpuName || "(unidentified)"}
WebGPU     ${profile.webgpu ? "yes" : "no"}  · fp16 ${profile.fp16 ? "yes" : "no"}  · maxBuffer ${profile.maxBufferMB ?? "?"} MB
RAM hint   ${profile.deviceMemoryGB ?? "?"} GB · cores ${profile.cores} · free storage ${profile.storageFreeMB ?? "?"} MB
Benchmark  ${profile.benchScore !== undefined ? Math.round(profile.benchScore * 100) + "/100" : "—"}
→ ${capacity.reasons.join("\n→ ")}`;
  $("#tier-ladder").innerHTML = TIERS.map(t => `<div class="tier ${t === capacity.tier ? "me" : ""}"><strong>${t}</strong><br>${TIER_INFO[t].name}</div>`).join("");
  $("#inference-mode").textContent = capacity.tier === "T0" ? "VPS relay" : "Your GPU (after load) / relay until then";

  nodeWS = new WebSocket(wsURL("node"));
  nodeWS.onopen = () => { nodeWS.send(JSON.stringify({ type: "hello", node: { id: nodeId, kind: "browser", name: nodeName, capacity, profile, stats: { tokS: 0, tasksDone: 0 } } }));
    setInterval(() => nodeWS.readyState === 1 && nodeWS.send(JSON.stringify({ type: "heartbeat", status: busy ? "busy" : "idle", stats: {} })), 10_000); };
  nodeWS.onmessage = async ev => { let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "welcome" || m.type === "policy:update" || m.type === "model:set") applyModel(m.model);
    if (m.type === "welcome") { $("#cluster-pill").className = "pill on"; $("#cluster-pill").textContent = `⬢ in swarm · ${nodeId}`; }
    if (m.type === "operator:message") addMsg("sys", `📣 operator: ${m.text}`);
    if (m.type === "task:assign") {
      if (!$("#accept-tasks").checked) { nodeWS.send(JSON.stringify({ type: "task:failed", taskId: m.task.id, error: "node not accepting tasks" })); return; }
      busy = true; const t = m.task; const banner = $("#swarm-task-banner");
      banner.classList.remove("hidden"); banner.textContent = `🐝 Swarm task ${t.id} [${t.role}] — ${t.prompt}`;
      try { const res = await runBrowserAgent(t.prompt, { fresh: true, onProgress: (k, text) => { addMsg(k === "tool" ? "tool" : "assistant", text);
          nodeWS.send(JSON.stringify({ type: "task:progress", taskId: t.id, text })); } });
        nodeWS.send(JSON.stringify({ type: "task:done", taskId: t.id, result: res, artifact: `# ${t.prompt}\n\n${res}` }));
      } catch (e) { nodeWS.send(JSON.stringify({ type: "task:failed", taskId: t.id, error: e.message })); }
      busy = false; banner.classList.add("hidden");
    } };
  nodeWS.onclose = () => { $("#cluster-pill").className = "pill off"; $("#cluster-pill").textContent = "cluster: disconnected (retrying…)"; setTimeout(bootNodeWSOnly, 4000); };
}
function bootNodeWSOnly() { /* rejoin without re-probing */ bootNode().catch(() => {}); }
function applyModel(model) {
  myModel = model; const m = typeof model === "string" ? modelById(model) : model;
  $("#assigned-model").textContent = m?.label || m?.id || String(model || "—");
  $("#dl-size").textContent = m?.downloadMB ? `≈ ${(m.downloadMB / 1024).toFixed(2)} GB (cached here)` : "—";
  $("#model-status").textContent = myCapacity?.tier === "T0" ? "T0 Relay — VPS runs the model." : "Not downloaded yet — chat uses VPS relay until you load it.";
}

// ---------- swarm console ----------
let SNAP = null; const taskLogs = new Map(); let selectedNode = null;
function bootUI() {
  const ws = new WebSocket(wsURL("ui"));
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "snapshot") { SNAP = m; renderSwarm(); }
    if (m.type === "event" && m.kind === "task-progress") { const l = taskLogs.get(m.taskId) || []; l.push(m.text); taskLogs.set(m.taskId, l);
      const el = document.querySelector(`[data-term="${m.taskId}"]`); if (el) { el.textContent += m.text + "\n"; el.scrollTop = el.scrollHeight; } }
  };
  ws.onclose = () => setTimeout(bootUI, 4000);
}
function renderSwarm() {
  if (!SNAP) return; const { nodes, tasks, policy } = SNAP;
  renderQuant();
  const online = nodes.filter(n => n.status !== "offline");
  $("#fleet-count").textContent = `· ${online.length} online`;
  const fleetVram = online.reduce((a, n) => a + (n.capacity?.estVramMB || 0), 0);
  $("#stats-bar").innerHTML = `<div class="kpis">
    <div><b>${online.length}</b><br><span class="dim small">nodes online</span></div>
    <div><b>${(fleetVram / 1024).toFixed(1)} GB</b><br><span class="dim small">fleet GPU memory</span></div>
    <div><b>${tasks.filter(t => t.status === "done").length}</b><br><span class="dim small">tasks done</span></div>
    <div><b>${tasks.filter(t => ["queued", "assigned"].includes(t.status)).length}</b><br><span class="dim small">in flight</span></div>
    <div><b>${SNAP.relay}</b><br><span class="dim small">VPS relay model</span></div>
    <div><b>${SNAP.strategy}</b><br><span class="dim small">strategy</span></div></div>`;
  $("#node-cards").innerHTML = nodes.map(n => { const m = typeof n.model === "string" ? modelById(n.model) : n.model; return `
    <div class="node-card ${selectedNode === n.id ? "sel" : ""}" data-node="${n.id}">
      <span class="dot ${n.status}"></span><strong>${n.name || n.id}</strong>
      <span class="badge">${n.kind}</span><span class="badge">${n.capacity?.tier || "?"} ${TIER_INFO[n.capacity?.tier]?.name || ""}</span>
      <div class="small dim">${m?.label || m?.id || "—"} · ~${n.capacity?.estVramMB || 0} MB GPU · ${n.stats?.tokS || 0} tok/s · ✓${n.stats?.tasksDone || 0}</div>
      ${n.currentTask ? `<div class="small">🐝 ${n.currentTask}</div>` : ""}
      ${selectedNode === n.id ? `<div style="margin-top:8px">
        <select data-model-for="${n.id}">${(SNAP.catalog || CATALOG).map(c => `<option value="${c.id}" ${c.id === (m?.id) ? "selected" : ""}>${c.tier} · ${c.label}</option>`).join("")}</select>
        <div class="row"><button data-act="model" data-id="${n.id}">Set model</button>
        <input data-msg-for="${n.id}" placeholder="message node…" style="flex:1"><button data-act="msg" data-id="${n.id}">→</button></div></div>` : ""}
    </div>`; }).join("") || "<p class=dim>No nodes yet — open this page on another device.</p>";
  document.querySelectorAll("[data-node]").forEach(c => c.onclick = e => { if (e.target.tagName !== "SELECT" && e.target.tagName !== "INPUT" && e.target.tagName !== "BUTTON") { selectedNode = selectedNode === c.dataset.node ? null : c.dataset.node; renderSwarm(); } });
  document.querySelectorAll("[data-act=model]").forEach(b => b.onclick = () => control({ action: "node-model", nodeId: b.dataset.id, model: document.querySelector(`[data-model-for="${b.dataset.id}"]`).value }));
  document.querySelectorAll("[data-act=msg]").forEach(b => b.onclick = () => control({ action: "node-message", nodeId: b.dataset.id, text: document.querySelector(`[data-msg-for="${b.dataset.id}"]`).value }));
  const sel = $("#swarm-node"); const cur = sel.value;
  sel.innerHTML = `<option value="">scheduler picks</option>` + online.map(n => `<option value="${n.id}">${n.name || n.id} (${n.capacity?.tier})</option>`).join(""); sel.value = cur;
  $("#ctl-strategy").value = SNAP.strategy; $("#ctl-concurrency").value = SNAP.maxConcurrentPerNode;
  if (!$("#policy-editor").dataset.built || $("#policy-editor").dataset.v !== String(policy.version)) {
    $("#policy-editor").dataset.built = "1"; $("#policy-editor").dataset.v = String(policy.version);
    $("#policy-editor").innerHTML = `<table><tr><th>Tier</th><th>Capacity</th><th>Specified model</th></tr>` + TIERS.map(t =>
      `<tr><td><strong>${t}</strong></td><td class="dim">${TIER_INFO[t].desc}</td><td><select data-tier="${t}">${
        (SNAP.catalog || CATALOG).map(c => `<option value="${c.id}" ${policy.tiers[t] === c.id ? "selected" : ""}>${c.label} (${c.params})</option>`).join("")}</select></td></tr>`).join("") + "</table>";
  }
  $("#board").innerHTML = [...tasks].reverse().slice(0, 24).map(t => `
    <div class="task"><h4><span class="st-${t.status}">● ${t.status}</span> ${t.id} <span class="dim">[${t.role}]${t.groupId ? " · broadcast " + t.groupId : ""}${t.nodeId ? " · " + t.nodeId : ""}</span></h4>
      <div class="small">${t.prompt.slice(0, 160)}</div>
      <div class="term" data-term="${t.id}">${(taskLogs.get(t.id) || []).join("\n")}${t.result ? "\n— result —\n" + t.result : ""}</div>
      <div class="row">${["queued", "assigned"].includes(t.status) ? `<button data-cancel="${t.id}">✕ cancel</button>` : ""}
      ${t.status === "done" ? `<button data-winner="${t.id}">🏆 merge winner</button>` : ""}</div></div>`).join("") || "<p class=dim>No tasks yet.</p>";
  document.querySelectorAll("[data-cancel]").forEach(b => b.onclick = () => control({ action: "cancel-task", taskId: b.dataset.cancel }));
  document.querySelectorAll("[data-winner]").forEach(b => b.onclick = async () => { const t = SNAP.tasks.find(x => x.id === b.dataset.winner);
    await api("/api/artifact", { method: "POST", body: JSON.stringify({ taskId: t.groupId || t.id, name: "winner.md", content: `# Winner ${t.id} (node ${t.nodeId})\n\n${t.prompt}\n\n${t.result}` }) });
    b.textContent = "🏆 merged to VPS artifacts ✓"; });
}
const control = b => api("/api/control", { method: "POST", body: JSON.stringify(b) });

// ---------- wiring ----------
// ---------- commander auth (gates the Swarm Console only) ----------
let ME = null, uiStarted = false;
async function refreshMe() {
  try { ME = await (await fetch("/api/auth/me")).json(); }
  catch { ME = { authEnabled: false, user: { username: "(offline)", role: "?" } }; }
  const authed = !ME.authEnabled || !!ME.user;
  $("#auth-gate").classList.toggle("hidden", authed);
  $("#fleet").classList.toggle("hidden", !authed);
  $("#swarm-main").classList.toggle("hidden", !authed);
  const chip = $("#user-chip");
  if (ME.user) { chip.textContent = `👤 ${ME.user.username} · ${ME.user.role}`; chip.classList.remove("hidden"); $("#logout-btn").classList.remove("hidden"); }
  else { chip.classList.add("hidden"); $("#logout-btn").classList.add("hidden"); }
  if (!authed) {
    const setup = !!ME.needsSetup;
    $("#auth-title").textContent = setup ? "⬢ Create the first commander" : "⬢ Commander login";
    $("#auth-blurb").textContent = setup
      ? "No accounts exist yet on this VPS. Create the first commander (admin) — setup closes permanently afterwards. On a public VPS, prefer bootstrapping with A_ADMIN_USER/A_ADMIN_PASSWORD instead."
      : "The Swarm Console commands the whole fleet — login required. Worker devices joining as nodes don't need an account.";
    $("#auth-go").textContent = setup ? "Create commander account" : "Log in";
    $("#auth-token-row").classList.toggle("hidden", !setup);
  }
  if (authed && !uiStarted) { uiStarted = true; bootUI(); }
  if (authed && ME.user?.role === "admin") loadUsers();
}
$("#auth-form").onsubmit = async e => { e.preventDefault(); $("#auth-err").textContent = "";
  const setup = !!ME?.needsSetup;
  const r = await api(setup ? "/api/auth/setup" : "/api/auth/login", { method: "POST",
    body: JSON.stringify({ username: $("#auth-user").value.trim(), password: $("#auth-pass").value, setupToken: $("#auth-token").value || undefined }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("#auth-err").textContent = j.error || `HTTP ${r.status}`; return; }
  $("#auth-pass").value = ""; refreshMe(); };
$("#logout-btn").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); };
async function loadUsers() {
  const r = await api("/api/auth/users"); if (!r.ok) return; const { users } = await r.json();
  $("#users-card").classList.remove("hidden");
  $("#user-list").innerHTML = users.map(u => `<div>👤 <strong>${u.username}</strong> <span class="badge">${u.role}</span>${u.username !== ME.user.username ? `<button data-del-user="${u.username}" style="float:right">✕</button>` : ""}</div>`).join("");
  document.querySelectorAll("[data-del-user]").forEach(b => b.onclick = async () => {
    await api("/api/auth/users", { method: "POST", body: JSON.stringify({ action: "delete", username: b.dataset.delUser }) }); loadUsers(); });
}
$("#nu-go").onclick = async () => {
  const r = await api("/api/auth/users", { method: "POST", body: JSON.stringify({ username: $("#nu-name").value.trim(), password: $("#nu-pass").value, role: $("#nu-role").value }) });
  if (!r.ok) { alert((await r.json().catch(() => ({}))).error || "failed"); return; }
  $("#nu-name").value = $("#nu-pass").value = ""; loadUsers(); };

// ---------- Quant Studio ----------
function renderQuant() {
  const q = SNAP?.quant; if (!q) return;
  const target = $("#q-target")?.value || "onnx-web";
  const t = q.tools || {};
  const webOk = t.optimum && t.ortPy, ggufOk = t.quantize;
  $("#quant-tools-line").textContent = target === "onnx-web"
    ? (webOk ? "✓ ONNX toolchain present (optimum + onnxruntime) — real browser builds enabled."
             : "⚠ ONNX toolchain missing on VPS (optimum-cli / onnxruntime) — jobs run as full dry-run plans until installed (QUANT.md).")
    : (ggufOk ? "✓ llama.cpp toolchain present — real GGUF builds enabled."
              : "⚠ llama.cpp toolchain not on the VPS yet — dry-run plans until installed (QUANT.md).");
  const list = (target === "onnx-web" ? q.recipes.web : q.recipes.gguf) || [];
  if ($("#q-recipes").dataset.built !== target) { $("#q-recipes").dataset.built = target;
    const defaults = target === "onnx-web" ? ["A-WEB-Q4F16-XL", "A-WEB-Q4"] : ["A-UD-Q4_K_XL", "A-UD-Q2_K_XL"];
    $("#q-recipes").innerHTML = list.map(r => `<label style="display:block"><input type="checkbox" value="${r.id}" style="width:auto" ${defaults.includes(r.id) ? "checked" : ""}> ${r.id} <span class="dim">→ ${r.tier}${r.dtype ? " · " + r.dtype : ""}</span></label>`).join(""); }
  $("#q-jobs").innerHTML = (q.jobs || []).slice(0, 6).map(j => `
    <details class="task" style="margin-bottom:8px"><summary><strong>${j.id}</strong> · ${j.model} · <span class="st-${j.status === "done" || j.status === "planned" ? "done" : j.status === "failed" ? "failed" : "assigned"}">● ${j.status}${j.stage ? " · " + j.stage : ""}</span> <span class="dim">${j.target || "gguf"}${j.dryRun ? " · dry-run" : ""} · by ${j.createdBy}</span></summary>
      <div class="term">${(j.logTail || j.log || []).slice(-25).join("\n") || j.error || ""}</div>
      ${(j.results || []).map(r => `<div class="small">· ${r.recipe}: ${r.status}${r.sizeMB ? ` · ${r.sizeMB} MB` : ""}${r.ppl ? ` · PPL ${r.ppl}` : ""}${r.registryId ? ` · <code>${r.registryId}</code>` : ""}</div>`).join("")}
    </details>`).join("");
  const reg = q.registry || [];
  if (reg.length) $("#q-registry").innerHTML = `<table style="width:100%;border-collapse:collapse"><tr><th align=left>Variant</th><th align=left>Size</th><th align=left>Runs on</th><th align=left>Assign to tier</th></tr>` +
    reg.map((v, i) => `<tr><td><code>${v.id}</code><br><span class="dim">${v.baseModel || ""} · ${v.bpw || "?"} bpw</span></td>
      <td>${v.downloadMB || "?"} MB</td><td>${v.engine === "onnx-web" ? "🌐 browser (ONNX " + (v.dtype || "") + ")" : "🖥 CLI/VPS (GGUF)"}</td>
      <td><span class="row2"><select id="qr-tier-${i}">${TIERS.map(tt => `<option ${tt === v.tier ? "selected" : ""}>${tt}</option>`).join("")}</select>
      <button data-qr="${i}">Assign</button></span></td></tr>`).join("") + "</table>";
  document.querySelectorAll("[data-qr]").forEach(b => b.onclick = async () => {
    const v = reg[+b.dataset.qr]; const tier = $(`#qr-tier-${b.dataset.qr}`).value;
    await api("/api/policy", { method: "POST", body: JSON.stringify({ tiers: { ...SNAP.policy.tiers, [tier]: v.id } }) });
    b.textContent = `✓ ${tier} now uses it`; });
}
$("#q-target").onchange = () => { $("#q-recipes").dataset.built = ""; renderQuant(); };
$("#q-go").onclick = async () => {
  const model = $("#q-model").value.trim(); if (!model) { $("#q-msg").textContent = "enter a HuggingFace model id"; return; }
  const recipeIds = [...document.querySelectorAll("#q-recipes input:checked")].map(c => c.value);
  if (!recipeIds.length) { $("#q-msg").textContent = "pick at least one recipe"; return; }
  const r = await api("/api/quant/jobs", { method: "POST", body: JSON.stringify({ model, recipeIds, target: $("#q-target").value,
    paramsB: $("#q-params").value ? +$("#q-params").value : undefined, imatrix: $("#q-imatrix").checked, dryRun: $("#q-dry").checked }) });
  const j = await r.json().catch(() => ({}));
  $("#q-msg").textContent = r.ok ? `job ${j.jobId} queued — watch it below` : (j.error || `HTTP ${r.status} (login as operator?)`);
  if (r.status === 401) refreshMe(); };

// ---------- wiring ----------
$("#tab-node").onclick = () => switchView(false); $("#tab-swarm").onclick = () => switchView(true);
function switchView(swarm) { $("#view-node").classList.toggle("hidden", swarm); $("#view-swarm").classList.toggle("hidden", !swarm);
  $("#tab-node").classList.toggle("active", !swarm); $("#tab-swarm").classList.toggle("active", swarm); history.replaceState(null, "", swarm ? "/swarm" : "/"); }
if (location.pathname === "/swarm") switchView(true);
$("#new-chat").onclick = () => { history = [history[0]]; $("#messages").innerHTML = ""; };
$("#load-model").onclick = loadLocalModel;
$("#input").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); } });
$("#composer").onsubmit = async e => { e.preventDefault(); const v = $("#input").value.trim(); if (!v) return; $("#input").value = "";
  addMsg("user", v); const thinking = addMsg("sys", "A is working…");
  try { await runBrowserAgent(v, { onProgress: (k, text) => { thinking.remove(); addMsg(k === "tool" ? "tool" : "assistant", text); } }); }
  catch (err) { thinking.textContent = `error: ${err.message}`; } };
$("#swarm-go").onclick = async () => { const prompt = $("#swarm-prompt").value.trim(); if (!prompt) return;
  await api("/api/tasks", { method: "POST", body: JSON.stringify({ prompt, role: $("#swarm-role").value, mode: $("#swarm-mode").value,
    n: +$("#swarm-n").value, minTier: $("#swarm-tier").value || undefined, nodeId: $("#swarm-node").value || undefined, retries: +$("#swarm-retries").value }) }); };
$("#ctl-strategy").onchange = e => control({ action: "strategy", value: e.target.value });
$("#ctl-concurrency").onchange = e => control({ action: "concurrency", value: +e.target.value });
$("#ctl-pause").onclick = () => control({ action: "pause-all" }); $("#ctl-resume").onclick = () => control({ action: "resume-all" });
$("#ctl-bcast-go").onclick = () => control({ action: "broadcast-message", text: $("#ctl-bcast").value });
$("#policy-save").onclick = async () => { const tiers = {}; document.querySelectorAll("[data-tier]").forEach(s => tiers[s.dataset.tier] = s.value);
  await api("/api/policy", { method: "POST", body: JSON.stringify({ tiers }) }); $("#policy-save").textContent = "Pushed ✓ — nodes updating live";
  setTimeout(() => $("#policy-save").textContent = "Save & push policy", 2500); };
$("#copy-join").onclick = () => navigator.clipboard?.writeText(location.origin + "/" + (TOKEN ? `?token=${TOKEN}` : ""));
setInterval(async () => { try { const r = await api("/api/state"); const s = await r.json();
  $("#event-log").textContent = (s.events || []).slice(-14).reverse().map(e => `${e.t?.slice(11, 19)} ${e.type} ${e.nodeId || e.taskId || ""}`).join("\n"); } catch {} }, 8000);

addMsg("sys", `⬢ A ready on ${nodeName}. Probing this device's maximum model capacity…`);
bootNode().then(() => addMsg("sys", `Capacity tier ${myCapacity.tier} (${TIER_INFO[myCapacity.tier].name}). Chat now (relay) or load the model locally above.`)).catch(e => addMsg("sys", "probe error: " + e.message));
refreshMe(); // gates the Swarm Console behind commander login, then boots its live feed
