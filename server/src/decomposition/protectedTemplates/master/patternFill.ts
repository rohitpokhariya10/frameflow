/**
 * The clean background of a master template: the source with its replaceable content (text ink, text plates, logo slots)
 * removed, and every removed pixel continued from the artwork around it. Local and deterministic; always an estimate,
 * shown for review with each filled area marked by how it was continued:
 *
 *   plain     a plain field (one smooth surface): continued exactly          trusted
 *   pattern   a repeating pattern (a lattice of diamonds, dots, stripes): each block copied from the same pattern one or
 *             more repeats away, chosen where the block's known edge matches best                  trusted when it matches
 *   flat      flat graphic colours (bands, shapes): their regions continued   trusted
 *   smooth    anything else: a smooth estimate of the colours around it, no detail invented        an estimate to check
 *
 * The repeat of a pattern is measured from the artwork itself (the shifts that map the known pixels around the hole onto
 * themselves), never assumed.
 */
import sharp from 'sharp';
import type { ProtectedFillRegion } from '@frameflow/shared';
import { flattenRgb, type Rgba } from '../pixels.js';
import { backgroundDifficulty, graphicFill, plainFieldFill } from '../../backgroundRecovery.js';
import { label } from '../../backgroundContamination.js';
import { boxBlur, grow, maskedBlur, pushPull } from '../../outerBackground.js';

export type FillMethod = 'plain' | 'pattern' | 'flat' | 'smooth';
export interface FilledArea { box: { x: number; y: number; width: number; height: number }; pixels: number; method: FillMethod; trusted: boolean; detail: string; lattice?: Lattice; matchError?: number }
export interface CleanBackground { png: Buffer; previewPng: Buffer; maskPng: Buffer; areas: FilledArea[]; regions: ProtectedFillRegion[]; filledPercent: number; trustedPercent: number }

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * The ground colours right around a hole (a ring of `ring` px, masked pixels skipped): the colours of the pattern it sits
 * in (its ground, at least 6% of the ring, and its lines, at least 2.5%), at most three. A frame or panel of another colour further
 * away is not among them, so it never counts as the pattern.
 */
function holeGround(rgb: Uint8Array, mask: Uint8Array, w: number, h: number, hole: { x: number; y: number; width: number; height: number }, ring = 36): number[][] {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let y = Math.max(0, hole.y - ring); y < Math.min(h, hole.y + hole.height + ring); y += 2) for (let x = Math.max(0, hole.x - ring); x < Math.min(w, hole.x + hole.width + ring); x += 2) {
    const i = y * w + x;
    if (mask[i] || (x >= hole.x && x < hole.x + hole.width && y >= hole.y && y < hole.y + hole.height)) continue;
    const k = ((rgb[i * 3] >> 4) << 8) | ((rgb[i * 3 + 1] >> 4) << 4) | (rgb[i * 3 + 2] >> 4), c = counts.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++; c.r += rgb[i * 3]; c.g += rgb[i * 3 + 1]; c.b += rgb[i * 3 + 2]; counts.set(k, c); total++;
  }
  const out: number[][] = [];
  // The ground itself is common; a pattern's thin lines can be only a few percent of the ring.
  for (const c of [...counts.values()].sort((a, b) => b.n - a.n)) {
    if (c.n < total * (out.length ? 0.025 : 0.06) || out.length >= 3) break;
    const col = [c.r / c.n, c.g / c.n, c.b / c.n];
    if (!out.some(o => Math.max(...o.map((v, k) => Math.abs(v - col[k]))) <= 20)) out.push(col);
  }
  return out;
}
export interface Lattice { a: { x: number; y: number }; b: { x: number; y: number }; strength: number }
/**
 * The lattice of a repeating pattern around a hole (two shifts that map the pattern onto itself), or none. For each colour
 * of the ground right around the hole, the share of its pixels that land on the same colour after a shift: a pattern's
 * line colour drops right after small shifts and comes back to nearly all at a repeat, while a flat field or a frame never
 * peaks. First the shortest repeat along x, then the shortest shift with a vertical part (a staggered row of diamonds is
 * repeated diagonally), both refined at full resolution. `cache` shares the result between holes in the same pattern.
 */
export function measureLattice(rgb: Uint8Array, mask: Uint8Array, w: number, h: number, hole: { x: number; y: number; width: number; height: number }, cache?: Map<string, Lattice | null>, log?: (line: string) => void): Lattice | undefined {
  const ground = holeGround(rgb, mask, w, h, hole);
  log?.(`ground ${JSON.stringify(ground.map(g => g.map(Math.round)))}`);
  if (!ground.length) return undefined;
  const reach = 460, win = { x: Math.max(0, hole.x - reach), y: Math.max(0, hole.y - reach), width: 0, height: 0 };
  win.width = Math.min(w, hole.x + hole.width + reach) - win.x; win.height = Math.min(h, hole.y + hole.height + reach) - win.y;
  const key = `${ground.map(g => g.map(v => Math.round(v / 16)).join('.')).join('|')}@${Math.round(hole.x / 700)},${Math.round(hole.y / 700)}`;
  if (cache?.has(key)) return cache.get(key) ?? undefined;
  const s = 3, W = Math.floor(win.width / s), H = Math.floor(win.height / s);
  const near = (i: number, c: number[], t: number) => Math.abs(rgb[i * 3] - c[0]) <= t && Math.abs(rgb[i * 3 + 1] - c[1]) <= t && Math.abs(rgb[i * 3 + 2] - c[2]) <= t;
  // How well a shift maps the ground pixels around the hole onto themselves, in colour (mean of the largest channel
  // difference, sampled at full resolution); a true repeat of a vector pattern is a few levels at most.
  // How well a shift maps the pattern's line pixels (colour `line`) onto the same colour, in RGB: the mean largest channel
  // difference, sampled at full resolution. A true repeat of a vector pattern is a few levels (anti-aliasing) at most.
  let line = ground[0];
  // The median, so line pixels that a shift carries off the pattern (onto a frame, an illustration) do not count.
  const colourError = (dx: number, dy: number) => {
    const hist = new Uint32Array(256);
    let n = 0;
    for (let y = win.y; y < win.y + win.height; y += 2) for (let x = win.x; x < win.x + win.width; x += 2) {
      const x2 = x + dx, y2 = y + dy;
      if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
      const i = y * w + x, j = y2 * w + x2;
      if (mask[i] || mask[j] || !near(i, line, 22)) continue;
      hist[Math.max(Math.abs(rgb[i * 3] - rgb[j * 3]), Math.abs(rgb[i * 3 + 1] - rgb[j * 3 + 1]), Math.abs(rgb[i * 3 + 2] - rgb[j * 3 + 2]))]++; n++;
    }
    if (n < 200) return Infinity;
    for (let v = 0, seen = 0; v < 256; v++) { seen += hist[v]; if (seen * 2 >= n) return v; }
    return 255;
  };
  /** The candidate shift (refined ±3 px at full resolution) with the lowest colour error; the shortest among near-equals. */
  const pickByColour = (cands: { x: number; y: number; v: number }[]) => {
    log?.(`  pick from ${JSON.stringify(cands.slice(0, 6).map(c => [c.x, c.y, +c.v.toFixed(2)]))}`);
    const refined = cands.map(c => {
      let b: { x: number; y: number; e: number } = { x: c.x, y: c.y, e: colourError(c.x, c.y) };
      for (let dy = c.y - (c.y ? 3 : 0); dy <= c.y + (c.y ? 3 : 0); dy++) for (let dx = c.x - 3; dx <= c.x + 3; dx++) { if (!dx && !dy) continue; const e = colourError(dx, dy); if (e < b.e) b = { x: dx, y: dy, e }; }
      return b;
    }).filter(r => Number.isFinite(r.e));
    log?.(`  refined ${JSON.stringify(refined.slice(0, 6).map(r => [r.x, r.y, +r.e.toFixed(1)]))}`);
    if (!refined.length) return undefined;
    const min = Math.min(...refined.map(r => r.e));
    if (min > 18) return undefined;
    return refined.filter(r => r.e <= Math.max(min * 1.3, min + 1.5)).sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y))[0];
  };
  let best: (Lattice & { colour: number[] }) | undefined;
  for (const c of ground) {
    line = c;
    const on = new Uint8Array(W * H), known = new Uint8Array(W * H), cells: number[] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (win.y + y * s + 1) * w + win.x + x * s + 1; if (mask[i]) continue; known[y * W + x] = 1; if (near(i, c, 22)) { on[y * W + x] = 1; cells.push(y * W + x); } }
    if (cells.length < 150) continue;
    const step = Math.max(1, Math.floor(cells.length / 6000));
    const share = (dx: number, dy: number) => {
      let hit = 0, n = 0;
      for (let k = 0; k < cells.length; k += step) {
        const a = cells[k], x = a % W, y = (a - x) / W, x2 = x + dx, y2 = y + dy;
        if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
        const b = y2 * W + x2; if (!known[b]) continue;
        n++; if (on[b]) hit++;
      }
      return n >= 100 ? hit / n : NaN;
    };
    // The colour must lose its match right after a small shift (thin structure, not a flat area).
    const after = Math.min(...[2, 3, 4].map(k => share(k, 0)).filter(Number.isFinite), ...[2, 3, 4].map(k => share(0, k)).filter(Number.isFinite));
    log?.(`colour ${c.map(Math.round)} cells ${cells.length} after ${after.toFixed(2)}`);
    if (!(after < 0.5)) continue;
    // A repeat stands out against the share of an unrelated shift (thin lines rarely meet by chance).
    const xs = Array.from({ length: Math.floor(Math.min(reach / s, W * 0.6)) - 2 }, (_, i) => share(i + 3, 0)).filter(Number.isFinite).sort((a, b) => a - b);
    const chance = xs[Math.floor(xs.length / 2)] ?? 0, peak = Math.max(0.4, chance * 5, chance + 0.3);
    // Candidates along x: every local peak of the share; the true repeat is the shortest whose copy matches in colour.
    const xPeaks: { d: number; v: number }[] = [];
    const xMax = Math.floor(Math.min(reach / s, W * 0.6)), xShares = Array.from({ length: xMax + 2 }, (_, k) => (k >= 3 ? share(k, 0) : NaN));
    for (let k = 4; k <= xMax; k++) if (xShares[k] >= peak && xShares[k] >= (xShares[k - 1] || 0) && xShares[k] >= (xShares[k + 1] || 0)) xPeaks.push({ d: k, v: xShares[k] });
    log?.(`  chance ${chance.toFixed(2)} peak ${peak.toFixed(2)} xPeaks ${JSON.stringify(xPeaks.slice(0, 8).map(p => [p.d * s, +p.v.toFixed(2)]))}`);
    if (!xPeaks.length) continue;
    const pickedX = pickByColour(xPeaks.map(p => ({ x: p.d * s, y: 0, v: p.v }))), ax = pickedX && { ...pickedX, v: xPeaks.find(p => p.d * s === Math.round(pickedX.x / s) * s)?.v ?? peak };
    if (!ax) continue;
    // The second repeat: shifts with a vertical part, not shorter than a quarter of the first (a short shift along a
    // pattern's own lines maps those lines onto themselves without being a repeat); judged by colour like the first.
    const found: { x: number; y: number; v: number }[] = [], minLength = ax.x / s * 0.25;
    for (let dy = 1; dy <= Math.floor(Math.min(reach / s, H * 0.6)); dy++) for (let dx = -Math.ceil(ax.x / s / 2) - 1; dx <= Math.ceil(ax.x / s / 2) + 1; dx++) {
      if (Math.hypot(dx, dy) < minLength) continue;
      const v = share(dx, dy); if (Number.isFinite(v) && v >= peak) found.push({ x: dx * s, y: dy * s, v });
    }
    if (!found.length) continue;
    const top = found.sort((p, q) => q.v - p.v).slice(0, 12), pickedB = pickByColour(top), bxy = pickedB && { ...pickedB, v: top[0].v };
    if (!bxy) continue;
    const strength = (ax.v + bxy.v) / 2 - after;
    if (!best || strength > best.strength) best = { a: { x: ax.x, y: ax.y }, b: { x: bxy.x, y: bxy.y }, strength, colour: c };
  }
  if (!best) { cache?.set(key, null); return undefined; }
  line = best.colour;
  // Sub-pixel: a repeat of 230.5 px shows as the best match at 461 px for twice the shift.
  const refine = (v: { x: number; y: number }) => {
    const e1 = colourError(v.x, v.y);
    let b2 = { x: v.x * 2, y: v.y * 2 }, b2e = Infinity;
    for (let dy = v.y * 2 - (v.y ? 1 : 0); dy <= v.y * 2 + (v.y ? 1 : 0); dy++) for (let dx = v.x * 2 - 1; dx <= v.x * 2 + 1; dx++) { const e = colourError(dx, dy); if (e < b2e) { b2e = e; b2 = { x: dx, y: dy }; } }
    return b2e < e1 * 0.85 ? { x: b2.x / 2, y: b2.y / 2 } : v;
  };
  const result: Lattice = { a: refine(best.a), b: refine(best.b), strength: Math.round(best.strength * 100) / 100 };
  cache?.set(key, result);
  return result;
}

/**
 * Fills one hole by copying the repeating pattern: 24 px blocks from the hole's edge inward, each copied from a lattice shift
 * (whole repeats, ±2 px) whose source square is entirely the pattern's own ground (no hole, no other content, nothing of
 * another colour) and whose copy best matches the block's known or already filled edge. Validity is one look-up per shift
 * (a summed-area table of the pixels that may not be copied).
 */
function patternCopy(rgb: Uint8Array, out: Buffer, fill: Uint8Array, bad: Int32Array, w: number, h: number, pixels: number[], lattice: Lattice): { error: number; failed: number; seams: number } {
  const B = 32, R = 4;
  const hole = new Uint8Array(w * h);
  for (const i of pixels) hole[i] = 1;
  const blocks = new Map<number, number[]>();
  for (const i of pixels) { const x = i % w, y = (i - x) / w, k = Math.floor(y / B) * 100000 + Math.floor(x / B); (blocks.get(k) ?? blocks.set(k, []).get(k)!).push(i); }
  // Whole-pixel shifts only: with a repeat of 230.5 px an odd multiple would land half a pixel off and break thin lines.
  const shifts: { dx: number; dy: number }[] = [], whole = (v: number) => Math.abs(v - Math.round(v)) < 0.15;
  for (let a = -14; a <= 14; a++) for (let b = -14; b <= 14; b++) {
    const ex = a * lattice.a.x + b * lattice.b.x, ey = a * lattice.a.y + b * lattice.b.y;
    if ((a || b) && whole(ex) && whole(ey)) shifts.push({ dx: Math.round(ex), dy: Math.round(ey) });
  }
  shifts.sort((p, q) => Math.hypot(p.dx, p.dy) - Math.hypot(q.dx, q.dy));
  const used = new Map<number, { dx: number; dy: number }>();
  // Pixels that may not be copied, as a summed-area table (W+1 × H+1).
  const W1 = w + 1, sat = (x0: number, y0: number, x1: number, y1: number) => bad[y1 * W1 + x1] - bad[y0 * W1 + x1] - bad[y1 * W1 + x0] + bad[y0 * W1 + x0];
  const clean = (x0: number, y0: number, x1: number, y1: number) => x0 >= 0 && y0 >= 0 && x1 <= w && y1 <= h && sat(x0, y0, x1, y1) === 0;
  const done = new Uint8Array(w * h), knownAt = (i: number) => !hole[i] || done[i];
  let errSum = 0, errN = 0, failed = 0;
  // One shift for the whole hole when a clean copy of all of it exists nearby: no seam inside it at all.
  {
    let hx0 = w, hy0 = h, hx1 = 0, hy1 = 0;
    for (const i of pixels) { const x = i % w, y = (i - x) / w; if (x < hx0) hx0 = x; if (x > hx1) hx1 = x; if (y < hy0) hy0 = y; if (y > hy1) hy1 = y; }
    const ring: number[] = [];
    for (let y = Math.max(0, hy0 - R); y <= Math.min(h - 1, hy1 + R); y += 2) for (let x = Math.max(0, hx0 - R); x <= Math.min(w - 1, hx1 + R); x += 2) if (!hole[y * w + x]) ring.push(y * w + x);
    let whole: { dx: number; dy: number; err: number } | undefined;
    for (const s of shifts.slice(0, 120)) for (let ex = -2; ex <= 2; ex++) for (let ey = -2; ey <= 2; ey++) {
      const dx = s.dx + ex, dy = s.dy + ey;
      if (!clean(hx0 + dx, hy0 + dy, hx1 + 1 + dx, hy1 + 1 + dy)) continue;
      let err = 0, n = 0;
      for (let k = 0; k < ring.length; k += Math.max(1, Math.floor(ring.length / 400))) { const i = ring[k], j = i + dy * w + dx; if (j < 0 || j >= w * h) continue; err += Math.abs(rgb[i * 3] - rgb[j * 3]) + Math.abs(rgb[i * 3 + 1] - rgb[j * 3 + 1]) + Math.abs(rgb[i * 3 + 2] - rgb[j * 3 + 2]); n++; }
      const mean = n ? err / (3 * n) : 255;
      if (!whole || mean < whole.err) whole = { dx, dy, err: mean };
    }
    if (whole && whole.err < 4) {
      for (const i of pixels) { const j = i + whole.dy * w + whole.dx; for (let c = 0; c < 3; c++) out[i * 3 + c] = rgb[j * 3 + c]; fill[i] = 1; }
      return { error: whole.err, failed: 0, seams: 0 };
    }
  }
  const pending = new Set(blocks.keys());
  const knownAround = (k: number) => { const by = Math.floor(k / 100000), bx = k % 100000; let n = 0; for (let y = by * B - R; y < by * B + B + R; y += 3) for (let x = bx * B - R; x < bx * B + B + R; x += 3) if (x >= 0 && y >= 0 && x < w && y < h && knownAt(y * w + x)) n++; return n; };
  while (pending.size) {
    // Onion order: the block with the most known pixels around it next.
    let pick = -1, pickKnown = -1;
    for (const k of pending) { const n = knownAround(k); if (n > pickKnown) { pickKnown = n; pick = k; } if (n > 40) break; }
    pending.delete(pick);
    const by = Math.floor(pick / 100000), bx = pick % 100000, members = blocks.get(pick)!;
    let mx0 = w, my0 = h, mx1 = 0, my1 = 0;
    for (const i of members) { const x = i % w, y = (i - x) / w; if (x < mx0) mx0 = x; if (x > mx1) mx1 = x; if (y < my0) my0 = y; if (y > my1) my1 = y; }
    const edge: number[] = [];
    for (let y = by * B - R; y < by * B + B + R; y++) for (let x = bx * B - R; x < bx * B + B + R; x++) if (x >= 0 && y >= 0 && x < w && y < h && knownAt(y * w + x)) edge.push(y * w + x);
    const sample = edge.length > 160 ? edge.filter((_, k) => k % Math.ceil(edge.length / 160) === 0) : edge;
    const errorOf = (dx: number, dy: number) => {
      let err = 0, n = 0;
      for (const i of sample) {
        const x = i % w + dx, y = (i - (i % w)) / w + dy;
        if (x < 0 || y < 0 || x >= w || y >= h || hole[y * w + x]) continue;
        const j = y * w + x, src = done[i] ? out : rgb;
        err += Math.abs(src[i * 3] - rgb[j * 3]) + Math.abs(src[i * 3 + 1] - rgb[j * 3 + 1]) + Math.abs(src[i * 3 + 2] - rgb[j * 3 + 2]); n++;
      }
      return n ? err / (3 * n) : 64;
    };
    let best: { dx: number; dy: number; err: number } | undefined, tried = 0;
    // The shift a neighbouring block used first: one shift over a whole area leaves no seam inside it.
    for (const k of [pick - 1, pick + 1, pick - 100000, pick + 100000]) {
      const n = used.get(k);
      if (!n || !clean(mx0 + n.dx, my0 + n.dy, mx1 + 1 + n.dx, my1 + 1 + n.dy)) continue;
      const err = errorOf(n.dx, n.dy);
      if (!best || err < best.err) best = { dx: n.dx, dy: n.dy, err };
    }
    if (best && best.err < 6) tried = Infinity;
    for (const s of tried === Infinity ? [] : shifts) {
      if (!clean(mx0 + s.dx, my0 + s.dy, mx1 + 1 + s.dx, my1 + 1 + s.dy)) continue;
      const err = errorOf(s.dx, s.dy);
      if (!best || err < best.err) best = { dx: s.dx, dy: s.dy, err };
      if (++tried >= 8 || best.err < 2) break;
    }
    // Always aligned to the block's own edge (±2 px): a repeat that is not a whole number of pixels drifts a little over
    // several repeats, and neighbouring blocks must meet without a step in the pattern's lines.
    if (best) { const start: { dx: number; dy: number; err: number } = best; for (let ex = -2; ex <= 2; ex++) for (let ey = -2; ey <= 2; ey++) {
      const dx = start.dx + ex, dy = start.dy + ey;
      if ((ex || ey) && clean(mx0 + dx, my0 + dy, mx1 + 1 + dx, my1 + 1 + dy)) { const err = errorOf(dx, dy); if (err < best.err) best = { dx, dy, err }; }
    } }
    if (!best) { failed += members.length; continue; }
    used.set(pick, { dx: best.dx, dy: best.dy });
    for (const i of members) { const j = i + best.dy * w + best.dx; for (let c = 0; c < 3; c++) out[i * 3 + c] = rgb[j * 3 + c]; done[i] = 1; fill[i] = 1; }
    errSum += best.err * members.length; errN += members.length;
  }
  // Seams: where two neighbouring blocks were copied with different shifts, whether the pixels just across their common
  // edge are what the first block's own source has there. Equivalent shifts of the pattern agree; a step does not.
  let seams = 0;
  for (const [k, sh] of used) for (const [nk, horizontal] of [[k + 1, true], [k + 100000, false]] as const) {
    const o = used.get(nk);
    if (!o || (o.dx === sh.dx && o.dy === sh.dy)) continue;
    const by = Math.floor(k / 100000), bx = k % 100000;
    let bad = 0;
    for (let t = 0; t < B; t++) {
      const x = horizontal ? (bx + 1) * B : bx * B + t, y = horizontal ? by * B + t : (by + 1) * B;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const b = y * w + x, sx = x + sh.dx, sy = y + sh.dy;
      if (!done[b] || sx < 0 || sy < 0 || sx >= w || sy >= h || sat(sx, sy, sx + 1, sy + 1)) continue;
      // A step of a pixel is invisible; within ±1 px of where the first block's source puts it, the pixel must exist.
      let closest = 255;
      for (let ey = -1; ey <= 1; ey++) for (let ex = -1; ex <= 1; ex++) {
        const qx = sx + ex, qy = sy + ey;
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const j = qy * w + qx;
        closest = Math.min(closest, Math.max(Math.abs(out[b * 3] - rgb[j * 3]), Math.abs(out[b * 3 + 1] - rgb[j * 3 + 1]), Math.abs(out[b * 3 + 2] - rgb[j * 3 + 2])));
      }
      if (closest > 40) bad++;
    }
    if (bad >= 3) seams++;
  }
  return { error: errN ? errSum / errN : 255, failed, seams };
}
/** The pixels of a hole's pattern that may not be copied into it: anything not near its ground colours, or to be filled. */
function badForPattern(rgb: Uint8Array, invalid: Uint8Array, w: number, h: number, ground: number[][]): Int32Array {
  const W1 = w + 1, sat = new Int32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ok = !invalid[i] && ground.some(g => Math.abs(rgb[i * 3] - g[0]) <= 36 && Math.abs(rgb[i * 3 + 1] - g[1]) <= 36 && Math.abs(rgb[i * 3 + 2] - g[2]) <= 36);
      row += ok ? 0 : 1;
      sat[(y + 1) * W1 + x + 1] = sat[y * W1 + x + 1] + row;
    }
  }
  return sat;
}
/**
 * A hole in a plain field: the ring just around it is one colour within a small tolerance. Filled with that colour, or a
 * gradient between its sides' colours when they differ slightly. A thin ring is tried first (text inside a narrow pill or
 * bar: a wider ring would reach the pill's outline and the artwork beyond it), then one scaled to the hole.
 */
function localPlain(rgb: Uint8Array, out: Buffer, pixels: number[], box: { x: number; y: number; width: number; height: number }, hole: Uint8Array, w: number, h: number): boolean {
  const wide = Math.max(4, Math.min(16, Math.round(Math.min(box.width, box.height) * 0.5)));
  return [...new Set([Math.min(5, wide), wide])].some(r => plainRing(rgb, out, pixels, box, hole, w, h, r));
}
function plainRing(rgb: Uint8Array, out: Buffer, pixels: number[], box: { x: number; y: number; width: number; height: number }, hole: Uint8Array, w: number, h: number, r: number): boolean {
  const side = (x0: number, y0: number, x1: number, y1: number) => { const v: number[][] = []; for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) { const i = y * w + x; if (!hole[i]) v.push([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]); } return v; };
  const top = side(box.x - r, box.y - r, box.x + box.width + r, box.y), bottom = side(box.x - r, box.y + box.height, box.x + box.width + r, box.y + box.height + r);
  const left = side(box.x - r, box.y, box.x, box.y + box.height), right = side(box.x + box.width, box.y, box.x + box.width + r, box.y + box.height);
  const all = [...top, ...bottom, ...left, ...right];
  if (all.length < 20) return false;
  const med = (v: number[][]) => [0, 1, 2].map(c => { const s = v.map(p => p[c]).sort((a, b) => a - b); return s[s.length >> 1]; });
  const m = med(all), within = all.filter(p => Math.max(Math.abs(p[0] - m[0]), Math.abs(p[1] - m[1]), Math.abs(p[2] - m[2])) <= 14).length / all.length;
  if (within < 0.95) return false;
  const tm = top.length ? med(top) : m, bm = bottom.length ? med(bottom) : m;
  for (const i of pixels) { const y = Math.floor(i / w), t = box.height > 1 ? (y - box.y) / (box.height - 1) : 0; for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(tm[c] * (1 - t) + bm[c] * t); }
  return true;
}

/**
 * Large plain areas of the artwork (a margin, a solid band): flat pixels (their 5×5 neighbourhood within a few levels)
 * joined while their colour stays near the first one's, kept when large (3% of the poster). A pattern's cells, split by its
 * lines, are each much smaller and never count, even where the lines are faint. Returns each pixel's area (0: none) and
 * each area's colour.
 */
function plainAreas(rgb: Uint8Array, remove: Uint8Array, w: number, h: number): { ids: Int32Array; colours: number[][] } {
  const n = w * h, flat = new Uint8Array(n), lo = new Uint8Array(n), hi = new Uint8Array(n), tmpLo = new Uint8Array(n), tmpHi = new Uint8Array(n), r = 2;
  flat.fill(1);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 255, b = 0; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { const v = rgb[(y * w + k) * 3 + c]; if (v < a) a = v; if (v > b) b = v; } tmpLo[y * w + x] = a; tmpHi[y * w + x] = b; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 255, b = 0; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { const i = k * w + x; if (tmpLo[i] < a) a = tmpLo[i]; if (tmpHi[i] > b) b = tmpHi[i]; } lo[y * w + x] = a; hi[y * w + x] = b; }
    for (let i = 0; i < n; i++) if (hi[i] - lo[i] > 12) flat[i] = 0;
  }
  const ids = new Int32Array(n), colours: number[][] = [], min = Math.max(3000, Math.round(n * 0.03));
  const seen = new Uint8Array(n);
  for (let s0 = 0; s0 < n; s0++) {
    if (!flat[s0] || remove[s0] || seen[s0]) continue;
    const seed = [rgb[s0 * 3], rgb[s0 * 3 + 1], rgb[s0 * 3 + 2]], pixels = [s0];
    seen[s0] = 1;
    for (let k = 0; k < pixels.length; k++) {
      const p = pixels[k], x = p % w, y = (p - x) / w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q < 0 || seen[q] || !flat[q] || remove[q]) continue;
        if (Math.max(Math.abs(rgb[q * 3] - seed[0]), Math.abs(rgb[q * 3 + 1] - seed[1]), Math.abs(rgb[q * 3 + 2] - seed[2])) > 12) continue;
        seen[q] = 1; pixels.push(q);
      }
    }
    if (pixels.length < min) continue;
    const id = colours.length + 1, sum = [0, 0, 0];
    for (const p of pixels) { ids[p] = id; for (let c = 0; c < 3; c++) sum[c] += rgb[p * 3 + c]; }
    colours.push(sum.map(v => Math.round(v / pixels.length)));
  }
  return { ids, colours };
}
/**
 * Each pixel to remove takes the plain area (or 0: other artwork) whose kept pixels are nearest. Small pieces of artwork
 * (a frame's dot, a flourish beside a margin) do not count: `big` marks the artwork that does.
 */
function nearestArea(ids: Int32Array, big: Uint8Array, remove: Uint8Array, w: number, h: number): Int32Array {
  const n = w * h, dPlain = new Int32Array(n).fill(-1), dArt = new Int32Array(n).fill(-1), area = new Int32Array(n);
  const neighbours = (i: number) => { const x = i % w, y = (i - x) / w; return [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]; };
  const plainQ: number[] = [], artQ: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!remove[i]) continue;
    for (const q of neighbours(i)) {
      if (q < 0 || remove[q]) continue;
      if (ids[q] > 0 && dPlain[i] < 0) { dPlain[i] = 1; area[i] = ids[q]; plainQ.push(i); }
      if (big[q] && dArt[i] < 0) { dArt[i] = 1; artQ.push(i); }
    }
  }
  for (let k = 0; k < plainQ.length; k++) { const i = plainQ[k]; for (const q of neighbours(i)) if (q >= 0 && remove[q] && dPlain[q] < 0) { dPlain[q] = dPlain[i] + 1; area[q] = area[i]; plainQ.push(q); } }
  for (let k = 0; k < artQ.length; k++) { const i = artQ[k]; for (const q of neighbours(i)) if (q >= 0 && remove[q] && dArt[q] < 0) { dArt[q] = dArt[i] + 1; artQ.push(q); } }
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) if (remove[i]) out[i] = dPlain[i] < 0 ? 0 : dArt[i] < 0 || dPlain[i] <= dArt[i] ? area[i] : 0;
  return out;
}
/**
 * The straight edge between a plain area and other artwork, continued across a hole (a panel's top edge under a badge):
 * the line that best separates the hole's rim pixels of the two kinds (Fisher's direction, then the threshold with the
 * fewest rim pixels on the wrong side). Undefined when the rim does not split cleanly that way.
 */
function edgeAcross(plainRim: number[], artRim: number[], w: number): ((i: number) => boolean) | undefined {
  if (plainRim.length < 12 || artRim.length < 12) return undefined;
  const xy = (i: number) => [i % w, Math.floor(i / w)], mean = (v: number[]) => { const m = [0, 0]; for (const i of v) { const p = xy(i); m[0] += p[0]; m[1] += p[1]; } return [m[0] / v.length, m[1] / v.length]; };
  const m1 = mean(plainRim), m2 = mean(artRim), S = [0, 0, 0];
  for (const [v, m] of [[plainRim, m1], [artRim, m2]] as const) for (const i of v) { const p = xy(i), dx = p[0] - m[0], dy = p[1] - m[1]; S[0] += dx * dx; S[1] += dx * dy; S[2] += dy * dy; }
  const k = plainRim.length + artRim.length, a = S[0] / k + 1, b = S[1] / k, c = S[2] / k + 1, det = a * c - b * b;
  let wx = (c * (m1[0] - m2[0]) - b * (m1[1] - m2[1])) / det, wy = (a * (m1[1] - m2[1]) - b * (m1[0] - m2[0])) / det;
  const len = Math.hypot(wx, wy); if (!len) return undefined;
  wx /= len; wy /= len;
  const proj = (i: number) => { const p = xy(i); return p[0] * wx + p[1] * wy; };
  const points = [...plainRim.map(i => ({ v: proj(i), plain: true })), ...artRim.map(i => ({ v: proj(i), plain: false }))].sort((p, q) => p.v - q.v);
  // Plain projects higher (w points from the artwork's mean to the plain one's): plain is above the threshold.
  let wrong = artRim.length, best = { errors: Infinity, t: 0 };
  for (let j = 0; j <= points.length; j++) {
    if (j > 0) wrong += points[j - 1].plain ? 1 : -1;
    const t = j === 0 ? points[0].v - 1 : j === points.length ? points[j - 1].v + 1 : (points[j - 1].v + points[j].v) / 2;
    if (wrong < best.errors) best = { errors: wrong, t };
  }
  if (best.errors > 0.08 * points.length) return undefined;
  return (i: number) => proj(i) > best.t;
}

/**
 * The clean background: `remove` marks every pixel to remove (1). `keep` marks content that must not be copied into a
 * hole (other text, logos, illustrations kept as artwork can be added by the caller); holes are never copied from either.
 */
export async function cleanBackground(source: Rgba, removeInput: Uint8Array, options: { keep?: Uint8Array; log?: (line: string) => void } = {}): Promise<CleanBackground> {
  const { width: w, height: h } = source, n = w * h, rgb = flattenRgb(source), started = Date.now(), stage = (what: string) => options.log?.(`${what}: ${Date.now() - started} ms`);
  const remove = absorbHalo(rgb, removeInput, w, h);
  stage('halo');
  const invalid = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (remove[i] || options.keep?.[i]) invalid[i] = 1;
  const plain = plainFieldFill(rgb, remove, w, h), out = Buffer.from(plain.out);
  stage('plain fields');
  const { labels, count } = label(remove, w, h);
  const members: number[][] = Array.from({ length: count + 1 }, () => []);
  for (let i = 0; i < n; i++) if (labels[i]) members[labels[i]].push(i);
  const repeats = new Map<string, Lattice | null>(), badTables = new Map<string, Int32Array>();
  const areas: FilledArea[] = [], untrusted = new Uint8Array(n), filled = new Uint8Array(n), smooth = new Uint8Array(n), comp = new Uint8Array(n);
  // A hole between a large plain area (a margin, a band) and other artwork (a badge over a frame's corner): each pixel is
  // continued from what is nearest it. The plain side takes that area's colour; the rest is filled as usual, never copying
  // the plain area into it (a pattern would otherwise take white blocks from the margin).
  const plainArea = plainAreas(rgb, remove, w, h), big = new Uint8Array(n);
  { // Artwork that counts beside a plain area: kept, not plain, in a piece of some size.
    const art = new Uint8Array(n); for (let i = 0; i < n; i++) art[i] = !remove[i] && !plainArea.ids[i] ? 1 : 0;
    const pieces = label(art, w, h), size = new Int32Array(pieces.count + 1);
    for (let i = 0; i < n; i++) size[pieces.labels[i]]++;
    for (let i = 0; i < n; i++) if (pieces.labels[i] && size[pieces.labels[i]] >= Math.max(4000, n * 0.002)) big[i] = 1;
  }
  const nearest = nearestArea(plainArea.ids, big, remove, w, h);
  stage('plain areas');
  const boxOf = (pixels: number[]) => { let x0 = w, y0 = h, x1 = 0, y1 = 0; for (const i of pixels) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }; };
  const holes: { pixels: number[]; original: number; split: boolean }[] = [];
  for (let l = 1; l <= count; l++) {
    const pixels = members[l], onPlain = pixels.filter(i => nearest[i] > 0).length, share = onPlain / pixels.length;
    if (pixels.length > 20000) options.log?.(`hole ${l}: ${pixels.length} px, ${Math.round(share * 100)}% nearest a plain area → ${share < 0.15 || share > 0.85 ? 'one piece' : 'split'}`);
    if (share < 0.15 || share > 0.85) { holes.push({ pixels, original: l, split: false }); continue; }
    // The two kinds of rim; a straight edge between them is continued across, else each pixel goes with the nearest.
    const plainRim: number[] = [], artRim: number[] = [], seenRim = new Set<number>();
    for (const i of pixels) { const x = i % w, y = (i - x) / w; for (const q of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (q >= 0 && !remove[q] && !seenRim.has(q)) { seenRim.add(q); if (plainArea.ids[q]) plainRim.push(q); else if (big[q]) artRim.push(q); } }
    const plainSide = edgeAcross(plainRim, artRim, w), plainIds = new Map<number, number>();
    for (const q of plainRim) plainIds.set(plainArea.ids[q], (plainIds.get(plainArea.ids[q]) ?? 0) + 1);
    const mainPlain = [...plainIds.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 0;
    const byArea = new Map<number, number[]>(), rest = new Uint8Array(n), restPixels: number[] = [];
    for (const i of pixels) { const a = plainSide ? (plainSide(i) ? (nearest[i] || mainPlain) : 0) : nearest[i]; if (a > 0) (byArea.get(a) ?? byArea.set(a, []).get(a)!).push(i); else { rest[i] = 1; restPixels.push(i); } }
    for (const [a, part] of byArea) {
      const c = plainArea.colours[a - 1];
      for (const i of part) { for (let k = 0; k < 3; k++) out[i * 3 + k] = c[k]; filled[i] = 1; }
      areas.push({ box: boxOf(part), pixels: part.length, method: 'plain', trusted: true, detail: 'Beside a plain area (a margin or a band): continued in its colour.' });
    }
    // The rest, in its connected pieces.
    for (const s0 of restPixels) {
      if (!rest[s0]) continue;
      const piece = [s0]; rest[s0] = 0;
      for (let k = 0; k < piece.length; k++) { const p = piece[k], x = p % w, y = (p - x) / w; for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && rest[q]) { rest[q] = 0; piece.push(q); } }
      holes.push({ pixels: piece, original: l, split: true });
    }
  }
  // Split pieces learn only from their own side: the plain area is unknown to them (pattern repeat, copies, smoothing).
  let withoutPlain: Uint8Array | undefined;
  const removeOrPlain = () => withoutPlain ??= (() => { const v = remove.slice(); for (let i = 0; i < n; i++) if (plainArea.ids[i]) v[i] = 1; return v; })();
  const splitRepeats = new Map<string, Lattice | null>(), plainFilled = new Uint8Array(n);
  for (const a of areas) if (a.detail.startsWith('Beside a plain area')) for (let y = a.box.y; y < a.box.y + a.box.height; y++) for (let x = a.box.x; x < a.box.x + a.box.width; x++) { const i = y * w + x; if (remove[i] && filled[i]) plainFilled[i] = 1; }
  let holeStart = Date.now(), lastHole: { pixels: number; split: boolean } | undefined;
  const slow = () => { if (lastHole && Date.now() - holeStart > 300) options.log?.(`slow hole: ${lastHole.pixels} px${lastHole.split ? ' (split)' : ''}, ${Date.now() - holeStart} ms, ${areas.at(-1)?.method}`); holeStart = Date.now(); };
  for (const hole of holes) {
    slow(); lastHole = { pixels: hole.pixels.length, split: hole.split };
    const pixels = hole.pixels, l = hole.original;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (const i of pixels) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const box = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    // A few pixels (a speck left between larger holes): continued from their kept neighbours, outside in.
    if (pixels.length < 64) {
      const todo = new Set(pixels);
      for (let pass = 0; todo.size && pass < 16; pass++) for (const i of [...todo]) {
        const x = i % w, y = (i - x) / w, sum = [0, 0, 0];
        let k = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const q = ny * w + nx; if (todo.has(q) || (remove[q] && !filled[q])) continue; for (let c = 0; c < 3; c++) sum[c] += remove[q] ? out[q * 3 + c] : rgb[q * 3 + c]; k++; }
        if (!k) continue;
        for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(sum[c] / k);
        filled[i] = 1; todo.delete(i);
      }
      for (const i of todo) smooth[i] = 1;
      areas.push({ box, pixels: pixels.length, method: 'plain', trusted: true, detail: 'A few pixels, continued from their neighbours.' });
      continue;
    }
    // A split piece: its own side only (a pattern's repeat is tried before calling it plain, so faint lines continue).
    const lattice = hole.split ? measureLattice(rgb, removeOrPlain(), w, h, box, splitRepeats) : undefined;
    if (!lattice && localPlain(rgb, out, pixels, box, hole.split ? removeOrPlain() : remove, w, h)) { areas.push({ box, pixels: pixels.length, method: 'plain', trusted: true, detail: 'A plain field around it, continued.' }); for (const i of pixels) filled[i] = 1; continue; }
    if (!hole.split && plain.regions[l - 1]?.plain) { areas.push({ box, pixels: pixels.length, method: 'plain', trusted: true, detail: `A plain field (${plain.regions[l - 1].explainedPercent}% on one smooth surface), continued.` }); for (const i of pixels) filled[i] = 1; continue; }
    const pattern = hole.split ? lattice : measureLattice(rgb, remove, w, h, box, repeats, pixels.length > 50000 ? options.log : undefined);
    if (pattern) {
      const lattice = pattern;
      const ground = holeGround(rgb, remove, w, h, box), key = `${hole.split ? 'split ' : ''}${JSON.stringify(ground.map(g => g.map(v => Math.round(v / 8))))}`;
      const noPlain = () => { const v = invalid.slice(); for (let i = 0; i < n; i++) if (plainArea.ids[i]) v[i] = 1; return v; };
      const bad = badTables.get(key) ?? badTables.set(key, badForPattern(rgb, hole.split ? noPlain() : invalid, w, h, ground)).get(key)!;
      const copy = patternCopy(rgb, out, filled, bad, w, h, pixels, lattice);
      const trusted = copy.failed === 0 && copy.error <= 12 && copy.seams <= Math.max(1, Math.round(pixels.length / 200000));
      if (copy.failed) for (const i of pixels) if (!filled[i]) smooth[i] = 1;
      if (!trusted) for (const i of pixels) untrusted[i] = 1;
      areas.push({ box, pixels: pixels.length, method: 'pattern', trusted, lattice, matchError: round(copy.error, 1),
        detail: `A repeating pattern (it repeats every ${round(Math.hypot(lattice.a.x, lattice.a.y), 1)} and ${round(Math.hypot(lattice.b.x, lattice.b.y), 1)} px), copied from the same pattern nearby; edges match within ${round(copy.error, 1)} levels of 255${copy.seams > 1 ? `; ${copy.seams} small steps where copied pieces meet: check the pattern's lines here` : ''}${copy.failed ? `; ${copy.failed} px had no clean source and are estimated` : ''}.` });
      continue;
    }
    for (const i of pixels) comp[i] = 1;
    const difficulty = backgroundDifficulty(rgb, comp, w, h), graphic = difficulty.flatGraphic ? graphicFill(rgb, comp, w, h) : undefined;
    if (graphic) { for (const i of pixels) { for (let c = 0; c < 3; c++) out[i * 3 + c] = graphic[i * 3 + c]; filled[i] = 1; } areas.push({ box, pixels: pixels.length, method: 'flat', trusted: true, detail: `Flat colours around it (${difficulty.flatColorPercent}% flat), continued.` }); }
    else { for (const i of pixels) { smooth[i] = 1; untrusted[i] = 1; } areas.push({ box, pixels: pixels.length, method: 'smooth', trusted: false, detail: `${difficulty.simpleGraphic ? 'Shading or a gradient' : 'Texture or a picture'} around it: filled with a smooth estimate of its colours (no detail invented). Check it, or upload a clean background.` }); }
    for (const i of pixels) comp[i] = 0;
  }
  slow();
  stage('holes');
  if (smooth.some(Boolean)) {
    const f = Float32Array.from(out), known = new Float32Array(n);
    for (let i = 0; i < n; i++) known[i] = smooth[i] || plainFilled[i] ? 0 : 1;
    const field = boxBlur(pushPull(maskedBlur(f, known, w, h, 12), known, w, h), w, h, 3, 6);
    for (let i = 0; i < n; i++) if (smooth[i]) for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(field[i * 3 + c])));
  }
  const png = await sharp(out, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
  const overlay = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) if (remove[i]) { const warn = untrusted[i]; overlay[i * 4] = warn ? 245 : 40; overlay[i * 4 + 1] = warn ? 158 : 170; overlay[i * 4 + 2] = warn ? 11 : 90; overlay[i * 4 + 3] = 110; }
  const previewPng = await sharp(png).composite([{ input: overlay, raw: { width: w, height: h, channels: 4 }, left: 0, top: 0 }]).png().toBuffer();
  const maskPng = await sharp(Buffer.from(remove.map(v => (v ? 255 : 0))), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
  let removed = 0, estimated = 0; for (let i = 0; i < n; i++) { if (remove[i]) removed++; if (untrusted[i]) estimated++; }
  const regions: ProtectedFillRegion[] = areas.map(a => ({ elementIds: [], areaPercent: round(100 * a.pixels / n), method: a.method === 'smooth' ? 'smooth-fill' : a.method === 'flat' ? 'graphic-fill' : 'plain-field', trusted: a.trusted, reason: a.detail }));
  return { png, previewPng, maskPng, areas, regions, filledPercent: round(100 * removed / n), trustedPercent: removed ? round(100 * (removed - estimated) / removed) : 100 };
}

/**
 * A removal grown over what is left of the removed content's edge: an outline's anti-aliased fringe, a soft shadow or a
 * glow, up to 6 px. A pixel joins when it touches the removal and is not near any ground colour around that hole.
 */
export function absorbHalo(rgb: Uint8Array, mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = Uint8Array.from(mask), { labels, count } = label(mask, w, h);
  const boxes = Array.from({ length: count + 1 }, () => ({ x0: w, y0: h, x1: -1, y1: -1 }));
  for (let i = 0; i < w * h; i++) if (labels[i]) { const b = boxes[labels[i]], x = i % w, y = (i - x) / w; if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; }
  for (let l = 1; l <= count; l++) {
    const b = boxes[l], box = { x: b.x0, y: b.y0, width: b.x1 - b.x0 + 1, height: b.y1 - b.y0 + 1 }, ground = holeGround(rgb, mask, w, h, box, 16);
    if (!ground.length) continue;
    const isGround = (i: number) => ground.some(g => Math.abs(rgb[i * 3] - g[0]) <= 30 && Math.abs(rgb[i * 3 + 1] - g[1]) <= 30 && Math.abs(rgb[i * 3 + 2] - g[2]) <= 30);
    for (let pass = 0; pass < 6; pass++) {
      const add: number[] = [];
      for (let y = Math.max(1, b.y0 - pass - 1); y <= Math.min(h - 2, b.y1 + pass + 1); y++) for (let x = Math.max(1, b.x0 - pass - 1); x <= Math.min(w - 2, b.x1 + pass + 1); x++) {
        const i = y * w + x;
        if (out[i] || isGround(i)) continue;
        if (out[i - 1] || out[i + 1] || out[i - w] || out[i + w]) add.push(i);
      }
      if (!add.length) break;
      for (const i of add) out[i] = 1;
    }
  }
  return out;
}
/** A mask grown by r pixels (the anti-aliased edge and any soft shadow go with the content). */
export const growMask = (mask: Uint8Array, w: number, h: number, r: number) => grow(mask, w, h, r);
