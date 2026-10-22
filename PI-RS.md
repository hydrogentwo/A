# pi-rs integration

[pi-rs](https://github.com/lassejlv/pi-rs) is a Rust port of Pi: a single
native `pi` binary with the **same CLI, TUI, on-disk formats** (session JSONL,
`settings.json`, `auth.json`, `models.json` under `~/.pi/agent`), **RPC
protocol and extension API** as TypeScript Pi — with TS extensions running on
an embedded Boa JavaScript engine (oxc TypeScript stripping, Node API shims),
so no Node/Bun is needed at runtime. It makes A better in four concrete ways:

## 1. pi-rs as a first-class swarm runtime (works today)
Any machine with `pi` on PATH can join the fleet and execute swarm tasks with
Pi itself (its tools, extensions, providers and OAuth logins — unchanged):

```bash
# install pi-rs (or TypeScript Pi — the adapter speaks to both identically)
git clone https://github.com/lassejlv/pi-rs && cd pi-rs && cargo install --path crates/pi-coding-agent

a pi-rs                    # detect binary + ~/.pi/agent state
a pi-rs run "fix the tests"   # one-off delegated task, streamed
a join ws://YOUR-VPS:8787/ws --runtime pi-rs    # join the swarm as a pi-rs node
```

Tasks run via Pi's print/JSON mode (`pi -p --mode json`) in an isolated task
workspace; events stream into the Swarm Console like any other node's.
`A_PI_BIN`/`A_PI_ARGS` override the binary/extra args. Because pi-rs is one
statically-linked binary with a jcode-class footprint, a pi-rs node is the
lightest worker you can put in the fleet today — this is A's native-node
bridge without porting A's core.

## 2. A learned Pi's driver modes (works today)
Pi/pi-rs are embeddable because of their **JSON event mode** and **RPC mode**;
A now speaks both patterns too, so Orca-class GUIs and scripts can drive `a`
exactly like they drive `pi`:

```bash
a run "task" --json        # NDJSON events: start/tool/text/result
printf '{"type":"task","id":1,"prompt":"build it"}\n' | a rpc --yes
```

## 3. Shared state, respected (works today)
`a compat scan` and `a pi-rs` report the shared `~/.pi/agent` directory
(settings/models presence, custom providers from `models.json`, default model)
— never reading secrets (`auth.json` is detected, not opened). Switching a
machine between Pi, pi-rs and A is lossless because all three read the same dirs.

## 4. The native-node roadmap got a blueprint
pi-rs's `pi-jsrt` (Boa + oxc + Node shims) proves the hard part of a Rust A
node: running the existing JS/TS plugin ecosystem without Node. Our roadmap
native node follows that architecture against A's own wire protocol
(`src/cluster/protocol.mjs`) instead of reinventing it.

## Honest notes
- Event parsing is deliberately tolerant across Pi protocol revisions
  (unknown shapes are ignored; final text falls back to raw output).
- On a pi-rs node, **Pi's own** auth/providers/guardrails govern execution;
  A's guardrails apply to A's built-in runtime. Give pi nodes the least
  privilege they'd have standalone.
- Verified here with a protocol-faithful fake `pi` (this sandbox has no Rust
  toolchain crates access); run `a pi-rs` on a machine with the real binary
  to confirm versions, then `a join --runtime pi-rs`.
