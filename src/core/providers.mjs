// Model providers. One chat() contract: {model, messages, tools} ->
// {text, toolCalls:[{name,args}], usage}. OpenAI-compatible covers OpenAI,
// DeepSeek, Ollama, vLLM, LM Studio, OpenRouter, Groq… (OpenCode lesson:
// provider freedom). Anthropic native. Demo = deterministic offline model so
// the whole harness is testable/demoable with zero keys. Cluster = ask a
// browser/CLI node in your swarm to run inference (the new bit).

export function demoProvider() {
  // Deterministic scripted model: follows simple natural instructions so the
  // loop, tools, swarm and UI all work offline. Honest demo, not an LLM.
  return { id: "demo", async chat({ messages, tools = [] }) {
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";
    const toolResults = messages.filter(m => m.role === "tool").length;
    const has = n => tools.some(t => t.function?.name === n);
    const txt = String(lastUser);
    // Text-protocol agents (e.g. the WASM core) pack history into one prompt:
    // a "tool result:" line means the requested action already happened.
    if (toolResults === 0 && txt.includes("tool result:")) {
      const seg = txt.split("tool result:").pop().split("\n")[0].trim();
      return { text: `Done. Tool result: ${seg.slice(0, 200)}`, toolCalls: [], usage: usage(messages, seg) };
    }
    if (toolResults === 0) {
      let m;
      if (has("write") && (m = txt.match(/create\s+(\S+)\s+(?:saying|with(?: content)?)[:\s]+([^\n]+)/is)))
        return { text: "", toolCalls: [{ name: "write", args: { path: m[1], content: m[2].trim() } }], usage: usage(messages, txt) };
      if (has("bash") && (m = txt.match(/run[:\s]+(.+)/is)))
        return { text: "", toolCalls: [{ name: "bash", args: { command: m[1].trim() } }], usage: usage(messages, txt) };
      if (has("read") && (m = txt.match(/read\s+(\S+)/i)))
        return { text: "", toolCalls: [{ name: "read", args: { path: m[1] } }], usage: usage(messages, txt) };
      if (has("write")) // generic task: leave a trace file so results are visible end-to-end
        return { text: "", toolCalls: [{ name: "write", args: { path: "a-output.md", content: `# Task\n\n${txt}\n\nDone by A (demo provider). Configure a real model: A_PROVIDER=openai A_API_KEY=… A_MODEL=…\n` } }], usage: usage(messages, txt) };
    }
    if (toolResults >= 1) {
      const res = [...messages].reverse().find(m => m.role === "tool")?.content || "";
      return { text: `Done. Tool result: ${String(res).slice(0, 400)}`, toolCalls: [], usage: usage(messages, res) };
    }
    return { text: `(demo provider) You said: ${txt.slice(0, 200)}. Set A_PROVIDER/A_MODEL/A_API_KEY for a real model, or join a cluster node.`, toolCalls: [], usage: usage(messages, txt) };
  }};
  function usage(msgs, out) { const t = s => Math.ceil(String(s).length / 4); return { inputTokens: msgs.reduce((a, m) => a + t(m.content || ""), 0), outputTokens: t(out) }; }
}

export function openAICompatible({ baseURL = "https://api.openai.com/v1", apiKey = "", model = "gpt-4o-mini", id = "openai" } = {}) {
  return { id, model, async chat({ messages, tools, signal }) {
    const r = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, { method: "POST", signal,
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages: toOpenAI(messages), tools: tools?.length ? tools : undefined }) });
    if (!r.ok) throw new Error(`${id} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json(), msg = j.choices?.[0]?.message || {};
    return { text: msg.content || "", usage: { inputTokens: j.usage?.prompt_tokens || 0, outputTokens: j.usage?.completion_tokens || 0 },
      toolCalls: (msg.tool_calls || []).map(c => ({ name: c.function.name, args: safeJSON(c.function.arguments) })) };
  }};
}
function toOpenAI(messages) { // internal msgs already carry toolCalls/tool results; normalize
  return messages.map(m => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.id || "call", content: String(m.content) };
    if (m.toolCalls?.length) return { role: "assistant", content: m.content || null, tool_calls: m.toolCalls.map((c, i) => ({ id: c.id || `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
    return { role: m.role, content: m.content };
  });
}
const safeJSON = s => { try { return JSON.parse(s || "{}"); } catch { return { _raw: s }; } };

export function anthropic({ apiKey, model = "claude-sonnet-5" } = {}) {
  return { id: "anthropic", model, async chat({ messages, tools, system, signal }) {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal,
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 8192, system,
        messages: messages.filter(m => m.role !== "system").map(m => m.role === "tool"
          ? { role: "user", content: [{ type: "tool_result", tool_use_id: m.id || "call", content: String(m.content) }] }
          : m.toolCalls?.length ? { role: "assistant", content: [...(m.content ? [{ type: "text", text: m.content }] : []), ...m.toolCalls.map((c, i) => ({ type: "tool_use", id: c.id || `call_${i}`, name: c.name, input: c.args }))] }
          : { role: m.role, content: m.content }),
        tools: tools?.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) }) });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    return { text: j.content?.filter(b => b.type === "text").map(b => b.text).join("") || "",
      toolCalls: (j.content || []).filter(b => b.type === "tool_use").map(b => ({ name: b.name, args: b.input, id: b.id })),
      usage: { inputTokens: j.usage?.input_tokens || 0, outputTokens: j.usage?.output_tokens || 0 } };
  }};
}

const PRESETS = { openai: {}, deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  ollama: { baseURL: "http://127.0.0.1:11434/v1", model: "llama3.1" }, openrouter: { baseURL: "https://openrouter.ai/api/v1" },
  groq: { baseURL: "https://api.groq.com/openai/v1" }, lmstudio: { baseURL: "http://127.0.0.1:1234/v1" } };
export function providerFromEnv(env = process.env) {
  const id = (env.A_PROVIDER || "demo").toLowerCase();
  if (id === "demo") return demoProvider();
  if (id === "anthropic") return anthropic({ apiKey: env.A_API_KEY || env.ANTHROPIC_API_KEY, model: env.A_MODEL });
  const p = PRESETS[id] || {};
  return openAICompatible({ id, baseURL: env.A_BASE_URL || p.baseURL, apiKey: env.A_API_KEY || env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY, model: env.A_MODEL || p.model });
}
