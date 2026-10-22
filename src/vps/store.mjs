// VPS long-term storage: append-only JSONL event log + plain files.
// The DeepSeek invariant: everything model-visible is logged, so any session
// can be resumed, forked (Pi tree) and replayed. Layout under A_DATA dir:
//   events.jsonl            — cluster/swarm event log (the source of truth)
//   sessions/<id>.jsonl     — per-agent transcripts pushed from nodes/CLI
//   artifacts/<taskId>/…    — files agents produced (diffs, outputs)
//   policy.json             — model-per-capacity policy (Swarm Console edits this)
//   nodes.json              — last-known node registry
import { appendFile, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_POLICY } from "../cluster/catalog.mjs";

export class Store {
  constructor(dir = process.env.A_DATA || join(process.cwd(), ".a-data")) { this.dir = dir; }
  async init() {
    await mkdir(join(this.dir, "sessions"), { recursive: true });
    await mkdir(join(this.dir, "artifacts"), { recursive: true });
    this.policy = await this.readJSON("policy.json", structuredClone(DEFAULT_POLICY));
    return this;
  }
  async readJSON(name, fallback) { try { return JSON.parse(await readFile(join(this.dir, name), "utf8")); } catch { return fallback; } }
  async writeJSON(name, val) { await mkdir(this.dir, { recursive: true }); await writeFile(join(this.dir, name), JSON.stringify(val, null, 2)); }
  async event(type, data = {}) { const e = { t: new Date().toISOString(), type, ...data };
    await appendFile(join(this.dir, "events.jsonl"), JSON.stringify(e) + "\n").catch(() => {}); return e; }
  async events(limit = 200) { try { const l = (await readFile(join(this.dir, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
    return l.slice(-limit).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean); } catch { return []; } }
  async savePolicy(p) { this.policy = { ...this.policy, ...p, version: (this.policy.version || 1) + 1 }; await this.writeJSON("policy.json", this.policy); return this.policy; }
  async putArtifact(taskId, name, content) { const d = join(this.dir, "artifacts", taskId); await mkdir(d, { recursive: true });
    await writeFile(join(d, name.replace(/[^\w.\/-]/g, "_")), content); }
  async listSessions() { try { return (await readdir(join(this.dir, "sessions"))).filter(f => f.endsWith(".jsonl")); } catch { return []; } }
  async appendSession(id, line) { await appendFile(join(this.dir, "sessions", `${id}.jsonl`), line + "\n").catch(() => {}); }
  async stats() { const ev = await this.events(5000);
    return { events: ev.length, tasksDone: ev.filter(e => e.type === "task:done").length,
             tasksFailed: ev.filter(e => e.type === "task:failed").length, sessions: (await this.listSessions()).length }; }
}
