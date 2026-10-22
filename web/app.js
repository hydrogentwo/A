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
  const id = typeof myModel === "string" ? myModel : myModel?.id;
  const st = $("#model-status"), bar = $("#dl-progress");
  if (!id || id.startsWith("relay/")) { st.textContent = "Tier T0 — using VPS relay model (nothing to download)."; return; }
  if (!navigator.gpu) { st.textContent = "No WebGPU in this browser — staying on VPS relay."; return; }
  try {
    st.textContent = `Loading ${id} via Transformers.js (cached in this browser)…`; bar.classList.remove("hidden");
    const { pipeline } = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js");
    localPipe = await pipeline("text-generation", id, { dtype: "q4", device: "webgpu",
      progress_callback: p => { if (p.status === "progress") bar.firstElementChild.style.width = `${Math.round(p.progress || 0)}%`; } });
    bar.classList.add("hidden"); st.textContent = `✓ ${id} running on this GPU.`; $("#inference-mode").textContent = "On your GPU (WebGPU)";
  } catch (e) { bar.classList.add("hidden"); st.textContent = `Local load failed (${String(e).slice(0, 140)}) — using VPS relay instead. (Some catalog models ship via WebLLM; relay covers them today.)`; }
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
        <select data-model-for="${n.id}">${CATALOG.map(c => `<option value="${c.id}" ${c.id === (m?.id) ? "selected" : ""}>${c.tier} · ${c.label}</option>`).join("")}</select>
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
        CATALOG.map(c => `<option value="${c.id}" ${policy.tiers[t] === c.id ? "selected" : ""}>${c.label} (${c.params})</option>`).join("")}</select></td></tr>`).join("") + "</table>";
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
bootUI();
