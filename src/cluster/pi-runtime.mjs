// pi / pi-rs runtime adapter — run swarm tasks on the `pi` binary instead of
// A's built-in agent. pi-rs (github.com/lassejlv/pi-rs) is a Rust port of Pi
// with the SAME CLI, on-disk formats (~/.pi/agent) and RPC/JSON protocols as
// TypeScript Pi, in a single native binary with TypeScript extensions on an
// embedded Boa JS engine (no Node at runtime). Because both implementations
// are protocol-identical, one adapter drives either — A doesn't care which
// `pi` is on PATH. This is also our native-node bridge: a swarm worker with a
// jcode-class footprint, today, without porting A's core.
import { spawn, execFileSync } from "node:child_process";

export const PI_INSTALL_HINT = `pi binary not found. Install either implementation (same interface):
  pi-rs (Rust, single binary):  git clone https://github.com/lassejlv/pi-rs && cd pi-rs && cargo install --path crates/pi-coding-agent
  Pi (TypeScript):              npm install -g @earendil-works/pi-coding-agent
Or point A_PI_BIN at an existing binary.`;

function which(bin) { try { return execFileSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" }).trim() || null; } catch { return null; } }
function versionOf(bin) { try { return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim().split("\n")[0]; } catch { return ""; } }

export function detectPi(bin = process.env.A_PI_BIN || "pi") {
  const path = which(bin);
  if (!path) return { found: false, bin };
  return { found: true, bin, path, version: versionOf(bin),
    flavor: "pi (TypeScript or pi-rs — protocol-identical; formats under ~/.pi/agent are shared)" };
}

// Other external agent CLIs an Orca-style fleet may already have installed.
// A can delegate to pi today; the rest are detected for display/roadmap.
export function detectRuntimes() {
  return [["pi", "Pi / pi-rs (delegable today)"], ["claude", "Claude Code"], ["codex", "Codex CLI"],
    ["opencode", "OpenCode"], ["gemini", "Gemini CLI"], ["goose", "Goose"], ["aider", "Aider"]]
    .map(([bin, label]) => ({ bin, label, found: !!which(bin), version: which(bin) ? versionOf(bin) : "" }));
}

// Best-effort extraction of human-meaningful progress from a Pi JSON event.
// Tolerant across event-shape revisions: unknown shapes return null.
export function piEventText(ev) {
  if (!ev || typeof ev !== "object") return null;
  const contentText = c => Array.isArray(c) ? c.filter(p => p?.type === "text" && p.text).map(p => p.text).join("") : typeof c === "string" ? c : "";
  if (typeof ev.toolName === "string" && /tool/.test(ev.type || "")) return `⚙ pi tool: ${ev.toolName}`;
  const fromMsg = contentText(ev.message?.content);
  if (fromMsg && /message_end|agent_end|turn_end/.test(ev.type || "")) return fromMsg;
  if (typeof ev.delta === "string") return ev.delta;
  if (typeof ev.text === "string" && ev.text.trim()) return ev.text;
  if (fromMsg) return fromMsg;
  return null;
}

// Run one task on pi in print+JSON mode inside `cwd` (its own tools/sessions
// apply — including Pi extensions, now also under pi-rs's embedded JS engine).
export function runPiTask({ bin = process.env.A_PI_BIN || "pi", cwd = process.cwd(), prompt, model,
                            onEvent = () => {}, timeoutMs = 600_000 } = {}) {
  if (!prompt) return Promise.reject(new Error("prompt required"));
  return new Promise((resolve, reject) => {
    const extra = (process.env.A_PI_ARGS || "").split(" ").filter(Boolean);
    const args = ["-p", "--mode", "json", ...extra, ...(model ? ["--model", model] : []), prompt];
    let child;
    try { child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return reject(new Error(`${e.message}\n${PI_INSTALL_HINT}`)); }
    let raw = "", err = "", buf = "", finalText = "", sawJSON = false, settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; try { child.kill("SIGKILL"); } catch {} reject(new Error(`pi timed out after ${timeoutMs}ms`)); } }, timeoutMs);
    child.stdout.on("data", d => {
      raw += d; buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { const ev = JSON.parse(line); sawJSON = true; const t = piEventText(ev);
          if (t) { if (!t.startsWith("⚙")) finalText = t; onEvent("progress", t); } }
        catch { onEvent("progress", line); }
      }
    });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { if (settled) return; settled = true; clearTimeout(timer);
      reject(new Error(e.code === "ENOENT" ? PI_INSTALL_HINT : e.message)); });
    child.on("close", code => { if (settled) return; settled = true; clearTimeout(timer);
      if (code === 0) resolve({ text: (finalText || (sawJSON ? "" : raw) || raw).trim(), raw });
      else reject(new Error(`pi exited ${code}: ${(err || raw).slice(-600)}`)); });
  });
}
