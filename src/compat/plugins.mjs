// Plugin adapters — run other harnesses' code plugins UNMODIFIED (best effort),
// via small API shims onto the kernel:
//  • Pi extensions       (.pi/extensions/*.ts|js, ~/.pi/agent/extensions) —
//      default export (pi) => { pi.registerTool, pi.registerCommand, pi.on }
//  • OpenCode plugins    (.opencode/plugin/*, .opencode/tool/*, opencode.json plugin[])
//      export const X = async ({client,$}) => ({ tool:{}, "tool.execute.before":fn … })
//  • Claude Code plugins (.claude-plugin/plugin.json → skills/agents/commands/hooks)
//      hooks: PreToolUse/PostToolUse/UserPromptSubmit… → kernel events + shell hooks
//  • DeepSeek/Octomind taps & A plugins (.a/plugins/*, manifest.json) — kernel.use()
//  • Gemini extensions   (gemini-extension.json → context + mcpServers)
// Trust model = Pi's: extensions run with your permissions. A asks once per
// project (trust marker .a/trusted) outside --yes/test flows.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { walk, parseFrontmatter } from "./discover.mjs";

const exists = async p => stat(p).then(() => true).catch(() => false);
const readJSON = async p => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } };
async function importAny(file) { // .ts loads via Node >=22 native type-stripping
  return import(pathToFileURL(file).href + `?t=${Date.now()}`);
}

export async function discoverPlugins(cwd) {
  const out = [];
  const scan = async (dir, kind, re) => { for (const f of await walk(join(cwd, dir), 2)) if (re.test(f)) out.push({ kind, path: f, name: f.split("/").pop() }); };
  await scan(".pi/extensions", "pi-extension", /\.(ts|js|mjs)$/);
  await scan(".opencode/plugin", "opencode-plugin", /\.(ts|js|mjs)$/);
  await scan(".opencode/tool", "opencode-tool", /\.(ts|js|mjs)$/);
  await scan(".a/plugins", "a-plugin", /\.(ts|js|mjs|json)$/);
  await scan(".octo/taps", "octomind-tap", /manifest\.json$|TAP\.md$/);
  if (await exists(join(cwd, ".claude-plugin/plugin.json"))) out.push({ kind: "claude-plugin", path: join(cwd, ".claude-plugin/plugin.json"), name: "claude-plugin" });
  if (await exists(join(cwd, "gemini-extension.json"))) out.push({ kind: "gemini-extension", path: join(cwd, "gemini-extension.json"), name: "gemini-extension" });
  const oc = await readJSON(join(cwd, "opencode.json"));
  for (const p of oc?.plugin || []) out.push({ kind: "opencode-npm-plugin", path: String(p), name: String(p) });
  const home = join(homedir(), ".pi/agent/extensions");
  for (const f of await walk(home, 1)) if (/\.(ts|js|mjs)$/.test(f)) out.push({ kind: "pi-extension(global)", path: f, name: f.split("/").pop() });
  return out;
}

// --- Pi shim ---
function piShim(kernel) {
  const S = s => s; // pi passes TypeBox schemas; they ARE JSON Schema at runtime
  return {
    registerTool: t => kernel.registerTool({ name: t.name, description: t.description, parameters: S(t.parameters) || { type: "object", properties: {} },
      execute: async (args, ctx) => { const r = await t.execute("call", args, undefined, undefined, ctx); return r?.content?.map?.(c => c.text).join("\n") ?? String(r ?? "ok"); } }, "pi-extension"),
    registerCommand: (name, cmd) => kernel.registerCommand(name, { description: cmd.description, handler: cmd.handler }, "pi-extension"),
    registerShortcut: () => {}, on: (ev, fn) => kernel.on(mapPiEvent(ev), fn, "pi-extension"),
    sendUserMessage: () => {}, getActiveTools: () => [...kernel.tools.keys()], setActiveTools: () => {},
  };
}
const mapPiEvent = e => ({ session_start: "session:start", turn_start: "turn:before", turn_end: "turn:after",
  tool_call: "tool:before", tool_result: "tool:after", before_agent_start: "turn:before" }[e] || e);

// --- OpenCode shim ---
function opencodeShimAdapter(kernel, mod, dir) {
  const factories = Object.values(mod).filter(v => typeof v === "function");
  return (async () => { for (const f of factories) {
    const hooks = await f({ client: { app: { log: async () => {} } }, $: null, directory: dir, worktree: dir }).catch(() => null);
    if (!hooks) continue;
    for (const [name, t] of Object.entries(hooks.tool || {}))
      kernel.registerTool({ name, description: t.description || name, parameters: zodish(t.args), execute: async args => String(await t.execute(args, {})) }, "opencode-plugin");
    if (hooks["tool.execute.before"]) kernel.on("tool:before", async ({ call }) => { await hooks["tool.execute.before"]({ tool: call.name }, { args: call.args }); }, "opencode-plugin");
    if (hooks["tool.execute.after"]) kernel.on("tool:after", async ({ call, result }) => { await hooks["tool.execute.after"]({ tool: call.name, args: call.args }, { output: result }); }, "opencode-plugin");
    if (hooks["chat.system.transform"]) kernel.on("context:build", async ctx => { const o = { system: [ctx.system || ""] }; await hooks["chat.system.transform"]({}, o); return { system: o.system.join("\n") }; }, "opencode-plugin");
  } })();
}
function zodish(args) { // OpenCode custom tools use zod via tool.schema — degrade gracefully to loose schema
  const props = {}; for (const k of Object.keys(args || {})) props[k] = { type: "string", description: args[k]?.description || k };
  return { type: "object", properties: props };
}

// --- Claude hooks (settings.json hooks + plugin hooks.json) → shell commands on kernel events ---
function registerClaudeHooks(kernel, hooks, source) {
  const run = (cmd, payload) => new Promise(res => { const p = execFile("bash", ["-lc", cmd], { timeout: 30_000 }, (e, out) => res({ code: e?.code ?? 0, out }));
    p.stdin.end(JSON.stringify(payload)); });
  const bind = (list, event, payloadFn, canBlock) => { for (const h of list || []) for (const sub of h.hooks || [])
    if (sub.type === "command" && sub.command) kernel.on(event, async ctx => { const r = await run(sub.command, payloadFn(ctx));
      if (canBlock && r.code === 2) return { block: true, reason: r.out || `hook blocked (${source})` }; }, source); };
  bind(hooks.PreToolUse, "tool:before", c => ({ tool_name: c.call?.name, tool_input: c.call?.args }), true);
  bind(hooks.PostToolUse, "tool:after", c => ({ tool_name: c.call?.name, tool_response: c.result }), false);
  bind(hooks.UserPromptSubmit, "turn:before", c => ({ prompt: c.task || "" }), true);
  bind(hooks.Stop, "session:end", () => ({}), false);
  bind(hooks.SessionStart, "session:start", () => ({}), false);
}

export async function loadPluginsIntoKernel(kernel, cwd, { onEvent = () => {} } = {}) {
  const found = await discoverPlugins(cwd); const loaded = [];
  // Claude settings hooks (project) — cheap, no code import needed
  const cs = await readJSON(join(cwd, ".claude/settings.json"));
  if (cs?.hooks) { registerClaudeHooks(kernel, cs.hooks, "claude-settings"); loaded.push("claude-hooks"); }
  for (const p of found) {
    try {
      if (p.kind.startsWith("pi-extension")) { const m = await importAny(p.path); const fn = m.default || Object.values(m)[0]; if (typeof fn === "function") await fn(piShim(kernel)); loaded.push(`pi:${p.name}`); }
      else if (p.kind === "opencode-plugin" || p.kind === "opencode-tool") { await opencodeShimAdapter(kernel, await importAny(p.path), cwd); loaded.push(`opencode:${p.name}`); }
      else if (p.kind === "a-plugin" && /\.(ts|js|mjs)$/.test(p.path)) { const m = await importAny(p.path); await kernel.use(m.default || m, `a:${p.name}`); loaded.push(`a:${p.name}`); }
      else if (p.kind === "claude-plugin") { const man = await readJSON(p.path); const base = join(cwd);
        const hj = await readJSON(join(base, "hooks/hooks.json")); if (hj?.hooks) registerClaudeHooks(kernel, hj.hooks, `claude-plugin:${man?.name}`); loaded.push(`claude-plugin:${man?.name || "?"}`); }
      else if (p.kind === "octomind-tap") { loaded.push(`tap:${p.name}(skills indexed)`); } // taps surface as skills via discoverSkills
      else if (p.kind === "gemini-extension") { loaded.push("gemini-extension(context+mcp indexed)"); }
      else if (p.kind === "opencode-npm-plugin") { onEvent("plugin:note", { msg: `npm plugin '${p.name}' — install into .opencode/node_modules to activate (v0.1 indexes only)` }); }
    } catch (e) { onEvent("plugin:error", { plugin: p.name, error: e.message }); }
  }
  return loaded;
}
export { parseFrontmatter };
