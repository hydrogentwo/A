import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Regression guard: the web GUI has no other test coverage, and a lost edit
// once shipped a console whose login/quant JS was missing while APIs passed.
test("gui: swarm console JS is complete and wired to the HTML", async () => {
  const js = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(js, /async function refreshMe\(\)/, "refreshMe defined");
  assert.match(js, /refreshMe\(\); \/\/ gates the Swarm Console/, "refreshMe invoked at boot");
  assert.match(js, /function renderQuant\(\)/, "renderQuant defined");
  assert.match(js, /function renderSwarm\(\) \{[\s\S]{0,140}?renderQuant\(\);/, "renderSwarm calls renderQuant");
  assert.match(js, /async function loadLocalModel\(\)/, "format-aware loader present");
  assert.match(js, /remoteHost/, "VPS-served ONNX loading wired");
  for (const id of ["auth-form", "auth-gate", "q-target", "q-recipes", "q-go", "users-card", "user-chip", "logout-btn", "quant-card"])
    assert.ok(html.includes(`id="${id}"`), `#${id} in HTML`);
  for (const id of ["auth-form", "q-target", "q-go", "logout-btn"])
    assert.ok(js.includes(`"#${id}"`), `#${id} handled in JS`);
  assert.ok(html.includes('id="agent-core"'), "#agent-core select in HTML");
  assert.ok(js.includes("runWasmAgent") && js.includes('import { runWasmAgent'), "WASM core wired in JS");
  assert.ok(js.includes("/agents/a-agent.wasm"), "wasm module URL present");
});
