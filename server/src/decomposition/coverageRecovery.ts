/**
 * Coverage of the creative by its layers. Seedream can leave part of an object out of every layer and out of its base
 * (live run 2026-10-08T08-46-52: an open case lid). Nothing then shows it but the original; a background continued
 * from the original keeps it as a patch, and a layer behind it keeps a hole in its shape.
 *
 *   uncoveredContent  original pixels no layer covers that the provider's clean base does not show either
 *   smoothReach       where a smooth backdrop really is: grown from where its own pixels already show the creative
 *                     (agreeing), never across an edge of the original. Uncovered content it reaches joins it; content
 *                     it does not reach, and object content the backdrop layer itself carried, is an object's part
 *   ownerOf           the object such a part belongs to: the back-most object it touches (whatever is in front of it
 *                     covers it, so it shows only between them)
 *   matte             the content cut from the original against the clean base (difference matte, colours unmixed)
 *   completeHidden    a smooth backdrop's part hidden behind the layers in front, continued from its own pixels inside
 *                     its outline, so hiding or moving what is in front shows a whole shape
 *   retainedContent   a background that still shows such content (it was continued from the original): contaminated
 *
 * Shadows (darker, same hue) and smooth tone differences at the canvas edge are not objects and are never recovered.
 * Deterministic and local; no model call.
 */
import type { Grid } from './backgroundContamination.js';
import { label } from './backgroundContamination.js';
import { grow, pushPull } from './outerBackground.js';

export const MIN_REGION = 0.001, MIN_CUT = 48, SMOOTH_REGION_STEP = 6;
export type UncoveredRegion = { mask: Uint8Array; areaPercent: number; meanDiff: number; smooth: boolean; box: [number, number, number, number] };
const diffAt = (a: ArrayLike<number>, b: ArrayLike<number>, i: number) => Math.max(Math.abs(a[i * 3] - b[i * 3]), Math.abs(a[i * 3 + 1] - b[i * 3 + 1]), Math.abs(a[i * 3 + 2] - b[i * 3 + 2]));
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Regions of `original` (RGB on `grid`) that no layer covers and that differ from `reference` (the clean base) beyond
 * what the base differs everywhere else (a re-rendered base shifts tones a little). `covered`: union of layer alphas.
 */
export function uncoveredContent(original: ArrayLike<number>, reference: ArrayLike<number>, covered: Uint8Array, grid: Grid): { regions: UncoveredRegion[]; typical: number; cut: number } {
  const { width: w, height: h } = grid, n = w * h, near = grow(covered, w, h, 2), outside: number[] = [];
  for (let i = 0; i < n; i++) if (!near[i]) outside.push(diffAt(original, reference, i));
  outside.sort((a, b) => a - b);
  const typical = outside[outside.length >> 1] ?? 0, cut = Math.max(MIN_CUT, 3 * typical + 12);
  const flagged = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!covered[i] && diffAt(original, reference, i) > cut) flagged[i] = 1;
  const { labels, count } = label(flagged, w, h);
  const stats = Array.from({ length: count + 1 }, () => ({ px: 0, diff: 0, step: 0, steps: 0, dim: 0, border: false, x0: w, y0: h, x1: -1, y1: -1 }));
  for (let i = 0; i < n; i++) {
    const k = labels[i]; if (!k) continue;
    const s = stats[k], x = i % w, y = (i - x) / w;
    s.px++; s.diff += diffAt(original, reference, i);
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) s.border = true;
    if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
    // A shadow: darker than the base in every channel by about the same factor.
    const r = [0, 1, 2].map(c => (original[i * 3 + c] + 1) / (reference[i * 3 + c] + 1));
    if (Math.max(...r) < 0.92 && Math.max(...r) - Math.min(...r) < 0.15) s.dim++;
    // Texture inside the region: steps between neighbouring pixels of the original that both belong to it.
    for (const j of [i + 1, i + w]) if (j < n && labels[j] === k && (j !== i + 1 || x < w - 1)) { s.step += Math.max(Math.abs(original[i * 3] - original[j * 3]), Math.abs(original[i * 3 + 1] - original[j * 3 + 1]), Math.abs(original[i * 3 + 2] - original[j * 3 + 2])); s.steps++; }
  }
  const regions: UncoveredRegion[] = [];
  for (let k = 1; k <= count; k++) {
    const s = stats[k];
    if (s.px < MIN_REGION * n || s.dim >= 0.7 * s.px) continue;
    const smooth = (s.steps ? s.step / s.steps : 0) <= SMOOTH_REGION_STEP;
    // A smooth difference along the canvas edge is the base's own tone, not something left out.
    if (smooth && s.border) continue;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (labels[i] === k) mask[i] = 1;
    regions.push({ mask, areaPercent: round(100 * s.px / n), meanDiff: Math.round(s.diff / s.px), smooth, box: [s.x0, s.y0, s.x1 + 1, s.y1 + 1] });
  }
  return { regions, typical, cut };
}

/** A layer a part could join: its alpha (0/1 on the grid), depth, kind and, to compare colours, its own pixels (RGBA). */
export type OwnerCandidate = { id: string; alpha: Uint8Array; z: number; kind: 'object' | 'backdrop' | 'other'; rgba?: ArrayLike<number> };
/** Candidates touching `mask` (within 2 px) along a meaningful share of its outline, with how much they share. */
function touching(mask: Uint8Array, candidates: OwnerCandidate[], grid: Grid) {
  const ring = grow(mask, grid.width, grid.height, 2), n = grid.width * grid.height;
  let ringSize = 0; for (let i = 0; i < n; i++) if (ring[i] && !mask[i]) ringSize++;
  return candidates.map(c => { let shared = 0; for (let i = 0; i < n; i++) if (ring[i] && !mask[i] && c.alpha[i]) shared++; return { c, shared }; })
    .filter(t => t.shared >= Math.max(4, 0.03 * ringSize));
}
/** The backdrop a region borders most, if any. */
export const touchingBackdrop = (mask: Uint8Array, candidates: OwnerCandidate[], grid: Grid) =>
  touching(mask, candidates, grid).filter(t => t.c.kind === 'backdrop').sort((a, b) => b.shared - a.shared)[0]?.c;
/** Coarse colour histogram (8 levels a channel, normalised) of `pixels` (3 or 4 channels) over `mask`. */
function histogram(pixels: ArrayLike<number>, channels: 3 | 4, mask: Uint8Array): Float32Array {
  const bins = new Float32Array(512); let total = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { bins[(pixels[i * channels] >> 5) * 64 + (pixels[i * channels + 1] >> 5) * 8 + (pixels[i * channels + 2] >> 5)]++; total++; }
  if (total) for (let b = 0; b < 512; b++) bins[b] /= total;
  return bins;
}
/** The share of colours two histograms have in common (0..1). */
const alike = (a: Float32Array, b: Float32Array) => { let shared = 0; for (let k = 0; k < a.length; k++) shared += Math.min(a[k], b[k]); return shared; };
/**
 * The object a part belongs to: among the objects it touches, those it resembles (an object's missing part is made of
 * what the object is made of, so a white lid is not a purple line that ends at it), the back-most (whatever is in front
 * of it covers it, so it shows only between them). `colours`: the original (RGB on the grid) and the part's own pixels,
 * when `mask` is grown to find what it touches. Undefined when no object touches it.
 */
export function ownerOf(mask: Uint8Array, candidates: OwnerCandidate[], grid: Grid, colours?: { original: ArrayLike<number>; part: Uint8Array }): OwnerCandidate | undefined {
  const objects = touching(mask, candidates, grid).filter(t => t.c.kind === 'object').sort((a, b) => a.c.z - b.c.z);
  if (!colours || objects.length < 2) return objects[0]?.c;
  const part = histogram(colours.original, 3, colours.part), scored = objects.map(t => ({ c: t.c, sim: t.c.rgba ? alike(part, histogram(t.c.rgba, 4, t.c.alpha)) : 0 }));
  const best = Math.max(...scored.map(s => s.sim)), alikeOnes = scored.filter(s => s.sim >= Math.max(0.25, 0.5 * best));
  return (alikeOnes.length ? alikeOnes : scored)[0].c;
}

/**
 * Whether an original pixel is the base re-lit rather than something on it: the base darker (every channel scaled
 * alike, a shadow) or lighter (moved alike toward white, a glow), within `tolerance`. A grey lid on a pale base is
 * neither (red and green fall while blue rises).
 */
export function baseTone(original: ArrayLike<number>, reference: ArrayLike<number>, i: number, tolerance = 16): boolean {
  const o = [original[i * 3], original[i * 3 + 1], original[i * 3 + 2]], r = [reference[i * 3], reference[i * 3 + 1], reference[i * 3 + 2]];
  const fit = (predict: (c: number) => number) => Math.max(...[0, 1, 2].map(c => Math.abs(o[c] - predict(c))));
  // Least squares: darker o = k·r; lighter o = r + t·(255 − r).
  const rr = r.reduce((s, v) => s + v * v, 0), k = rr ? r.reduce((s, v, c) => s + v * o[c], 0) / rr : 0;
  const room = r.map(v => 255 - v), roomSq = room.reduce((s, v) => s + v * v, 0), t = roomSq ? room.reduce((s, v, c) => s + v * (o[c] - r[c]), 0) / roomSq : 0;
  return (k <= 1 && fit(c => k * r[c]) <= tolerance) || (t >= 0 && fit(c => r[c] + t * room[c]) <= tolerance);
}
const stepAt = (a: ArrayLike<number>, i: number, j: number) => Math.max(Math.abs(a[i * 3] - a[j * 3]), Math.abs(a[i * 3 + 1] - a[j * 3 + 1]), Math.abs(a[i * 3 + 2] - a[j * 3 + 2]));
/**
 * Where a backdrop's own pixels (straight RGBA on the grid) over the clean `reference` already show the creative, within
 * `tolerance`, among `visible`: the pixels its true extent is grown from.
 */
export function agreeing(rgba: ArrayLike<number>, original: ArrayLike<number>, reference: ArrayLike<number>, visible: Uint8Array, tolerance = 24): Uint8Array {
  const out = new Uint8Array(visible.length);
  for (let i = 0; i < visible.length; i++) {
    if (!visible[i]) continue;
    const a = rgba[i * 4 + 3] / 255;
    if ([0, 1, 2].every(c => Math.abs(rgba[i * 4 + c] * a + reference[i * 3 + c] * (1 - a) - original[i * 3 + c]) <= tolerance)) out[i] = 1;
  }
  return out;
}
/**
 * Where a smooth backdrop is, among `domain` (where it is visible, and uncovered content): grown from `seeds` through
 * neighbours whose original colours differ by at most `step`, and straight across thin layers in front of it (at most
 * `gap` pixels of `front`, comparing the colours on either side). A smooth backdrop has no edge inside it; an object in
 * front of it is outlined by one, however close their colours (a white lid on a pale fade).
 */
export function smoothReach(domain: Uint8Array, seeds: Uint8Array, front: Uint8Array, original: ArrayLike<number>, grid: Grid, step: number, gap: number): Uint8Array {
  const { width: w, height: h } = grid, n = w * h, reach = new Uint8Array(n), queue: number[] = [];
  for (let i = 0; i < n; i++) if (seeds[i] && domain[i]) { reach[i] = 1; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q], x = i % w, y = (i - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let k = 1; k <= gap + 1; k++) {
        const nx = x + dx * k, ny = y + dy * k;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) break;
        const j = ny * w + nx;
        if (!domain[j]) { if (front[j] && k <= gap) continue; break; }
        if (!reach[j] && stepAt(original, i, j) <= step) { reach[j] = 1; queue.push(j); }
        break;
      }
    }
  }
  return reach;
}
/** Connected parts of a 0/1 map of at least `min` pixels. */
export function parts(map: Uint8Array, grid: Grid, min: number): Uint8Array[] {
  const { labels, count } = label(map, grid.width, grid.height), out: Uint8Array[] = [];
  for (let k = 1; k <= count; k++) { const m = new Uint8Array(map.length); let px = 0; for (let i = 0; i < map.length; i++) if (labels[i] === k) { m[i] = 1; px++; } if (px >= min) out.push(m); }
  return out;
}

/**
 * The region cut from the original against the clean reference, at canvas resolution (RGB buffers, `region` 0/1):
 * alpha from how much the original differs from the reference, colours unmixed from the reference.
 */
export function matte(original: ArrayLike<number>, reference: ArrayLike<number>, region: Uint8Array, low = 16, high = 64): Buffer {
  const n = region.length, out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    if (!region[i]) continue;
    const a = Math.min(1, Math.max(0, (diffAt(original, reference, i) - low) / (high - low)));
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(Math.min(255, Math.max(0, (original[i * 3 + c] - (1 - a) * reference[i * 3 + c]) / a)));
    out[i * 4 + 3] = Math.round(255 * a);
  }
  return out;
}
/** `top` over `bottom` (straight RGBA, same size). */
export function over(top: Uint8Array, bottom: Uint8Array): Buffer {
  const out = Buffer.alloc(top.length);
  for (let i = 0; i < top.length; i += 4) {
    const at = top[i + 3] / 255, ab = bottom[i + 3] / 255, a = at + ab * (1 - at);
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((top[i + c] * at + bottom[i + c] * ab * (1 - at)) / a);
    out[i + 3] = Math.round(255 * a);
  }
  return out;
}

/** The convex hull of a 0/1 map, rasterised: a shape's outline continued straight across a gap in it. */
export function convexHull(map: Uint8Array, w: number, h: number): Uint8Array {
  const pts: [number, number][] = [];
  for (let y = 0; y < h; y++) { let first = -1, last = -1; for (let x = 0; x < w; x++) if (map[y * w + x]) { if (first < 0) first = x; last = x; } if (first >= 0) { pts.push([first, y]); if (last !== first) pts.push([last, y]); } }
  const out = new Uint8Array(w * h);
  if (pts.length < 3) { for (const [x, y] of pts) out[y * w + x] = 1; return out; }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  for (let y = 0; y < h; y++) {
    const xs: number[] = [];
    for (let k = 0; k < hull.length; k++) {
      const [x0, y0] = hull[k], [x1, y1] = hull[(k + 1) % hull.length];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0));
      else if (y0 === y && y1 === y) xs.push(x0, x1);
    }
    if (!xs.length) continue;
    const from = Math.max(0, Math.floor(Math.min(...xs))), to = Math.min(w - 1, Math.ceil(Math.max(...xs)));
    for (let x = from; x <= to; x++) out[y * w + x] = 1;
  }
  return out;
}

/**
 * A smooth layer's pixels inside `hidden` (straight RGBA, `w`×`h`), continued from its own pixels inside `hull` (push-pull
 * on premultiplied colour and alpha). Outside the hull nothing is added: the shape's outline is kept. `replace`: what the
 * provider drew there is replaced, never patched in (its visible part was proven wrong, so its guess behind is too, and
 * keeping it where it happens to agree leaves a product's grey baked in as a patchwork); otherwise only what is weaker
 * than the continuation (a hole) is filled.
 */
export function completeHidden(rgba: Uint8Array, hidden: Uint8Array, hull: Uint8Array, w: number, h: number, replace = true): Buffer {
  const n = w * h, known = new Float32Array(n), colour = new Float32Array(n * 3), alpha = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (!hull[i] || hidden[i]) continue;
    known[i] = 1;
    const a = rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) colour[i * 3 + c] = rgba[i * 4 + c] * a;
    alpha[i * 3] = alpha[i * 3 + 1] = alpha[i * 3 + 2] = a;
  }
  const filledColour = pushPull(colour, known, w, h), filledAlpha = pushPull(alpha, known, w, h), out = Buffer.from(rgba);
  for (let i = 0; i < n; i++) {
    if (!hidden[i] || !hull[i]) continue;
    const a = Math.min(1, Math.max(0, filledAlpha[i * 3]));
    if (!replace && a * 255 <= rgba[i * 4 + 3]) continue;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = a > 0 ? Math.round(Math.min(255, Math.max(0, filledColour[i * 3 + c] / a))) : 0;
    out[i * 4 + 3] = Math.round(255 * a);
  }
  return out;
}

/**
 * Where a candidate background (RGB on `grid`) still shows original content the clean reference does not: it was
 * continued from the original around something no layer took. Textured regions only (an object's part, not a tone), and
 * never the base's own content (`ofBase`: what continues the base, which a background rightly shows).
 */
export function retainedContent(background: ArrayLike<number>, original: ArrayLike<number>, reference: ArrayLike<number>, covered: Uint8Array, grid: Grid, ofBase?: Uint8Array): UncoveredRegion[] {
  const { regions } = uncoveredContent(original, reference, covered, grid);
  return regions.filter(r => {
    if (r.smooth) return false;
    let kept = 0, px = 0, base = 0;
    for (let i = 0; i < r.mask.length; i++) if (r.mask[i]) { px++; if (ofBase?.[i]) base++; if (diffAt(background, original, i) <= 24) kept++; }
    return base < 0.5 * px && kept >= 0.5 * px;
  });
}
