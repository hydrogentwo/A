// The agent loop. Pi-minimal system prompt (<1k tokens), Octomind cache-aware
// compaction, DeepSeek append-only event log (model-visible ⇒ logged),
// OpenCode Plan/Build roles, jcode-style persistent memory injection.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const BASE_SYSTEM = `You are A, a coding agent. Tools: read, write, edit, bash (+ any listed).
Work in small verifiable steps. Prefer editing over rewriting. Run tests after changes.
Never invent file contents — read first. State assumptions. When done, summarize briefly: what changed, how verified.`;

export class Session {
  constructor({ cwd, id = randomUUID().slice(0, 8), parent = null } = {}) {
    this.cwd = cwd; this.id = id; this.parent = parent; this.messages = []; this.usage = { inputTokens: 0, outputTokens: 0 };
    this.dir = join(cwd, ".a", "sessions"); this.file = join(this.dir, `${id}.jsonl`);
  }
  async log(type, data) { // append-only event log (DeepSeek invariant: replayable/forkable)
    await mkdir(this.dir, { recursive: true }).catch(() => {});
    await appendFile(this.file, JSON.stringify({ t: new Date().toISOString(), type, ...data }) + "\n").catch(() => {});
  }
  fork() { const s = new Session({ cwd: this.cwd, parent: this.id }); s.messages = [...this.messages]; return s; } // Pi tree sessions
}

// Cache-aware compaction (Octomind): keep system + last N turns intact (preserves
// provider prompt-cache prefix), summarize the middle deterministically when no
// model summary is available.
export function compact(messages, { keepLast = 8, maxChars = 60_000 } = {}) {
  const total = messages.reduce((a, m) => a + String(m.content || "").length, 0);
  if (total <= maxChars || messages.length <= keepLast + 2) return messages;
  const head = messages.filter(m => m.role === "system");
  const rest = messages.filter(m => m.role !== "system");
  const mid = rest.slice(0, -keepLast), tail = rest.slice(-keepLast);
  const digest = mid.map(m => `${m.role}: ${String(m.content || m.toolCalls?.map(c => c.name).join(",") || "").slice(0, 160)}`).join("\n").slice(0, 4000);
  return [...head, { role: "user", content: `[compacted ${mid.length} earlier messages]\n${digest}` }, ...tail];
}

export async function runAgent({ kernel, provider, session, task, systemExtra = "", memory = null,
                                 maxSteps = 25, role = "build", onEvent = () => {}, toolAllowlist = null }) {
  const emit = async (ev, ctx) => { onEvent(ev, ctx); return kernel.emit(ev, ctx); };
  await emit("session:start", { session, task, role });
  await session.log("task", { task, role, provider: provider.id });
  const memHits = memory ? await memory.recall(task, 3).catch(() => []) : [];
  if (!session.messages.length) session.messages.push({ role: "system", content:
    [BASE_SYSTEM, systemExtra, memHits.length ? `Relevant memory:\n${memHits.map(h => "- " + h.text).join("\n")}` : ""].filter(Boolean).join("\n\n") });
  session.messages.push({ role: "user", content: task });
  await session.log("user", { content: task });

  let finalText = "";
  for (let step = 0; step < maxSteps; step++) {
    session.messages = compact(session.messages);
    await emit("turn:before", { session, step });
    const tools = toolAllowlist ? kernel.toolSchemas(toolAllowlist) : kernel.toolSchemas();
    const sys = session.messages.find(m => m.role === "system")?.content;
    const res = await provider.chat({ messages: session.messages, tools, system: sys, model: provider.model });
    session.usage.inputTokens += res.usage?.inputTokens || 0; session.usage.outputTokens += res.usage?.outputTokens || 0;
    await emit("model:response", { session, res });
    const asst = { role: "assistant", content: res.text || "", toolCalls: res.toolCalls || [] };
    session.messages.push(asst); await session.log("assistant", { content: asst.content, toolCalls: asst.toolCalls.map(c => c.name), usage: res.usage });
    if (asst.content) { finalText = asst.content; onEvent("text", { text: asst.content }); }
    if (!asst.toolCalls.length) break;
    for (const call of asst.toolCalls) {
      const tool = kernel.tools.get(call.name);
      const ctx = await emit("tool:before", { session, call });
      let out;
      if (ctx.blocked) { out = `blocked: ${ctx.blockReason}`; await emit("tool:denied", { session, call }); }
      else if (!tool) out = `unknown tool: ${call.name}`;
      else { try { out = await tool.execute(call.args || {}, { session, kernel }); } catch (e) { out = `error: ${e.message}`; } }
      out = String(out); onEvent("tool", { name: call.name, args: call.args, result: out.slice(0, 500) });
      await emit("tool:after", { session, call, result: out });
      session.messages.push({ role: "tool", id: call.id, content: out });
      await session.log("tool", { name: call.name, args: call.args, result: out.slice(0, 2000) });
    }
    await emit("turn:after", { session, step });
  }
  if (memory && finalText) await memory.remember(`Task: ${task}\nResult: ${finalText.slice(0, 500)}`, { session: session.id }).catch(() => {});
  await session.log("done", { usage: session.usage }); await emit("session:end", { session });
  return { text: finalText, usage: session.usage, sessionId: session.id };
}
