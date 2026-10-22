#!/bin/sh
# Build the reference WASM agent core (web/agents/a-agent.ts -> a-agent.wasm)
set -e
npx asc web/agents/a-agent.ts --outFile web/agents/a-agent.wasm --runtime stub --initialMemory 64 --noAssert -O2
ls -la web/agents/a-agent.wasm
