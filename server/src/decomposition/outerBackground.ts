/**
 * Local, deterministic rebuild of a clean full-canvas outer background for framed layouts (Template A).
 *
 * In every Template A run so far Seedream's own "outer background" layer came back as a grey or ring-shaped
 * placeholder, whatever the prompt said, while its base image held the real outer background with the inner backdrop
 * and border - and sometimes the subject too - still in it. This replaces the backdrop, border, foreground and any
 * leftover contamination by continuing the surrounding (clean) background. The real outer-background pixels come from
 * the uploaded image when it matches the canvas (the base was seen re-rendered, e.g. white instead of green), else the base:
 * a smooth color and lighting field interpolated inward from the region's edge (push-pull), plus fine texture borrowed
 * from an untouched full-width (or full-height) band of the same background. No model call; raw layers are untouched.
 */
import sharp, { type OverlayOptions } from 'sharp';

type Size = { width: number; height: number };
/** contaminationPercent: base pixels outside every layer that were still foreground/halo and got replaced; residualPercent: backgroundResidualPercent of the result. */
export type RebuildResult = { png: Buffer; holePercent: number; texture: string; contaminationPercent: number; residualPercent: number;
  /** Where the real outer-background pixels came from; enclosedPercent: area filled because the backdrop/border enclosed it. */
  source: 'original' | 'base'; enclosedPercent: number };

/** Separable box blur with clamped edges on interleaved float channels. */
export function boxBlur(src: Float32Array, w: number, h: number, ch: number, r: number): Float32Array {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), n = 2 * r + 1;
  for (let y = 0; y < h; y++) for (let c = 0; c < ch; c++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[(y * w + Math.min(w - 1, Math.max(0, k))) * ch + c];
    for (let x = 0; x < w; x++) {
      tmp[(y * w + x) * ch + c] = sum / n;
      sum += src[(y * w + Math.min(w - 1, x + r + 1)) * ch + c] - src[(y * w + Math.max(0, x - r)) * ch + c];
    }
  }
  for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * ch + c];
    for (let y = 0; y < h; y++) {
      out[(y * w + x) * ch + c] = sum / n;
      sum += tmp[(Math.min(h - 1, y + r + 1) * w + x) * ch + c] - tmp[(Math.max(0, y - r) * w + x) * ch + c];
    }
  }
  return out;
}

/** Average color of known pixels around each pixel (known = weight 1): smooth color and lighting without texture. */
export function maskedBlur(rgb: Float32Array, known: Float32Array, w: number, h: number, r: number): Float32Array {
  const weighted = new Float32Array(rgb.length);
  for (let i = 0; i < known.length; i++) for (let c = 0; c < 3; c++) weighted[i * 3 + c] = rgb[i * 3 + c] * known[i];
  const num = boxBlur(weighted, w, h, 3, r), den = boxBlur(known, w, h, 1, r), out = new Float32Array(rgb.length);
  for (let i = 0; i < known.length; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = den[i] > 1e-4 ? num[i * 3 + c] / den[i] : 0;
  return out;
}

/** Push-pull: fills unknown pixels from progressively coarser averages of known ones, upsampled bilinearly. */
export function pushPull(rgb: Float32Array, known: Float32Array, w: number, h: number): Float32Array {
  const levels: { c: Float32Array; wt: Float32Array; w: number; h: number }[] = [];
  const c0 = new Float32Array(rgb.length);
  for (let i = 0; i < known.length; i++) for (let c = 0; c < 3; c++) c0[i * 3 + c] = rgb[i * 3 + c] * known[i];
  levels.push({ c: c0, wt: known.slice(), w, h });
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const prev = levels.at(-1)!, nw = Math.ceil(prev.w / 2), nh = Math.ceil(prev.h / 2);
    const c = new Float32Array(nw * nh * 3), wt = new Float32Array(nw * nh);
    for (let y = 0; y < prev.h; y++) for (let x = 0; x < prev.w; x++) {
      const i = y * prev.w + x, j = (y >> 1) * nw + (x >> 1);
      wt[j] += prev.wt[i];
      for (let k = 0; k < 3; k++) c[j * 3 + k] += prev.c[i * 3 + k];
    }
    levels.push({ c, wt, w: nw, h: nh });
  }
  // Coarse to fine: a pixel keeps its own average where it has known support, else takes the upsampled coarser value.
  let upper: Float32Array | undefined, uw = 0, uh = 0;
  for (let l = levels.length - 1; l >= 0; l--) {
    const { c, wt, w: lw, h: lh } = levels[l], res = new Float32Array(lw * lh * 3);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const i = y * lw + x;
      if (wt[i] > 1e-6 || !upper) { for (let k = 0; k < 3; k++) res[i * 3 + k] = wt[i] > 1e-6 ? c[i * 3 + k] / wt[i] : 0; continue; }
      const fx = Math.min(uw - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), fy = Math.min(uh - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(uw - 1, x0 + 1), y1 = Math.min(uh - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
      for (let k = 0; k < 3; k++) {
        const top = upper[(y0 * uw + x0) * 3 + k] * (1 - ax) + upper[(y0 * uw + x1) * 3 + k] * ax;
        const bottom = upper[(y1 * uw + x0) * 3 + k] * (1 - ax) + upper[(y1 * uw + x1) * 3 + k] * ax;
        res[i * 3 + k] = top * (1 - ay) + bottom * ay;
      }
    }
    upper = res; uw = lw; uh = lh;
  }
  return upper!;
}

/** Longest run of rows (or columns) with no hole pixel: the texture source. */
function clearBand(hole: Uint8Array, w: number, h: number, rows: boolean) {
  let best = { start: 0, length: 0 }, start = -1;
  const outer = rows ? h : w, inner = rows ? w : h;
  for (let a = 0; a <= outer; a++) {
    let clear = a < outer;
    for (let b = 0; clear && b < inner; b++) if (hole[rows ? a * w + b : b * w + a]) clear = false;
    if (clear && start < 0) start = a;
    if (!clear && start >= 0) { if (a - start > best.length) best = { start, length: a - start }; start = -1; }
  }
  return best;
}
const reflect = (v: number, n: number) => { const m = ((v % (2 * n)) + 2 * n) % (2 * n); return m < n ? m : 2 * n - 1 - m; };

/** Square dilation of a 0/1 map by r pixels. */
export function grow(map: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const blurred = boxBlur(Float32Array.from(map), w, h, 1, r), out = new Uint8Array(map.length);
  for (let i = 0; i < map.length; i++) if (blurred[i] > 1e-3) out[i] = 1;
  return out;
}
export const deviation = (rgb: Float32Array, model: Float32Array, i: number) =>
  Math.max(Math.abs(rgb[i * 3] - model[i * 3]), Math.abs(rgb[i * 3 + 1] - model[i * 3 + 1]), Math.abs(rgb[i * 3 + 2] - model[i * 3 + 2]));
/** Texture noise of the pixels marked in `use`, as a robust sigma (median absolute deviation from the model). */
export function noiseSigma(rgb: Float32Array, model: Float32Array, use: Float32Array): number {
  const devs: number[] = [], step = Math.max(1, Math.floor(use.length / 20000));
  for (let i = 0; i < use.length; i += step) if (use[i]) devs.push(deviation(rgb, model, i));
  if (!devs.length) return 1;
  devs.sort((a, b) => a - b);
  return Math.max(0.5, devs[devs.length >> 1] * 1.4826);
}

/**
 * Cleanliness check for a rebuilt background: percent of pixels that stand out from their surroundings (wider than a
 * ~100 px neighborhood's average by 8 noise sigmas, at least 24 levels) - e.g. a leftover sleeve, a bright smear or a
 * backdrop fragment. A clean continuous background scores ~0.
 */
export function backgroundResidualPercent(rgbBytes: Uint8Array, w: number, h: number): number {
  const rgb = Float32Array.from(rgbBytes), model = boxBlur(rgb, w, h, 3, 48), all = new Float32Array(w * h).fill(1);
  const threshold = Math.max(24, 8 * noiseSigma(rgb, model, all));
  let count = 0;
  for (let i = 0; i < w * h; i++) if (deviation(rgb, model, i) > threshold) count++;
  return Math.round(10000 * count / (w * h)) / 100;
}

/** Marks every pixel not reachable from the canvas edge without crossing the mask (the inside of a ring, gaps in an oval). */
function fillEnclosed(mask: Uint8Array, w: number, h: number): number {
  const reached = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let head = 0, tail = 0;
  const visit = (i: number) => { if (!mask[i] && !reached[i]) { reached[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
  while (head < tail) {
    const i = queue[head++], x = i % w;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < mask.length - w) visit(i + w);
  }
  let filled = 0;
  for (let i = 0; i < mask.length; i++) if (!mask[i] && !reached[i]) { mask[i] = 1; filled++; }
  return filled;
}

/**
 * The real outer-background pixels: the uploaded image itself when it has the canvas aspect (Seedream's base can be
 * re-rendered - observed with a white instead of green background, or a redrawn subject), else the provider's base.
 */
async function pixelSource(base: Buffer, source: Buffer | undefined, w: number, h: number): Promise<{ rgb: Buffer; name: 'original' | 'base' }> {
  if (source) {
    const meta = await sharp(source).metadata().catch(() => undefined);
    if (meta?.width && meta.height && Math.abs((meta.width / meta.height) / (w / h) - 1) <= 0.01) {
      return { rgb: await sharp(source).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer(), name: 'original' };
    }
  }
  return { rgb: await sharp(base).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer(), name: 'base' };
}

/**
 * Rebuilds the outer background as one opaque full-canvas PNG from the real outer-background pixels (the uploaded image
 * when it matches the canvas aspect, else the provider base). Replaced: the inner backdrop and border (`holes`) and
 * everything they enclose, every foreground layer (`foreground`: subject, held objects), a 6 px margin, and any
 * remaining pixels that still stand out from the background (leftover foreground no layer covers, halos, shadows).
 * Returns undefined when less than 1% of the canvas is visible outer background: then nothing reliable can be rebuilt.
 */
export async function rebuildOuterBackground(base: Buffer, canvas: Size, holes: OverlayOptions[], foreground: OverlayOptions[] = [], options: { source?: Buffer } = {}): Promise<RebuildResult | undefined> {
  const { width: w, height: h } = canvas, n = w * h;
  const { rgb: baseRgb, name: source } = await pixelSource(base, options.source, w, h);
  const alphaOf = async (overlay: OverlayOptions) =>
    sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([overlay]).extractChannel(3).raw().toBuffer();
  // Backdrop + border, with everything they enclose: gaps in a partial backdrop alpha or inside a hairline border ring.
  const hole = new Uint8Array(n);
  for (const overlay of holes) { const alpha = await alphaOf(overlay); for (let i = 0; i < n; i++) if (alpha[i] > 16) hole[i] = 1; }
  const enclosed = fillEnclosed(hole, w, h);
  for (const overlay of foreground) { const alpha = await alphaOf(overlay); for (let i = 0; i < n; i++) if (alpha[i] > 16) hole[i] = 1; }
  // Grow the hole 6 px so anti-aliased edges are replaced too.
  const mask = grow(hole, w, h, 6);
  if (!mask.some(Boolean)) return { png: await sharp(baseRgb, { raw: { width: w, height: h, channels: 3 } }).ensureAlpha().png().toBuffer(), holePercent: 0, texture: 'none', contaminationPercent: 0, residualPercent: backgroundResidualPercent(baseRgb, w, h), source, enclosedPercent: 0 };

  const rgb = Float32Array.from(baseRgb);
  // Leftover contamination: compare each remaining base pixel with a background model built only from pixels at least
  // 48 px from the hole and carried inward, so a large leftover (a sleeve crossing the frame) cannot hide itself by
  // pulling the local average toward its own color. Stricter within that 48 px zone, where halos and shadows sit.
  // Repeated so contamination reaching further out is caught ring by ring.
  let contamination = 0;
  for (let pass = 0; pass < 3; pass++) {
    const near = grow(mask, w, h, 48), far = new Float32Array(n);
    for (let i = 0; i < n; i++) far[i] = near[i] ? 0 : 1;
    if (!far.some(Boolean)) break;
    const model = pushPull(maskedBlur(rgb, far, w, h, 24), far, w, h);
    const sigma = noiseSigma(rgb, model, far), tNear = Math.max(16, 6 * sigma), tFar = Math.max(36, 10 * sigma);
    const flagged = new Uint8Array(n);
    let found = 0;
    for (let i = 0; i < n; i++) if (!mask[i] && deviation(rgb, model, i) > (near[i] ? tNear : tFar)) { flagged[i] = 1; found++; }
    if (!found) break;
    const spread = grow(flagged, w, h, 4);
    for (let i = 0; i < n; i++) if (spread[i] && !mask[i]) { mask[i] = 1; contamination++; }
  }
  let holeCount = 0;
  for (let i = 0; i < n; i++) holeCount += mask[i];
  // Nothing trustworthy to continue from: keep the provider layer rather than invent a background.
  if (n - holeCount < n * 0.01) return undefined;

  const { out, texture } = fillMasked(rgb, mask, w, h);
  return { png: await sharp(out, { raw: { width: w, height: h, channels: 3 } }).ensureAlpha().png().toBuffer(), holePercent: Math.round(1000 * holeCount / n) / 10, texture,
    contaminationPercent: Math.round(10000 * contamination / n) / 100, residualPercent: backgroundResidualPercent(out, w, h), source, enclosedPercent: Math.round(10000 * enclosed / n) / 100 };
}

/**
 * Fills the masked pixels (mask = 1) by continuing the unmasked surroundings: a smooth color and lighting field
 * interpolated inward (push-pull), plus fine texture borrowed from the longest untouched row or column band. Unmasked
 * pixels are kept; a 3 px soft seam blends inside the mask. Deterministic, no model call. Shared by the outer-background
 * rebuild and the recursive decomposition's residual images and local clean-background fallback.
 */
export function fillMasked(rgb: Float32Array, mask: Uint8Array, w: number, h: number): { out: Buffer; texture: string } {
  const n = w * h;
  const known = new Float32Array(n);
  for (let i = 0; i < n; i++) known[i] = mask[i] ? 0 : 1;
  // Low frequency: color and lighting of the surrounding background, continued inward, then smoothed.
  const lowKnown = maskedBlur(rgb, known, w, h, 20);
  const low = boxBlur(pushPull(lowKnown, known, w, h), w, h, 3, 24);
  // High frequency: texture detail from the longest untouched band, mirrored across the canvas.
  const rows = clearBand(mask, w, h, true), cols = clearBand(mask, w, h, false);
  const useRows = rows.length >= cols.length, band = useRows ? rows : cols;
  const texture = band.length >= 16 ? `${useRows ? 'rows' : 'columns'} ${band.start}-${band.start + band.length - 1}` : 'none (too little untouched background)';
  const filled = new Float32Array(rgb.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    let sx = x, sy = y;
    if (band.length >= 16) { if (useRows) sy = band.start + reflect(y - band.start, band.length); else sx = band.start + reflect(x - band.start, band.length); }
    const s = sy * w + sx;
    for (let c = 0; c < 3; c++) filled[i * 3 + c] = low[i * 3 + c] + (band.length >= 16 ? rgb[s * 3 + c] - lowKnown[s * 3 + c] : 0);
  }
  // Blend: base outside, filled inside, 3 px soft seam inside the grown margin.
  const alpha = boxBlur(Float32Array.from(mask), w, h, 1, 3), out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const a = mask[i] ? alpha[i] : 0;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(rgb[i * 3 + c] * (1 - a) + filled[i * 3 + c] * a)));
  }
  return { out, texture };
}
