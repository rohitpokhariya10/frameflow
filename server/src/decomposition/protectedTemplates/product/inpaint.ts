/**
 * Local exemplar-based inpainting (multi-scale PatchMatch, Wexler-style voting): what was hidden behind an object (or
 * under text on busy artwork) rebuilt from patches of the picture's own surrounding artwork — stripes, rays, rings,
 * borders and plain fields continue with their own texture instead of a blur. Free and deterministic (seeded).
 *
 * It is an ESTIMATE of pixels that were never visible: callers record the share they filled and say so; it never
 * replaces a pixel outside `hole`.

 */
type Img = { w: number; h: number; c: Float32Array }; // 3 channels, 0..255

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

function down(img: Img, hole: Uint8Array): { img: Img; hole: Uint8Array } {
  const w = Math.max(1, img.w >> 1), h = Math.max(1, img.h >> 1), c = new Float32Array(w * h * 3), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let n = 0; const acc = [0, 0, 0];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const X = Math.min(img.w - 1, 2 * x + dx), Y = Math.min(img.h - 1, 2 * y + dy), i = Y * img.w + X;
      if (hole[i]) { out[y * w + x] = 1; continue; }
      for (let k = 0; k < 3; k++) acc[k] += img.c[i * 3 + k]; n++;
    }
    for (let k = 0; k < 3; k++) c[(y * w + x) * 3 + k] = n ? acc[k] / n : 0;
  }
  return { img: { w, h, c }, hole: out };
}

/** Coarsest level: holes filled from their edge inward with the mean of known neighbours (a starting point only). */
function onionFill(img: Img, hole: Uint8Array) {
  const known = Uint8Array.from(hole, v => (v ? 0 : 1));
  let left = hole.reduce((s, v) => s + v, 0), guard = 0;
  while (left > 0 && guard++ < img.w + img.h) {
    const next: number[] = [];
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
      const i = y * img.w + x; if (known[i]) continue;
      let n = 0; const acc = [0, 0, 0];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= img.w || Y >= img.h) continue;
        const j = Y * img.w + X; if (!known[j]) continue; for (let k = 0; k < 3; k++) acc[k] += img.c[j * 3 + k]; n++;
      }
      if (n) { for (let k = 0; k < 3; k++) img.c[i * 3 + k] = acc[k] / n; next.push(i); }
    }
    for (const i of next) known[i] = 1;
    left -= next.length;
    if (!next.length) break;
  }
}

/** One level: PatchMatch nearest neighbours for every patch touching the hole, then voting; `nnf` carried between levels. */
function solveLevel(img: Img, hole: Uint8Array, r: number, em: number, iters: number, rand: () => number, init?: Int32Array, exclude?: Uint8Array): Int32Array {
  const { w, h, c } = img, n = w * h;
  // Valid source centres: the whole patch inside the picture, outside the hole and outside what may not be copied.
  // (bad: 1 = its patch touches the hole, 2 = only what may not be copied.)
  const bad = new Uint8Array(n);
  for (const v of [2, 1]) for (let i = 0; i < n; i++) if (v === 1 ? hole[i] : exclude?.[i]) { const x = i % w, y = (i - x) / w; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) bad[Y * w + X] = v; } }
  const valid: number[] = [];
  for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) if (!bad[y * w + x]) valid.push(y * w + x);
  const nnf = new Int32Array(n).fill(-1), dist = new Float32Array(n).fill(Infinity);
  if (!valid.length) return nnf;
  // Targets: centres whose patch touches the hole (not those only near an excluded source: a large exclusion made every
  // pixel of the picture a target, 25 s at 4096 px).
  const targets: number[] = [];
  for (let i = 0; i < n; i++) if (bad[i] === 1) targets.push(i);
  const isValid = (s: number) => { const x = s % w, y = (s - x) / w; return x >= r && y >= r && x < w - r && y < h - r && !bad[s]; };
  const d = (t: number, s: number, best: number) => {
    const tx = t % w, ty = (t - tx) / w, sx = s % w, sy = (s - sx) / w; let sum = 0, m = 0;
    for (let dy = -r; dy <= r; dy++) { const Y = ty + dy; if (Y < 0 || Y >= h) continue; for (let dx = -r; dx <= r; dx++) {
      const X = tx + dx; if (X < 0 || X >= w) continue;
      const a = (Y * w + X) * 3, b = ((sy + dy) * w + sx + dx) * 3, e0 = c[a] - c[b], e1 = c[a + 1] - c[b + 1], e2 = c[a + 2] - c[b + 2];
      sum += e0 * e0 + e1 * e1 + e2 * e2; m++; if (sum > best * m) return Infinity;
    } }
    return m ? sum / m : Infinity;
  };
  for (const t of targets) { const s = init && init[t] >= 0 && isValid(init[t]) ? init[t] : valid[Math.floor(rand() * valid.length)]; nnf[t] = s; dist[t] = d(t, s, Infinity); }
  const maxR = Math.max(w, h);
  for (let e = 0; e < em; e++) {
    for (let it = 0; it < iters; it++) {
      const order = it % 2 ? [...targets].reverse() : targets, step = it % 2 ? 1 : -1;
      for (const t of order) {
        const tx = t % w;
        // Propagation from the neighbour already visited in this pass.
        for (const nb of [tx + step >= 0 && tx + step < w ? t + step : -1, t + step * w >= 0 && t + step * w < n ? t + step * w : -1]) {
          if (nb < 0 || nnf[nb] < 0) continue;
          const cand = nnf[nb] - (nb - t); if (!isValid(cand)) continue;
          const dd = d(t, cand, dist[t]); if (dd < dist[t]) { dist[t] = dd; nnf[t] = cand; }
        }
        // Random search around the current match, shrinking.
        const s0 = nnf[t], sx = s0 % w, sy = (s0 - sx) / w;
        for (let rad = maxR; rad >= 1; rad >>= 1) {
          const X = Math.round(sx + (rand() * 2 - 1) * rad), Y = Math.round(sy + (rand() * 2 - 1) * rad); if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          const cand = Y * w + X; if (!isValid(cand)) continue;
          const dd = d(t, cand, dist[t]); if (dd < dist[t]) { dist[t] = dd; nnf[t] = cand; }
        }
      }
    }
    // Voting: each hole pixel the similarity-weighted mean of what the patches covering it propose.
    const acc = new Float32Array(n * 3), wsum = new Float32Array(n);
    const finite = targets.map(t => dist[t]).filter(Number.isFinite).sort((a, b) => a - b), sigma = Math.max(1, finite[Math.floor(finite.length * 0.75)] ?? 1);
    for (const t of targets) {
      if (nnf[t] < 0 || !Number.isFinite(dist[t])) continue;
      const tx = t % w, ty = (t - tx) / w, s = nnf[t], sx = s % w, sy = (s - sx) / w, wt = Math.exp(-dist[t] / (2 * sigma));
      for (let dy = -r; dy <= r; dy++) { const Y = ty + dy; if (Y < 0 || Y >= h) continue; for (let dx = -r; dx <= r; dx++) {
        const X = tx + dx; if (X < 0 || X >= w) continue; const q = Y * w + X; if (!hole[q]) continue;
        const b = ((sy + dy) * w + sx + dx) * 3; acc[q * 3] += c[b] * wt; acc[q * 3 + 1] += c[b + 1] * wt; acc[q * 3 + 2] += c[b + 2] * wt; wsum[q] += wt;
      } }
    }
    for (let q = 0; q < n; q++) if (hole[q] && wsum[q] > 0) for (let k = 0; k < 3; k++) c[q * 3 + k] = acc[q * 3 + k] / wsum[q];
    for (const t of targets) dist[t] = nnf[t] >= 0 ? d(t, nnf[t], Infinity) : Infinity;
  }
  return nnf;
}

/**
 * Fills `hole` (1 = rebuild) in an RGB picture. Returns a new RGB array; pixels outside the hole are the input's own.
 * `patch`: patch side (odd). Holes that touch nothing known are left as the coarse estimate.
 */
export function inpaint(rgb: Uint8Array, w: number, h: number, hole: Uint8Array, options: { patch?: number; seed?: number; exclude?: Uint8Array } = {}): Uint8Array {
  if (!hole.some(v => v)) return Uint8Array.from(rgb);
  const r = (options.patch ?? 7) >> 1, rand = rng(options.seed ?? 7);
  const base: Img = { w, h, c: Float32Array.from(rgb) };
  const levels: { img: Img; hole: Uint8Array; exclude?: Uint8Array }[] = [{ img: base, hole, exclude: options.exclude }];
  while (Math.min(levels.at(-1)!.img.w, levels.at(-1)!.img.h) >= 2 * Math.max(40, 6 * r)) { const l = levels.at(-1)!; levels.push({ ...down(l.img, l.hole), ...(l.exclude ? { exclude: down(l.img, l.exclude).hole } : {}) }); }
  onionFill(levels.at(-1)!.img, levels.at(-1)!.hole);
  let nnf: Int32Array | undefined;
  for (let l = levels.length - 1; l >= 0; l--) {
    const { img, hole: hl } = levels[l];
    if (l < levels.length - 1) {
      // Start from the coarser solution: its pixels (in the hole) and its matches, scaled up.
      const coarse = levels[l + 1];
      for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
        const i = y * img.w + x; if (!hl[i]) continue;
        const X = Math.min(coarse.img.w - 1, x >> 1), Y = Math.min(coarse.img.h - 1, y >> 1), j = Y * coarse.img.w + X;
        for (let k = 0; k < 3; k++) img.c[i * 3 + k] = coarse.img.c[j * 3 + k];
      }
      if (nnf) {
        const up = new Int32Array(img.w * img.h).fill(-1);
        for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
          const X = Math.min(coarse.img.w - 1, x >> 1), Y = Math.min(coarse.img.h - 1, y >> 1), s = nnf[Y * coarse.img.w + X];
          if (s < 0) continue; const sx = s % coarse.img.w, sy = (s - sx) / coarse.img.w;
          up[y * img.w + x] = Math.min(img.h - 1, 2 * sy + (y & 1)) * img.w + Math.min(img.w - 1, 2 * sx + (x & 1));
        }
        nnf = up;
      }
    }
    nnf = solveLevel(img, hl, r, l === 0 ? 2 : 3, l === 0 ? 3 : 4, rand, nnf, levels[l].exclude);
  }
  const out = Uint8Array.from(rgb);
  for (let i = 0; i < w * h; i++) if (hole[i]) for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.max(0, Math.min(255, Math.round(base.c[i * 3 + k])));
  return out;
}
