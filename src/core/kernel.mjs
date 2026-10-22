// Kernel — "everything is a plugin" (DeepSeek Harness/Cordis lesson) +
// Pi-style lifecycle events and OpenCode/Claude-style hooks, unified.
// Plugins register: tools, slash-commands, agents, hooks, event handlers.
// EVERY harness adapter (compat/*) funnels into this one registry, so a Pi
// extension, an OpenCode plugin and a Claude plugin coexist as peers.

export const EVENTS = [
  "session:start", "session:end", "turn:before", "turn:after",
  "tool:before", "tool:after", "tool:denied",           // guardrails/permissions hook here
  "context:build", "context:compact",                    // filters may rewrite history
  "model:request", "model:response", "agent:spawn", "swarm:task",
];

export class Kernel {
  constructor() {
    this.tools = new Map(); this.commands = new Map(); this.agents = new Map();
    this.handlers = new Map(); this.plugins = []; this.skills = [];
  }
  on(event, fn, source = "core") {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push({ fn, source }); return this;
  }
  // Handlers may mutate `ctx` or return {block:true, reason} to veto (Pi semantics).
  async emit(event, ctx = {}) {
    for (const h of this.handlers.get(event) || []) {
      const r = await h.fn(ctx);
      if (r?.block) { ctx.blocked = true; ctx.blockReason = r.reason || `blocked by ${h.source}`; return ctx; }
      if (r && typeof r === "object") Object.assign(ctx, r);
    }
    return ctx;
  }
  registerTool(tool, source = "core") { // {name, description, parameters(JSONSchema), execute(args,ctx)}
    if (!tool.name || typeof tool.execute !== "function") throw new Error(`bad tool from ${source}`);
    this.tools.set(tool.name, { ...tool, source }); return this;
  }
  registerCommand(name, cmd, source = "core") { this.commands.set(name, { ...cmd, source }); return this; }
  registerAgent(name, agent, source = "core") { this.agents.set(name, { ...agent, source }); return this; }
  async use(plugin, source = plugin.name || "plugin") { // {name, apply(kernel, config)} | async fn(kernel)
    const apply = typeof plugin === "function" ? plugin : plugin.apply?.bind(plugin);
    if (apply) await apply(this, plugin.config || {});
    this.plugins.push({ name: source }); return this;
  }
  toolSchemas(only) {
    return [...this.tools.values()].filter(t => !only || only.includes(t.name))
      .map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  describe() {
    return { tools: [...this.tools.values()].map(t => ({ name: t.name, source: t.source })),
             commands: [...this.commands.keys()], agents: [...this.agents.keys()],
             plugins: this.plugins.map(p => p.name), skills: this.skills.map(s => s.name) };
  }
}
