// Swarm scheduler (jcode swarm + Orca fan-out, capability-aware).
// Strategies (switchable live from Swarm Console):
//  capability — best-fit: smallest capable node whose model suits the role (fleet-efficient)
//  fastest    — highest capacity score / tok/s first
//  round-robin— spread evenly   broadcast — same task to N nodes, compare, merge winner (Orca)
import { modelById } from "./catalog.mjs";

export class Scheduler {
  constructor(policy) { this.policy = policy; this.rr = 0; this.strategy = "capability"; this.maxConcurrentPerNode = 1; }
  rank(nodes, task) {
    const roleModels = this.policy.roles?.[task.role] || [];
    const minTier = task.minTier || "T0"; const order = ["T0","T1","T2","T3","T4","T5"];
    const eligible = nodes.filter(n => n.status !== "offline" && (n.assigned || 0) < this.maxConcurrentPerNode
      && order.indexOf(n.capacity?.tier || "T0") >= order.indexOf(minTier));
    const score = n => {
      const m = modelById(typeof n.model === "string" ? n.model : n.model?.id);
      let s = n.capacity?.score || 0;
      if (m && roleModels.includes(m.id)) s += 40;
      if (m && m.roles.includes(task.role)) s += 15;
      if (this.policy.preferLocal && n.kind !== "relay") s += 5;
      if (n.status === "idle") s += 10;
      s += Math.min(10, (n.stats?.tokS || 0) / 5);
      s -= (n.stats?.failures || 0) * 8;
      return s;
    };
    if (this.strategy === "round-robin") { const e = eligible; if (!e.length) return []; this.rr %= e.length; return [e[this.rr++], ...e]; }
    if (this.strategy === "capability") // best-fit: prefer LOWEST sufficient score (keeps big nodes free)
      return eligible.map(n => [score(n), n]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    return eligible.map(n => [score(n), n]).sort((a, b) => b[0] - a[0]).map(x => x[1]); // fastest (default fallback)
  }
  pick(nodes, task) { return this.rank(nodes, task)[0] || null; }
  pickN(nodes, task, n) { return this.rank(nodes, task).slice(0, n); }
}
