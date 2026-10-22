import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runWasmAgent, toolCallsToText } from "../web/wasm-host.js";
import { demoProvider } from "../src/core/providers.mjs";

const wasm = await readFile(new URL("../web/agents/a-agent.wasm", import.meta.url));

test("wasm agent core: full loop — chat → tool block parsed in WASM → host tool → done", async () => {
  const files = {};
  const tools = [
    { name: "write", execute: a => { files[a.path] = a.content; return `wrote ${a.path}`; } },
    { name: "read", execute: a => files[a.path] ?? "error: no such file" },
  ];
  let calls = 0; const events = [];
  const chatText = async prompt => {
    calls++;
    if (calls === 1) return toolCallsToText({ toolCalls: [{ name: "write", args: { path: "hi.txt", content: "hello {nested} \"q\"" } }] });
    assert.ok(prompt.includes("tool result: wrote hi.txt"), "transcript carries tool result into next prompt");
    return "All done.";
  };
  const r = await runWasmAgent(wasm, "create hi.txt", { tools, chatText, onEvent: (k, t) => events.push([k, t]) });
  assert.equal(r.text, "All done.");
  assert.equal(files["hi.txt"], 'hello {nested} "q"', "brace/quote-aware args extraction in WASM");
  assert.ok(events.some(([k]) => k === "tool") && events.some(([k]) => k === "log"));
});

test("wasm agent + demo provider via relay-style chatText terminates (text-protocol shim)", async () => {
  const files = {};
  const tools = [{ name: "write", execute: a => { files[a.path] = a.content; return `wrote ${a.path} (${a.content.length} bytes)`; } }];
  const demo = demoProvider();
  const chatText = async prompt => toolCallsToText(await demo.chat({ messages: [{ role: "user", content: prompt }],
    tools: [{ type: "function", function: { name: "write", description: "", parameters: {} } }] }));
  const r = await runWasmAgent(wasm, "create hello.txt saying hi from wasm", { tools, chatText });
  assert.equal(files["hello.txt"], "hi from wasm");
  assert.match(r.text, /Done/);
});

test("wasm host: rejects modules missing ABI exports", async () => {
  const empty = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const bytes = new Uint8Array(await WebAssembly.serializeModule?.(empty) ?? [0, 97, 115, 109, 1, 0, 0, 0]);
  await assert.rejects(() => runWasmAgent(bytes, "x", { chatText: async () => "hi" }), /missing export|ABI/);
});
