import { describe, expect, it } from 'vitest';
import { FlowGraph } from './maxflow.js';

/** Edmonds–Karp on a dense capacity matrix (node n = source, n + 1 = sink): the reference. */
function reference(n: number, terms: [number, number][], edges: [number, number, number, number][]) {
  const N = n + 2, s = n, t = n + 1, cap = Array.from({ length: N }, () => new Float64Array(N));
  terms.forEach(([a, b], i) => { cap[s][i] += a; cap[i][t] += b; });
  for (const [i, j, c, r] of edges) { cap[i][j] += c; cap[j][i] += r; }
  let flow = 0;
  for (;;) {
    const prev = new Int32Array(N).fill(-1); prev[s] = s; const q = [s];
    while (q.length && prev[t] < 0) { const u = q.shift()!; for (let v = 0; v < N; v++) if (prev[v] < 0 && cap[u][v] > 1e-12) { prev[v] = u; q.push(v); } }
    if (prev[t] < 0) break;
    let b = Infinity; for (let v = t; v !== s; v = prev[v]) b = Math.min(b, cap[prev[v]][v]);
    for (let v = t; v !== s; v = prev[v]) { cap[prev[v]][v] -= b; cap[v][prev[v]] += b; }
    flow += b;
  }
  return flow;
}
let seed = 7; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

describe('Boykov–Kolmogorov max-flow', () => {
  it('finds the same maximum flow as Edmonds–Karp on random graphs, and its cut costs exactly that', () => {
    for (let trial = 0; trial < 300; trial++) {
      const n = 2 + Math.floor(rand() * 28), terms: [number, number][] = [], edges: [number, number, number, number][] = [];
      for (let i = 0; i < n; i++) terms.push([rand() < 0.5 ? Math.round(rand() * 20) : 0, rand() < 0.5 ? Math.round(rand() * 20) : 0]);
      const m = Math.floor(rand() * n * 3);
      for (let k = 0; k < m; k++) { const i = Math.floor(rand() * n), j = Math.floor(rand() * n); if (i !== j) edges.push([i, j, Math.round(rand() * 15), Math.round(rand() * 15)]); }
      const g = new FlowGraph(n, edges.length);
      terms.forEach(([a, b], i) => g.addTerminal(i, a, b));
      for (const [i, j, c, r] of edges) g.addEdge(i, j, c, r);
      const flow = g.maxflow();
      expect(flow, `trial ${trial}`).toBeCloseTo(reference(n, terms, edges), 6);
      // The cut: source-side nodes pay their sink capacity, sink-side ones their source capacity, plus edges crossing.
      const side = Array.from({ length: n }, (_, i) => g.inSource(i));
      let cut = 0; terms.forEach(([a, b], i) => { cut += side[i] ? b : a; });
      for (const [i, j, c, r] of edges) { if (side[i] && !side[j]) cut += c; if (side[j] && !side[i]) cut += r; }
      expect(cut, `trial ${trial} cut`).toBeCloseTo(flow, 6);
    }
  });

  it('cuts a 300 × 300 grid quickly', () => {
    const W = 300, H = 300, g = new FlowGraph(W * H, 2 * W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, inside = (x - 150) ** 2 + (y - 150) ** 2 < 80 ** 2;
      g.addTerminal(i, inside ? 3 : 1, inside ? 1 : 3);
      if (x + 1 < W) g.addEdge(i, i + 1, 2, 2); if (y + 1 < H) g.addEdge(i, i + W, 2, 2);
    }
    const t0 = Date.now(); g.maxflow(); const ms = Date.now() - t0;
    let inDisc = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g.inSource(y * W + x)) inDisc++;
    expect(Math.abs(inDisc - Math.PI * 80 * 80) / (Math.PI * 80 * 80)).toBeLessThan(0.05);
    expect(ms).toBeLessThan(3000);
  });
});
