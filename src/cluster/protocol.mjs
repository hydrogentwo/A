// Cluster wire protocol (WebSocket, JSON). Shared by VPS, browser nodes, CLI nodes.
// node → vps : hello{node} · heartbeat{stats} · task:progress · task:done · tool:event · chat:reply
// vps → node : welcome{nodeId,policy,model} · policy:update · task:assign{task} · task:cancel · model:set · ping
// ui  → vps : subscribe · swarm:submit · swarm:control{...} (also available over REST)
// vps → ui  : snapshot{nodes,tasks,policy,stats} · event{...}
export const PROTOCOL_VERSION = 1;
export const msg = (type, data = {}) => JSON.stringify({ v: PROTOCOL_VERSION, type, ts: Date.now(), ...data });
export function parse(raw) { try { const j = JSON.parse(raw); return j?.type ? j : null; } catch { return null; } }
// Node record (VPS-side + UI cards):
// { id, kind:'browser'|'cli'|'sim', name, capacity{tier,score,estVramMB}, profile,
//   model, status:'idle'|'busy'|'offline'|'loading-model', currentTask, stats{tokS,tasksDone,...} }
export function newTaskId() { return "t_" + Math.random().toString(36).slice(2, 9); }
