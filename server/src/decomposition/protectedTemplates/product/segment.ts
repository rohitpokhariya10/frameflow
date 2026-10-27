/**
 * Local object masks by graph cut (GrabCut: Rother, Kolmogorov, Blake 2004), one object at a time from front to back:
 *
 *   colours    a Gaussian mixture of the object's colours (its box, then what the cut keeps) and one of its surroundings
 *              (a ring around its box, then what the cut leaves out) — the surroundings are learned locally, so a stand
 *              under a product, a temple beside a character or the page colour around a white appliance count as what
 *              is NOT the object, while white inside a white appliance's box can still be the appliance
 *   edges      neighbouring pixels are cut apart cheaply where their colours step strongly and dearly where they do not
 *              (contrast-sensitive smoothness): the mask follows the object's outline, not a colour threshold
 *   order      an object in front keeps what it claimed: a pixel of it is never given to an object behind (the box of a
 *              laptop holding the phones in front of it); past its box an object may still reach a little, at a cost
 *   rounds     colours re-fitted to the last cut, then cut again (three rounds)
 *
 * The cut is minimised exactly (maxflow.ts). It only decides which pixels are the object; how transparent its rim is
 * and what is behind it are decided later (prepare.ts).
 */
import { FlowGraph } from './maxflow.js';

type Box = { x: number; y: number; width: number; height: number };

/** A Gaussian mixture of RGB colours with full covariances (the colour model GrabCut uses). */
export class ColourModel {
  private constructor(private readonly comps: { w: number; mean: number[]; inv: number[]; logNorm: number }[]) {}
  get size() { return this.comps.length; }
  /** Fitted to `samples` (r, g, b triples): k-means seeds, then a few rounds of assigning each sample to its likeliest component. */
  static fit(samples: Float32Array, K = 5, rounds = 4): ColourModel | undefined {
    const n = samples.length / 3; if (n < 20) return undefined;
    // At most 20 000 samples, spread over the set.
    const step = Math.max(1, Math.floor(n / 20000)), m = Math.floor(n / step), s = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) for (let c = 0; c < 3; c++) s[i * 3 + c] = samples[i * step * 3 + c];
    const k = Math.min(K, m), assign = new Int32Array(m);
    // Seeds: the first sample, then each next the farthest from the seeds so far (deterministic k-means++).
    const centres: number[][] = [[s[0], s[1], s[2]]], d2 = new Float64Array(m).fill(Infinity);
    while (centres.length < k) {
      const c = centres[centres.length - 1]; let far = 0, at = 0;
      for (let i = 0; i < m; i++) { const d = (s[i * 3] - c[0]) ** 2 + (s[i * 3 + 1] - c[1]) ** 2 + (s[i * 3 + 2] - c[2]) ** 2; if (d < d2[i]) d2[i] = d; if (d2[i] > far) { far = d2[i]; at = i; } }
      if (far === 0) break; centres.push([s[at * 3], s[at * 3 + 1], s[at * 3 + 2]]);
    }
    for (let r = 0; r < 6; r++) {
      for (let i = 0; i < m; i++) { let best = 0, bd = Infinity; for (let j = 0; j < centres.length; j++) { const c = centres[j], d = (s[i * 3] - c[0]) ** 2 + (s[i * 3 + 1] - c[1]) ** 2 + (s[i * 3 + 2] - c[2]) ** 2; if (d < bd) { bd = d; best = j; } } assign[i] = best; }
      const sum = centres.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < m; i++) { const q = sum[assign[i]]; q[0] += s[i * 3]; q[1] += s[i * 3 + 1]; q[2] += s[i * 3 + 2]; q[3]++; }
      sum.forEach((q, j) => { if (q[3]) centres[j] = [q[0] / q[3], q[1] / q[3], q[2] / q[3]]; });
    }
    let model = ColourModel.fromAssignment(s, assign, centres.length);
    for (let r = 0; r < rounds && model; r++) {
      for (let i = 0; i < m; i++) assign[i] = model.likeliest(s[i * 3], s[i * 3 + 1], s[i * 3 + 2]);
      model = ColourModel.fromAssignment(s, assign, centres.length) ?? model;
    }
    return model;
  }
  private static fromAssignment(s: Float32Array, assign: Int32Array, k: number): ColourModel | undefined {
    const m = assign.length, comps: ColourModel['comps'] = [];
    for (let j = 0; j < k; j++) {
      let count = 0; const mean = [0, 0, 0];
      for (let i = 0; i < m; i++) if (assign[i] === j) { count++; for (let c = 0; c < 3; c++) mean[c] += s[i * 3 + c]; }
      if (count < 5) continue;
      for (let c = 0; c < 3; c++) mean[c] /= count;
      const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < m; i++) if (assign[i] === j) { const d = [s[i * 3] - mean[0], s[i * 3 + 1] - mean[1], s[i * 3 + 2] - mean[2]]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a * 3 + b] += d[a] * d[b]; }
      for (let q = 0; q < 9; q++) cov[q] /= count;
      // A floor on the spread (flat colours and JPEG noise): about two levels a channel.
      for (let a = 0; a < 3; a++) cov[a * 4] += 4;
      const det = cov[0] * (cov[4] * cov[8] - cov[5] * cov[7]) - cov[1] * (cov[3] * cov[8] - cov[5] * cov[6]) + cov[2] * (cov[3] * cov[7] - cov[4] * cov[6]);
      if (!(det > 0)) continue;
      const inv = [
        (cov[4] * cov[8] - cov[5] * cov[7]) / det, (cov[2] * cov[7] - cov[1] * cov[8]) / det, (cov[1] * cov[5] - cov[2] * cov[4]) / det,
        (cov[5] * cov[6] - cov[3] * cov[8]) / det, (cov[0] * cov[8] - cov[2] * cov[6]) / det, (cov[2] * cov[3] - cov[0] * cov[5]) / det,
        (cov[3] * cov[7] - cov[4] * cov[6]) / det, (cov[1] * cov[6] - cov[0] * cov[7]) / det, (cov[0] * cov[4] - cov[1] * cov[3]) / det];
      comps.push({ w: count / m, mean, inv, logNorm: -0.5 * Math.log(det) - 1.5 * Math.log(2 * Math.PI) });
    }
    return comps.length ? new ColourModel(comps) : undefined;
  }
  private logComp(j: number, r: number, g: number, b: number) {
    const c = this.comps[j], d0 = r - c.mean[0], d1 = g - c.mean[1], d2 = b - c.mean[2], v = c.inv;
    const q = d0 * (v[0] * d0 + v[1] * d1 + v[2] * d2) + d1 * (v[3] * d0 + v[4] * d1 + v[5] * d2) + d2 * (v[6] * d0 + v[7] * d1 + v[8] * d2);
    return Math.log(c.w) + c.logNorm - 0.5 * q;
  }
  private likeliest(r: number, g: number, b: number) { let best = 0, bl = -Infinity; for (let j = 0; j < this.comps.length; j++) { const l = this.logComp(j, r, g, b); if (l > bl) { bl = l; best = j; } } return best; }
  /** −log p(colour). */
  cost(r: number, g: number, b: number) {
    let mx = -Infinity; const ls: number[] = [];
    for (let j = 0; j < this.comps.length; j++) { const l = this.logComp(j, r, g, b); ls.push(l); if (l > mx) mx = l; }
    let sum = 0; for (const l of ls) sum += Math.exp(l - mx);
    return -(mx + Math.log(sum));
  }
}

export interface CutTarget {
  box: Box;
  /** Pixels it may not take (an object in front already has them). */
  taken: Uint8Array;
  /** Pixels that are surely its own (none: the box decides). */
  sure?: Uint8Array;
  /** Its first estimate (else its box): where its colours are first learned from. */
  init?: Uint8Array;
  /** An earlier mask: its rim is kept, and (with `priorCost`, per pixel changed) the cut departs from it only where the colours and the edges clearly say so. */
  prior?: Uint8Array; priorCost?: number;
  /** Pixels never to learn its surroundings from (other objects in front): not what is behind it. */
  ignore?: Uint8Array;
  /** Colours of the scene outside every object (r, g, b triples), learned from too: scenery seen elsewhere in the picture. */
  scene?: Float32Array;
  /** Pixels of other objects beside it (not ones it sits on): neither it nor its surroundings. */
  elsewhere?: Uint8Array;
}
const SMOOTH = 50, HARD = 1e6;

/** One object's mask by graph cut, in a picture of w × h (RGB). */
export function cutObject(rgb: Uint8Array, w: number, h: number, t: CutTarget, rounds = 3): Uint8Array {
  const n = w * h, b = t.box, side = Math.max(b.width, b.height);
  // The graph: the box and a margin it may reach into; the ring past it: its surroundings, only to learn colours from.
  const margin = Math.min(Math.max(3, Math.round(side * 0.06)), 40), ring = Math.max(4, Math.round(side * 0.12));
  const R = { x0: Math.max(0, b.x - margin), y0: Math.max(0, b.y - margin), x1: Math.min(w, b.x + b.width + margin), y1: Math.min(h, b.y + b.height + margin) };
  const G = { x0: Math.max(0, R.x0 - ring), y0: Math.max(0, R.y0 - ring), x1: Math.min(w, R.x1 + ring), y1: Math.min(h, R.y1 + ring) };
  const RW = R.x1 - R.x0, RH = R.y1 - R.y0, out = new Uint8Array(n); if (RW < 2 || RH < 2) return out;
  const inBox = (x: number, y: number) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
  const label = new Uint8Array(RW * RH);
  for (let y = R.y0; y < R.y1; y++) for (let x = R.x0; x < R.x1; x++) { const i = y * w + x; if (!t.taken[i] && (t.init ? t.init[i] : inBox(x, y) || t.sure?.[i])) label[(y - R.y0) * RW + x - R.x0] = 1; }
  // Contrast scale: the mean squared colour step between neighbours in the region.
  let sum = 0, cnt = 0;
  const step2 = (i: number, j: number) => (rgb[i * 3] - rgb[j * 3]) ** 2 + (rgb[i * 3 + 1] - rgb[j * 3 + 1]) ** 2 + (rgb[i * 3 + 2] - rgb[j * 3 + 2]) ** 2;
  for (let y = R.y0; y < R.y1; y++) for (let x = R.x0; x < R.x1; x++) { const i = y * w + x; if (x + 1 < R.x1) { sum += step2(i, i + 1); cnt++; } if (y + 1 < R.y1) { sum += step2(i, i + w); cnt++; } }
  const beta = cnt && sum ? 1 / (2 * (sum / cnt)) : 0;
  const samples = (pick: (i: number, x: number, y: number) => boolean, x0: number, y0: number, x1: number, y1: number) => {
    const v: number[] = []; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * w + x; if (pick(i, x, y)) v.push(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]); }
    return Float32Array.from(v);
  };
  const inR = (x: number, y: number) => x >= R.x0 && x < R.x1 && y >= R.y0 && y < R.y1;
  for (let round = 0; round < rounds; round++) {
    const fg = ColourModel.fit(samples((_i, x, y) => inR(x, y) && label[(y - R.y0) * RW + x - R.x0] === 1, R.x0, R.y0, R.x1, R.y1));
    const local = samples((i, x, y) => !t.taken[i] && !t.ignore?.[i] && !t.elsewhere?.[i] && (!inR(x, y) || label[(y - R.y0) * RW + x - R.x0] === 0), G.x0, G.y0, G.x1, G.y1);
    // (The scenery near it learned too, never outweighing what is right around it.)
    const scene = t.scene && t.scene.length > local.length ? t.scene.subarray(0, Math.max(60 * 3, local.length - local.length % 3)) : t.scene;
    const both = scene ? new Float32Array(local.length + scene.length) : local; if (scene) { both.set(local); both.set(scene, local.length); }
    const bg = ColourModel.fit(both, 8);
    if (!fg || !bg) break;
    const g = new FlowGraph(RW * RH, RW * RH * 4);
    for (let y = R.y0; y < R.y1; y++) for (let x = R.x0; x < R.x1; x++) {
      const i = y * w + x, k = (y - R.y0) * RW + x - R.x0;
      if (t.taken[i]) { g.addTerminal(k, 0, HARD); continue; }
      if (t.sure?.[i]) { g.addTerminal(k, HARD, 0); continue; }
      const r = rgb[i * 3], gg = rgb[i * 3 + 1], bb = rgb[i * 3 + 2];
      // Past its box an object reaches only where its colours are clearly its own.
      const kp = t.prior ? t.priorCost ?? 0 : 0, cf = fg.cost(r, gg, bb) + (inBox(x, y) ? 0 : 2) + (t.prior && !t.prior[i] ? kp : 0), cb = bg.cost(r, gg, bb) + (t.prior?.[i] ? kp : 0), lo = Math.min(cf, cb);
      g.addTerminal(k, cb - lo, cf - lo);
    }
    const link = (i: number, j: number, ki: number, kj: number, wgt: number) => { const c = wgt * Math.exp(-beta * step2(i, j)); g.addEdge(ki, kj, c, c); };
    for (let y = R.y0; y < R.y1; y++) for (let x = R.x0; x < R.x1; x++) {
      const i = y * w + x, k = (y - R.y0) * RW + x - R.x0;
      if (x + 1 < R.x1) link(i, i + 1, k, k + 1, SMOOTH);
      if (y + 1 < R.y1) link(i, i + w, k, k + RW, SMOOTH);
      if (x + 1 < R.x1 && y + 1 < R.y1) link(i, i + w + 1, k, k + RW + 1, SMOOTH / Math.SQRT2);
      if (x > R.x0 && y + 1 < R.y1) link(i, i + w - 1, k, k + RW - 1, SMOOTH / Math.SQRT2);
    }
    g.maxflow();
    let changed = 0;
    for (let k = 0; k < RW * RH; k++) { const v = g.inSource(k) ? 1 : 0; if (v !== label[k]) { changed++; label[k] = v; } }
    if (!changed) break;
  }
  for (let y = R.y0; y < R.y1; y++) for (let x = R.x0; x < R.x1; x++) if (label[(y - R.y0) * RW + x - R.x0]) out[y * w + x] = 1;
  // The earlier mask's pixels just past the cut (its rim: colours mixed with what is behind, which the cut gives to the
  // surroundings) stay the object's: left out, they remained in the background as a line around it.
  if (t.prior) {
    const near = new Uint8Array(n), r = 2;
    for (let y = R.y0; y < R.y1; y++) for (let x = R.x0; x < R.x1; x++) if (out[y * w + x])
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) near[Y * w + X] = 1; }
    for (let i = 0; i < n; i++) if (!out[i] && near[i] && t.prior[i] && !t.taken[i]) out[i] = 1;
  }
  return out;
}

/**
 * Every object's mask, front to back (`objects` in that order): each cut where the ones in front have not already taken
 * the pixels. `sure`: pixels known to be an object's (optional, by id).
 */
export function cutObjects(rgb: Uint8Array, w: number, h: number, objects: { id: string; box: Box; init?: Uint8Array; prior?: Uint8Array; priorCost?: number }[], sure?: Map<string, Uint8Array>, others: Box[] = []): Map<string, Uint8Array> {
  const n = w * h, taken = new Uint8Array(n), out = new Map<string, Uint8Array>();
  // The scenery near each object: every pixel outside all boxes (with a margin) within its box enlarged by its own size,
  // at most 8 000 of them spread over that area (the whole picture's: a white page far below a TV made its white panel
  // look like scenery).
  const all = [...objects.map(o => o.box), ...others], pad = (b: Box) => Math.max(2, Math.round(Math.max(b.width, b.height) * 0.04));
  const outside = (x: number, y: number) => !all.some(b => x >= b.x - pad(b) && x < b.x + b.width + pad(b) && y >= b.y - pad(b) && y < b.y + b.height + pad(b));
  const sceneNear = (b: Box) => {
    const s = Math.max(b.width, b.height), x0 = Math.max(0, b.x - s), y0 = Math.max(0, b.y - s), x1 = Math.min(w, b.x + b.width + s), y1 = Math.min(h, b.y + b.height + s);
    const st = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 8000))), v: number[] = [];
    for (let y = y0; y < y1; y += st) for (let x = x0; x < x1; x += st) if (outside(x, y)) { const i = y * w + x; v.push(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]); }
    return v.length >= 60 ? Float32Array.from(v) : undefined;
  };
  for (const o of objects) {
    const scene = sceneNear(o.box), elsewhere = new Uint8Array(n);
    // Other objects' boxes beside it: not its surroundings (a white air conditioner beside a TV made the TV's white frame
    // look like scenery). One it sits on (a soundbar on a TV's panel, earbuds on a laptop) is what is behind it.
    const holds = (b: Box) => { const ix = Math.max(0, Math.min(b.x + b.width, o.box.x + o.box.width) - Math.max(b.x, o.box.x)), iy = Math.max(0, Math.min(b.y + b.height, o.box.y + o.box.height) - Math.max(b.y, o.box.y)); return ix * iy >= 0.7 * o.box.width * o.box.height; };
    for (const b of all) if (b !== o.box && !holds(b)) for (let y = Math.max(0, b.y); y < Math.min(h, b.y + b.height); y++) for (let x = Math.max(0, b.x); x < Math.min(w, b.x + b.width); x++) elsewhere[y * w + x] = 1;
    const m = cutObject(rgb, w, h, { box: o.box, taken, ignore: taken, elsewhere, ...(scene ? { scene } : {}), ...(o.init ? { init: o.init } : {}), ...(o.prior ? { prior: o.prior, priorCost: o.priorCost } : {}), ...(sure?.get(o.id) ? { sure: sure.get(o.id) } : {}) });
    for (let i = 0; i < n; i++) if (m[i]) taken[i] = 1;
    out.set(o.id, m);
  }
  return out;
}

/** A mask with its gaps filled where they lie inside both its row's and its column's extent (a white body between an
 * appliance's dark top and its base), within `box`. */
export function filledSpans(m: Uint8Array, w: number, h: number, box: Box): Uint8Array {
  const out = Uint8Array.from(m), x0 = Math.max(0, box.x), y0 = Math.max(0, box.y), x1 = Math.min(w, box.x + box.width), y1 = Math.min(h, box.y + box.height);
  const rowLo = new Int32Array(h).fill(w), rowHi = new Int32Array(h).fill(-1), colLo = new Int32Array(w).fill(h), colHi = new Int32Array(w).fill(-1);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (m[y * w + x]) { if (x < rowLo[y]) rowLo[y] = x; if (x > rowHi[y]) rowHi[y] = x; if (y < colLo[x]) colLo[x] = y; if (y > colHi[x]) colHi[x] = y; }
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (x >= rowLo[y] && x <= rowHi[y] && y >= colLo[x] && y <= colHi[x]) out[y * w + x] = 1;
  return out;
}

/**
 * A mask's parts that are scenery cut through: each smooth part of the picture (neighbours stepping by little in colour)
 * the mask holds a piece of, which lies mostly outside the mask around the object (the stand a microwave stands on, the
 * pink block behind a dishwasher, a temple beside a character, a frame's pillar beside a terminal) and keeps out of the
 * middle of the object's box, is not the object's: removed. Returns how many pixels it took out.
 */
export function dropScenery(rgb: Uint8Array, w: number, h: number, mask: Uint8Array, box: Box, scenery: { box: Box; colour: (r: number, g: number, b: number) => boolean }[] = []): number {
  const side = Math.max(box.width, box.height), m = Math.max(4, Math.round(side * 0.3));
  const X0 = Math.max(0, box.x - m), Y0 = Math.max(0, box.y - m), X1 = Math.min(w, box.x + box.width + m), Y1 = Math.min(h, box.y + box.height + m);
  const core = { x0: box.x + box.width * 0.25, y0: box.y + box.height * 0.25, x1: box.x + box.width * 0.75, y1: box.y + box.height * 0.75 };
  let size = 0; for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) if (mask[y * w + x]) size++;
  if (!size) return 0;
  const seen = new Uint8Array((X1 - X0) * (Y1 - Y0)), at = (x: number, y: number) => (y - Y0) * (X1 - X0) + x - X0;
  const step = (i: number, j: number) => Math.max(Math.abs(rgb[i * 3] - rgb[j * 3]), Math.abs(rgb[i * 3 + 1] - rgb[j * 3 + 1]), Math.abs(rgb[i * 3 + 2] - rgb[j * 3 + 2]));
  // Its main colours (4-bit buckets holding 85 % of its pixels).
  const counts = new Map<number, number>(), key = (i: number) => (rgb[i * 3] >> 4 << 8) | (rgb[i * 3 + 1] >> 4 << 4) | (rgb[i * 3 + 2] >> 4);
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { const i = y * w + x; if (mask[i]) counts.set(key(i), (counts.get(key(i)) ?? 0) + 1); }
  const main: number[][] = []; let acc = 0;
  for (const [k, c] of [...counts].sort((p, q) => q[1] - p[1])) { if (acc >= size * 0.85) break; acc += c; main.push([((k >> 8) << 4) + 8, (((k >> 4) & 15) << 4) + 8, ((k & 15) << 4) + 8]); }
  let removed = 0;
  for (let y0 = Y0; y0 < Y1; y0++) for (let x0 = X0; x0 < X1; x0++) {
    const s0 = y0 * w + x0; if (!mask[s0] || seen[at(x0, y0)]) continue;
    const px = [s0], stack = [s0]; seen[at(x0, y0)] = 1;
    while (stack.length) {
      const i = stack.pop()!, x = i % w, y = (i - x) / w;
      for (const [X, Y] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (X < X0 || Y < Y0 || X >= X1 || Y >= Y1 || seen[at(X, Y)]) continue; const j = Y * w + X;
        if (step(i, j) > 6) continue; seen[at(X, Y)] = 1; px.push(j); stack.push(j);
      }
    }
    let inside = 0, outside = 0, middle = 0;
    for (const i of px) { if (!mask[i]) { outside++; continue; } inside++; const x = i % w, y = (i - x) / w; if (x >= core.x0 && x < core.x1 && y >= core.y0 && y < core.y1) middle++; }
    // (In a display block the detection named and that stays in the background — the pink block behind a purifier,
    // between it and a dishwasher, mostly inside its mask — it need not continue outside.)
    const inScenery = scenery.some(({ box: b, colour }) => {
      let k = 0; const mean = [0, 0, 0];
      for (const i of px) if (mask[i]) { const x = i % w, y = (i - x) / w; if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) k++; for (let c = 0; c < 3; c++) mean[c] += rgb[i * 3 + c]; }
      return k >= inside * 0.7 && colour(mean[0] / inside, mean[1] / inside, mean[2] / inside);
    });
    if (inside < 4 || (!inScenery && outside < inside * 1.5) || inside > size * 0.5) continue;
    // Out of the middle of its box; or, anywhere (a detected box can be loose), in a colour unlike its main ones.
    if (middle > inside * 0.1 || inScenery) {
      const mean = [0, 1, 2].map(c => { let t = 0, k = 0; for (const i of px) if (mask[i]) { t += rgb[i * 3 + c]; k++; } return t / k; });
      // (Its main colours apart from this region's own: a colour mostly made of the region does not vouch for it.)
      const here = new Map<number, number>(); for (const i of px) if (mask[i]) here.set(key(i), (here.get(key(i)) ?? 0) + 1);
      const own = main.filter(q => { const k = ((q[0] - 8) >> 4) << 8 | ((q[1] - 8) >> 4) << 4 | ((q[2] - 8) >> 4); return (here.get(k) ?? 0) < (counts.get(k) ?? 1) * 0.5; });
      if (own.some(q => Math.max(Math.abs(q[0] - mean[0]), Math.abs(q[1] - mean[1]), Math.abs(q[2] - mean[2])) <= 40)) continue;
    }
    for (const i of px) if (mask[i]) { mask[i] = 0; removed++; }
  }
  return removed;
}

/** Colours (4-bit buckets) that make up most of a ring around `box` (not counting `skip` pixels): what surrounds it. */
function ringColours(rgb: Uint8Array, w: number, h: number, box: Box, skip: Uint8Array): Set<number> {
  const r = Math.max(3, Math.round(Math.max(box.width, box.height) * 0.12)), counts = new Map<number, number>(); let total = 0;
  for (let y = Math.max(0, box.y - r); y < Math.min(h, box.y + box.height + r); y++) for (let x = Math.max(0, box.x - r); x < Math.min(w, box.x + box.width + r); x++) {
    if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) continue;
    const i = y * w + x; if (skip[i]) continue; const k = (rgb[i * 3] >> 4 << 8) | (rgb[i * 3 + 1] >> 4 << 4) | (rgb[i * 3 + 2] >> 4); counts.set(k, (counts.get(k) ?? 0) + 1); total++;
  }
  const out = new Set<number>(); for (const [k, c] of counts) if (c >= total * 0.08) out.add(k);
  return out;
}

export interface RefineObject { id: string; kind: string; box: Box; z: number }
/**
 * The local masks (prepare.ts) refined, front to back:
 *   gaps       the cut (cutObject) adds what its colours missed inside a product's box — the white body of a water purifier
 *              below its dark top, which the scene's white page made look like background — or inside a character's own
 *              outline, and takes nothing away from the first mask (a rim or a TV's white frame stays as it was)
 *   on another a small product on a larger one's surface (a soundbar on a TV's panel, earbuds in front of a laptop): the
 *              colours that surround it are that surface's, so it is cut from what is left, and the cut decides
 *   scenery    dropScenery, and for a character dropBands
 *   order      what an object in front has is never another's
 * Returns the masks and, per object, how many pixels were added and taken out (for the report).
 */
export function refineMasks(rgb: Uint8Array, w: number, h: number, objects: RefineObject[], local: Map<string, Uint8Array>, others: Box[] = [], sceneryBoxes: Box[] = []): { masks: Map<string, Uint8Array>; changes: Map<string, { added: number; scenery: number }> } {
  const n = w * h, front = [...objects].sort((a, b) => b.z - a.z), taken = new Uint8Array(n), masks = new Map<string, Uint8Array>(), changes = new Map<string, { added: number; scenery: number }>();
  // Each display block's own colours: those common (2 %) among its box's pixels outside every object's box.
  const boxes = [...objects.map(o => o.box), ...others], inAny = (x: number, y: number) => boxes.some(b => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height);
  const scenery = sceneryBoxes.map(b => {
    const counts = new Map<number, number>(); let total = 0;
    for (let y = Math.max(0, b.y); y < Math.min(h, b.y + b.height); y++) for (let x = Math.max(0, b.x); x < Math.min(w, b.x + b.width); x++) {
      if (inAny(x, y)) continue; const i = y * w + x, k = (rgb[i * 3] >> 4 << 8) | (rgb[i * 3 + 1] >> 4 << 4) | (rgb[i * 3 + 2] >> 4); counts.set(k, (counts.get(k) ?? 0) + 1); total++;
    }
    const colour = (r: number, g: number, bl: number) => { if (total < 50) return false; const R = r >> 4, G = g >> 4, B = bl >> 4; let c = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) c += counts.get(((R + dr) << 8) | ((G + dg) << 4) | (B + db)) ?? 0;
      return c >= total * 0.02; };
    return { box: b, colour };
  });
  const inside = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) / Math.max(1, a.width * a.height);
  const all = [...objects.map(o => o.box), ...others];
  for (const o of front) {
    const lm = Uint8Array.from(local.get(o.id) ?? new Uint8Array(n)); for (let i = 0; i < n; i++) if (taken[i]) lm[i] = 0;
    const onAnother = o.kind === 'product' && objects.some(p => p !== o && p.kind === 'product' && p.box.width * p.box.height >= 3 * o.box.width * o.box.height && inside(o.box, p.box) >= 0.7);
    // (A product's colours first learned from its whole box, as GrabCut does: its first mask lacked whatever the scene's own
    // colours hid, the white body of a purifier among them. A character's from its first mask: its box holds scenery.)
    let init: Uint8Array | undefined = o.kind === 'product' ? undefined : lm;
    if (onAnother) { const around = ringColours(rgb, w, h, o.box, taken), b = o.box, start = new Uint8Array(n);
      for (let y = Math.max(0, b.y); y < Math.min(h, b.y + b.height); y++) for (let x = Math.max(0, b.x); x < Math.min(w, b.x + b.width); x++) { const i = y * w + x; if (!taken[i] && !around.has((rgb[i * 3] >> 4 << 8) | (rgb[i * 3 + 1] >> 4 << 4) | (rgb[i * 3 + 2] >> 4))) start[i] = 1; }
      init = start; }
    const elsewhere = new Uint8Array(n);
    for (const b of all) if (b !== o.box && inside(o.box, b) < 0.7) for (let y = Math.max(0, b.y); y < Math.min(h, b.y + b.height); y++) for (let x = Math.max(0, b.x); x < Math.min(w, b.x + b.width); x++) elsewhere[y * w + x] = 1;
    const cut = cutObject(rgb, w, h, { box: o.box, taken, ignore: taken, elsewhere, ...(init ? { init } : {}), prior: lm });
    let m: Uint8Array, added = 0;
    if (onAnother) { m = cut; for (let i = 0; i < n; i++) if (m[i] && !lm[i]) added++; }
    else {
      // A product gains what the cut adds inside its box (a character only inside its own outline: its box holds scenery).
      const spans = o.kind === 'product' ? undefined : filledSpans(lm, w, h, o.box), b = o.box; m = lm;
      for (let y = Math.max(0, b.y); y < Math.min(h, b.y + b.height); y++) for (let x = Math.max(0, b.x); x < Math.min(w, b.x + b.width); x++) {
        const i = y * w + x; if (cut[i] && !lm[i] && !taken[i] && (!spans || spans[i])) { m[i] = 1; added++; }
      }
    }
    const dropped = dropScenery(rgb, w, h, m, o.box, scenery) + (o.kind === 'character' ? dropBands(rgb, w, h, m, o.box) : 0);
    for (let i = 0; i < n; i++) if (m[i]) taken[i] = 1;
    masks.set(o.id, m); changes.set(o.id, { added, scenery: dropped });
  }
  // Enclosed: an area nobody has, inside an object's extent and bounded only by it and the objects in front of it, in
  // the colour of its pixels around it (a TV's white panel under its soundbar, which the soundbar's first mask held and
  // the cut gave back) is that object's. (Scenery seen through it — between a headphone's band and cups — is in another
  // colour, and stays.)
  for (const o of front) {
    const m = masks.get(o.id)!, own = (i: number) => m[i] === 1, inFront = front.filter(p => p.z > o.z).map(p => masks.get(p.id)!);
    let x0 = w, y0 = h, x1 = -1, y1 = -1, size = 0;
    for (let i = 0; i < n; i++) if (m[i]) { size++; const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (!size) continue;
    const BW = x1 - x0 + 1, seen = new Uint8Array(BW * (y1 - y0 + 1)), at = (x: number, y: number) => (y - y0) * BW + x - x0;
    for (let ys = y0; ys <= y1; ys++) for (let xs = x0; xs <= x1; xs++) {
      const s0 = ys * w + xs; if (seen[at(xs, ys)] || taken[s0]) continue;
      const px = [s0], stack = [s0]; seen[at(xs, ys)] = 1; let open = false, border = 0; const ownC = [0, 0, 0];
      while (stack.length) {
        const i = stack.pop()!, x = i % w, y = (i - x) / w;
        for (const [X, Y] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (X < x0 || Y < y0 || X > x1 || Y > y1) { open = true; continue; }
          const j = Y * w + X;
          if (taken[j]) { if (own(j)) { border++; for (let c = 0; c < 3; c++) ownC[c] += rgb[j * 3 + c]; } else if (!inFront.some(f => f[j])) open = true; continue; }
          if (seen[at(X, Y)]) continue; seen[at(X, Y)] = 1; px.push(j); stack.push(j);
        }
      }
      if (open || !border || px.length > size * 0.25) continue;
      const mean = [0, 1, 2].map(c => px.reduce((a, i) => a + rgb[i * 3 + c], 0) / px.length), edge = ownC.map(v => v / border);
      if (Math.max(...[0, 1, 2].map(c => Math.abs(mean[c] - edge[c]))) > 30) continue;
      for (const i of px) { m[i] = 1; taken[i] = 1; }
      changes.get(o.id)!.added += px.length;
    }
  }
  return { masks, changes };
}

/**
 * A character's thin attachments that are scenery running through: what a small opening of its mask strips off (strokes
 * a few pixels thick — the rows of a lotus band beside its legs, the edge of a temple at its waist), each connected piece
 * whose colours continue on the same rows just outside the character's box (on either side) for most of its pixels.
 * Thin parts of its own (a crown's tip, the trunk) are in colours not found there, and stay. Returns how many it removed.
 */
export function dropBands(rgb: Uint8Array, w: number, h: number, mask: Uint8Array, box: Box): number {
  const r = Math.max(1, Math.round(Math.max(box.width, box.height) * 0.012)), n = w * h;
  const X0 = Math.max(0, box.x - 2 * r), Y0 = Math.max(0, box.y - 2 * r), X1 = Math.min(w, box.x + box.width + 2 * r), Y1 = Math.min(h, box.y + box.height + 2 * r);
  const erode = (m: Uint8Array) => { const o = new Uint8Array(n); for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { let all = true; for (let dy = -r; dy <= r && all; dy++) for (let dx = -r; dx <= r && all; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h || !m[Y * w + X]) all = false; } if (all) o[y * w + x] = 1; } return o; };
  const dilate = (m: Uint8Array) => { const o = new Uint8Array(n); for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { if (!m[y * w + x]) continue; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) o[Y * w + X] = 1; } } return o; };
  const opened = dilate(erode(mask)), seen = new Uint8Array(n);
  const far = (i: number, j: number) => Math.max(Math.abs(rgb[i * 3] - rgb[j * 3]), Math.abs(rgb[i * 3 + 1] - rgb[j * 3 + 1]), Math.abs(rgb[i * 3 + 2] - rgb[j * 3 + 2]));
  // The same row just outside the box: a few pixels each side.
  const outsideMatch = (i: number) => {
    const y = Math.floor(i / w);
    for (const x of [box.x - 2, box.x - 4, box.x - 6, box.x + box.width + 1, box.x + box.width + 3, box.x + box.width + 5]) { if (x < 0 || x >= w) continue; const j = y * w + x; if (!mask[j] && far(i, j) <= 30) return true; }
    return false;
  };
  let removed = 0;
  for (let y0 = Y0; y0 < Y1; y0++) for (let x0 = X0; x0 < X1; x0++) {
    const s0 = y0 * w + x0; if (!mask[s0] || opened[s0] || seen[s0]) continue;
    const px = [s0], stack = [s0]; seen[s0] = 1;
    while (stack.length) { const i = stack.pop()!, x = i % w; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < n && mask[j] && !opened[j] && !seen[j]) { seen[j] = 1; px.push(j); stack.push(j); } }
    if (px.length < 3) continue;
    let match = 0; for (const i of px) if (outsideMatch(i)) match++;
    if (match < px.length * 0.6) continue;
    for (const i of px) mask[i] = 0; removed += px.length;
  }
  return removed;
}


