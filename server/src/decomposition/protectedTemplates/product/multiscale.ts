/**
 * Large uploads (a 4096 px creative is 16.7 million pixels): the object analysis — local masks, display stands and the
 * background rebuilt behind them — runs on a WORKING copy of a fixed size, and the layers are composed from the
 * full-size pixels.
 *
 *   why       the analysis' thresholds are in pixels (colour steps between neighbours, region sizes, margins) and were
 *             tuned and verified on creatives about 600 px across; run on 16.7 million pixels it found other regions
 *             (6 stands at 607 px, 4 at 1024, 1 at 2048) and its patch inpainting took minutes
 *   down      area average (each working pixel the mean of the full-size pixels it covers: no ringing, no colour of one
 *             object reaching the pixels beside it)
 *   labels    each full-size pixel takes the label (object k, stand j, background) its working neighbours vote for,
 *             weighted by distance and by how alike their colours are to its own (joint bilateral upsampling): edges
 *             follow the full-size picture, not the working grid
 *   fill      only where something was taken out: the working rebuild, sampled bilinearly; every other pixel stays the
 *             full-size original's own
 *
 * Text, logos and their removal are never scaled: they are handled at full size before this.
 */
export const PRODUCT_WORK_SIDE = 768;

export interface WorkSize { w: number; h: number; fx: number; fy: number }

/** The working size for a picture, or undefined when it is small enough to analyse as it is. */
export function workSize(w: number, h: number, side = PRODUCT_WORK_SIDE): WorkSize | undefined {
  const long = Math.max(w, h);
  if (long <= side) return undefined;
  const ww = Math.max(1, Math.round(w * side / long)), wh = Math.max(1, Math.round(h * side / long));
  return { w: ww, h: wh, fx: ww / w, fy: wh / h };
}

/** Area-average downscale of an RGB picture. */
export function binDown(rgb: Uint8Array, w: number, h: number, ws: WorkSize): Uint8Array {
  const nw = ws.w * ws.h, sum = new Float64Array(nw * 3), count = new Uint32Array(nw);
  const col = new Int32Array(w); for (let x = 0; x < w; x++) col[x] = Math.min(ws.w - 1, Math.floor(x * ws.fx));
  for (let y = 0; y < h; y++) {
    const row = Math.min(ws.h - 1, Math.floor(y * ws.fy)) * ws.w;
    for (let x = 0; x < w; x++) { const q = row + col[x], i = (y * w + x) * 3; sum[q * 3] += rgb[i]; sum[q * 3 + 1] += rgb[i + 1]; sum[q * 3 + 2] += rgb[i + 2]; count[q]++; }
  }
  const out = new Uint8Array(nw * 3);
  for (let q = 0; q < nw; q++) for (let c = 0; c < 3; c++) out[q * 3 + c] = Math.round(sum[q * 3 + c] / Math.max(1, count[q]));
  return out;
}

/** A full-size mask on the working grid: a working pixel is set when at least `share` of what it covers is. */
export function maskDown(mask: Uint8Array, w: number, h: number, ws: WorkSize, share = 0.5): Uint8Array {
  const nw = ws.w * ws.h, on = new Uint32Array(nw), count = new Uint32Array(nw), out = new Uint8Array(nw);
  for (let y = 0; y < h; y++) {
    const row = Math.min(ws.h - 1, Math.floor(y * ws.fy)) * ws.w;
    for (let x = 0; x < w; x++) { const q = row + Math.min(ws.w - 1, Math.floor(x * ws.fx)); count[q]++; if (mask[y * w + x]) on[q]++; }
  }
  for (let q = 0; q < nw; q++) if (on[q] && (share <= 0 || on[q] >= count[q] * share)) out[q] = 1;
  return out;
}

/** The working pixel covering a full-size pixel. */
export const workIndex = (x: number, y: number, ws: WorkSize) => Math.min(ws.h - 1, Math.floor(y * ws.fy)) * ws.w + Math.min(ws.w - 1, Math.floor(x * ws.fx));

export function dilate(mask: Uint8Array, w: number, h: number, r = 1): Uint8Array {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const out = Uint8Array.from(cur);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!cur[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) out[Y * w + X] = 1; }
    }
    cur = out;
  }
  return cur;
}

/**
 * Working labels (-1 background, else a layer's number) at full size. Where the 3×3 working pixels around a pixel agree,
 * it is theirs; elsewhere (a band about one working pixel wide along every edge) the 4×4 working neighbours vote,
 * each by its distance and by how close its colour is to the full-size pixel's.
 */
export function upsampleLabels(labels: Int32Array, wrgb: Uint8Array, ws: WorkSize, rgb: Uint8Array, w: number, h: number): Int32Array {
  const W = ws.w, H = ws.h, out = new Int32Array(w * h);
  const uniform = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const l = labels[y * W + x]; let same = 1;
    for (let dy = -1; dy <= 1 && same; dy++) for (let dx = -1; dx <= 1; dx++) { const X = Math.min(W - 1, Math.max(0, x + dx)), Y = Math.min(H - 1, Math.max(0, y + dy)); if (labels[Y * W + X] !== l) { same = 0; break; } }
    uniform[y * W + x] = same;
  }
  const keys: number[] = [], weights: number[] = [], sr2 = 2 * 18 * 18, ss2 = 2 * 0.75 * 0.75;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * ws.fy - 0.5, cy = Math.min(H - 1, Math.max(0, Math.round(v))), y0 = Math.floor(v);
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * ws.fx - 0.5, cx = Math.min(W - 1, Math.max(0, Math.round(u))), c = cy * W + cx, i = y * w + x;
      if (uniform[c]) { out[i] = labels[c]; continue; }
      const x0 = Math.floor(u); keys.length = 0; weights.length = 0;
      for (let qy = y0 - 1; qy <= y0 + 2; qy++) { if (qy < 0 || qy >= H) continue; for (let qx = x0 - 1; qx <= x0 + 2; qx++) {
        if (qx < 0 || qx >= W) continue;
        const q = qy * W + qx, ds = (qx - u) * (qx - u) + (qy - v) * (qy - v); if (ds > 4) continue;
        const dc = Math.max(Math.abs(rgb[i * 3] - wrgb[q * 3]), Math.abs(rgb[i * 3 + 1] - wrgb[q * 3 + 1]), Math.abs(rgb[i * 3 + 2] - wrgb[q * 3 + 2]));
        const wt = Math.exp(-ds / ss2 - (dc * dc) / sr2) + 1e-9, k = keys.indexOf(labels[q]);
        if (k < 0) { keys.push(labels[q]); weights.push(wt); } else weights[k] += wt;
      } }
      let best = 0; for (let k = 1; k < keys.length; k++) if (weights[k] > weights[best]) best = k;
      out[i] = keys.length ? keys[best] : labels[c];
    }
  }
  return out;
}

/** Bilinear sample of a working RGB picture at a full-size pixel, only from working pixels `use` allows (else nearest allowed). */
export function sampleRgb(wrgb: Uint8Array, ws: WorkSize, x: number, y: number, out: number[], use?: (q: number) => boolean): boolean {
  const u = Math.min(ws.w - 1, Math.max(0, (x + 0.5) * ws.fx - 0.5)), v = Math.min(ws.h - 1, Math.max(0, (y + 0.5) * ws.fy - 0.5));
  const x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(ws.w - 1, x0 + 1), y1 = Math.min(ws.h - 1, y0 + 1), tx = u - x0, ty = v - y0;
  let a = 0, r = 0, g = 0, b = 0;
  for (const [qx, qy, wt] of [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]] as const) {
    const q = qy * ws.w + qx; if (wt <= 0 || (use && !use(q))) continue;
    a += wt; r += wrgb[q * 3] * wt; g += wrgb[q * 3 + 1] * wt; b += wrgb[q * 3 + 2] * wt;
  }
  if (a <= 0) {
    // None of the four: the nearest allowed pixel within two working pixels.
    let best = -1, bd = Infinity;
    for (let qy = Math.max(0, y0 - 2); qy <= Math.min(ws.h - 1, y0 + 3); qy++) for (let qx = Math.max(0, x0 - 2); qx <= Math.min(ws.w - 1, x0 + 3); qx++) {
      const q = qy * ws.w + qx, d = (qx - u) ** 2 + (qy - v) ** 2; if (d < bd && (!use || use(q))) { bd = d; best = q; }
    }
    if (best < 0) return false;
    out[0] = wrgb[best * 3]; out[1] = wrgb[best * 3 + 1]; out[2] = wrgb[best * 3 + 2]; return true;
  }
  out[0] = Math.round(r / a); out[1] = Math.round(g / a); out[2] = Math.round(b / a); return true;
}
