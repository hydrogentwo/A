# ⬢ A — the one harness

**A combines the best of Pi, Octomind, jcode, OpenCode and DeepSeek Harness into a single CLI
harness + browser cluster — and runs the skills / MCP servers / plugins of all of them
(plus Claude Code, Codex, Gemini CLI and Cursor) unmodified.**

Open A's URL on any computer or phone: it **auto-probes the device, senses the largest
model it can run, auto-assigns the operator-specified model for that capacity tier, and
joins the swarm** — coordinated by a VPS that holds all long-term storage. An
Orca-inspired Swarm Console gives the operator maximal control over the fleet.

| Ancestor | What A took |
|---|---|
| **Pi** | 4-tool minimal core (`read/write/edit/bash`), <1k-token system prompt, TS extensions, skills with progressive disclosure, tree sessions |
| **Octomind** | Cache-aware compaction, guardrails-as-code, MCP-native lazy loading, taps, token efficiency |
| **jcode** | Capability-aware **swarm** (many agents, conflict-isolated workspaces), persistent semantic memory, low footprint |
| **OpenCode** | Provider freedom (any OpenAI-compatible + Anthropic + local), client/server split, Plan/Build roles, `AGENTS.md` `/init` |
| **DeepSeek Harness** | Everything-is-a-plugin kernel, append-only event log (model-visible ⇒ logged; resume/fork/replay), sandbox policy, headless operation |
| **MiniCPM5-2B-WebGPU-Pi** (HF) | The browser node UX: in-browser agent + bash, "saved on this device", model download card |
| **Orca** | The over-arching GUI: fleet sidebar, parallel agent panes, fan-out → compare → merge winner, mobile steering |

## Quick start

```bash
npm install
node bin/a.mjs serve               # VPS coordinator → http://localhost:8787
```
Open the URL anywhere → **This device** tab (Pi-in-browser agent) and **Swarm console**
tab (fleet command). Headless machines: `node bin/a.mjs join ws://YOUR-VPS:8787/ws`.
No spare computers? Simulate a fleet:
```bash
for d in phone chromebook laptop desktop ancient; do
  node bin/a.mjs simnode $d --url ws://127.0.0.1:8787/ws & done
```

CLI agent (works offline with the deterministic `demo` provider):
```bash
node bin/a.mjs run "create hello.txt saying hi from A" --yes
node bin/a.mjs compat scan .       # what A found from every harness in this repo
```
Real models: `A_PROVIDER=deepseek A_API_KEY=… A_MODEL=deepseek-chat a run "…" ` — also
`openai|anthropic|ollama|openrouter|groq|lmstudio` (or any OpenAI-compatible `A_BASE_URL`).

## Auto-sensing maximum model per device
On join, each node probes WebGPU adapter limits, fp16, RAM hint, storage quota, GPU class
and a 150 ms benchmark → a **capacity tier** → the **operator-specified model for that
tier** (editable live in the Swarm Console; `a policy` shows it):

| Tier | Device class | Default model |
|---|---|---|
| T0 Relay | no WebGPU | VPS/cloud relay model |
| T1 Nano | phones, weak iGPUs | Qwen3 0.6B |
| T2 Small | most laptops | **MiniCPM5 2B** (your reference) |
| T3 Medium | good iGPU / entry dGPU | Qwen3 4B |
| T4 Large | solid dGPU / Apple Silicon Pro | Qwen2.5-Coder 7B |
| T5 XL | high-end dGPU | Qwen3.5 9B (browser ceiling) + optional cloud-assist |

Local inference uses Transformers.js/WebGPU when you click **Load model** (weights cache
on the device); until then — and always for T0 — the **VPS relay** runs inference while
tools still execute locally in the browser workspace.

## Compatibility (zero config — just open your existing repo)
`a compat scan` proves it on `examples/demo/` (a fixture with one of everything):
SKILL.md skills (`.a/.agents/.claude/.pi/.opencode/.codex/.gemini` + Octomind taps),
MCP configs (`.mcp.json`, `opencode.json`, `.cursor/`, `.vscode/`, `.pi/`, Gemini settings,
Codex `config.toml`) normalized into one registry with a real stdio/HTTP MCP client,
**Pi `.ts` extensions and OpenCode plugins executed unmodified** via API shims, Claude
plugins + hooks, agents, slash-commands/prompt-templates, and context files
(`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Cursor rules…). Full matrix: [COMPAT.md](COMPAT.md).

## Deploy the VPS
```bash
A_CLUSTER_TOKEN=$(openssl rand -hex 16) PORT=8787 docker compose -f deploy/docker-compose.yml up -d
```
Behind Caddy for TLS (`deploy/Caddyfile`): `https://a.example.com/?token=…` is your join
link; `/swarm` is the console. All state lives in one data dir (append-only event log,
sessions, artifacts, policy). Details: [deploy/](deploy/) + [ARCHITECTURE.md](ARCHITECTURE.md).

## Commander login (Swarm Console)
The commanding `/swarm` GUI is gated by accounts that live only on your VPS
(scrypt-hashed passwords, hashed sessions, audit-logged). Roles: **admin** (+
manage users) · **operator** (command the fleet) · **viewer** (watch only).
First run: create the first commander in the `/swarm` setup screen — or, better
on a public VPS, bootstrap with `A_ADMIN_USER`/`A_ADMIN_PASSWORD` (see
`deploy/.env.example`), which closes setup entirely. Worker nodes never need
accounts; they still join with the cluster token. Scripts use `a login --url …`
or the cluster token.

## Quant Studio 🦥 (built on Unsloth's Dynamic quants)
`a quant recipes|plan|run` and Swarm Console → **Quant Studio**: turn any HF
model (or your Unsloth fine-tune) into per-tier Dynamic GGUFs — BF16 convert →
imatrix calibration on chat/code data → per-tensor dynamic quantization
(protect embeddings/down-proj/router, crush bulk experts) → perplexity
validation → auto-registered into the catalog, ready to assign per capacity
tier. Full detail + credits: [QUANT.md](QUANT.md).

## Security model
Cluster token on every API/WS · guardrails-as-code (`allow|ask|deny`, secret paths denied
by default) · optional `A_SANDBOX=1` (bubblewrap) on CLI nodes · Pi's honest trust model:
code plugins run with your permissions — audit what you install. Browser nodes are
sandboxed by the browser; their workspace never leaves the device unless a task returns it.

`npm test` · `node bin/a.mjs help` · [ROADMAP.md](ROADMAP.md) (WebLLM, worktree merge,
ACP, native Rust node…). MIT.
