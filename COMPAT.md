# Compatibility matrix

A's native home is `.a/` + `AGENTS.md`. Everything else is **auto-imported** — when
formats conflict, earlier-listed source wins. Verified live on `examples/demo/`
(`node bin/a.mjs compat scan examples/demo --load`).

## Skills — `SKILL.md` with YAML frontmatter (`name`, `description`)
Only the index enters the system prompt; the body loads on invocation (progressive
disclosure, so 200 skills cost ~200 lines, not 200 files).
`.a/skills` · `.agents/skills` (Agent Skills standard) · `.claude/skills` · `.pi/skills` ·
`.opencode/skills` · `.codex/skills` · `.muse/skills` · `.octo/taps` (Octomind) ·
`skills/` · globals under `~/` equivalents incl. `~/.pi/agent/skills`.

## MCP — one registry + real client (stdio JSON-RPC + streamable HTTP)
| Source file | Harness |
|---|---|
| `.a/mcp.json` | A (native) |
| `.mcp.json` | Claude Code / generic |
| `opencode.json → mcp` (`type: local/remote`) | OpenCode |
| `.pi/mcp.json` | Pi ≥1.0 |
| `.cursor/mcp.json` · `.vscode/mcp.json` | Cursor / VS Code |
| `.muse/settings.json → mcpServers` | Gemini CLI |
| `.codex/config.toml → [mcp_servers.*]` | Codex |

Tools register as `mcp__<server>__<tool>`. Loaded with `--mcp` (lazy by design — Pi's
context lesson). `a mcp list|tools|call` for direct access.

## Code plugins — executed unmodified via shims (`src/compat/plugins.mjs`)
- **Pi extensions** `.pi/extensions/*.ts|js` (+ `~/.pi/agent/extensions`): shim provides
  `registerTool/registerCommand/on/getActiveTools…`; Pi events map to kernel events.
  TypeScript loads via Node ≥22 native type-stripping.
- **OpenCode plugins** `.opencode/plugin/*`, `.opencode/tool/*`: factory `({client,$,…})`
  shimmed; `tool{}`, `tool.execute.before/after`, `chat.system.transform` mapped.
  (npm plugins from `opencode.json → plugin[]` are indexed; auto-install is on the roadmap.)
- **Claude Code** `.claude-plugin/plugin.json` (+ its `hooks/hooks.json`) and
  `.claude/settings.json` hooks: `PreToolUse`(exit-2 blocks)/`PostToolUse`/
  `UserPromptSubmit`/`SessionStart`/`Stop` → kernel events. Plugin-bundled skills/agents/
  commands are discovered through their standard dirs.
- **A / DeepSeek-style** `.a/plugins/*.mjs` → `kernel.use(plugin)` (everything-is-a-plugin).
- **Octomind taps** `.octo/taps` → surfaced as skills. **Gemini extensions**
  `gemini-extension.json` → context + MCP indexed.

## Agents / commands / prompts (Markdown + frontmatter)
Agents: `.a/agents` `.claude/agents` `.opencode/agent` `.codex/agents`
Commands/templates: `.a/commands` `.claude/commands` `.opencode/command` `.pi/prompts`

## Context files (merged into system prompt, first found wins per name)
`AGENTS.md` · `CLAUDE.md` · `GEMINI.md` · `.a/AGENTS.md` · `OCTO.md` · `CONVENTIONS.md` ·
`.muserules` · `.cursor/rules/*.mdc`

## Kernel events every adapter shares
`session:start/end · turn:before/after · tool:before/after/denied · context:build/compact ·
model:request/response` — any handler may mutate context or veto a tool call (`block`),
which is how Pi extensions, OpenCode hooks, Claude shell hooks and guardrails compose.

## Known limits (v0.1, see ROADMAP)
Zod-typed OpenCode tool args degrade to loose string schemas; Pi TUI-widget APIs are
no-ops in CLI mode; Codex TOML parse is targeted to `mcp_servers`; no marketplace installer yet.
