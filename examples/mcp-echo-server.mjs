#!/usr/bin/env node
// Minimal stdio MCP server (no deps) — tools: echo, add. Used by tests/demo.
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = o => process.stdout.write(JSON.stringify(o) + "\n");
rl.on("line", line => {
  let j; try { j = JSON.parse(line); } catch { return; }
  if (j.method === "initialize") return send({ jsonrpc: "2.0", id: j.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } } });
  if (j.method === "tools/list") return send({ jsonrpc: "2.0", id: j.id, result: { tools: [
    { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } } ] } });
  if (j.method === "tools/call") { const { name, arguments: a } = j.params;
    const text = name === "echo" ? `echo: ${a.text}` : name === "add" ? String(a.a + a.b) : "unknown tool";
    return send({ jsonrpc: "2.0", id: j.id, result: { content: [{ type: "text", text }] } }); }
  if (j.id) send({ jsonrpc: "2.0", id: j.id, result: {} });
});
