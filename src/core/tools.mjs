// Pi's lesson: the core needs exactly 4 tools — read, write, edit, bash.
// Everything else arrives via skills/MCP/plugins (loaded lazily, Octomind-style,
// so the system prompt stays <1k tokens). Tools run through guardrails
// (allow/ask/deny) and an optional OS sandbox on CLI nodes (DeepSeek lesson:
// bwrap on Linux when available + A_SANDBOX=1).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { execFile } from "node:child_process";

export function coreTools({ cwd = process.cwd(), guardrails, sandbox = false } = {}) {
  const inside = p => { const abs = resolve(cwd, p); return { abs, rel: relative(cwd, abs) }; };
  async function guard(action, detail) {
    if (!guardrails) return true;
    const v = await guardrails.check(action, detail);
    if (v.decision === "deny") throw new Error(`guardrail deny: ${v.reason || action}`);
    if (v.decision === "ask" && !v.approved) throw new Error(`needs approval (policy=ask): ${action} ${detail}`);
    return true;
  }
  const S = t => ({ type: "object", properties: t, required: Object.keys(t) });
  return [
    { name: "read", description: "Read a text file (relative to workspace).", parameters: S({ path: { type: "string" } }),
      async execute({ path }) { await guard("read", path); const { abs } = inside(path); return (await readFile(abs, "utf8")).slice(0, 100_000); } },
    { name: "write", description: "Create or overwrite a file with full content.", parameters: S({ path: { type: "string" }, content: { type: "string" } }),
      async execute({ path, content }) { await guard("write", path); const { abs } = inside(path); await mkdir(dirname(abs), { recursive: true }); await writeFile(abs, content); return `wrote ${path} (${content.length} bytes)`; } },
    { name: "edit", description: "Replace an exact unique string in a file.", parameters: S({ path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }),
      async execute({ path, oldText, newText }) { await guard("edit", path); const { abs } = inside(path); const s = await readFile(abs, "utf8");
        const n = s.split(oldText).length - 1; if (n !== 1) throw new Error(`oldText occurs ${n} times in ${path} (need exactly 1)`);
        await writeFile(abs, s.replace(oldText, newText)); return `edited ${path}`; } },
    { name: "bash", description: "Run a shell command in the workspace (timeout 120s).", parameters: S({ command: { type: "string" } }),
      async execute({ command }) { await guard("bash", command);
        const cmd = sandbox ? ["bwrap", ["--ro-bind", "/", "/", "--bind", cwd, cwd, "--dev", "/dev", "--proc", "/proc", "bash", "-lc", command]]
                            : ["bash", ["-lc", command]];
        return await new Promise((res) => execFile(cmd[0], cmd[1], { cwd, timeout: 120_000, maxBuffer: 4 << 20 },
          (e, out, err) => res(`exit ${e?.code ?? 0}\n${out}${err ? "\nSTDERR:\n" + err : ""}`.slice(0, 50_000)))); } },
  ];
}

// Guardrails-as-code (Octomind): a plain JS/JSON policy evaluated per tool call.
// decision: allow | ask | deny. `ask` resolves via injected approver (CLI prompt,
// Swarm Console button, or --yes). Deny-list defaults protect secrets/keys.
export class Guardrails {
  constructor({ approver = async () => false, rules = [], mode = "ask" } = {}) { this.approver = approver; this.rules = rules; this.mode = mode; }
  async check(action, detail = "") {
    const d = String(detail);
    if (/(^|\/)\.env|\.pem$|id_rsa|credentials/i.test(d) && action !== "read") return { decision: "deny", reason: "secret path" };
    if (action === "bash" && /\brm\s+-rf\s+\/|\bmkfs\b|dd\s+if=.*of=\/dev/i.test(d)) return { decision: "deny", reason: "catastrophic command" };
    for (const r of this.rules) { // user rules: {action, match(regex string), decision, reason}
      if ((r.action === "*" || r.action === action) && new RegExp(r.match).test(d))
        return r.decision === "ask" ? { decision: "ask", approved: await this.approver({ action, detail, rule: r }) } : r;
    }
    if (action === "read") return { decision: "allow" };
    if (this.mode === "allow" || this.mode === "yolo") return { decision: "allow" };
    if (this.mode === "deny-writes" && action !== "bash") return { decision: "deny", reason: "writes disabled" };
    return { decision: "ask", approved: await this.approver({ action, detail }) };
  }
}
export async function loadGuardrails(cwd, opts = {}) {
  let rules = [];
  for (const f of [".a/guardrails.json", "guardrails.json", ".octo/guardrails.json"]) {
    try { rules = JSON.parse(await readFile(resolve(cwd, f), "utf8")).rules || []; break; } catch {}
  }
  return new Guardrails({ rules, ...opts });
}
