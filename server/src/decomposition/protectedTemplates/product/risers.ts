/**
 * Display stands (risers): the pedestals, cylinders and platforms products stand on, between them and the shared
 * podium (a pink platform under a TV and its speakers, a mint cylinder under a microwave). They are neither the products
 * nor the background: each becomes its own layer, so a product can be moved or hidden without taking its stand with it
 * (and without leaving a bite out of it), a stand can be moved or hidden on its own, and the shared podium stays in the
 * background.
 *
 *   regions    the display area (around the products, down to the podium's top) split into smooth regions: neighbours
 *              joined while their colours step by little, so a shaded cylinder is one region and its edge against the
 *              podium, a product or another stand ends it
 *   kinds      a region is part of an object when nearly all of it is inside that object's box; the floor is the widest
 *              region resting on the podium's top; a stand is any other region of some size touching a product, not
 *              in the podium's box nor in a decoration's; neighbouring stand regions of continuous colour are one stand,
 *              and the slivers between shading bands go with the stand they lie in, when a product stands on it (its feet
 *              on it, not below its bottom)
 *   hints      the administrator's corrections from the review, as "Podium or stand" boxes: "its own layer" makes what is
 *              in the box a stand (when it was not found, or found wrong); "part of the background" keeps a found stand
 *              in the background
 *   completed  what the products (and stands in front) hide of a stand, filled in: a stand's sides are upright, so a
 *              hidden column continues down to the stand's bottom line and up to its top line (both followed from where
 *              they are seen), coloured from the nearest pixel of the stand seen in that column (its shading runs across
 *              it, not down it), else from its row
 *
 * The completed part is an estimate of pixels nobody saw; its share is reported, and a stand mostly hidden is flagged.
 */
type Box = { x: number; y: number; width: number; height: number };
export interface StandHint { box: Box; layer: 'own' | 'background'; id?: string }
export interface RiserInput {
  /** What stands on the stands (products) and in front of them (characters): boxes, and their masks when known. */
  objects: { box: Box; kind: 'product' | 'character'; mask?: Uint8Array }[];
  /** The shared podium (stays in the background); without one, only the administrator's own boxes become stands. */
  podium?: Box;
  /** Pixels of the background's ground colours. */
  ground: Uint8Array;
  hints?: StandHint[];
  /** Decorations and frames: never stands. */
  structures?: Box[];
  /** Given the floor's pixels (the podium's top the products and stands stand on) when one is found. */
  onFloor?: (pixels: number[]) => void;
}
export interface Riser {
  /** Its extent with the completed part. */
  box: Box;
  /** Full-canvas masks: its own visible pixels; visible and completed. */
  visible: Uint8Array; shape: Uint8Array;
  /** Its colours inside `box` (RGB, row by row): the picture's where it is seen, the estimate where it is completed. */
  rgb: Uint8Array;
  visiblePixels: number; completedPixels: number;
  source: 'auto' | 'user';
  /** The administrator's box it was made from. */
  hint?: string;
  /** The objects (indices into `objects`) standing on it. */
  under: number[];
  /** Mostly hidden (more of it completed than seen): its shape and colours are mostly an estimate. */
  uncertain: boolean;
  /** The lowest row it is seen at: the nearer of two stands is the lower one (back to front by it, not by `box`). */
  seenBottom: number;
  /** Its bottom is seen standing on something in enough columns (else it was continued down behind what hides it). */
  bottomSeen: boolean;
}

const STEP = 6, FINE_STEP = 3;
const within = (b: Box, x: number, y: number) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
const grow = (b: Box, m: number): Box => ({ x: b.x - m, y: b.y - m, width: b.width + 2 * m, height: b.height + 2 * m });

/** Stands in an RGB picture (with the text already taken out). */
export function findRisers(rgb: Uint8Array, w: number, h: number, input: RiserInput): Riser[] {
  const { objects, podium, ground } = input, hints = input.hints ?? [], structures = input.structures ?? [], n = w * h;
  const products = objects.filter(o => o.kind === 'product'), own = hints.filter(x => x.layer === 'own');
  if (!products.length && !own.length) return [];
  if (!podium && !own.length) return [];
  // 1 The display area: around the products, from their tops down to just into the podium (and every hint box).
  const boxes = [...products.map(o => o.box), ...own.map(x => x.box)];
  let ax0 = Math.min(...boxes.map(b => b.x)) - w * 0.05, ax1 = Math.max(...boxes.map(b => b.x + b.width)) + w * 0.05, ay0 = Math.min(...boxes.map(b => b.y));
  let ay1 = podium ? podium.y + podium.height * 0.15 : Math.max(...boxes.map(b => b.y + b.height)) + h * 0.05;
  for (const x of hints) { ax0 = Math.min(ax0, x.box.x); ax1 = Math.max(ax1, x.box.x + x.box.width); ay0 = Math.min(ay0, x.box.y); ay1 = Math.max(ay1, x.box.y + x.box.height); }
  const X0 = Math.max(0, Math.floor(ax0)), X1 = Math.min(w, Math.ceil(ax1)), Y0 = Math.max(0, Math.floor(ay0)), Y1 = Math.min(h, Math.ceil(ay1));
  if (X1 - X0 < 4 || Y1 - Y0 < 4) return [];
  const step = (i: number, j: number) => Math.max(Math.abs(rgb[i * 3] - rgb[j * 3]), Math.abs(rgb[i * 3 + 1] - rgb[j * 3 + 1]), Math.abs(rgb[i * 3 + 2] - rgb[j * 3 + 2]));
  const inArea = (x: number, y: number) => x >= X0 && x < X1 && y >= Y0 && y < Y1;

  // 2 Smooth regions.
  const label = new Int32Array(n).fill(-1);
  type Region = { px: number[]; x0: number; y0: number; x1: number; y1: number; mean: number[]; part: boolean; kind: 'part' | 'floor' | 'podium' | 'stand' | 'small' | 'other' };
  const regions: Region[] = [];
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const s = y * w + x; if (label[s] >= 0 || ground[s]) continue;
    const k = regions.length, px = [s], stack = [s]; label[s] = k;
    while (stack.length) {
      const i = stack.pop()!, xx = i % w, yy = (i - xx) / w;
      for (const [X, Y] of [[xx - 1, yy], [xx + 1, yy], [xx, yy - 1], [xx, yy + 1]]) {
        if (!inArea(X, Y)) continue; const j = Y * w + X;
        if (label[j] >= 0 || ground[j] || step(i, j) > STEP) continue;
        label[j] = k; px.push(j); stack.push(j);
      }
    }
    let rx0 = w, ry0 = h, rx1 = -1, ry1 = -1; const sum = [0, 0, 0];
    for (const i of px) { const xx = i % w, yy = (i - xx) / w; if (xx < rx0) rx0 = xx; if (xx > rx1) rx1 = xx; if (yy < ry0) ry0 = yy; if (yy > ry1) ry1 = yy; for (let c = 0; c < 3; c++) sum[c] += rgb[i * 3 + c]; }
    regions.push({ px, x0: rx0, y0: ry0, x1: rx1, y1: ry1, mean: sum.map(v => v / px.length), part: false, kind: 'other' });
  }
  const share = (r: Region, b: Box) => { let c = 0; for (const i of r.px) { const x = i % w; if (within(b, x, (i - x) / w)) c++; } return c / r.px.length; };
  const minSize = Math.max(60, Math.round(n * 0.00015));
  // 3 Kinds: parts of objects, the podium, the floor, stands.
  const classify = (r: Region) => {
    r.part = objects.some(o => share(r, o.box) >= 0.85);
    if (r.part) r.kind = 'part'; else if (podium && share(r, podium) >= 0.4) r.kind = 'podium'; else if (r.px.length < minSize) r.kind = 'small';
  };
  for (const r of regions) classify(r);
  let floor: Region | undefined;
  if (podium) {
    const band0 = podium.y - podium.height * 0.35, band1 = podium.y + podium.height * 0.1;
    // A floor a stand of nearly its colour leaked into (somewhere along their soft edge the colour steps by little): the
    // region then reaches above the podium's band. It is split again with finer steps: the largest part is the floor;
    // a part reaching above the band, not of the floor's colour, becomes a region of its own.
    for (const r of [...regions]) {
      if (r.kind !== 'other' || r.y1 < podium.y - 3 || r.y0 >= band0 || r.y0 > band1 || r.x1 - r.x0 < (X1 - X0) * 0.25) continue;
      const k0 = label[r.px[0]], inR = new Uint8Array(n); for (const i of r.px) inR[i] = 1;
      const subs: { px: number[]; top: number; mean: number[] }[] = [];
      for (const s0 of r.px) {
        if (inR[s0] !== 1) continue;
        const px = [s0], stack = [s0]; inR[s0] = 2; let top = h;
        while (stack.length) { const i = stack.pop()!, x = i % w; top = Math.min(top, (i - x) / w); for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < n && inR[j] === 1 && step(i, j) <= FINE_STEP) { inR[j] = 2; px.push(j); stack.push(j); } }
        subs.push({ px, top, mean: [0, 1, 2].map(c => px.reduce((s, i) => s + rgb[i * 3 + c], 0) / px.length) });
      }
      const main = subs.reduce((a, b) => (b.px.length > a.px.length ? b : a)), keep: number[] = [], parts: number[][] = [];
      for (const q of subs) { if (q === main || q.top >= band0 || Math.max(...[0, 1, 2].map(c => Math.abs(q.mean[c] - main.mean[c]))) <= 10) { for (const i of q.px) keep.push(i); } else parts.push(q.px); }
      if (!parts.length) continue;
      const bound = (q: Region, px: number[]) => { q.px = px; q.x0 = w; q.y0 = h; q.x1 = -1; q.y1 = -1; const sum = [0, 0, 0]; for (const i of px) { const x = i % w, y = (i - x) / w; if (x < q.x0) q.x0 = x; if (x > q.x1) q.x1 = x; if (y < q.y0) q.y0 = y; if (y > q.y1) q.y1 = y; for (let c = 0; c < 3; c++) sum[c] += rgb[i * 3 + c]; } q.mean = sum.map(v => v / px.length); };
      bound(r, keep); for (const i of keep) label[i] = k0;
      for (const px of parts) { const q: Region = { px, x0: 0, y0: 0, x1: 0, y1: 0, mean: [], part: false, kind: 'other' }; bound(q, px); for (const i of px) label[i] = regions.length; regions.push(q); classify(q); }
    }
    // Resting on the podium's band (a platform standing on the floor ends above it).
    for (const r of regions) if (r.kind === 'other' && r.y1 >= podium.y - 3 && r.y0 <= band1 && r.y0 >= band0 && (!floor || r.x1 - r.x0 > floor.x1 - floor.x0)) floor = r;
    if (floor && floor.x1 - floor.x0 < (X1 - X0) * 0.25) floor = undefined;
    if (floor) for (const r of regions) if (r.kind === 'other' && r.y1 >= band0 && r.y0 <= band1 && Math.max(...[0, 1, 2].map(c => Math.abs(r.mean[c] - floor!.mean[c]))) <= 10) r.kind = 'floor';
  }
  if (floor) input.onFloor?.(regions.filter(r => r.kind === 'floor').flatMap(r => r.px));
  const touchesProduct = (r: Region) => products.some(o => { const b = grow(o.box, 3); return r.x0 < b.x + b.width && r.x1 >= b.x && r.y0 < b.y + b.height && r.y1 >= b.y && r.y1 >= o.box.y + o.box.height * 0.5; });
  for (const r of regions) {
    if (r.kind !== 'other') continue;
    if (r.x1 - r.x0 < 7 || r.y1 - r.y0 < 3 || r.y0 <= Y0 + 1 || structures.some(b => share(r, b) >= 0.5) || !touchesProduct(r)) continue;
    r.kind = 'stand';
  }
  // 4 Stands of continuous colour joined; slivers between their shading bands taken in.
  const parent = regions.map((_, k) => k), root = (k: number): number => (parent[k] === k ? k : (parent[k] = root(parent[k])));
  const pairs = new Map<string, { a: number; b: number; steps: number[] }>();
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const i = y * w + x, a = label[i]; if (a < 0) continue;
    for (const j of [x + 1 < X1 ? i + 1 : -1, y + 1 < Y1 ? i + w : -1]) {
      if (j < 0) continue; const b = label[j]; if (b < 0 || b === a) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`; let p = pairs.get(key);
      if (!p) pairs.set(key, p = { a: Math.min(a, b), b: Math.max(a, b), steps: [] });
      p.steps.push(step(i, j));
    }
  }
  const median = (v: number[]) => [...v].sort((p, q) => p - q)[v.length >> 1];
  const boundary = new Map<number, number>();
  for (const p of pairs.values()) { boundary.set(p.a, (boundary.get(p.a) ?? 0) + p.steps.length); boundary.set(p.b, (boundary.get(p.b) ?? 0) + p.steps.length); }
  // Each region's borders, in the pairs' order (one pass: a scan of every pair per region is quadratic on a big picture).
  const borders = new Map<number, { a: number; b: number; steps: number[] }[]>();
  for (const p of pairs.values()) for (const k of [p.a, p.b]) { let list = borders.get(k); if (!list) borders.set(k, list = []); list.push(p); }
  for (const [k, r] of regions.entries()) {
    if (r.kind !== 'small' && r.kind !== 'other') continue;
    let best = -1, length = 0;
    for (const p of borders.get(k) ?? []) { const other = p.a === k ? p.b : p.a; if (regions[other].kind === 'stand' && p.steps.length > length) { best = other; length = p.steps.length; } }
    if (best >= 0 && r.px.length < minSize * 2 && length >= (boundary.get(k) ?? 1) * 0.3) { r.kind = 'stand'; parent[k] = root(best); }
  }
  for (const p of pairs.values()) {
    const A = regions[p.a], B = regions[p.b];
    // A stand shaded strongly from light to dark splits into bands: joined where the colour runs on across their edge.
    if (A.kind !== 'stand' || B.kind !== 'stand' || p.steps.length < 4 || median(p.steps) > 14 || Math.max(...[0, 1, 2].map(c => Math.abs(A.mean[c] - B.mean[c]))) > 90) continue;
    parent[root(p.a)] = root(p.b);
  }
  const groups = new Map<number, number[]>();
  for (const [k, r] of regions.entries()) if (r.kind === 'stand') { const g = root(k); let ks = groups.get(g); if (!ks) groups.set(g, ks = []); ks.push(k); }
  // 5 Hints: "part of the background" drops a found stand; "its own layer" makes everything in the box (but objects'
  // parts, and the floor or podium unless the box holds most of them) one stand.
  const found: { px: number[]; source: 'auto' | 'user'; hint?: string }[] = [];
  const inside = (px: number[], b: Box) => { let c = 0; for (const i of px) { const x = i % w; if (within(b, x, (i - x) / w)) c++; } return c / Math.max(1, px.length); };
  const bounds = (px: number[]) => { let x0 = w, y0 = h, x1 = -1, y1 = -1; for (const i of px) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, x1, y1 }; };
  // The products standing on it: over it (a third of their width at least), their feet on it — not below its bottom (a
  // dishwasher in front of a refrigerator's lower door, both grey, is one smooth region ending above their feet: no stand).
  const standingOn = (b: { x0: number; y0: number; x1: number; y1: number }) => objects.flatMap((o, j) => (o.kind === 'product' && Math.min(o.box.x + o.box.width, b.x1 + 1) - Math.max(o.box.x, b.x0) >= o.box.width * 0.3 && o.box.y + o.box.height >= b.y0 - 6 && o.box.y + o.box.height <= b.y1 ? [j] : []));
  for (const ks of groups.values()) {
    const px = ks.flatMap(k => regions[k].px);
    if (px.length < minSize || hints.some(x => inside(px, x.box) >= 0.5) || !standingOn(bounds(px)).length) continue;
    found.push({ px, source: 'auto' });
  }
  // A box marked as a stand: the smooth regions mostly inside it (in any colour, the background's too: a riser may be
  // drawn in it), not parts of objects; what continues well outside the box (the background, the floor) is not taken.
  // Finer steps than above: a stand the colour of the floor it stands on is still told from it at their soft edge.
  for (const x of own) {
    const b = { x: Math.max(0, Math.round(x.box.x)), y: Math.max(0, Math.round(x.box.y)), width: 0, height: 0 };
    b.width = Math.min(w, Math.round(x.box.x + x.box.width)) - b.x; b.height = Math.min(h, Math.round(x.box.y + x.box.height)) - b.y;
    const m = 8, WX0 = Math.max(0, b.x - m), WY0 = Math.max(0, b.y - m), WX1 = Math.min(w, b.x + b.width + m), WY1 = Math.min(h, b.y + b.height + m);
    const seen = new Uint8Array(n), px: number[] = [];
    for (let y = b.y; y < b.y + b.height; y++) for (let xx = b.x; xx < b.x + b.width; xx++) {
      const s0 = y * w + xx; if (seen[s0]) continue;
      const part = [s0], stack = [s0]; seen[s0] = 1;
      while (stack.length) {
        const i = stack.pop()!, X = i % w, Y = (i - X) / w;
        for (const [XX, YY] of [[X - 1, Y], [X + 1, Y], [X, Y - 1], [X, Y + 1]]) { if (XX < WX0 || YY < WY0 || XX >= WX1 || YY >= WY1) continue; const j = YY * w + XX; if (seen[j] || step(i, j) > 3) continue; seen[j] = 1; part.push(j); stack.push(j); }
      }
      if (inside(part, b) < 0.7) continue;
      for (const i of part) { const r = regions[label[i]]; if (!(r && r.kind === 'part') && !objects.some(o => o.mask?.[i] && r?.kind !== 'stand')) px.push(i); }
    }
    if (px.length) found.push({ px, source: 'user', ...(x.id ? { hint: x.id } : {}) });
  }
  if (!found.length) return [];
  // 5b A stand's thin edges left in an object's mask (its outline, a pale line between it and the object) go with the
  // stand: pieces of the mask at most 4 px thick next to it, in colours near the stand's own.
  {
    const near = new Int32Array(n).fill(-1);
    found.forEach((f, k) => { for (const i of f.px) { const x = i % w, y = (i - x) / w; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) near[Y * w + X] = k; } } });
    const erode = (m: Uint8Array) => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) { if (!m[i]) continue; const x = i % w; if (x > 0 && x < w - 1 && i >= w && i + w < n && m[i - 1] && m[i + 1] && m[i - w] && m[i + w] && m[i - w - 1] && m[i - w + 1] && m[i + w - 1] && m[i + w + 1]) o[i] = 1; } return o; };
    const dilate = (m: Uint8Array) => { const o = Uint8Array.from(m); for (let i = 0; i < n; i++) { if (!m[i]) continue; const x = i % w; for (const j of [i - 1, i + 1, i - w, i + w, i - w - 1, i - w + 1, i + w - 1, i + w + 1]) if (j >= 0 && j < n && Math.abs((j % w) - x) <= 1) o[j] = 1; } return o; };
    const taken = new Uint8Array(n); for (const f of found) for (const i of f.px) taken[i] = 1;
    for (const o of objects) {
      if (!o.mask) continue;
      const m = Uint8Array.from(o.mask); for (let i = 0; i < n; i++) if (taken[i]) m[i] = 0;
      const opened = dilate(dilate(erode(erode(m))));
      for (let i = 0; i < n; i++) {
        const k = near[i]; if (!m[i] || opened[i] || k < 0 || taken[i]) continue;
        const x = i % w, y = (i - x) / w; let best = Infinity;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const j = Y * w + X; if (taken[j]) best = Math.min(best, step(i, j)); }
        if (best <= 24) { found[k].px.push(i); taken[i] = 1; }
      }
    }
  }
  // 6 Completed behind what is in front: objects, and stands nearer (lower bottom) than this one.
  const anyStand = new Uint8Array(n); for (const f of found) for (const i of f.px) anyStand[i] = 1;
  const objectPixel = new Uint8Array(n);
  for (const o of objects) {
    if (o.mask) { for (let i = 0; i < n; i++) if (o.mask[i] && !anyStand[i]) objectPixel[i] = 1; continue; }
    for (let y = Math.max(0, o.box.y); y < Math.min(h, o.box.y + o.box.height); y++) for (let x = Math.max(0, o.box.x); x < Math.min(w, o.box.x + o.box.width); x++) { const i = y * w + x; if (!anyStand[i] && !ground[i]) objectPixel[i] = 1; }
  }
  // With the object's one-pixel rim (its soft edge goes with it), so no seam of the background is left in the stand.
  const rim = Uint8Array.from(objectPixel);
  for (let i = 0; i < n; i++) if (objectPixel[i]) { const x = i % w; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < n && !anyStand[j] && !ground[j]) rim[j] = 1; }
  objectPixel.set(rim);
  const character = new Uint8Array(n); for (const o of objects) if (o.kind === 'character' && o.mask) for (let i = 0; i < n; i++) if (o.mask[i]) character[i] = 1;
  const bottoms = found.map(f => f.px.reduce((b, i) => Math.max(b, Math.floor(i / w)), -1));
  const owner = new Int32Array(n).fill(-1); found.forEach((f, k) => { for (const i of f.px) owner[i] = k; });
  return found.map((f, k) => {
    const visible = new Uint8Array(n); for (const i of f.px) visible[i] = 1;
    const occluder = (i: number) => objectPixel[i] === 1 || (owner[i] >= 0 && owner[i] !== k && bottoms[owner[i]] > bottoms[k]);
    let bx0 = w, bx1 = -1; for (const i of f.px) { const x = i % w; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; }
    const cw = bx1 - bx0 + 1, topVis = new Float64Array(cw).fill(NaN), botVis = new Float64Array(cw).fill(NaN);
    for (const i of f.px) { const x = i % w, y = (i - x) / w, c = x - bx0; if (!(topVis[c] <= y)) topVis[c] = y; if (!(botVis[c] >= y)) botVis[c] = y; }
    // A line (top or bottom) where it is seen: columns whose end is not against something in front; failing that, the
    // columns reaching furthest. Elsewhere followed between them (straight), never short of what is seen.
    const line = (vis: Float64Array, dir: -1 | 1) => {
      const samples: [number, number][] = [];
      for (let c = 0; c < cw; c++) { if (Number.isNaN(vis[c])) continue; const y = vis[c] + dir; if (y < 0 || y >= h || !occluder(y * w + bx0 + c)) samples.push([c, vis[c]]); }
      // A stand's top and bottom are near-level arcs: an end far short of the furthest one is a gap, not the line.
      const ends = [...vis].filter(v => !Number.isNaN(v)), far = dir > 0 ? Math.max(...ends) : Math.min(...ends), slack = 3 + 0.15 * (Math.max(...ends) - Math.min(...ends));
      for (let q = samples.length - 1; q >= 0; q--) if (Math.abs(samples[q][1] - far) > slack) samples.splice(q, 1);
      if (!samples.length) for (let c = 0; c < cw; c++) if (!Number.isNaN(vis[c]) && Math.abs(vis[c] - far) <= 3) samples.push([c, vis[c]]);
      const out = new Float64Array(cw);
      for (let c = 0; c < cw; c++) {
        let L: [number, number] | undefined, R: [number, number] | undefined;
        for (const s of samples) { if (s[0] <= c && (!L || s[0] > L[0])) L = s; if (s[0] >= c && (!R || s[0] < R[0])) R = s; }
        const v = L && R ? (R[0] === L[0] ? L[1] : L[1] + (R[1] - L[1]) * (c - L[0]) / (R[0] - L[0])) : (L ?? R)![1];
        out[c] = Number.isNaN(vis[c]) ? Math.round(v) : dir > 0 ? Math.max(vis[c], Math.round(v)) : Math.min(vis[c], Math.round(v));
      }
      return out;
    };
    const top = line(topVis, -1), bottom = line(botVis, 1), shape = Uint8Array.from(visible), completedAt: number[] = [];
    // Its bottom hardly seen anywhere (behind products and nearer stands all along): a stand rests on the floor, so each
    // column reaches down behind what hides it, to the first pixel that is not in front of it. Not behind a character: one
    // standing in front says nothing of where the stand ends.
    let seenEnds = 0; for (let c = 0; c < cw; c++) { if (Number.isNaN(botVis[c])) continue; const y = botVis[c] + 1; if (y < h && !occluder(y * w + bx0 + c)) seenEnds++; }
    const bottomSeen = seenEnds >= Math.max(3, cw * 0.1);
    if (!bottomSeen) for (let c = 0; c < cw; c++) {
      let y = Math.max(top[c], Number.isNaN(botVis[c]) ? top[c] : botVis[c]) + 1; while (y < h && occluder(y * w + bx0 + c) && !character[y * w + bx0 + c]) y++;
      bottom[c] = Math.max(bottom[c], y - 1);
    }
    for (let c = 0; c < cw; c++) for (let y = Math.max(0, top[c]); y <= Math.min(h - 1, bottom[c]); y++) { const i = y * w + bx0 + c; if (!visible[i] && occluder(i)) { shape[i] = 1; completedAt.push(i); } }
    let x0 = w, y0 = h, x1 = -1, y1 = -1; for (let i = 0; i < n; i++) if (shape[i]) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const box = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }, out = new Uint8Array(box.width * box.height * 3), at = (i: number) => { const x = i % w, y = (i - x) / w; return ((y - y0) * box.width + x - x0) * 3; };
    for (const i of f.px) { const o = at(i); for (let c = 0; c < 3; c++) out[o + c] = rgb[i * 3 + c]; }
    // A seen pixel to copy from: not on its edge against something in front (an edge pixel carries that colour).
    const clear = (i: number) => { const x = i % w; return visible[i] === 1 && !(x > 0 && occluder(i - 1)) && !(x < w - 1 && occluder(i + 1)) && !(i >= w && occluder(i - w)) && !(i + w < n && occluder(i + w)); };
    const pending: number[] = [];
    for (const i of completedAt) {
      const x = i % w, y = (i - x) / w; let src = -1;
      for (let d = 1; d < h && src < 0; d++) { const up = y - d, dn = y + d; if (up < y0 && dn > y1) break; if (up >= y0 && clear(up * w + x)) src = up * w + x; else if (dn <= y1 && clear(dn * w + x)) src = dn * w + x; }
      if (src < 0) { pending.push(i); continue; }
      const o = at(i); for (let c = 0; c < 3; c++) out[o + c] = rgb[src * 3 + c];
    }
    // Columns with nothing seen: between the nearest coloured pixels of the row.
    const unfilled = new Set(pending), filled = (i: number) => shape[i] === 1 && !unfilled.has(i);
    for (const i of pending) {
      const x = i % w, y = (i - x) / w; let l = -1, r = -1;
      for (let xx = x - 1; xx >= x0; xx--) if (filled(y * w + xx)) { l = xx; break; }
      for (let xx = x + 1; xx <= x1; xx++) if (filled(y * w + xx)) { r = xx; break; }
      const o = at(i);
      if (l < 0 && r < 0) { shape[i] = 0; continue; }
      const a = at(y * w + (l >= 0 ? l : r)), b = at(y * w + (r >= 0 ? r : l)), t = l >= 0 && r >= 0 ? (x - l) / (r - l) : 0;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(out[a + c] + (out[b + c] - out[a + c]) * t);
    }
    const completed = completedAt.reduce((s, i) => s + shape[i], 0);
    const under = standingOn({ x0, y0, x1, y1 });
    return { box, visible, shape, rgb: out, visiblePixels: f.px.length, completedPixels: completed, source: f.source, ...(f.hint ? { hint: f.hint } : {}), under, uncertain: completed > f.px.length, seenBottom: bottoms[k], bottomSeen };
  });
}
