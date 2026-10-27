/**
 * Boykov–Kolmogorov max-flow / min-cut ("An Experimental Comparison of Min-Cut/Max-Flow Algorithms for Energy
 * Minimization in Vision", 2004): two search trees grown from the source and the sink, reused between augmentations —
 * the algorithm image segmentation uses on pixel grids. A graph is built once (terminal weights and pairwise edges) and
 * cut once; `inSource(i)` then tells which side of the minimum cut node i is on.
 */
const NONE = -1, TERMINAL = -2, ORPHAN = -3;

export class FlowGraph {
  private readonly first: Int32Array; private readonly parent: Int32Array; private readonly ts: Int32Array; private readonly dist: Int32Array;
  private readonly sink: Uint8Array; private readonly trCap: Float64Array; private readonly active: Uint8Array;
  private readonly head: Int32Array; private readonly next: Int32Array; private readonly rCap: Float64Array;
  private arcs = 0; private flow = 0;
  constructor(readonly nodes: number, maxEdges: number) {
    this.first = new Int32Array(nodes).fill(-1); this.parent = new Int32Array(nodes).fill(NONE);
    this.ts = new Int32Array(nodes); this.dist = new Int32Array(nodes); this.sink = new Uint8Array(nodes); this.trCap = new Float64Array(nodes); this.active = new Uint8Array(nodes);
    this.head = new Int32Array(2 * maxEdges); this.next = new Int32Array(2 * maxEdges); this.rCap = new Float64Array(2 * maxEdges);
  }
  /** Capacities from the source and to the sink (added to what the node has; opposite ones cancel into the flow). */
  addTerminal(i: number, source: number, sink: number) {
    const delta = this.trCap[i];
    if (delta > 0) source += delta; else sink -= delta;
    this.flow += Math.min(source, sink);
    this.trCap[i] = source - sink;
  }
  /** An edge i → j of capacity `cap` and j → i of `rev`. */
  addEdge(i: number, j: number, cap: number, rev: number) {
    const a = this.arcs, b = a + 1; this.arcs += 2;
    this.head[a] = j; this.rCap[a] = cap; this.next[a] = this.first[i]; this.first[i] = a;
    this.head[b] = i; this.rCap[b] = rev; this.next[b] = this.first[j]; this.first[j] = b;
  }
  /** After `maxflow`: whether node i is on the source side of the cut (a node in neither tree is on the sink side). */
  inSource(i: number) { return this.parent[i] !== NONE && !this.sink[i]; }

  maxflow(): number {
    const { first, parent, ts, dist, sink, trCap, active, head, next, rCap } = this, n = this.nodes;
    const queue = new Int32Array(n + 1); let qh = 0, qt = 0, qn = 0;
    const push = (i: number) => { if (active[i]) return; active[i] = 1; queue[qt] = i; qt = (qt + 1) % (n + 1); qn++; };
    const pop = (): number => { while (qn) { const i = queue[qh]; qh = (qh + 1) % (n + 1); qn--; active[i] = 0; if (parent[i] !== NONE) return i; } return -1; };
    // (Orphans in any order: the order changes the work, not the cut.)
    const orphans: number[] = []; let time = 0;
    for (let i = 0; i < n; i++) {
      if (trCap[i] > 0) { sink[i] = 0; parent[i] = TERMINAL; push(i); ts[i] = 0; dist[i] = 1; }
      else if (trCap[i] < 0) { sink[i] = 1; parent[i] = TERMINAL; push(i); ts[i] = 0; dist[i] = 1; }
      else parent[i] = NONE;
    }
    let current = -1;
    for (;;) {
      let i = current;
      if (i >= 0 && parent[i] === NONE) i = -1;
      if (i < 0) { i = pop(); if (i < 0) break; }
      current = -1;
      // Grow the tree i is in; stop at an arc reaching the other tree.
      let middle = -1;
      if (!sink[i]) {
        for (let a = first[i]; a >= 0; a = next[a]) {
          if (!rCap[a]) continue;
          const j = head[a];
          if (parent[j] === NONE) { sink[j] = 0; parent[j] = a ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; push(j); }
          else if (sink[j]) { middle = a; break; }
          else if (ts[j] <= ts[i] && dist[j] > dist[i]) { parent[j] = a ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; }
        }
      } else {
        for (let a = first[i]; a >= 0; a = next[a]) {
          if (!rCap[a ^ 1]) continue;
          const j = head[a];
          if (parent[j] === NONE) { sink[j] = 1; parent[j] = a ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; push(j); }
          else if (!sink[j]) { middle = a ^ 1; break; }
          else if (ts[j] <= ts[i] && dist[j] > dist[i]) { parent[j] = a ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; }
        }
      }
      time++;
      if (middle < 0) continue;
      current = i; // i may still have paths: it is looked at again first
      // Augment along source tree → middle arc → sink tree, by the bottleneck.
      let bottleneck = rCap[middle], k = head[middle ^ 1];
      for (;;) { const a = parent[k]; if (a === TERMINAL) break; if (bottleneck > rCap[a ^ 1]) bottleneck = rCap[a ^ 1]; k = head[a]; }
      if (bottleneck > trCap[k]) bottleneck = trCap[k];
      k = head[middle];
      for (;;) { const a = parent[k]; if (a === TERMINAL) break; if (bottleneck > rCap[a]) bottleneck = rCap[a]; k = head[a]; }
      if (bottleneck > -trCap[k]) bottleneck = -trCap[k];
      rCap[middle ^ 1] += bottleneck; rCap[middle] -= bottleneck;
      k = head[middle ^ 1];
      for (;;) {
        const a = parent[k]; if (a === TERMINAL) break;
        rCap[a] += bottleneck; rCap[a ^ 1] -= bottleneck;
        if (!rCap[a ^ 1]) { parent[k] = ORPHAN; orphans.push(k); }
        k = head[a];
      }
      trCap[k] -= bottleneck; if (!trCap[k]) { parent[k] = ORPHAN; orphans.push(k); }
      k = head[middle];
      for (;;) {
        const a = parent[k]; if (a === TERMINAL) break;
        rCap[a ^ 1] += bottleneck; rCap[a] -= bottleneck;
        if (!rCap[a]) { parent[k] = ORPHAN; orphans.push(k); }
        k = head[a];
      }
      trCap[k] += bottleneck; if (!trCap[k]) { parent[k] = ORPHAN; orphans.push(k); }
      this.flow += bottleneck;
      // Adoption: each orphan finds a new parent in its own tree (one that reaches its terminal), or becomes free.
      while (orphans.length) {
        const o = orphans.pop()!, inSink = sink[o];
        let best = -1, bestD = Infinity;
        for (let a0 = first[o]; a0 >= 0; a0 = next[a0]) {
          if (!(inSink ? rCap[a0] : rCap[a0 ^ 1])) continue;
          let j = head[a0];
          if (sink[j] !== inSink || parent[j] === NONE) continue;
          let d = 0;
          for (;;) {
            if (ts[j] === time) { d += dist[j]; break; }
            const a = parent[j]; d++;
            if (a === TERMINAL) { ts[j] = time; dist[j] = 1; break; }
            if (a === ORPHAN) { d = Infinity; break; }
            j = head[a];
          }
          if (d < Infinity) {
            if (d < bestD) { best = a0; bestD = d; }
            for (let jj = head[a0]; ts[jj] !== time; jj = head[parent[jj]]) { ts[jj] = time; dist[jj] = d--; }
          }
        }
        if (best >= 0) { parent[o] = best; ts[o] = time; dist[o] = bestD + 1; continue; }
        parent[o] = NONE;
        for (let a0 = first[o]; a0 >= 0; a0 = next[a0]) {
          const j = head[a0];
          if (sink[j] !== inSink || parent[j] === NONE) continue;
          // A neighbour that could still pass flow to (or from) it becomes active; its children are orphans too.
          if (inSink ? rCap[a0] : rCap[a0 ^ 1]) push(j);
          const a = parent[j];
          if (a !== TERMINAL && a !== ORPHAN && head[a] === o) { parent[j] = ORPHAN; orphans.push(j); }
        }
      }
    }
    return this.flow;
  }
}
