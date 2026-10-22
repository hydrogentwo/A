# Architecture

```
                        ┌─────────────────────────────────────────────┐
   any computer/phone   │  VPS  `a serve`                             │
  ───────────────────►  │  · HTTP: web app + REST (/api/*)            │
   browser = node       │  · WS hub: nodes ⇄ scheduler ⇄ consoles     │
   probes GPU → tier    │  · LONG-TERM STORAGE (A_DATA):              │
   gets policy model    │      events.jsonl  (append-only truth)      │
   local WebGPU model   │      sessions/  artifacts/  policy.json     │
   or VPS relay         │  · Relay provider for T0 / pre-download     │
                        └───────▲──────────────▲────────────────────┘
                  `a join` (CLI node)     Swarm Console (/swarm, same page)
                  real shell + worktree    fleet · fan-out · compare/merge
```

## Three runtimes, one core
- **Core** (`src/core`) — kernel (plugin registry + events), 4 tools + guardrails,
  agent loop (compaction, sessions), TF-IDF memory, providers. Zero-build ESM so any
  cluster machine runs it instantly; one runtime dep (`ws`).
- **Compat** (`src/compat`) — discovery + MCP client + plugin shims. Every harness's
  assets become kernel citizens (tools/commands/agents/hooks/skills-index).
- **Cluster** (`src/cluster`) — isomorphic capacity scoring + catalog/policy + wire
  protocol + scheduler; shared verbatim by browser, CLI and VPS (the VPS serves
  `src/` modules to the browser). Headless node runner for `a join`/`a simnode`.
- **VPS** (`src/vps`) — store (append-only JSONL + files) + coordinator server +
  **commander auth** (scrypt accounts, hashed sessions, viewer/operator/admin;
  gates every commanding API + the console WS while nodes join by cluster token).
- **Quant** (`src/quant`) — Unsloth-Dynamic-style recipes (per-tensor llama.cpp
  overrides + imatrix calibration + PPL validation) and the job/registry engine
  whose outputs merge into the served model catalog per capacity tier.

## Key invariants
1. **Model-visible ⇒ logged** (DeepSeek): every prompt, tool call and result lands in a
   session JSONL locally and in VPS storage → resume/fork/replay anywhere.
2. **Progressive disclosure** (Pi/Octomind): skill bodies, MCP schemas and plugin tools
   load on demand; core system prompt stays <1k tokens.
3. **Capacity before assignment**: a node never gets a model or task beyond its probed
   tier unless the operator explicitly overrides it in the console.
4. **Policy is data, pushed live**: model-per-capacity lives on the VPS (`policy.json`)
   and broadcasts to nodes; per-node pins override tiers.
5. **Command is authenticated, work is not**: anything that moves the fleet needs
   a commander session (or the cluster token for machines); joining as a worker never does.
6. **Tools are equal**: core, MCP, Pi-extension, OpenCode and skill tools share one
   registry and one guardrail/hook pipeline.

## Scheduling
`capability` (best-fit — smallest sufficient node, role-preferred model wins) ·
`fastest` · `round-robin`; plus **broadcast** mode = Orca fan-out: same prompt to N
nodes in isolated workspaces (`.a-cluster-work/<taskId>` on CLI nodes, per-task VFS
namespaces in browsers), compare results in the console, merge the winner's artifact
to VPS storage. Failed tasks retry (configurable) and requeue on node disconnect.

## Failure & safety
Heartbeats (10 s) + offline detection; tasks on dead nodes requeue; guardrails deny
secret paths & catastrophic shells by default and can require approval per rule —
approvals surface in the CLI or as console actions. Cluster token guards REST+WS.
Browser nodes can opt out of swarm tasks and keep all files on-device.

## Why not Rust (yet)?
jcode/Octomind prove a Rust core is lighter; but Pi/OpenCode/Claude plugins are JS/TS —
native execution of the existing ecosystem wins for v0.1. The protocol is
language-agnostic; a Rust node speaking it is the ROADMAP's first stretch goal.
