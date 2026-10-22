// A reference WASM agent core — the agent loop itself, compiled to WebAssembly.
// This is the slot a future pi-rs `pi_agent.wasm` (pi-agent crate on wasm32)
// drops into: same host ABI (see web/wasm-host.js + WASM-STACK.md).
//
// ABI (cooperative step machine — no asyncify/JSPI assumptions):
//   imports (module "a"):
//     emit(ptr,len)                                   progress/log line (sync)
//     tool(np,nl, ap,al, out,cap) -> len              browser tools are sync
//   exports:
//     scratch(), scratch_cap()                        host <-> agent mailbox
//     begin(len)    task bytes are in scratch[0..len]
//     poll() -> n   envelope in scratch: 'C'+prompt (need chat) | 'D'+text (done)
//     deliver(len)  chat completion bytes are in scratch[0..len]
// Byte-level on purpose (stub runtime, zero GC): transcripts/prompts are
// opaque UTF-8; only ASCII markers of the tool protocol are interpreted.

@external("a", "emit")
declare function a_emit(ptr: usize, len: i32): void;
@external("a", "tool")
declare function a_tool(np: usize, nl: i32, ap: usize, al: i32, out: usize, cap: i32): i32;

const RESULT: usize = 1900000; const RCAP: i32 = 65536;
const SCRATCH: usize = 2000000; const SCAP: i32 = 262144;
const TRANS: usize = 2300000; const TCAP: i32 = 1500000;

let tlen: i32 = 0;      // transcript length at TRANS
let dlen: i32 = 0;      // done-text length at RESULT
let phase: i32 = 0;     // 0 = needs chat, 1 = done
let steps: i32 = 0;

const SYSTEM: string =
  "You are A, a coding agent running as a WebAssembly agent core in a browser.\n" +
  "Host tools: read(path), write(path,content), edit(path,oldText,newText), bash(command).\n" +
  "To call a tool reply with ONLY a block like:\n```tool\n{\"name\":\"write\",\"args\":{\"path\":\"a.txt\",\"content\":\"hi\"}}\n```\n" +
  "Otherwise reply with your final answer as plain text. Work step by step.\n";

function emitAscii(s: string): void {
  for (let i = 0; i < s.length; i++) store<u8>(RESULT + <usize>i, <u8>s.charCodeAt(i));
  a_emit(RESULT, s.length);
}
function appendAscii(s: string): void {
  for (let i = 0; i < s.length && tlen < TCAP; i++) { store<u8>(TRANS + <usize>tlen, <u8>s.charCodeAt(i)); tlen++; }
}
function appendBytes(addr: usize, len: i32): void {
  const n: i32 = len < TCAP - tlen ? len : TCAP - tlen;
  memory.copy(TRANS + <usize>tlen, addr, <usize>n); tlen += n;
}
// find ASCII needle in bytes [base, base+len) starting at offset `from`; -1 if absent
function findStr(base: usize, len: i32, needle: string, from: i32): i32 {
  const nl = needle.length;
  for (let i = from; i + nl <= len; i++) {
    let ok = true;
    for (let j = 0; j < nl; j++) if (load<u8>(base + <usize>(i + j)) != <u8>needle.charCodeAt(j)) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}
function setDone(addr: usize, len: i32): void {
  dlen = len < RCAP ? len : RCAP;
  memory.copy(RESULT, addr, <usize>dlen); phase = 1;
}
function setDoneAscii(s: string): void {
  dlen = s.length;
  for (let i = 0; i < s.length; i++) store<u8>(RESULT + <usize>i, <u8>s.charCodeAt(i));
  phase = 1;
}

export function scratch(): usize { return SCRATCH; }
export function scratch_cap(): i32 { return SCAP; }

export function begin(taskLen: i32): void {
  tlen = 0; steps = 0; phase = 0;
  appendAscii(SYSTEM);
  appendAscii("\nuser: ");
  appendBytes(SCRATCH, taskLen);
  appendAscii("\nassistant:");
  emitAscii("wasm-agent: task received");
}

export function poll(): i32 {
  if (phase == 1) {
    store<u8>(SCRATCH, 68); // 'D'
    memory.copy(SCRATCH + 1, RESULT, <usize>dlen);
    return 1 + dlen;
  }
  store<u8>(SCRATCH, 67);   // 'C'
  const n: i32 = tlen < SCAP - 1 ? tlen : SCAP - 1;
  memory.copy(SCRATCH + 1, TRANS, <usize>n);
  return 1 + n;
}

export function deliver(len: i32): void {
  steps++;
  if (steps > 10) { setDoneAscii("(wasm agent: step limit reached)"); return; }
  const marker = findStr(SCRATCH, len, "```tool", 0);
  if (marker < 0) { setDone(SCRATCH, len); return; }
  const blockEnd = findStr(SCRATCH, len, "```", marker + 7);
  if (blockEnd < 0) { setDone(SCRATCH, len); return; }
  // name: first quoted string after "name":
  const nameKey = findStr(SCRATCH, blockEnd, "\"name\"", marker);
  if (nameKey < 0) { setDone(SCRATCH, len); return; }
  let n0 = findStr(SCRATCH, blockEnd, "\"", nameKey + 6);
  if (n0 < 0) { setDone(SCRATCH, len); return; }
  n0 += 1;
  const n1 = findStr(SCRATCH, blockEnd, "\"", n0);
  if (n1 < 0) { setDone(SCRATCH, len); return; }
  // args: first '{' after "args", brace-matched (string/escape aware)
  const argsKey = findStr(SCRATCH, blockEnd, "\"args\"", marker);
  if (argsKey < 0) { setDone(SCRATCH, len); return; }
  const a0 = findStr(SCRATCH, blockEnd, "{", argsKey);
  if (a0 < 0) { setDone(SCRATCH, len); return; }
  let depth = 0, inStr = false, esc = false, a1 = -1;
  for (let i = a0; i < blockEnd; i++) {
    const c = load<u8>(SCRATCH + <usize>i);
    if (esc) esc = false;
    else if (c == 92 && inStr) esc = true;          // backslash
    else if (c == 34) inStr = !inStr;               // quote
    else if (!inStr && c == 123) depth++;           // {
    else if (!inStr && c == 125) { depth--; if (depth == 0) { a1 = i + 1; break; } }
  }
  if (a1 < 0) { setDone(SCRATCH, len); return; }

  const rlen = a_tool(SCRATCH + <usize>n0, n1 - n0, SCRATCH + <usize>a0, a1 - a0, RESULT, RCAP);
  // transcript += completion + "\ntool result: " + result + "\nassistant:"
  appendBytes(SCRATCH, len);
  appendAscii("\ntool result: ");
  if (rlen > 0) appendBytes(RESULT, rlen);
  appendAscii("\nassistant:");
  emitAscii("wasm-agent: tool executed");
}
