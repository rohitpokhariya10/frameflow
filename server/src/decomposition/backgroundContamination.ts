/**
 * Image-derived checks for the recursive decomposition (recursiveDecomposition.ts). Deterministic, no model call.
 *
 *   assessBackgroundContamination   does a background/residual image still hold foreground objects outside the layers
 *                                   already extracted? (the "recurse or stop" decision)
 *   objectRetention                 does an image still show an extracted layer where that layer was? (a base that
 *                                   duplicates its layers, or a rebuilt background that recreated a removed product)
 *   overlapStats / layerShape       layer masks on a small analysis grid, for duplicate detection and stacking order
 *
 * Everything works on a reduced grid (gridFor), never on full-resolution images, so a 4K creative costs the same as a
 * small one. The background model is the outer-background rebuild's own: a smooth color and lighting field continued
 * from the known background (outerBackground.ts), estimated twice so a large object cannot pull it toward itself.
 */
import sharp from 'sharp';
import { placedOverlay, type Canvas, type LayerInfo, type Placement } from './layerizeArtifacts.js';
import { boxBlur, deviation, grow, maskedBlur, noiseSigma, pushPull } from './outerBackground.js';

/** A working resolution for a canvas: at most `maxSide` on the longer side, never above the canvas itself. */
export type Grid = { width: number; height: number; scale: number };
export function gridFor(canvas: Canvas, maxSide: number): Grid {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  return { width: Math.max(1, Math.round(canvas.width * scale)), height: Math.max(1, Math.round(canvas.height * scale)), scale };
}
/** An image as raw RGB at exactly the grid size. Callers only pass images with the grid's aspect ratio. */
export const rgbOnGrid = (image: Buffer, grid: { width: number; height: number }) =>
  sharp(image).resize(grid.width, grid.height, { fit: 'fill' }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();

/** A canvas placement scaled onto a grid, in the form placedOverlay resizes and clips. */
export function scaledPlacement(p: Placement, scale: number): Placement {
  if (p.kind === 'unresolved') return p;
  const x = Math.round(p.x * scale), y = Math.round(p.y * scale);
  return { kind: 'bbox-scaled', x, y, width: Math.max(1, Math.round((p.x + p.width) * scale) - x), height: Math.max(1, Math.round((p.y + p.height) * scale) - y) };
}
/** Resolved layers composited back to front onto a transparent grid, as raw RGBA. */
export async function compositeOnGrid(items: { png: Buffer; placement: Placement }[], grid: Grid): Promise<Buffer> {
  const overlays = [];
  for (const item of items) {
    const overlay = await placedOverlay(item.png, scaledPlacement(item.placement, grid.scale), grid);
    if (overlay) overlays.push(overlay);
  }
  return sharp({ create: { width: grid.width, height: grid.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(overlays).raw().toBuffer();
}
/** A 0/1 map of the pixels any of the layers covers (alpha above 16) on the grid. */
export async function coverageOnGrid(items: { png: Buffer; placement: Placement }[], grid: Grid): Promise<Uint8Array> {
  const rgba = await compositeOnGrid(items, grid), map = new Uint8Array(grid.width * grid.height);
  for (let i = 0; i < map.length; i++) if (rgba[i * 4 + 3] > 16) map[i] = 1;
  return map;
}

export type Box = { x0: number; y0: number; x1: number; y1: number };
/** A layer on the analysis grid: its opaque pixels (alpha above 127), its colors, how many and their box (end exclusive). */
export type LayerShape = { alpha: Uint8Array; rgba: Buffer; count: number; box?: Box };
export async function layerShape(png: Buffer, layer: Pick<LayerInfo, 'placement'>, grid: Grid): Promise<LayerShape> {
  const rgba = await compositeOnGrid([{ png, placement: layer.placement }], grid), alpha = new Uint8Array(grid.width * grid.height);
  let count = 0, x0 = grid.width, y0 = grid.height, x1 = -1, y1 = -1;
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    const i = y * grid.width + x;
    if (rgba[i * 4 + 3] <= 127) continue;
    alpha[i] = 1; count++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { alpha, rgba, count, ...(count ? { box: { x0, y0, x1: x1 + 1, y1: y1 + 1 } } : {}) };
}
/** Union of 0/1 maps. */
export function unionOf(maps: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (const map of maps) for (let i = 0; i < size; i++) if (map[i]) out[i] = 1;
  return out;
}
export const countOf = (map: Uint8Array) => { let n = 0; for (const v of map) n += v ? 1 : 0; return n; };
export function intersectCount(a: Uint8Array, b: Uint8Array): number { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] && b[i]) n++; return n; }
const boxArea = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
function boxIoU(a?: Box, b?: Box): number {
  if (!a || !b) return 0;
  const inter = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return inter / Math.max(1, boxArea(a) + boxArea(b) - inter);
}
/** How two layers overlap: shared pixels, mask IoU, the share of each inside the other, and box IoU. */
export function overlapStats(a: LayerShape, b: LayerShape) {
  const inter = intersectCount(a.alpha, b.alpha), union = a.count + b.count - inter;
  return { inter, iou: union ? inter / union : 0, aInB: a.count ? inter / a.count : 0, bInA: b.count ? inter / b.count : 0, boxIoU: boxIoU(a.box, b.box) };
}

/** Morphological erosion of a 0/1 map by r pixels (square). */
function erode(map: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const inverse = new Uint8Array(map.length);
  for (let i = 0; i < map.length; i++) inverse[i] = map[i] ? 0 : 1;
  const grown = grow(inverse, w, h, r), out = new Uint8Array(map.length);
  for (let i = 0; i < map.length; i++) out[i] = grown[i] ? 0 : 1;
  return out;
}
/** 8-connected components of a 0/1 map; 0 = unlabeled. */
export function label(map: Uint8Array, w: number, h: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(map.length), queue = new Int32Array(map.length);
  let count = 0;
  for (let start = 0; start < map.length; start++) {
    if (!map[start] || labels[start]) continue;
    labels[start] = ++count;
    let head = 0, tail = 0;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++], x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) {
          const j = ny * w + nx;
          if (map[j] && !labels[j]) { labels[j] = count; queue[tail++] = j; }
        }
      }
    }
  }
  return { labels, count };
}
/** "upper left" … "center" … "lower right", from a normalized center. */
export function positionWords(cx: number, cy: number): string {
  const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center', row = cy < 1 / 3 ? 'upper' : cy > 2 / 3 ? 'lower' : 'middle';
  if (row === 'middle') return col === 'center' ? 'center' : `middle ${col}`;
  return `${row} ${col}`;
}

/**
 * The background as it would continue under `exclude` (0/1): smooth color and lighting from the other pixels. Estimated
 * twice; the second time without the pixels the first estimate flagged as foreground, so an object cannot hide itself.
 */
export function backgroundModel(rgbBytes: Uint8Array, w: number, h: number, exclude?: Uint8Array): { model: Float32Array; known: Float32Array; threshold: number; sigma: number } {
  const n = w * h, rgb = Float32Array.from(rgbBytes), r = Math.max(4, Math.round(Math.max(w, h) / 24));
  const known = new Float32Array(n);
  for (let i = 0; i < n; i++) known[i] = exclude?.[i] ? 0 : 1;
  const modelOf = (support: Float32Array) => boxBlur(pushPull(maskedBlur(rgb, support, w, h, r), support, w, h), w, h, 3, Math.max(2, r >> 1));
  let model = modelOf(known), sigma = noiseSigma(rgb, model, known), threshold = Math.max(28, 6 * sigma);
  const outliers = new Uint8Array(n);
  let found = 0;
  for (let i = 0; i < n; i++) if (known[i] && deviation(rgb, model, i) > threshold) { outliers[i] = 1; found++; }
  // Nothing stood out: the second estimate would use exactly the same pixels, so the first is the model.
  if (!found) return { model, known, threshold, sigma };
  const spread = grow(outliers, w, h, 3), support = new Float32Array(n);
  let supported = 0;
  for (let i = 0; i < n; i++) if (known[i] && !spread[i]) { support[i] = 1; supported++; }
  if (supported >= n * 0.02) { model = modelOf(support); sigma = noiseSigma(rgb, model, support); threshold = Math.max(28, 6 * sigma); }
  return { model, known, threshold, sigma };
}

export type ContaminationOptions = {
  /** Smallest region that counts, in percent of the image. */
  minRegionPercent: number;
  /** Total area of confident regions (percent of the image) from which the image counts as contaminated. */
  contaminatedPercent: number;
  /** The confidence (0–1) a region needs to count. */
  minConfidence: number;
  /**
   * The contrast a region also needs to count (deviation / threshold). Set when every element the planner listed was
   * extracted: what is left is then presumed to be the background's own design (a platform, soft circles) unless it
   * stands out as strongly as a product does. Absent: any contrast counts.
   */
  minContrast?: number;
};
/** A foreground-like region: normalized box [x0, y0, x1, y1] (0–1), area, solidity (area / box), contrast (deviation / threshold). */
export type ContaminationRegion = { box: [number, number, number, number]; areaPercent: number; fill: number; contrast: number; confidence: number; position: string };
export type ContaminationVerdict = 'contaminated' | 'clean' | 'below-threshold' | 'low-confidence' | 'not-assessable';
export type ContaminationAssessment = {
  contaminated: boolean; verdict: ContaminationVerdict;
  /** The highest confidence among the regions that count (0 when none). */
  confidence: number;
  /** Total area of the regions that count, in percent of the image. */
  contaminatedPercent: number;
  regions: ContaminationRegion[]; reasons: string[];
  /** Percent of the image outside the extracted layers (what was looked at), and the deviation threshold used. */
  assessedPercent: number; threshold: number;
};
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Whether a background (or a residual image) still holds foreground objects outside `explained` (0/1: the pixels the
 * extracted layers already account for; a small margin around them is ignored as their edge or halo). Pixels that stand
 * out from the smooth background model are grouped into regions (fragments of one object within ~1.5% of the image of
 * each other are one region). A region's confidence rises with its size, solidity and contrast, so scattered texture,
 * confetti and thin noise stay below it while products, pedestals and text blocks do not. Never throws on content.
 */
export function assessBackgroundContamination(input: { rgb: Uint8Array; width: number; height: number; explained?: Uint8Array }, options: ContaminationOptions): ContaminationAssessment {
  const { width: w, height: h } = input, n = w * h, side = Math.max(w, h);
  const excluded = input.explained ? grow(input.explained, w, h, Math.max(2, Math.round(side * 0.01))) : new Uint8Array(n);
  const assessed = n - countOf(excluded), assessedPercent = round(100 * assessed / n, 1);
  if (assessed < n * 0.05) {
    return { contaminated: false, verdict: 'not-assessable', confidence: 0, contaminatedPercent: 0, regions: [], assessedPercent, threshold: 0,
      reasons: ['Less than 5% of the image lies outside the extracted layers, so there is no background left to assess.'] };
  }
  const { model, known, threshold } = backgroundModel(input.rgb, w, h, excluded), rgb = Float32Array.from(input.rgb);
  const flagged = new Uint8Array(n), dev = new Float32Array(n);
  for (let i = 0; i < n; i++) if (known[i]) { const d = deviation(rgb, model, i); if (d > threshold) { flagged[i] = 1; dev[i] = d; } }
  // Opening: isolated noise pixels are not objects.
  const opened = grow(erode(flagged, w, h, 1), w, h, 1);
  for (let i = 0; i < n; i++) if (!flagged[i]) opened[i] = 0;
  const { labels, count } = label(grow(opened, w, h, Math.max(1, Math.round(side * 0.015))), w, h);
  const stats = Array.from({ length: count + 1 }, () => ({ pixels: 0, dev: 0, x0: w, y0: h, x1: -1, y1: -1 }));
  for (let i = 0; i < n; i++) {
    if (!opened[i]) continue;
    const s = stats[labels[i]], x = i % w, y = (i - x) / w;
    s.pixels++; s.dev += dev[i];
    if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
  }
  const regions: ContaminationRegion[] = [];
  for (const s of stats.slice(1)) {
    const areaPercent = 100 * s.pixels / n;
    if (!s.pixels || areaPercent < options.minRegionPercent) continue;
    const fill = s.pixels / ((s.x1 - s.x0 + 1) * (s.y1 - s.y0 + 1)), contrast = s.dev / s.pixels / threshold;
    const confidence = 0.3 * Math.min(1, areaPercent / (3 * options.minRegionPercent)) + 0.45 * Math.min(1, fill / 0.4) + 0.25 * Math.min(1, Math.max(0, contrast - 1));
    regions.push({ box: [round(s.x0 / w, 3), round(s.y0 / h, 3), round((s.x1 + 1) / w, 3), round((s.y1 + 1) / h, 3)], areaPercent: round(areaPercent), fill: round(fill), contrast: round(contrast),
      confidence: round(confidence), position: positionWords((s.x0 + s.x1 + 1) / 2 / w, (s.y0 + s.y1 + 1) / 2 / h) });
  }
  regions.sort((a, b) => b.areaPercent - a.areaPercent);
  const counted = regions.filter(r => r.confidence >= options.minConfidence && r.contrast >= (options.minContrast ?? 0)), contaminatedPercent = round(counted.reduce((sum, r) => sum + r.areaPercent, 0));
  const confidence = counted.length ? Math.max(...counted.map(r => r.confidence)) : 0;
  const base = { regions, assessedPercent, threshold: round(threshold, 1), contaminatedPercent, confidence };
  if (!regions.length) return { ...base, contaminated: false, verdict: 'clean', reasons: ['Nothing outside the extracted layers stands out from the background.'] };
  if (!counted.length) {
    const design = regions.filter(r => r.confidence >= options.minConfidence).length;
    return { ...base, contaminated: false, verdict: 'low-confidence', reasons: [design
      ? `${design} region(s) stand out, but every element the planner listed was extracted and none stands out like an object (contrast below ${options.minContrast}): the background's own design.`
      : `${regions.length} region(s) stand out, but none is solid or large enough to be an object (best confidence ${Math.max(...regions.map(r => r.confidence))} < ${options.minConfidence}).`] };
  }
  if (contaminatedPercent < options.contaminatedPercent) return { ...base, contaminated: false, verdict: 'below-threshold', reasons: [`${counted.length} object-like region(s) cover ${contaminatedPercent}% of the image, below the ${options.contaminatedPercent}% threshold.`] };
  return { ...base, contaminated: true, verdict: 'contaminated',
    reasons: [`${counted.length} object-like region(s) outside the extracted layers cover ${contaminatedPercent}% of the image (${counted.slice(0, 6).map(r => `${r.position} ${r.areaPercent}%`).join(', ')}).`] };
}

export type Retention = { file: string; name?: string; distinctPixels: number; retainedPercent: number };
/**
 * How much of each layer `candidate` still shows where that layer is. Only the layer's distinctive pixels count (where
 * the original differs clearly from the estimated background `model`), so a product colored like its background is not
 * mistaken for a leftover. retainedPercent: the share of those pixels where candidate still matches the original.
 * Layers with fewer than 24 distinctive grid pixels are left out (nothing to judge).
 */
export function objectRetention(candidate: Uint8Array, original: Uint8Array, model: Float32Array, layers: { file: string; name?: string; alpha: Uint8Array }[]): Retention[] {
  const out: Retention[] = [];
  for (const layer of layers) {
    let distinct = 0, retained = 0;
    for (let i = 0; i < layer.alpha.length; i++) {
      if (!layer.alpha[i]) continue;
      const o = i * 3;
      if (Math.max(Math.abs(original[o] - model[o]), Math.abs(original[o + 1] - model[o + 1]), Math.abs(original[o + 2] - model[o + 2])) <= 32) continue;
      distinct++;
      if (Math.max(Math.abs(candidate[o] - original[o]), Math.abs(candidate[o + 1] - original[o + 1]), Math.abs(candidate[o + 2] - original[o + 2])) <= 20) retained++;
    }
    if (distinct >= 24) out.push({ file: layer.file, ...(layer.name ? { name: layer.name } : {}), distinctPixels: distinct, retainedPercent: round(100 * retained / distinct, 1) });
  }
  return out;
}

/** How close a reconstruction is to the original: mean absolute difference (0–255) and percent of clearly changed pixels. */
export type Fidelity = { meanAbsDiff: number; changedPercent: number };
export function fidelity(a: Uint8Array, b: Uint8Array): Fidelity {
  const n = Math.min(a.length, b.length) / 3;
  let sum = 0, changed = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3, d0 = Math.abs(a[o] - b[o]), d1 = Math.abs(a[o + 1] - b[o + 1]), d2 = Math.abs(a[o + 2] - b[o + 2]);
    sum += (d0 + d1 + d2) / 3;
    if (Math.max(d0, d1, d2) > 40) changed++;
  }
  return { meanAbsDiff: round(sum / Math.max(1, n), 1), changedPercent: round(100 * changed / Math.max(1, n), 1) };
}
/** Raw RGBA flattened onto white as raw RGB. */
export function flattenRgba(rgba: Buffer): Buffer {
  const n = rgba.length / 4, out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(rgba[i * 4 + c] * a + 255 * (1 - a));
  }
  return out;
}
