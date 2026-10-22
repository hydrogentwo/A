// MCP everywhere. Config normalization from every harness's file/format +
// a real client (stdio JSON-RPC + streamable-HTTP) so MCP tools register into
// the kernel as first-class tools. Token lesson from Pi: MCP tool schemas are
// DEFERRED — the model sees a compact index; full schemas load on demand.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const readJSON = async p => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } };
function norm(name, s, source) {
  if (s.command) return { name, transport: "stdio", command: s.command, args: s.args || [], env: s.env || {}, source };
  const url = s.url || s.httpUrl || s.endpoint; if (url) return { name, transport: "http", url, headers: s.headers || {}, source };
  return null;
}
export async function discoverMCP(cwd) {
  const out = new Map(); const add = (obj, source) => { for (const [n, s] of Object.entries(obj || {})) { const v = norm(n, s, source); if (v && !out.has(n)) out.set(n, v); } };
  add((await readJSON(join(cwd, ".a/mcp.json")))?.mcpServers, ".a/mcp.json");
  add((await readJSON(join(cwd, ".mcp.json")))?.mcpServers, ".mcp.json (Claude Code)");
  add((await readJSON(join(cwd, ".cursor/mcp.json")))?.mcpServers, ".cursor/mcp.json");
  add((await readJSON(join(cwd, ".vscode/mcp.json")))?.servers, ".vscode/mcp.json");
  add((await readJSON(join(cwd, ".pi/mcp.json")))?.mcpServers, ".pi/mcp.json");
  const oc = await readJSON(join(cwd, "opencode.json")) || await readJSON(join(cwd, ".opencode/opencode.json"));
  if (oc?.mcp) for (const [n, s] of Object.entries(oc.mcp)) { // OpenCode: {type:local, command:[..]} | {type:remote,url}
    const v = s.type === "local" ? { name: n, transport: "stdio", command: s.command?.[0], args: s.command?.slice(1) || [], env: s.environment || {}, source: "opencode.json" }
                                 : { name: n, transport: "http", url: s.url, headers: s.headers || {}, source: "opencode.json" };
    if (v.command || v.url) if (!out.has(n)) out.set(n, v);
  }
  const gem = await readJSON(join(cwd, ".muse/settings.json")); add(gem?.mcpServers, ".muse/settings.json");
  const toml = await readFile(join(cwd, ".codex/config.toml"), "utf8").catch(() => ""); // Codex TOML (targeted parse)
  for (const m of toml.matchAll(/\[mcp_servers\.([\w-]+)\]([^[]*)/g)) {
    const cmd = m[2].match(/command\s*=\s*"([^"]+)"/)?.[1], url = m[2].match(/url\s*=\s*"([^"]+)"/)?.[1];
    const args = [...(m[2].match(/args\s*=\s*\[([^\]]*)\]/)?.[1] || "").matchAll(/"([^"]+)"/g)].map(x => x[1]);
    if ((cmd || url) && !out.has(m[1])) out.set(m[1], cmd ? { name: m[1], transport: "stdio", command: cmd, args, env: {}, source: ".codex/config.toml" } : { name: m[1], transport: "http", url, headers: {}, source: ".codex/config.toml" });
  }
  return [...out.values()];
}

export class MCPClient {
  constructor(cfg) { this.cfg = cfg; this.seq = 0; this.pending = new Map(); this.buf = ""; }
  async start() {
    if (this.cfg.transport === "http") { await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "a-harness", version: "0.1.0" } }).catch(() => {}); return this; }
    this.proc = spawn(this.cfg.command, this.cfg.args, { env: { ...process.env, ...this.cfg.env }, stdio: ["pipe", "pipe", "inherit"] });
    this.proc.stdout.on("data", d => { this.buf += d; let i; while ((i = this.buf.indexOf("\n")) >= 0) { const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue; try { const j = JSON.parse(line); const p = this.pending.get(j.id); if (p) { this.pending.delete(j.id); j.error ? p.rej(new Error(j.error.message || "mcp error")) : p.res(j.result); } } catch {} } });
    await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "a-harness", version: "0.1.0" } });
    this.notify("notifications/initialized", {}); return this;
  }
  notify(method, params) { if (this.proc) this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
  async rpc(method, params) {
    const id = ++this.seq; const body = { jsonrpc: "2.0", id, method, params };
    if (this.cfg.transport === "http") {
      const r = await fetch(this.cfg.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.cfg.headers }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({})); if (j.error) throw new Error(j.error.message); return j.result;
    }
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.proc.stdin.write(JSON.stringify(body) + "\n");
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`mcp timeout: ${method}`)); }, 30_000).unref?.(); });
  }
  async tools() { return (await this.rpc("tools/list", {}))?.tools || []; }
  async call(name, args) { const r = await this.rpc("tools/call", { name, arguments: args });
    return (r?.content || []).map(c => c.text ?? JSON.stringify(c)).join("\n") || JSON.stringify(r); }
  stop() { try { this.proc?.kill(); } catch {} }
}

// Connect servers and register their tools into the kernel as `mcp__<server>__<tool>`.
export async function loadMCPIntoKernel(kernel, servers, { onEvent = () => {} } = {}) {
  const clients = [];
  for (const cfg of servers) {
    try {
      const c = await new MCPClient(cfg).start(); clients.push(c);
      for (const t of await c.tools()) kernel.registerTool({
        name: `mcp__${cfg.name}__${t.name}`, description: `[mcp:${cfg.name}] ${t.description || t.name}`,
        parameters: t.inputSchema || { type: "object", properties: {} },
        execute: args => c.call(t.name, args) }, `mcp:${cfg.name}`);
      onEvent("mcp:connected", { server: cfg.name, source: cfg.source });
    } catch (e) { onEvent("mcp:error", { server: cfg.name, error: e.message }); }
  } return clients;
}
