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
  // Which region each hidden pixel belongs to: each region's share is interpolated smoothly inward from the pixels
  // around the hole (push-pull), and the strongest wins, so a boundary crossing the hole (a curve between a white field
  // and a yellow shape) continues as a smooth line between where it enters and leaves, not a staircase.
  // Only the thin band right at the hole's edge votes, so a region does not win by its size elsewhere (a big white field).
  const owner = new Int8Array(n).fill(-1), strength = new Float32Array(n);
  const edge = grow(core, w, h, Math.max(2, Math.round(radius / 3))), labeled = new Float32Array(n);
  for (let i = 0; i < n; i++) if (labels[i] >= 0 && edge[i]) labeled[i] = 1;
  for (let ci = 0; ci < pal.centers.length; ci++) {
    const share = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) if (labeled[i] && labels[i] === ci) share[i * 3] = 1;
    const field = boxBlur(pushPull(share, labeled, w, h), w, h, 3, 2);
    for (let i = 0; i < n; i++) if (core[i] && field[i * 3] > strength[i]) { strength[i] = field[i * 3]; owner[i] = ci; }
  }
  // Two regions with one smooth visible boundary (a field and a brand curve): the boundary itself is extrapolated
  // through the hole, which keeps the curve's shape where interpolation would let the larger region win.
  if (pal.centers.length === 2) {
    const curve = fitBoundary(labels, core, w, h, radius);
    if (curve) for (let i = 0; i < n; i++) if (core[i]) owner[i] = curve.labelAt(i % w, (i - (i % w)) / w);
  }
  const float = Float32Array.from(rgb), out = Buffer.from(Uint8Array.from(rgb));
  const r = Math.max(2, Math.round(radius / 2));
  for (let ci = 0; ci < pal.centers.length; ci++) {
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

export type BackgroundQualityReason = 'black-region' | 'darkened-region' | 'novel-content' | 'boundary-discontinuity' | 'large-unexpected-change' | 'foreground-reappeared';
export type BackgroundQuality = {
  quality: 'usable' | 'degraded' | 'failed'; reasons: BackgroundQualityReason[];
  metrics: {
    /** Inside the removed area: near-black share (only when the surroundings are not dark themselves), mean darkening
     * against the surroundings (luminance), share of colors found nowhere around it, and share of its edge band that
     * jumps away from the pixel just outside (a seam, a silhouette, a hole in a curve). */
    blackPercent: number; darkShift: number; novelPercent: number; boundaryDiscontinuityPercent: number;
    /** AI candidates only: share of the image outside the removed area that the model changed (it re-rendered the scene). */
    outsideMaskChangedPercent?: number;
    recreatedLayers: number;
  };
};
/**
 * Whether a candidate background is usable where the foreground was removed (`core` = 1), on the analysis grid. Each
 * metric is the worst removed region of at least 0.5% of the image (a person), not an average over every hole.
 * failed: a black silhouette or dark hole (black ≥ 10%), a seam along most of the edge (≥ 40%), mostly foreign colors
 * (≥ 35%) or a removed layer recreated. degraded: black ≥ 3%, seam ≥ 20%, foreign colors ≥ 15%, darkened by ≥ 50, or an
 * AI result that changed ≥ 40% of what lies outside the mask. Never retries anything; it only reports.
 */
export function backgroundQuality(input: { rgb: ArrayLike<number>; core: Uint8Array; w: number; h: number; outside?: { ai: ArrayLike<number>; source: ArrayLike<number> }; recreated?: number }): BackgroundQuality {
  const { rgb, core, w, h } = input, n = w * h, inner = countOf(core);
  const empty = { blackPercent: 0, darkShift: 0, novelPercent: 0, boundaryDiscontinuityPercent: 0, recreatedLayers: input.recreated ?? 0 };
  if (!inner) return { quality: 'usable', reasons: [], metrics: empty };
  const ring = ringOf(core, w, h, Math.max(3, Math.round(0.02 * Math.max(w, h)))), pal = palette(rgb, ring);
  const ringDark = ring.filter(i => Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) < 45).length / Math.max(1, ring.length);
  // Measured per removed region and reported for the worst large one (at least 0.5% of the image, else all together), so
  // a broken person-sized hole is not averaged away by small clean holes around text and buttons.
  const { labels, count } = label(core, w, h), { source, distance } = nearestOutside(core, w, h);
  const stats = Array.from({ length: count + 1 }, () => ({ size: 0, black: 0, novel: 0, lum: 0, band: 0, jumps: 0 }));
  for (let i = 0; i < n; i++) {
    if (!core[i]) continue;
    const s = stats[labels[i]];
    s.size++; s.lum += luminance(rgb, i);
    if (Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) < 40) s.black++;
    if (nearestCenter(pal.centers, rgb, i)[0] > 60) s.novel++;
    if (source[i] >= 0 && distance[i] <= 3) { s.band++; if (maxDiff(rgb, i, rgb, source[i]) > 60) s.jumps++; }
  }
  const regions = stats.slice(1).filter(s => s.size), large = regions.filter(s => s.size >= 0.005 * n);
  const all = regions.reduce((t, s) => ({ size: t.size + s.size, black: t.black + s.black, novel: t.novel + s.novel, lum: t.lum + s.lum, band: t.band + s.band, jumps: t.jumps + s.jumps }), { size: 0, black: 0, novel: 0, lum: 0, band: 0, jumps: 0 });
  const judged = large.length ? large : [all], worst = (f: (s: typeof all) => number) => Math.max(...judged.map(f));
  const ringLum = ring.reduce((s, i) => s + luminance(rgb, i), 0) / Math.max(1, ring.length);
  const metrics = { blackPercent: ringDark < 0.05 ? round(worst(s => 100 * s.black / s.size), 1) : 0, darkShift: round(worst(s => ringLum - s.lum / s.size), 1), novelPercent: round(worst(s => 100 * s.novel / s.size), 1),
    boundaryDiscontinuityPercent: round(worst(s => 100 * s.jumps / Math.max(1, s.band)), 1), recreatedLayers: input.recreated ?? 0 } as BackgroundQuality['metrics'];
  if (input.outside) {
    const keep = grow(core, w, h, 2);
    let outside = 0, changed = 0;
    for (let i = 0; i < n; i++) if (!keep[i]) { outside++; if (maxDiff(input.outside.ai, i, input.outside.source, i) > 40) changed++; }
    metrics.outsideMaskChangedPercent = round(100 * changed / Math.max(1, outside), 1);
  }
  const failed: BackgroundQualityReason[] = [], degraded: BackgroundQualityReason[] = [];
  const check = (reason: BackgroundQualityReason, value: number, fail: number, degrade: number) => { if (value >= fail) failed.push(reason); else if (value >= degrade) degraded.push(reason); };
  check('black-region', metrics.blackPercent, 10, 3);
  check('boundary-discontinuity', metrics.boundaryDiscontinuityPercent, 40, 20);
  check('novel-content', metrics.novelPercent, 35, 15);
  check('darkened-region', metrics.darkShift, Infinity, 50);
  check('large-unexpected-change', metrics.outsideMaskChangedPercent ?? 0, Infinity, 40);
  if (metrics.recreatedLayers) failed.push('foreground-reappeared');
  return { quality: failed.length ? 'failed' : degraded.length ? 'degraded' : 'usable', reasons: [...failed, ...degraded], metrics };
}
