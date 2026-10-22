// WASM agent host bridge — the "operating system" a WASM agent core runs on.
// Mirrors the HF MiniCPM-Pi space layering, with our agent core swappable:
//
//   WASM agent core (a-agent.wasm today · pi_agent.wasm when pi-rs ships wasm)
//        │  host ABI: emit · tool · (chat via poll/deliver state machine)
//   this host (JS): VFS+shell tools · inference routing · progress events
//        │
//   Transformers.js → ONNX Runtime → WebGPU/WASM · or VPS relay /api/chat
//
// Pure JS, no DOM: the browser app AND node:test drive it identically.
const enc = new TextEncoder(), dec = new TextDecoder();

// tools: [{name, execute(args)->string (SYNC — browser VFS tools are sync)}]
// chatText: async (prompt:string) -> completion string (text protocol in/out)
// onEvent: (kind:"text"|"tool"|"log", text) -> void
export async function runWasmAgent(wasmBytes, task, { tools = [], chatText, onEvent = () => {}, maxRounds = 25 } = {}) {
  if (typeof chatText !== "function") throw new Error("chatText required");
  const holder = { mem: null };
  const bytes = () => new Uint8Array(holder.mem.buffer); // re-read: memory may grow/detach
  const readStr = (ptr, len) => dec.decode(bytes().subarray(ptr, ptr + len));
  const writeScratch = (instance, str) => {
    const data = enc.encode(str);
    const at = Number(instance.exports.scratch()), cap = Number(instance.exports.scratch_cap());
    if (data.length > cap) throw new Error(`wasm scratch overflow (${data.length} > ${cap})`);
    bytes().set(data, at); return data.length;
  };
  const imports = {
    env: { // AssemblyScript runtime hooks (reference core); a Rust core would use its own/no env
      abort: () => { throw new Error("wasm agent aborted"); },
      seed: () => Date.now(),
    },
    a: {
    emit: (ptr, len) => onEvent("log", readStr(Number(ptr), Number(len))),
    tool: (np, nl, ap, al, out, cap) => {
      const name = readStr(Number(np), Number(nl));
      let result;
      try {
        const args = JSON.parse(readStr(Number(ap), Number(al)) || "{}");
        const t = tools.find(x => x.name === name);
        if (!t) result = `error: unknown tool ${name}`;
        else {
          const r = t.execute(args);
          result = (r && typeof r.then === "function") ? "error: async tools unsupported in WASM ABI v0" : String(r ?? "");
        }
        onEvent("tool", `⚙ ${name} → ${result.slice(0, 200)}`);
      } catch (e) { result = `error: ${e.message}`; }
      const data = enc.encode(result.slice(0, Number(cap)));
      bytes().set(data, Number(out)); return data.length;
    },
  } };
  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  holder.mem = instance.exports.memory;
  const ex = instance.exports;
  for (const fn of ["scratch", "scratch_cap", "begin", "poll", "deliver"])
    if (typeof ex[fn] !== "function") throw new Error(`wasm agent missing export: ${fn} (ABI mismatch — see WASM-STACK.md)`);

  ex.begin(writeScratch(instance, task));
  for (let round = 0; round < maxRounds; round++) {
    const n = Number(ex.poll());
    const env = bytes().subarray(Number(ex.scratch()), Number(ex.scratch()) + n);
    const code = String.fromCharCode(env[0]);
    const payload = dec.decode(env.subarray(1));
    if (code === "D") { if (payload.trim()) onEvent("text", payload); return { text: payload }; }
    if (code !== "C") throw new Error(`wasm agent protocol error (code ${code})`);
    const completion = await chatText(payload);
    ex.deliver(writeScratch(instance, String(completion)));
  }
  throw new Error("wasm agent exceeded host round limit");
}

// Chat adapters: make any message-based chat (relay) look like text-in/text-out,
// converting structured toolCalls back into the text tool protocol.
export function toolCallsToText(res) {
  const parts = [];
  if (res?.text) parts.push(res.text);
  for (const c of res?.toolCalls || []) parts.push("```tool\n" + JSON.stringify({ name: c.name, args: c.args || {} }) + "\n```");
  return parts.join("\n");
}
