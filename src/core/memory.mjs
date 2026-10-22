// Persistent semantic memory (jcode lesson), dependency-free: TF-IDF vectors
// over a JSONL store. Swap in real embeddings later via the same interface —
// recall(text,k) / remember(text,meta). Survives across sessions + syncs to VPS.
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const tok = s => (String(s).toLowerCase().match(/[a-z0-9_]{3,}/g) || []);
function vec(tokens, idf) { const v = new Map(); for (const t of tokens) v.set(t, (v.get(t) || 0) + (idf.get(t) || 1)); return v; }
function cos(a, b) { let d = 0, na = 0, nb = 0; for (const [k, v] of a) { na += v * v; if (b.has(k)) d += v * b.get(k); } for (const v of b.values()) nb += v * v; return d / (Math.sqrt(na * nb) || 1); }

export class Memory {
  constructor(dir) { this.file = join(dir, ".a", "memory.jsonl"); this.docs = null; }
  async load() {
    if (this.docs) return;
    try { this.docs = (await readFile(this.file, "utf8")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
    catch { this.docs = []; }
    const df = new Map(); for (const d of this.docs) for (const t of new Set(tok(d.text))) df.set(t, (df.get(t) || 0) + 1);
    this.idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + this.docs.length / (1 + n))]));
    for (const d of this.docs) d._v = vec(tok(d.text), this.idf);
  }
  async remember(text, meta = {}) {
    await mkdir(dirname(this.file), { recursive: true });
    const doc = { t: new Date().toISOString(), text, meta };
    await appendFile(this.file, JSON.stringify(doc) + "\n"); this.docs = null; return doc;
  }
  async recall(query, k = 3) {
    await this.load(); if (!this.docs.length) return [];
    const q = vec(tok(query), this.idf);
    return this.docs.map(d => ({ text: d.text, meta: d.meta, score: cos(q, d._v) }))
      .filter(x => x.score > 0.08).sort((a, b) => b.score - a.score).slice(0, k);
  }
}
