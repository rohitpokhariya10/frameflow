/**
 * Clean-background recovery for the recursive decomposition (recursiveDecomposition.ts): how hard the hole is, a
 * deterministic continuation for simple graphic backgrounds, and a quality check that any candidate background (the
 * provider base, Seedream's own scene layers, an AI edit, a fill) must pass before it is called clean.
 *
 * Offer creatives are mostly flat brand colors, white fields, gradients and large curves. When a person covers part of
 * them, the right hidden background is the natural continuation of those regions, not invented detail, and never a dark
 * silhouette. Everything here is local and deterministic; no model call.
 */
import { boxBlur, grow, maskedBlur, pushPull } from './outerBackground.js';
import { countOf, label } from './backgroundContamination.js';

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
/** Distance (largest channel difference) from pixel i to the nearest of `centers`, and which one; no allocation per pixel. */
function nearestCenter(centers: number[][], rgb: ArrayLike<number>, i: number): [number, number] {
  let best = Infinity, which = -1;
  for (let c = 0; c < centers.length; c++) {
    const d = Math.max(Math.abs(centers[c][0] - rgb[i * 3]), Math.abs(centers[c][1] - rgb[i * 3 + 1]), Math.abs(centers[c][2] - rgb[i * 3 + 2]));
    if (d < best) { best = d; which = c; }
  }
  return [best, which];
}
const maxDiff = (a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number) => Math.max(Math.abs(a[i * 3] - b[j * 3]), Math.abs(a[i * 3 + 1] - b[j * 3 + 1]), Math.abs(a[i * 3 + 2] - b[j * 3 + 2]));
const luminance = (rgb: ArrayLike<number>, i: number) => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];

/**
 * For each pixel inside `core` (1), the index of the nearest pixel outside it that `seed` allows (default: any outside
 * pixel), found by a breadth-first walk inward from the hole's edge (4-connected), and how far it is. -1 when none.
 */
export function nearestOutside(core: Uint8Array, w: number, h: number, seed?: (i: number) => boolean): { source: Int32Array; distance: Int32Array } {
  const n = w * h, source = new Int32Array(n).fill(-1), distance = new Int32Array(n).fill(-1), queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (core[i] || (seed && !seed(i))) continue;
    const x = i % w;
    if ((x > 0 && core[i - 1]) || (x < w - 1 && core[i + 1]) || (i >= w && core[i - w]) || (i < n - w && core[i + w])) { source[i] = i; distance[i] = 0; queue[tail++] = i; }
  }
  while (head < tail) {
    const i = queue[head++], x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
      if (j < 0 || !core[j] || source[j] >= 0) continue;
      source[j] = source[i]; distance[j] = distance[i] + 1; queue[tail++] = j;
    }
  }
  return { source, distance };
}

/**
 * The dominant flat colors of some pixels: k-means with k = 1…5 (farthest-point start, deterministic), the smallest k
 * whose centers are within `tolerance` of at least 92% of the pixels. explainedPercent: that share for the chosen k.
 */
export function palette(rgb: ArrayLike<number>, pixels: number[], tolerance = 36): { centers: number[][]; explainedPercent: number; simple: boolean } {
  const sample = pixels.length > 30000 ? pixels.filter((_, i) => i % Math.ceil(pixels.length / 30000) === 0) : pixels;
  if (!sample.length) return { centers: [], explainedPercent: 0, simple: false };
  const color = (i: number) => [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
  const distance = (c: number[], i: number) => Math.max(Math.abs(c[0] - rgb[i * 3]), Math.abs(c[1] - rgb[i * 3 + 1]), Math.abs(c[2] - rgb[i * 3 + 2]));
  let best = { centers: [] as number[][], explained: 0 };
  for (let k = 1; k <= 5; k++) {
    const mean = [0, 1, 2].map(c => sample.reduce((s, i) => s + rgb[i * 3 + c], 0) / sample.length);
    let centers: number[][] = [mean];
    while (centers.length < k) {
      let far = sample[0], farD = -1;
      for (const i of sample) { const d = Math.min(...centers.map(c => distance(c, i))); if (d > farD) { farD = d; far = i; } }
      centers.push(color(far));
    }
    for (let iter = 0; iter < 8; iter++) {
      const sums = centers.map(() => [0, 0, 0, 0]);
      for (const i of sample) {
        let bi = 0, bd = Infinity;
        centers.forEach((c, ci) => { const d = distance(c, i); if (d < bd) { bd = d; bi = ci; } });
        for (let c = 0; c < 3; c++) sums[bi][c] += rgb[i * 3 + c];
        sums[bi][3]++;
      }
      centers = centers.map((c, ci) => (sums[ci][3] ? [sums[ci][0] / sums[ci][3], sums[ci][1] / sums[ci][3], sums[ci][2] / sums[ci][3]] : c));
    }
    const explained = sample.filter(i => Math.min(...centers.map(c => distance(c, i))) <= tolerance).length / sample.length;
    best = { centers, explained };
    if (explained >= 0.92) break;
  }
  return { centers: best.centers.map(c => c.map(v => Math.round(v))), explainedPercent: round(100 * best.explained, 1), simple: best.explained >= 0.92 };
}

/** The pixels in a band of `radius` around the hole, outside it. */
const ringOf = (core: Uint8Array, w: number, h: number, radius: number) => {
  const grown = grow(core, w, h, radius), ring: number[] = [];
  for (let i = 0; i < core.length; i++) if (grown[i] && !core[i]) ring.push(i);
  return ring;
};

export type BackgroundDifficulty = {
  level: 'easy' | 'medium' | 'hard-large-occlusion';
  /** The removal mask's share of the canvas, its largest connected region's share, and how many regions it has. */
  coveragePercent: number; largestComponentPercent: number; components: number;
  /** Distinct background colors around the largest region: two or more means it crosses background geometry. */
  zones: number;
  /** The background around the hole is a few flat colors or gradients (an offer-creative design, not a photo). */
  simpleGraphic: boolean; palette: number[][]; explainedPercent: number;
};
/**
 * How hard the hidden background is to rebuild: hard-large-occlusion when one region covers at least 10% of the canvas
 * or the mask 25%, medium from 3% (or 8%, or a 1.5% region across two background zones), else easy.
 */
export function backgroundDifficulty(rgb: ArrayLike<number>, core: Uint8Array, w: number, h: number): BackgroundDifficulty {
  const n = w * h, coverage = countOf(core) / n;
  const { labels, count } = label(core, w, h), sizes = new Int32Array(count + 1);
  for (let i = 0; i < n; i++) sizes[labels[i]]++;
  let largest = 0, largestLabel = 0;
  for (let l = 1; l <= count; l++) if (sizes[l] > largest) { largest = sizes[l]; largestLabel = l; }
  const radius = Math.max(4, Math.round(0.03 * Math.max(w, h)));
  const around = palette(rgb, ringOf(core, w, h, radius));
  const lone = new Uint8Array(n);
  if (largestLabel) for (let i = 0; i < n; i++) if (labels[i] === largestLabel) lone[i] = 1;
  const zones = largestLabel ? palette(rgb, ringOf(lone, w, h, radius)).centers.length : 0;
  const largestShare = largest / n;
  const level = largestShare >= 0.1 || coverage >= 0.25 ? 'hard-large-occlusion' : largestShare >= 0.03 || coverage >= 0.08 || (zones >= 2 && largestShare >= 0.015) ? 'medium' : 'easy';
  return { level, coveragePercent: round(100 * coverage, 1), largestComponentPercent: round(100 * largestShare, 1), components: count, zones,
    simpleGraphic: around.simple, palette: around.centers, explainedPercent: around.explainedPercent };
}

/**
 * Deterministic continuation of a simple graphic background into the hole (`core` = 1): the colors around it are
 * clustered; each hidden pixel joins the region whose share, interpolated inward, is strongest there, so flat regions and
 * the boundaries between them (a white field meeting a yellow curve) continue crisply and smoothly; within a region the
 * color continues smoothly too (gradients). Undefined when the surroundings are not a few flat colors (a photo, a
 * texture): use another fill then.
 */
export function graphicFill(rgb: ArrayLike<number>, core: Uint8Array, w: number, h: number): Buffer | undefined {
  const n = w * h, radius = Math.max(4, Math.round(0.03 * Math.max(w, h)));
  const ring = ringOf(core, w, h, radius), pal = palette(rgb, ring);
  if (!pal.simple || !core.some(Boolean)) return undefined;
  const zone = grow(core, w, h, 3 * radius), labels = new Int8Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!zone[i] || core[i]) continue;
    const [d, which] = nearestCenter(pal.centers, rgb, i);
    labels[i] = d <= 60 ? which : -1;
  }
  // Colors joined by a smooth transition (one gradient the clustering split into several flat colors) are one region; a
  // crisp edge (a platform, a brand curve) separates regions. Otherwise a gradient's colors outvote each other and a
  // platform under a removed product wins the whole hole, leaving a lighter ghost of the product.
  const parent = pal.centers.map((_, c) => c), find = (c: number): number => (parent[c] === c ? c : (parent[c] = find(parent[c])));
  const bridges = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (labels[i] < 0) continue;
    const x = i % w;
    for (const j of [x < w - 1 ? i + 1 : -1, i + w < n ? i + w : -1]) {
      if (j < 0 || labels[j] < 0 || labels[j] === labels[i] || maxDiff(rgb, i, rgb, j) > 6) continue;
      const key = Math.min(labels[i], labels[j]) * 8 + Math.max(labels[i], labels[j]);
      bridges.set(key, (bridges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of bridges) if (count >= 10) parent[find(key >> 3)] = find(key & 7);
  const regionIds = [...new Set(pal.centers.map((_, c) => find(c)))], regionOf = pal.centers.map((_, c) => regionIds.indexOf(find(c)));
  for (let i = 0; i < n; i++) if (labels[i] >= 0) labels[i] = regionOf[labels[i]];
  const regions = regionIds.length;
  // Which region each hidden pixel belongs to: each region's share is interpolated smoothly inward from the pixels
  // around the hole (push-pull), and the strongest wins, so a boundary crossing the hole (a curve between a white field
  // and a yellow shape) continues as a smooth line between where it enters and leaves, not a staircase.
  // Only the thin band right at the hole's edge votes, so a region does not win by its size elsewhere (a big white field).
  const owner = new Int8Array(n).fill(-1), strength = new Float32Array(n);
  const edge = grow(core, w, h, Math.max(2, Math.round(radius / 3))), labeled = new Float32Array(n);
  for (let i = 0; i < n; i++) if (labels[i] >= 0 && edge[i]) labeled[i] = 1;
  for (let ci = 0; ci < regions; ci++) {
    const share = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) if (labeled[i] && labels[i] === ci) share[i * 3] = 1;
    const field = boxBlur(pushPull(share, labeled, w, h), w, h, 3, 2);
    for (let i = 0; i < n; i++) if (core[i] && field[i * 3] > strength[i]) { strength[i] = field[i * 3]; owner[i] = ci; }
  }
  // Where exactly two regions meet around a hole (a field and a brand curve, a wall and a panel), their boundary itself is
  // extended through it — as one smooth curve, or as straight edges meeting in a corner — which keeps the design's shape
  // where interpolation would let the larger region win. Hole by hole: each faces its own part of the design.
  if (regions >= 2) continueBoundaries(labels, core, owner, w, h, radius);
  const float = Float32Array.from(rgb), out = Buffer.from(Uint8Array.from(rgb));
  const r = Math.max(2, Math.round(radius / 2));
  for (let ci = 0; ci < regions; ci++) {
    const known = new Float32Array(n);
    let any = false;
    for (let i = 0; i < n; i++) if (labels[i] === ci) { known[i] = 1; any = true; }
    if (!any) continue;
    const model = boxBlur(pushPull(maskedBlur(float, known, w, h, r), known, w, h), w, h, 3, 1);
    for (let i = 0; i < n; i++) {
      if (!core[i] || owner[i] !== ci) continue;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(model[i * 3 + c])));
    }
  }
  // Any hidden pixel no colored region reached takes the plain continuation of everything around it.
  const unreached: number[] = [];
  for (let i = 0; i < n; i++) if (core[i] && owner[i] < 0) unreached.push(i);
  if (unreached.length) {
    const known = new Float32Array(n);
    for (let i = 0; i < n; i++) known[i] = core[i] ? 0 : 1;
    const model = pushPull(maskedBlur(float, known, w, h, r), known, w, h);
    for (const i of unreached) for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(model[i * 3 + c])));
  }
  return out;
}

/**
 * For each hole (connected region of `core`) around which exactly two regions meet: its pixels take the side of their
 * extended boundary (fitBoundary, else fitAxisBoundary). Worked in the hole's own window, so its cost is its size.
 */
function continueBoundaries(labels: Int8Array, core: Uint8Array, owner: Int8Array, w: number, h: number, radius: number) {
  const { labels: holes, count } = label(core, w, h), reach = 6 * radius;
  const boxes = Array.from({ length: count + 1 }, () => ({ x0: w, y0: h, x1: -1, y1: -1 }));
  for (let i = 0; i < core.length; i++) if (holes[i]) { const b = boxes[holes[i]], x = i % w, y = (i - x) / w; if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; }
  for (let k = 1; k <= count; k++) {
    const b = boxes[k], wx0 = Math.max(0, b.x0 - reach), wy0 = Math.max(0, b.y0 - reach), ww = Math.min(w - 1, b.x1 + reach) - wx0 + 1, wh = Math.min(h - 1, b.y1 + reach) - wy0 + 1;
    const own = new Uint8Array(ww * wh), local = new Int8Array(ww * wh).fill(-1), localCore = new Uint8Array(ww * wh);
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) { const i = (wy0 + y) * w + wx0 + x, j = y * ww + x; own[j] = holes[i] === k ? 1 : 0; localCore[j] = core[i]; local[j] = labels[i]; }
    const near = grow(own, ww, wh, reach), present = new Set<number>();
    for (let j = 0; j < own.length; j++) if (near[j] && !localCore[j] && local[j] >= 0) present.add(local[j]);
    if (present.size !== 2) continue;
    const [a, c] = [...present], pair = new Int8Array(own.length).fill(-1);
    for (let j = 0; j < own.length; j++) pair[j] = local[j] === a ? 0 : local[j] === c ? 1 : -1;
    const fit = fitBoundary(pair, own, ww, wh, radius) ?? fitAxisBoundary(pair, own, ww, wh, radius);
    if (!fit) continue;
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
      if (!own[y * ww + x]) continue;
      const side = fit.labelAt(x, y);
      if (side >= 0) owner[(wy0 + y) * w + wx0 + x] = side === 0 ? a : c;
    }
  }
}
/**
 * The boundary between two regions (labels 0 and 1) near the hole as straight axis-aligned edges: a horizontal edge at
 * one y, a vertical one at one x, or both (a panel's top and side meeting in a corner), each found where 80% of that
 * orientation's boundary pixels lie within 2 px of one line. Each side (or quadrant) takes the region that holds it
 * around the hole (80% purity); undefined when no straight edge or no clear side.
 */
function fitAxisBoundary(labels: Int8Array, core: Uint8Array, w: number, h: number, radius: number): { labelAt: (x: number, y: number) => number } | undefined {
  const near = grow(core, w, h, 6 * radius), across: number[] = [], along: number[] = [];
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    if (!near[i] || core[i] || labels[i] < 0) continue;
    if (labels[i + w] >= 0 && labels[i + w] !== labels[i] && !core[i + w]) across.push(y + 0.5);
    if (labels[i + 1] >= 0 && labels[i + 1] !== labels[i] && !core[i + 1]) along.push(x + 0.5);
  }
  const line = (values: number[]) => {
    if (values.length < 10) return undefined;
    const sorted = [...values].sort((p, q) => p - q), middle = sorted[sorted.length >> 1];
    return values.filter(v => Math.abs(v - middle) <= 2).length >= 0.8 * values.length ? middle : undefined;
  };
  const yc = line(across), xc = line(along);
  if (yc === undefined && xc === undefined) return undefined;
  const part = (x: number, y: number) => (yc !== undefined && y > yc ? 2 : 0) + (xc !== undefined && x > xc ? 1 : 0);
  const votes = [[0, 0], [0, 0], [0, 0], [0, 0]];
  for (let i = 0; i < labels.length; i++) if (near[i] && !core[i] && labels[i] >= 0) votes[part(i % w, (i - (i % w)) / w)][labels[i]]++;
  const sides = votes.map(v => (v[0] + v[1] ? (v[0] >= v[1] ? 0 : 1) : -1));
  if (votes.some(v => v[0] + v[1] > 0 && Math.max(v[0], v[1]) < 0.8 * (v[0] + v[1]))) return undefined;
  // A single straight edge must separate the two regions; with two, at least two parts must differ (a corner).
  if (new Set(sides.filter(side => side >= 0)).size < 2) return undefined;
  return { labelAt: (x, y) => sides[part(x, y)] };
}

/** Least-squares quadratic v = a·u² + b·u + c; returns the coefficients and the RMS residual, or undefined when degenerate. */
function fitQuadratic(us: number[], vs: number[]): { at: (u: number) => number; rms: number } | undefined {
  const n = us.length;
  if (n < 3) return undefined;
  // Normal equations for [a, b, c], on u centered and scaled for stability.
  const mean = us.reduce((s, u) => s + u, 0) / n, scale = Math.max(1, Math.max(...us.map(u => Math.abs(u - mean))));
  const S = [0, 0, 0, 0, 0], T = [0, 0, 0];
  for (let i = 0; i < n; i++) { const u = (us[i] - mean) / scale; let p = 1; for (let k = 0; k < 5; k++) { S[k] += p; p *= u; } T[0] += vs[i]; T[1] += vs[i] * u; T[2] += vs[i] * u * u; }
  const m = [[S[4], S[3], S[2]], [S[3], S[2], S[1]], [S[2], S[1], S[0]]], t = [T[2], T[1], T[0]];
  const det = (q: number[][]) => q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) + q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-9) return undefined;
  const coef = [0, 1, 2].map(k => det(m.map((row, r) => row.map((v, c) => (c === k ? t[r] : v)))) / d);
  const at = (u: number) => { const x = (u - mean) / scale; return coef[0] * x * x + coef[1] * x + coef[2]; };
  const rms = Math.sqrt(us.reduce((s, u, i) => s + (vs[i] - at(u)) ** 2, 0) / n);
  return { at, rms };
}
/**
 * The visible boundary between two regions near the hole, as one smooth curve (x = f(y) or y = f(x), whichever fits),
 * with which region lies on each side. Undefined unless the boundary really is one smooth curve (RMS within 1.5% of the
 * image) and each side is clearly one region (80%): then the share field is used instead.
 */
function fitBoundary(labels: Int8Array, core: Uint8Array, w: number, h: number, radius: number): { labelAt: (x: number, y: number) => number } | undefined {
  const near = grow(core, w, h, 6 * radius), xs: number[] = [], ys: number[] = [];
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    if (!near[i] || core[i] || labels[i] < 0) continue;
    const right = labels[i + 1], down = labels[i + w];
    if ((right >= 0 && right !== labels[i] && !core[i + 1]) || (down >= 0 && down !== labels[i] && !core[i + w])) { xs.push(x + 0.5); ys.push(y + 0.5); }
  }
  if (xs.length < 20) return undefined;
  const byY = fitQuadratic(ys, xs), byX = fitQuadratic(xs, ys);
  const best = !byY ? byX && { fit: byX, side: (x: number, y: number) => y - byX.at(x) } : !byX || byY.rms <= byX.rms ? { fit: byY, side: (x: number, y: number) => x - byY.at(y) } : { fit: byX, side: (x: number, y: number) => y - byX.at(x) };
  if (!best || best.fit.rms > 0.015 * Math.max(w, h)) return undefined;
  // Which region is on which side, from the labeled pixels around the hole.
  const edge = grow(core, w, h, 2 * radius), votes = [[0, 0], [0, 0]];
  for (let i = 0; i < labels.length; i++) if (edge[i] && !core[i] && labels[i] >= 0 && labels[i] < 2) votes[best.side(i % w, (i - (i % w)) / w) >= 0 ? 1 : 0][labels[i]]++;
  const sideLabel = votes.map(v => (v[0] + v[1] ? (v[0] >= v[1] ? 0 : 1) : -1)), purity = votes.map(v => Math.max(v[0], v[1]) / Math.max(1, v[0] + v[1]));
  if (sideLabel[0] < 0 || sideLabel[1] < 0 || sideLabel[0] === sideLabel[1] || purity.some(p => p < 0.8)) return undefined;
  return { labelAt: (x, y) => sideLabel[best.side(x, y) >= 0 ? 1 : 0] };
}

/** Solves the symmetric system m·x = t (Gaussian elimination with partial pivoting); undefined when singular. */
function solve(m: number[][], t: number[]): number[] | undefined {
  const k = t.length, a = m.map((row, r) => [...row, t[r]]);
  for (let c = 0; c < k; c++) {
    let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-9) return undefined;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < k; r++) { if (r === c) continue; const f = a[r][c] / a[c][c]; for (let j = c; j <= k; j++) a[r][j] -= f * a[c][j]; }
  }
  return a.map((row, r) => row[k] / row[r]);
}
/**
 * A smooth color surface over some pixels: per channel, v = a + b·u + c·v + d·u² + e·u·v + f·v² on coordinates centered
 * on (cx, cy) and scaled to about ±1, fitted by least squares and refitted twice without outliers (a bit of text, a
 * button edge or a platform in the ring). explained: share of the pixels within 18 of the surface; sigma: robust spread of the inliers.
 * A flat color, a linear or radial gradient and a soft vignette all fit; a step between two regions does not.
 */
export function fitSurface(rgb: ArrayLike<number>, pixels: number[], w: number, cx: number, cy: number, scale: number): { at: (x: number, y: number, out: number[]) => void; explained: number; sigma: number } | undefined {
  const sample = pixels.length > 20000 ? pixels.filter((_, i) => i % Math.ceil(pixels.length / 20000) === 0) : pixels;
  if (sample.length < 40) return undefined;
  const basis = (x: number, y: number) => { const u = (x - cx) / scale, v = (y - cy) / scale; return [1, u, v, u * u, u * v, v * v]; };
  const fit = (use: number[]) => {
    const m = Array.from({ length: 6 }, () => new Array(6).fill(0)), t = [0, 1, 2].map(() => new Array(6).fill(0));
    for (const i of use) {
      const b = basis(i % w, (i - (i % w)) / w);
      for (let r = 0; r < 6; r++) { for (let c = 0; c < 6; c++) m[r][c] += b[r] * b[c]; for (let ch = 0; ch < 3; ch++) t[ch][r] += b[r] * rgb[i * 3 + ch]; }
    }
    // A tiny ridge keeps a one-sided ring (a hole against the canvas edge) solvable; it barely moves a well-posed fit.
    for (let r = 0; r < 6; r++) m[r][r] += 1e-6 * use.length;
    const coef = t.map(rhs => solve(m, rhs));
    return coef.every(Boolean) ? coef as number[][] : undefined;
  };
  const value = (coef: number[][], i: number, out: number[]) => { const b = basis(i % w, (i - (i % w)) / w); for (let ch = 0; ch < 3; ch++) { let s = 0; for (let k = 0; k < 6; k++) s += coef[ch][k] * b[k]; out[ch] = s; } };
  const residual = (coef: number[][]) => { const out = [0, 0, 0]; return sample.map(i => { value(coef, i, out); return Math.max(Math.abs(rgb[i * 3] - out[0]), Math.abs(rgb[i * 3 + 1] - out[1]), Math.abs(rgb[i * 3 + 2] - out[2])); }); };
  let coef = fit(sample);
  if (!coef) return undefined;
  // Refitted without outliers, the cut set by the field's own pixel noise (how much neighbours differ), not by the fit:
  // a design element a little lighter or darker than the field (a white platform on lavender), all on one side of the
  // ring, would otherwise bend the surface toward itself and keep itself in.
  const steps = sample.filter(i => (i % w) + 1 < w).map(i => maxDiff(rgb, i, rgb, i + 1)).sort((a, b) => a - b);
  const cut = 8 + 3 * 1.4826 * (steps[steps.length >> 1] ?? 0);
  for (let round = 0; round < 3; round++) {
    const current = residual(coef);
    const inliers = sample.filter((_, k) => current[k] <= cut);
    if (inliers.length < 40 || inliers.length === sample.length) break;
    coef = fit(inliers) ?? coef;
  }
  const final = residual(coef), inner = final.filter(r => r <= 18).sort((a, b) => a - b);
  const c = coef;
  return { at: (x, y, out) => value(c, y * w + x, out), explained: final.filter(r => r <= 18).length / final.length, sigma: inner.length ? 1.4826 * inner[inner.length >> 1] : Infinity };
}

export type PlainRegion = { areaPercent: number; position: [number, number]; explainedPercent: number; sigma: number; plain: boolean };
/**
 * The removed area (`core` = 1) as the continuation of a plain background field: each connected region is filled with
 * the smooth surface (fitSurface) of the ring around it. `plain` only when every region's ring is such a field (a flat
 * brand color, a gradient, a soft glow or vignette: 97% of its pixels within 18 of the surface, little texture). Then the
 * fill is the clean background itself, with no shadow, silhouette or invented detail, and no model call is needed. A
 * region whose surroundings cross a design boundary (a curve between two colors, a wall meeting a floor) makes it not
 * plain; those need the region-aware continuation (graphicFill) or the image edit.
 */
export function plainFieldFill(rgb: ArrayLike<number>, core: Uint8Array, w: number, h: number): { out: Buffer; plain: boolean; regions: PlainRegion[] } {
  const n = w * h, out = Buffer.from(Uint8Array.from(rgb)), regions: PlainRegion[] = [];
  const { labels, count } = label(core, w, h);
  if (!count) return { out, plain: true, regions };
  const members: number[][] = Array.from({ length: count + 1 }, () => []);
  for (let i = 0; i < n; i++) if (labels[i]) members[labels[i]].push(i);
  const radius = Math.max(4, Math.round(0.04 * Math.max(w, h))), color = [0, 0, 0];
  let plain = true;
  for (let l = 1; l <= count; l++) {
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (const i of members[l]) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    // The ring, grown inside the region's own window (a region's cost is its size, not the canvas's).
    const wx0 = Math.max(0, x0 - radius), wy0 = Math.max(0, y0 - radius), ww = Math.min(w - 1, x1 + radius) - wx0 + 1, wh = Math.min(h - 1, y1 + radius) - wy0 + 1;
    const own = new Uint8Array(ww * wh);
    for (const i of members[l]) { const x = i % w, y = (i - x) / w; own[(y - wy0) * ww + (x - wx0)] = 1; }
    const grown = grow(own, ww, wh, radius), ring: number[] = [];
    for (let j = 0; j < grown.length; j++) { if (!grown[j]) continue; const i = (wy0 + Math.floor(j / ww)) * w + wx0 + (j % ww); if (!core[i]) ring.push(i); }
    const fit = fitSurface(rgb, ring, w, (x0 + x1) / 2, (y0 + y1) / 2, Math.max(8, (x1 - x0) / 2 + radius, (y1 - y0) / 2 + radius));
    // Nearly all of the ring on one smooth surface: a design element running under the removed area (a platform, a brand
    // shape) makes it not plain, so it continues region by region instead of being painted over.
    const ok = !!fit && fit.explained >= 0.97 && fit.sigma <= 6;
    regions.push({ areaPercent: round(100 * members[l].length / n, 2), position: [round((x0 + x1) / 2 / w, 2), round((y0 + y1) / 2 / h, 2)], explainedPercent: fit ? round(100 * fit.explained, 1) : 0, sigma: fit ? round(fit.sigma, 1) : -1, plain: ok });
    if (!ok) { plain = false; continue; }
    for (const i of members[l]) { fit!.at(i % w, (i - (i % w)) / w, color); for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(color[c]))); }
  }
  return { out, plain, regions };
}

export type BackgroundQualityReason = 'black-region' | 'darkened-region' | 'novel-content' | 'boundary-discontinuity' | 'large-unexpected-change' | 'foreground-reappeared' | 'silhouette-residue' | 'background-mismatch';
export type BackgroundQuality = {
  quality: 'usable' | 'degraded' | 'failed'; reasons: BackgroundQualityReason[];
  metrics: {
    /** Inside the removed area: near-black share (only when the surroundings are not dark themselves), mean darkening
     * against the surroundings (luminance), share of colors found nowhere around it, and share of its edge band that
     * jumps away from the pixel just outside (a seam, a silhouette, a hole in a curve). */
    blackPercent: number; darkShift: number; novelPercent: number; boundaryDiscontinuityPercent: number;
    /** Inside the removed area: share that is a ghost of what was removed — a darker, same-hue silhouette or shadow left
     * over the expected clean continuation, any visible deviation from it on a plain field, or a blot darker than
     * almost everything around it. 0 when nothing is known to compare with. */
    residuePercent: number;
    /** Provider and scene candidates: share of the image outside the removed area that differs from the original there
     * (a re-rendered or placeholder base, a grey slab where the creative shows its background). */
    backgroundMismatchPercent?: number;
    /** AI candidates only: share of the image outside the removed area that the model changed (it re-rendered the scene). */
    outsideMaskChangedPercent?: number;
    recreatedLayers: number;
  };
};
/** Chroma-consistent darkening: `rgb` at i is `expected` at i scaled by one factor k < 1 (a shadow, a dimmed ghost). */
export function darkenedBy(rgb: ArrayLike<number>, expected: ArrayLike<number>, i: number): number {
  const le = luminance(expected, i), lo = luminance(rgb, i);
  if (le < 24 || lo >= le) return 0;
  const k = lo / le;
  for (let c = 0; c < 3; c++) if (Math.abs(rgb[i * 3 + c] - k * expected[i * 3 + c]) > 16 + 0.15 * expected[i * 3 + c]) return 0;
  return 1 - k;
}
/**
 * Whether a candidate background is usable where the foreground was removed (`core` = 1), on the analysis grid. Each
 * metric is the worst removed region of at least 0.5% of the image (a person), not an average over every hole.
 * failed: a black silhouette or dark hole (black ≥ 10%), a seam along most of the edge (≥ 40%), mostly foreign colors
 * (≥ 35%), a ghost of the removed subject (residue ≥ 12%), a background that is not the creative's outside the removed
 * area (mismatch ≥ 20%) or a removed layer recreated. degraded: black ≥ 3%, seam ≥ 20%, foreign colors ≥ 15%, residue ≥
 * 4%, mismatch ≥ 6%, darkened by ≥ 50, or an AI result that changed ≥ 40% of what lies outside the mask.
 * `expected`: the clean continuation of the surroundings (plainFieldFill or graphicFill of the original), `plain` when it
 * is a plain field (then any visible deviation is residue). `original`: compared outside the removed area. Never retries
 * anything; it only reports.
 */
export function backgroundQuality(input: { rgb: ArrayLike<number>; core: Uint8Array; w: number; h: number; outside?: { ai: ArrayLike<number>; source: ArrayLike<number> }; recreated?: number;
  expected?: ArrayLike<number>; plain?: boolean; original?: ArrayLike<number> }): BackgroundQuality {
  const { rgb, core, w, h, expected } = input, n = w * h, inner = countOf(core);
  const empty = { blackPercent: 0, darkShift: 0, novelPercent: 0, boundaryDiscontinuityPercent: 0, residuePercent: 0, recreatedLayers: input.recreated ?? 0 };
  if (!inner) return { quality: 'usable', reasons: [], metrics: empty };
  const ring = ringOf(core, w, h, Math.max(3, Math.round(0.02 * Math.max(w, h)))), pal = palette(rgb, ring);
  const ringDark = ring.filter(i => Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) < 45).length / Math.max(1, ring.length);
  // A blot darker than nearly everything around the hole: a silhouette even where no clean continuation is known.
  const ringLums = ring.map(i => luminance(rgb, i)).sort((a, b) => a - b), ringLow = ringLums.length ? ringLums[Math.floor(0.05 * (ringLums.length - 1))] : 0;
  // Residue is judged on a lightly smoothed candidate, so texture and noise do not count, a soft ghost does.
  const smooth = expected ? boxBlur(Float32Array.from(rgb), w, h, 3, 1) : undefined;
  // Measured per removed region and reported for the worst large one (at least 0.5% of the image, else all together), so
  // a broken person-sized hole is not averaged away by small clean holes around text and buttons.
  const { labels, count } = label(core, w, h), { source, distance } = nearestOutside(core, w, h);
  const stats = Array.from({ length: count + 1 }, () => ({ size: 0, black: 0, novel: 0, lum: 0, band: 0, jumps: 0, residue: 0 }));
  for (let i = 0; i < n; i++) {
    if (!core[i]) continue;
    const s = stats[labels[i]], lum = luminance(rgb, i);
    s.size++; s.lum += lum;
    if (Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) < 40) s.black++;
    if (nearestCenter(pal.centers, rgb, i)[0] > 60) s.novel++;
    if (source[i] >= 0 && distance[i] <= 3) { s.band++; if (maxDiff(rgb, i, rgb, source[i]) > 60) s.jumps++; }
    if (smooth && expected) {
      const depth = darkenedBy(smooth, expected, i), drop = luminance(expected, i) - luminance(smooth, i);
      if ((depth >= 0.1 && drop >= 14) || (input.plain && maxDiff(smooth, i, expected, i) > 32)) { s.residue++; continue; }
    }
    if (ringLums.length && lum < ringLow - 30) s.residue++;
  }
  const regions = stats.slice(1).filter(s => s.size), large = regions.filter(s => s.size >= 0.005 * n);
  const all = regions.reduce((t, s) => ({ size: t.size + s.size, black: t.black + s.black, novel: t.novel + s.novel, lum: t.lum + s.lum, band: t.band + s.band, jumps: t.jumps + s.jumps, residue: t.residue + s.residue }),
    { size: 0, black: 0, novel: 0, lum: 0, band: 0, jumps: 0, residue: 0 });
  const judged = large.length ? large : [all], worst = (f: (s: typeof all) => number) => Math.max(...judged.map(f));
  const ringLum = ring.reduce((s, i) => s + luminance(rgb, i), 0) / Math.max(1, ring.length);
  const metrics = { blackPercent: ringDark < 0.05 ? round(worst(s => 100 * s.black / s.size), 1) : 0, darkShift: round(worst(s => ringLum - s.lum / s.size), 1), novelPercent: round(worst(s => 100 * s.novel / s.size), 1),
    boundaryDiscontinuityPercent: round(worst(s => 100 * s.jumps / Math.max(1, s.band)), 1), residuePercent: round(worst(s => 100 * s.residue / s.size), 1), recreatedLayers: input.recreated ?? 0 } as BackgroundQuality['metrics'];
  if (input.outside || input.original) {
    const keep = grow(core, w, h, 2);
    let outside = 0, changed = 0, mismatched = 0;
    for (let i = 0; i < n; i++) {
      if (keep[i]) continue;
      outside++;
      if (input.outside && maxDiff(input.outside.ai, i, input.outside.source, i) > 40) changed++;
      if (input.original && maxDiff(rgb, i, input.original, i) > 40) mismatched++;
    }
    if (input.outside) metrics.outsideMaskChangedPercent = round(100 * changed / Math.max(1, outside), 1);
    if (input.original) metrics.backgroundMismatchPercent = round(100 * mismatched / Math.max(1, outside), 1);
  }
  const failed: BackgroundQualityReason[] = [], degraded: BackgroundQualityReason[] = [];
  const check = (reason: BackgroundQualityReason, value: number, fail: number, degrade: number) => { if (value >= fail) failed.push(reason); else if (value >= degrade) degraded.push(reason); };
  check('black-region', metrics.blackPercent, 10, 3);
  check('boundary-discontinuity', metrics.boundaryDiscontinuityPercent, 40, 20);
  check('novel-content', metrics.novelPercent, 35, 15);
  check('silhouette-residue', metrics.residuePercent, 12, 4);
  check('background-mismatch', metrics.backgroundMismatchPercent ?? 0, 20, 6);
  check('darkened-region', metrics.darkShift, Infinity, 50);
  check('large-unexpected-change', metrics.outsideMaskChangedPercent ?? 0, Infinity, 40);
  if (metrics.recreatedLayers) failed.push('foreground-reappeared');
  return { quality: failed.length ? 'failed' : degraded.length ? 'degraded' : 'usable', reasons: [...failed, ...degraded], metrics };
}
