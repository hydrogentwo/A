// Universal discovery: find skills / context / agents / commands / prompts from
// EVERY known harness layout, zero config. Native home is .a/ + AGENTS.md;
// everything else is auto-imported (precedence: .a > project > user-global).
//
// Layouts covered (2026): A (.a), Agent Skills standard (.agents/skills, SKILL.md),
// Claude Code (.claude/{skills,agents,commands}, CLAUDE.md, .claude-plugin/),
// Pi (.pi/{extensions,skills,prompts}, ~/.pi/agent), OpenCode (.opencode/{agent,
// command,tool,plugin}, opencode.json), Codex (.codex, AGENTS.md), Gemini CLI
// (.gemini, GEMINI.md), Cursor (.cursor/{rules,mcp.json}), Octomind (.octo taps),
// DeepSeek Harness (skills/ + config plugins), Goose/Cline/Aider conventions.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export function parseFrontmatter(md) {
  const m = String(md).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: String(md) };
  const data = {};
  for (const line of m[1].split("\n")) { const kv = line.match(/^([\w-]+):\s*(.*)$/); if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim(); }
  return { data, body: m[2] };
}
const exists = async p => stat(p).then(() => true).catch(() => false);
export async function walk(dir, depth = 3, out = []) {
  if (depth < 0 || !(await exists(dir))) return out;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith(".git") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, depth - 1, out); else out.push(p);
  } return out;
}

const SKILL_DIRS = [".a/skills", ".agents/skills", ".claude/skills", ".pi/skills", ".opencode/skills", ".codex/skills", ".muse/skills", ".octo/taps", "skills"];
const GLOBAL_SKILL_DIRS = [".a/skills", ".agents/skills", ".claude/skills", ".pi/agent/skills", ".config/opencode/skills", ".codex/skills"];
export async function discoverSkills(cwd, { global = true } = {}) {
  const found = new Map();
  const roots = [...SKILL_DIRS.map(d => [join(cwd, d), d]), ...(global ? GLOBAL_SKILL_DIRS.map(d => [join(homedir(), d), "~/" + d]) : [])];
  for (const [root, label] of roots) {
    for (const f of await walk(root, 3)) {
      if (!/(^|\/)SKILL\.md$/i.test(f) && !/\.md$/i.test(f)) continue;
      const { data, body } = parseFrontmatter(await readFile(f, "utf8").catch(() => ""));
      const name = data.name || f.split("/").slice(-2, -1)[0] || f.split("/").pop().replace(/\.md$/, "");
      if (!found.has(name)) found.set(name, { name, description: data.description || body.split("\n")[0].slice(0, 120),
        path: f, source: label, body, /* progressive disclosure (Pi): body loads on invoke */ loaded: false });
    }
  } return [...found.values()];
}

const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".a/AGENTS.md", "OCTO.md", ".octo/OCTO.md", "CONVENTIONS.md", ".muserules"];
export async function discoverContext(cwd) {
  const parts = [];
  for (const f of CONTEXT_FILES) { const p = join(cwd, f); if (await exists(p)) parts.push({ file: f, text: (await readFile(p, "utf8")).slice(0, 20_000) }); }
  const rulesDir = join(cwd, ".cursor/rules");
  for (const f of await walk(rulesDir, 1)) if (/\.mdc?$/.test(f)) parts.push({ file: ".cursor/rules/" + f.split("/").pop(), text: parseFrontmatter(await readFile(f, "utf8")).body.slice(0, 8000) });
  return parts;
}

const AGENT_DIRS = [".a/agents", ".claude/agents", ".opencode/agent", ".codex/agents"];
const COMMAND_DIRS = [".a/commands", ".claude/commands", ".opencode/command", ".pi/prompts"];
async function discoverMdAssets(cwd, dirs, kind) {
  const out = [];
  for (const d of dirs) for (const f of await walk(join(cwd, d), 2)) {
    if (!/\.md$/i.test(f)) continue;
    const { data, body } = parseFrontmatter(await readFile(f, "utf8").catch(() => ""));
    out.push({ kind, name: data.name || f.split("/").pop().replace(/\.md$/i, ""), description: data.description || "",
      model: data.model, tools: data.tools?.split(/[,\s]+/).filter(Boolean), prompt: body, path: f, source: d });
  } return out;
}
export const discoverAgents = cwd => discoverMdAssets(cwd, AGENT_DIRS, "agent");
export const discoverCommands = cwd => discoverMdAssets(cwd, COMMAND_DIRS, "command");

// Pi agent-dir state, shared byte-for-byte by TypeScript Pi and pi-rs (Rust).
// We surface presence + custom provider names from models.json — never secrets
// (auth.json is detected, not read).
export async function discoverPi(cwd) {
  const agentDir = join(homedir(), ".pi", "agent");
  const files = {};
  for (const f of ["settings.json", "models.json", "auth.json"]) files[f] = await exists(join(agentDir, f));
  let customProviders = [];
  try { const m = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
    customProviders = Object.keys(m.providers || m || {}); } catch {}
  let defaultModel = null;
  try { const s = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")); defaultModel = s.defaultModel || s.model || null; } catch {}
  return { agentDir, files, customProviders, defaultModel,
    projectSettings: await exists(join(cwd, ".pi", "settings.json")),
    note: "~/.pi/agent is shared by Pi (TS) and pi-rs (Rust) — sessions/settings/models are format-identical" };
}

export async function scanAll(cwd, opts) {
  const { discoverMCP } = await import("./mcp.mjs");
  const { discoverPlugins } = await import("./plugins.mjs");
  const [skills, context, agents, commands, mcp, plugins, pi] = await Promise.all([
    discoverSkills(cwd, opts), discoverContext(cwd), discoverAgents(cwd), discoverCommands(cwd), discoverMCP(cwd), discoverPlugins(cwd), discoverPi(cwd)]);
  return { cwd, skills, context: context.map(c => ({ file: c.file, chars: c.text.length })), contextParts: context, agents, commands, mcp, plugins, pi,
    summary: `${skills.length} skills · ${mcp.length} MCP servers · ${plugins.length} plugins · ${agents.length} agents · ${commands.length} commands · ${context.length} context files` };
}
// Build the system-prompt appendix: context files + skill INDEX only (bodies on demand).
export function contextAppendix(scan) {
  const ctx = scan.contextParts.map(c => `## Project instructions (${c.file})\n${c.text}`).join("\n\n");
  const idx = scan.skills.length ? `## Skills available (invoke by name; full instructions load on demand)\n${scan.skills.map(s => `- ${s.name}: ${s.description} [${s.source}]`).join("\n")}` : "";
  return [ctx, idx].filter(Boolean).join("\n\n");
}
