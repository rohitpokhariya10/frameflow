/**
 * Local, deterministic background-filling primitives shared by the clean-background steps (backgroundRecovery.ts,
 * cleanBackground.ts, recursiveDecomposition.ts and others): blurs, a push-pull interpolation of a smooth color and
 * lighting field into masked holes, noise estimates, and a texture-aware fill. No model call.
 */
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
