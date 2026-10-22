# The WASM stack — Pi-class harnesses inside a browser tab

Inspired by [victor/MiniCPM5-2B-WebGPU-Pi](https://huggingface.co/spaces/victor/MiniCPM5-2B-WebGPU-Pi),
whose stack is: **Pi agent (TS) + Transformers.js (ONNX Runtime → WebGPU) +
just-bash (browser shell) + on-device files**. A generalizes that stack so the
agent core is swappable — including, next, a WASM build of pi-rs:

```
┌─ Agent core (pick one in the node UI) ────────────────────────────────┐
│  JS core (built-in)  │  🧩 WASM core (a-agent.wasm, 2.9 KB, today)    │
│                      │  🦀 pi-rs slot → pi_agent.wasm (upstream port)  │
└──────────────────────┴───────────┬────────────────────────────────────┘
                          host ABI  │ emit · tool · chat(poll/deliver)
┌─ Host = this web app (web/wasm-host.js) ──────────────────────────────┐
│  VFS + browser shell tools · progress events · inference routing      │
└───────────┬──────────────────────────────────────┬────────────────────┘
   Transformers.js → ONNX Runtime → WebGPU/WASM    │  VPS relay /api/chat
        (A-Quant A-WEB ONNX builds, /models/…)     │  (any API model)
```

Why WASM at all if JS works? The same reasons jcode/pi-rs exist: a native
core is smaller, faster to start, identical on every device, and — decisive
for us — **it's how the real Pi harness (pi-rs) can run in a tab with no
Node**: Rust compiles to wasm32; TypeScript Pi in a tab needs its code
adapted to browser APIs (what the HF space did by hand for one model).

## Host ABI v1 (`web/wasm-host.js`, implemented + tested)
Cooperative step machine — no Asyncify/JSPI assumptions, works in every engine:
- Imports (module `a`): `emit(ptr,len)`, `tool(np,nl,ap,al,out,cap)->len`
  (browser tools are synchronous; results written to agent scratch).
- Exports the agent must provide: `memory`, `scratch()`, `scratch_cap()`,
  `begin(taskLen)`, `poll()->n` (envelope: `'C'`+prompt = needs chat,
  `'D'`+text = done), `deliver(len)` (completion placed in scratch).
- Chat is text-in/text-out; structured tool calls ride the ```tool fenced-JSON
  protocol (the host converts relay `toolCalls` ↔ text both ways), so local
  WebGPU models and API relays look identical to the core.
The reference core `web/agents/a-agent.ts` (AssemblyScript, byte-level, stub
runtime — `npm run build:wasm`) implements the full loop in 2.9 KB: transcript
management, tool-block extraction with brace/quote-aware arg slicing, step limits.

## pi-rs → WASM: crate-by-crate audit (as of pi-rs 1.3.0)
No wasm target exists upstream today (deps: `tokio=full`, `reqwest+rustls`,
`ring`, `dirs`, `boa_engine`, `parking_lot`). The port, in dependency order:

| Crate | WASM verdict | What's needed |
|---|---|---|
| `pi-agent` (loop) | ✅ **port first** | futures/async-trait are wasm-fine; run on a single-thread executor (`wasm-bindgen-futures`/`tokio` current-thread + wasm timers). Becomes `pi_agent.wasm` against this host ABI. |
| `pi-ai` (providers) | ◐ feasible | `reqwest` with its **wasm fetch backend** (drop rustls/http2/socks features — the browser does TLS); `chrono`→wasmbind clock, `uuid`→JS crypto randomness. Or skip HTTP entirely: a `HostProvider` whose stream calls the host chat import (our relay/local ONNX). Prefer the latter inside A — one inference path per node. |
| `pi-coding-agent` tools/sessions | ◐ needs a platform trait | `std::fs`/`child_process` behind a `Platform` interface: native = real fs/bash; browser = host VFS + just-bash-class shell; sessions/settings in OPFS. Settings/auth formats already shared, so state survives the move. |
| `pi-mcp` | ◐ partial | Streamable-HTTP transport via fetch ✓; stdio transport can't exist (no processes) — feature-gate it. |
| `pi-tui` | ✂ exclude | Headless JSON/RPC mode + host DOM UI instead (exactly how A's node page already renders). A terminal-faithful variant could target xterm.js later. |
| `pi-jsrt` (Boa extensions) | ✂ exclude (inversion!) | In a browser the *host is a JS engine* — run Pi TS extensions in the host and expose their registrations to the WASM core as host tools. Embedding Boa-in-WASM is possible but doubles JS engines; revisit for a standalone (non-A) pi-rs tab build. |
| `pi-codemode` | ✂ defer | Same inversion as jsrt; host Workers can sandbox later. |
| `pi-json`, `pi-telemetry` | ✅ trivial | Pure logic. |

Suggested upstream shape: a `browser` cargo feature gating fs/process/stdio/
tui/jsrt, `wasm32-unknown-unknown` cdylib from a thin `pi-wasm` crate wrapping
`pi-agent` + `pi-ai`(HostProvider), exports matching a small ABI (ours or a
superset with streaming). Size is a non-issue after `wasm-opt` (agent+serde
class code lands in the low-MB; the *model* remains the big download, as the
HF space's 1.84 GB card shows). Threads: none needed — inference is host-side
and async; if a threaded build ever matters it needs COOP/COEP + SAB, which
`a serve` can add per-route.

## Where A stands
- ✅ Stack, ABI, host, reference core, GUI core switcher (JS / WASM / pi-rs slot),
  swarm visibility (`agentCore` in node hello), `/agents/*.wasm` served as
  `application/wasm`, Node + browser share `web/wasm-host.js`, 27 tests incl. e2e loop.
- ⏳ When a `pi_agent.wasm` exists (ours to build with upstream, or theirs),
  the loader needs only its URL — no host changes if it speaks ABI v1.
- ⏭ ABI v1.1 candidates: streaming tokens (`emit` chunk events already allow it),
  async tools via poll-states, JSPI direct-await imports once broadly shipped.
