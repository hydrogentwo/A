# Roadmap

**v0.2 — deeper local inference & merge**
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
