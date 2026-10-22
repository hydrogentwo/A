# Roadmap

**Done since v0.1** — commander login for the Swarm Console (roles + audit) ·
A-Quant suite v1 (Unsloth-Dynamic recipes, imatrix pipeline, registry → tier assignment) ·
node ONNX quantization pipeline (WEBGPU-ONNX.md) · WASM agent stack + reference WASM core with pi-rs slot (WASM-STACK.md) · pi-rs swarm runtime + `a rpc`/`a run --json`
driver modes + shared ~/.pi/agent reporting (PI-RS.md)

**v0.2 — deeper local inference & merge**
- ~~A-Quant `onnx` export stage~~ **done** (node ONNX pipeline + `/models` serving); KL-divergence eval in-job next

- Build/port **pi_agent.wasm** with upstream pi-rs (browser feature: pi-agent + HostProvider pi-ai, tools behind platform trait) — drops into the existing ABI slot
- WebLLM engine for catalog models without ONNX builds; tok/s self-report → scheduler feedback (re-tier underperformers automatically)
- Broadcast results as real diffs (git worktrees on CLI nodes) with Orca-style annotate → merge-winner commits
- Node capability: shared prefix/KV hints, model warm-up prefetch on policy push

**v0.3 — ecosystem completeness**
- npm/git plugin installer (`a install npm:… git:…`, Pi packages, Octomind tap registry, Claude marketplaces) with trust prompts + lockfile
- Full Zod→JSON-Schema for OpenCode tools; Pi TUI widget surface in web node UI; Codex `config.toml` full parse
- ACP (Agent Client Protocol) server mode so editors (Zed/JetBrains) drive A; delegate-to-external-agent tasks (run Claude Code/Codex/Pi binaries as swarm workers, DeepSeek-style)

**v0.4 — swarm intelligence**
- Pipelines (plan → build → review role chains) + jcode-style same-repo conflict detection across worktrees
- Cost/token budgets per task/node with automatic downshifting; semantic memory via real embeddings, synced brain on VPS
- Ambient/daemon mode (Octomind-style): watch repos, pre-warm nodes, schedule background hygiene tasks

**Later** — native Rust node binary (same wire protocol, ~30 MB), iOS/Android companion (PWA first), E2E-encrypted node storage, multi-VPS federation.
