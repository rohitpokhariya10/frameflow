/**
 * Cast shadows of removed foreground, for the recursive decomposition's clean background (recursiveDecomposition.ts).
 *
 * A person or product layer's alpha ends at its silhouette, while its shadow lies on the background around it: a soft
 * drop shadow beside a person, a contact shadow at the feet, a darker patch under a product. Left in, every background
 * candidate keeps it, a fill smears it into the hole as a muddy silhouette, and moving or hiding the subject leaves a
 * ghost behind. This finds those shadows in the ORIGINAL, so they are removed with their subject:
 *
 *   expected   the background continued over a zone around the removed area from beyond it: the plain field's smooth
 *              surface (plainFieldFill, exact for flat colors and gradients), else region by region (graphicFill), else
 *              a smooth continuation; what the background looks like with no subject and no shadow there. The coarser
 *              models only accept clearly dark shadows, so their own error on a gradient is never taken for one
 *   candidate  a pixel in that zone that is the expected color dimmed by one factor (same hue, darker), clearly so
 *   shadow     a connected group of candidates that touches the removed area, has at least one clearly dark pixel,
 *              and fades out softly (a crisp grey shape or dark design element has a hard edge and is kept)
 *
 * Deterministic, on the analysis grid; no model call. A dark design element touching the subject with soft edges can be
 * taken for a shadow; the record lists every group with its depth and softness.
 */
import { graphicFill, plainFieldFill } from './backgroundRecovery.js';
import { countOf, label, positionWords } from './backgroundContamination.js';
import { boxBlur, grow, maskedBlur, noiseSigma, pushPull } from './outerBackground.js';

export type ShadowComponent = { areaPercent: number; meanDepth: number; maxDepth: number; softness: number; position: string; accepted: boolean; reason: string };
export type ShadowDetection = {
  /** 0/1 on the grid: shadow pixels outside `core` to remove with the foreground. */
  mask: Uint8Array; percent: number;
  /** false when there was nothing to compare with (almost no background beyond the zone). */
  assessed: boolean; model: 'plain' | 'graphic' | 'smooth' | 'none'; components: ShadowComponent[]; note: string;
};
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const luminance = (rgb: ArrayLike<number>, i: number) => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];

/**
 * Shadows of the removed foreground (`core` = 1) in `rgb` (raw RGB on a w×h grid). `reach`: how far from the removed
 * area a shadow may extend (fraction of the longer side).
 */
export function castShadows(rgb: ArrayLike<number>, core: Uint8Array, w: number, h: number, options: { reach?: number } = {}): ShadowDetection {
  const n = w * h, side = Math.max(w, h), mask = new Uint8Array(n);
  const none = (note: string, assessed = false): ShadowDetection => ({ mask, percent: 0, assessed, model: 'none', components: [], note });
  if (!core.some(Boolean)) return none('Nothing is removed.');
  // The zone a shadow may reach: up to a tenth of the longer side, narrower when the foreground is spread so widely that
  // too little background would remain beyond it to continue from.
  let near: Uint8Array = new Uint8Array(n);
  for (const fraction of [options.reach ?? 0.1, 0.07, 0.04]) { near = grow(core, w, h, Math.max(6, Math.round(fraction * side))); if (n - countOf(near) >= 0.1 * n) break; }
  if (n - countOf(near) < 0.05 * n) return none('Less than 5% of the image lies beyond the removed area, so there is no clean background to compare with.');
  // The background over the zone as it continues from beyond it: the plain field's surface, else region by region for a
  // simple graphic design, else smooth.
  const plain = plainFieldFill(rgb, near, w, h);
  let expected: ArrayLike<number> | undefined = plain.plain ? plain.out : graphicFill(rgb, near, w, h), model: ShadowDetection['model'] = plain.plain ? 'plain' : 'graphic';
  if (!expected) {
    const known = new Float32Array(n), r = Math.max(4, Math.round(side / 48));
    for (let i = 0; i < n; i++) known[i] = near[i] ? 0 : 1;
    expected = boxBlur(pushPull(maskedBlur(Float32Array.from(rgb), known, w, h, r), known, w, h), w, h, 3, Math.max(2, r >> 1));
    model = 'smooth';
  }
  // Texture of the background beyond the zone, so grain is not a shadow.
  const band = grow(near, w, h, Math.max(3, Math.round(0.03 * side))), use = new Float32Array(n), rgbF = Float32Array.from(rgb);
  for (let i = 0; i < n; i++) use[i] = band[i] && !near[i] ? 1 : 0;
  const sigma = use.some(Boolean) ? noiseSigma(rgbF, boxBlur(rgbF, w, h, 3, 2), use) : 1;
  // How dark a shadow must be: a clear darkening on the exact plain-field surface; a much clearer one on the coarser
  // models, whose continuation of a gradient across a wide zone can itself be off by a tenth.
  const precise = model === 'plain', lowDrop = Math.max(6, 2 * sigma), highDrop = Math.max(precise ? 14 : 24, 3 * sigma), strongDepth = precise ? 0.12 : 0.22, meanDepthMin = precise ? 0 : 0.12;
  // Candidates: the expected color dimmed by one factor (a shadow keeps the hue of what it falls on), clearly or slightly.
  const depth = new Float32Array(n), candidate = new Uint8Array(n), strong = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!near[i] || core[i]) continue;
    const le = luminance(expected, i), lo = luminance(rgb, i);
    if (le < 24 || lo >= le) continue;
    const k = lo / le;
    if (k < 0.15) continue;
    let consistent = true;
    for (let c = 0; c < 3 && consistent; c++) if (Math.abs(rgb[i * 3 + c] - k * expected[i * 3 + c]) > 14 + 0.12 * expected[i * 3 + c]) consistent = false;
    if (!consistent || 1 - k < 0.05 || le - lo < lowDrop) continue;
    candidate[i] = 1; depth[i] = 1 - k;
    if (1 - k >= strongDepth && le - lo >= highDrop) strong[i] = 1;
  }
  const { labels, count } = label(candidate, w, h), touch = grow(core, w, h, 2);
  const stats = Array.from({ length: count + 1 }, () => ({ pixels: [] as number[], strong: 0, touches: false }));
  for (let i = 0; i < n; i++) if (labels[i]) { const s = stats[labels[i]]; s.pixels.push(i); if (strong[i]) s.strong++; if (touch[i]) s.touches = true; }
  const components: ShadowComponent[] = [], faintNear: { pixels: number[]; component: ShadowComponent }[] = [];
  for (const s of stats.slice(1)) {
    const area = s.pixels.length / n;
    if (area < Math.max(12 / n, 0.0003)) continue;
    const depths = s.pixels.map(i => depth[i]).sort((a, b) => a - b), p90 = depths[Math.floor(0.9 * (depths.length - 1))];
    // Softness: how many pixels the fade spans per pixel of outline. A crisp shape fades over one or two resampled pixels.
    let outline = 0, fading = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (const i of s.pixels) {
      const x = i % w, y = (i - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (depth[i] < 0.5 * p90) fading++;
      const open = (j: number) => j >= 0 && j < n && labels[j] !== labels[i] && !core[j];
      if ((x > 0 && open(i - 1)) || (x < w - 1 && open(i + 1)) || open(i - w) || open(i + w)) outline++;
    }
    const softness = fading / Math.max(1, outline), meanDepth = depths.reduce((t, d) => t + d, 0) / depths.length;
    const faint = !s.strong || meanDepth < meanDepthMin;
    const reason = !s.touches ? 'does not touch the removed foreground' : faint ? 'too faint to be a shadow' : area > 0.12 ? 'too large for a cast shadow (a design region)' : softness < 2 ? 'hard-edged (a design element, not a shadow)' : 'soft, same-hue darkening attached to the removed foreground';
    const accepted = s.touches && !faint && area <= 0.12 && softness >= 2;
    if (accepted) for (const i of s.pixels) mask[i] = 1;
    const component = { areaPercent: round(100 * area), meanDepth: round(meanDepth), maxDepth: round(depths[depths.length - 1]), softness: round(softness, 1),
      position: positionWords((x0 + x1 + 1) / 2 / w, (y0 + y1 + 1) / 2 / h), accepted, reason };
    components.push(component);
    if (!accepted && s.touches && area <= 0.12 && softness >= 2) faintNear.push({ pixels: s.pixels, component });
  }
  // The faint tails of an accepted shadow (split from it by the subject) go with it; a faint darkening on its own does not.
  if (faintNear.length && mask.some(Boolean)) {
    const around = grow(mask, w, h, Math.max(2, Math.round(0.03 * side)));
    for (const { pixels, component } of faintNear) if (pixels.some(i => around[i])) { for (const i of pixels) mask[i] = 1; Object.assign(component, { accepted: true, reason: 'faint tail of an accepted cast shadow' }); }
  }
  components.sort((a, b) => b.areaPercent - a.areaPercent);
  // The fading tail of each accepted shadow, down to a barely visible darkening, joins it (hysteresis): left outside, it
  // would draw a faint outline where the removed area ends and pull the continued field darker. Only on the exact
  // plain-field model, whose own error is far below that.
  if (precise && mask.some(Boolean)) {
    const tailDrop = Math.max(2, sigma), queue: number[] = [];
    for (let i = 0; i < n; i++) if (mask[i]) queue.push(i);
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head], x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || mask[j] || core[j] || !near[j]) continue;
        const le = luminance(expected, j), lo = luminance(rgb, j);
        if (le < 24 || le - lo < tailDrop || 1 - lo / le < 0.015) continue;
        const k = lo / le;
        let consistent = true;
        for (let c = 0; c < 3 && consistent; c++) if (Math.abs(rgb[j * 3 + c] - k * expected[j * 3 + c]) > 14 + 0.12 * expected[j * 3 + c]) consistent = false;
        if (consistent) { mask[j] = 1; queue.push(j); }
      }
    }
  }
  // One pixel more, so the anti-aliased fringe goes too; never into the removed area itself.
  const grown = grow(mask, w, h, 1);
  for (let i = 0; i < n; i++) mask[i] = grown[i] && !core[i] ? 1 : 0;
  const percent = round(100 * countOf(mask) / n);
  const kept = components.filter(c => c.accepted);
  return { mask, percent, assessed: true, model, components: components.slice(0, 12),
    note: kept.length ? `${kept.length} cast shadow(s) of the removed foreground (${percent}% of the image) are removed with it.` : 'No cast shadow of the removed foreground was found.' };
}
