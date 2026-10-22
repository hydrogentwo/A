// Pi-style driver modes for A itself, learned from Pi/pi-rs: an embeddable
// harness needs (1) --mode json event streaming and (2) --mode rpc over
// stdin/stdout, so other tools (Orca-class GUIs, editors, scripts) can drive
// it without a terminal. Wire format (newline-delimited JSON):
//   → {"type":"ping"}                          ← {"type":"pong","id":…}
//   → {"type":"task","id":1,"prompt":"…","cwd":"…","role":"build"}
//   ← {"type":"event","id":1,"kind":"tool|text","text":"…"}   (streamed)
//   ← {"type":"result","id":1,"text":"…","usage":{…},"sessionId":"…"}
//   ← {"type":"error","id":1,"error":"…"}
export function makeRpcHandler(runner) {
  if (typeof runner !== "function") throw new Error("runner required");
  return async function handleRpcLine(line, reply) {
    let req;
    try { req = JSON.parse(String(line)); } catch { return reply({ type: "error", id: null, error: "bad json" }); }
    const id = req.id ?? null;
    if (req.type === "ping" || req.method === "ping") return reply({ type: "pong", id });
    const prompt = req.prompt ?? req.task;
    if (req.type === "task" || typeof prompt === "string") {
      if (!prompt) return reply({ type: "error", id, error: "prompt required" });
      try {
        const r = await runner({ task: prompt, cwd: req.cwd, role: req.role || "build",
          onEvent: (kind, text) => reply({ type: "event", id, kind, text }) });
        return reply({ type: "result", id, text: r.text ?? "", usage: r.usage ?? null, sessionId: r.sessionId ?? null });
      } catch (e) { return reply({ type: "error", id, error: e.message }); }
    }
    return reply({ type: "error", id, error: "unknown request — expected {type:'task',prompt} or {type:'ping'}" });
  };
}
