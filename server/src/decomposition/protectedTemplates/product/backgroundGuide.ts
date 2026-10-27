/**
 * What the scene's own structure says is behind the objects, filled before patches are copied (inpaint.ts), which then
 * continue only what is left:
 *
 *   floor     a hole straight above the floor (the podium's top the products and stands stand on) is floor, up to a little
 *             behind the farthest row a stand is seen standing at; coloured from the nearest floor pixel of its row, else
 *             of the nearest floor row below. (Patches had put the back wall's rays, or the podium's gold rim, there.)
 *   column    a narrow vertical structure (a frame's column, its dots repeating) seen above a hole continues straight down
 *             through it, until a band crosses the hole (the same colour just left and right of it, another than the column's)
 *   stage     inside the stage's box, a hidden pixel continues its own row's repeating ornament (each row's period measured
 *             on what is seen of it); a row that does not repeat takes the nearest seen pixel of the stage on its row,
 *             between the stage's ends (a round podium's top shades across it), where some of the stage is seen on that
 *             row — a row where none is (above its back rim) is the wall's, and the burst may run on there (patches had
 *             put the pink stands' colours into the stage where a character stood on it, and made a dark flat box of a
 *             podium's top from its gold bands). Inside a background stand's box (a block behind the products), a
 *             hidden run of a row between two alike seen pixels of the stand is interpolated (patches left product-shaped
 *             outlines in it, and repeating copies streaks)
 *   burst     sunburst rays behind the objects: each hidden ray pixel takes its angle's stripe at its distance from the
 *             burst's centre (burst.ts), so the stripes run on straight and sharp
 *   mirror    a creative laid out symmetrically — its known pixels match their mirror image about one vertical axis (the
 *             temples, frame columns and borders of a festive poster) — and a hole pixel whose mirror is known, where the
 *             known pixels around it agree with their own mirror images: its mirror's colour. A one-off decoration (a
 *             badge) is never copied, and nothing is mirrored where the layout around is not symmetric.
 *   straight  what is left between two known pixels of one structure along a column or a row, interpolated
 *
 * A large picture is decided on its working copy (the mirror's agreement, the burst's centre) and drawn at full size
 * (fullSizeFill): the floor, the burst, the mirror and the straight runs take full-size pixels, never an enlarged copy.
 *
 * Either way it is an estimate of pixels nobody saw; callers report it as such.
 */
import { burstFill, findBurst, type Burst, type BurstScene } from './burst.js';

type Box = { x: number; y: number; width: number; height: number };
export interface BackgroundGuide {
  /** Known pixels of the floor (1). */
  floor?: Uint8Array;
  /** The farthest (highest) row the floor reaches. */
  floorTop?: number;
  /** Decorations never copied by symmetry (and looked through by a burst's rays). */
  oneOff?: Box[];
  /** The stage everything stands on: its patches continue only its own part of a hole (never the wall around it). */
  stage?: Box;
  /** Podiums and stands that stay in the background: where a burst's rays end. */
  stands?: Box[];
  /** A radial burst behind the objects: looked for on this picture when unset (small pictures only); none when null. */
  burst?: Burst | null;
}
/** How a pixel was filled (`GuidedFill.filled`): 0 not, else the step. */
export const FILL = { floor: 1, burst: 2, mirror: 3, straight: 4, column: 5, stage: 6 } as const;
export interface GuidedFill {
  rgb: Uint8Array; filled: Uint8Array; floor: number; burst: number; mirror: number; straight: number; column: number; stage: number;
  axis?: { x2: number; score: number };
  /** The burst that was used (found here, or given). */
  burstUsed?: Burst;
}

const diff2 = (a: Float32Array, i: number, b: Float32Array, j: number) => Math.max(Math.abs(a[i * 3] - b[j * 3]), Math.abs(a[i * 3 + 1] - b[j * 3 + 1]), Math.abs(a[i * 3 + 2] - b[j * 3 + 2]));
/** Box blur of the pixels `use` allows (each the mean of the allowed ones around it), separable. */
function blurKnown(rgb: Uint8Array, w: number, h: number, use: (i: number) => boolean, r: number): Float32Array {
  const n = w * h, sum = new Float32Array(n * 3), cnt = new Float32Array(n), tmp = new Float32Array(n * 3), tc = new Float32Array(n);
  for (let i = 0; i < n; i++) if (use(i)) { cnt[i] = 1; for (let c = 0; c < 3; c++) sum[i * 3 + c] = rgb[i * 3 + c]; }
  for (let y = 0; y < h; y++) { const a = [0, 0, 0]; let k = 0; for (let x = -r; x < w; x++) {
    const add = x + r, del = x - r - 1;
    if (add < w) { const i = y * w + add; k += cnt[i]; for (let c = 0; c < 3; c++) a[c] += sum[i * 3 + c]; }
    if (del >= 0) { const i = y * w + del; k -= cnt[i]; for (let c = 0; c < 3; c++) a[c] -= sum[i * 3 + c]; }
    if (x >= 0) { const i = y * w + x; tc[i] = k; for (let c = 0; c < 3; c++) tmp[i * 3 + c] = a[c]; }
  } }
  const out = new Float32Array(n * 3);
  for (let x = 0; x < w; x++) { const a = [0, 0, 0]; let k = 0; for (let y = -r; y < h; y++) {
    const add = y + r, del = y - r - 1;
    if (add < h) { const i = add * w + x; k += tc[i]; for (let c = 0; c < 3; c++) a[c] += tmp[i * 3 + c]; }
    if (del >= 0) { const i = del * w + x; k -= tc[i]; for (let c = 0; c < 3; c++) a[c] -= tmp[i * 3 + c]; }
    if (y >= 0) { const i = y * w + x; for (let c = 0; c < 3; c++) out[i * 3 + c] = k ? a[c] / k : 0; }
  } }
  return out;
}
const boxesMask = (boxes: Box[] | undefined, w: number, h: number) => {
  const m = new Uint8Array(w * h);
  for (const b of boxes ?? []) for (let y = Math.max(0, Math.floor(b.y)); y < Math.min(h, Math.ceil(b.y + b.height)); y++) for (let x = Math.max(0, Math.floor(b.x)); x < Math.min(w, Math.ceil(b.x + b.width)); x++) m[y * w + x] = 1;
  return m;
};
/** The floor step: fills `filled` (FILL.floor) and `out`; returns how many. */
function floorFill(rgb: Uint8Array, w: number, h: number, hole: Uint8Array, F: Uint8Array, floorTop: number | undefined, filled: Uint8Array, out: Uint8Array): number {
  const n = w * h, rows: number[][] = Array.from({ length: h }, () => []), sum = [0, 0, 0]; let count = 0, minRow = h, maxRow = -1, floorCount = 0;
  for (let i = 0; i < n; i++) if (F[i] && !hole[i]) { const x = i % w, y = (i - x) / w; rows[y].push(x); for (let c = 0; c < 3; c++) sum[c] += rgb[i * 3 + c]; count++; minRow = Math.min(minRow, y); maxRow = Math.max(maxRow, y); }
  if (count < 20) return 0;
  const mean = sum.map(v => v / count), top = floorTop ?? minRow;
  // Floor just below a hole: one of its pixels, or of its colour on its rows (a sliver the region left out).
  const floorAt = (i: number) => { if (F[i]) return true; const y = Math.floor(i / w); return y >= minRow - 3 && y <= maxRow + 3 && Math.max(...[0, 1, 2].map(c => Math.abs(rgb[i * 3 + c] - mean[c]))) <= 12; };
  // The nearest row with floor at or below y (else above), and in it the nearest floor pixel to x.
  const rowFor = new Int32Array(h).fill(-1);
  for (let y = h - 1, next = -1; y >= 0; y--) { if (rows[y].length) next = y; rowFor[y] = next; }
  for (let y = 0, last = -1; y < h; y++) { if (rows[y].length) last = y; if (rowFor[y] < 0) rowFor[y] = last; }
  const nearest = (xs: number[], x: number) => { let lo = 0, hi = xs.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m + 1; else hi = m; } return lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x) ? xs[lo - 1] : xs[lo]; };
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    if (!hole[y * w + x]) continue;
    let y1 = y; while (y1 + 1 < h && hole[(y1 + 1) * w + x]) y1++;
    // Coloured from the floor seen just below it in the same column (the floor in front of what stood there), else
    // the nearest floor of its row.
    if (y1 + 1 < h && floorAt((y1 + 1) * w + x)) for (let yy = Math.max(y, top); yy <= y1; yy++) {
      const r = rowFor[yy]; if (r < 0) continue;
      const below = (y1 + 1) * w + x, j = F[below] || floorAt(below) ? below : r * w + nearest(rows[r], x), i = yy * w + x;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = rgb[j * 3 + c];
      filled[i] = FILL.floor; floorCount++;
    }
    y = y1;
  }
  // Along its rows, where a stand covered the floor down to the podium's rim (no floor below it): from floor seen or
  // just filled, sideways into the hole, a short way.
  const reach = Math.round(w * 0.15);
  for (let y = top; y <= maxRow; y++) for (const dir of [1, -1]) {
    let from = -1;
    for (let x = dir > 0 ? 0 : w - 1; x >= 0 && x < w; x += dir) {
      const i = y * w + x;
      if (!hole[i] || filled[i]) { from = F[i] || filled[i] ? x : -1; continue; }
      if (from < 0 || Math.abs(x - from) > reach) continue;
      const r = rowFor[y]; if (r < 0) continue;
      const j = r * w + nearest(rows[r], x);
      for (let c = 0; c < 3; c++) out[i * 3 + c] = rgb[j * 3 + c];
      filled[i] = FILL.floor; floorCount++;
    }
  }
  return floorCount;
}

/** The column step (see the file's comment): fills `filled` (FILL.column) and `out`; returns how many. */
function columnFill(out: Uint8Array, w: number, h: number, hole: Uint8Array, filled: Uint8Array, oneOff: Uint8Array): number {
  // L rows above the hole, repeating with a period up to L/2 (a frame's dots are ~2% of the height apart).
  const L = Math.max(8, Math.round(h * 0.06)), maxW = Math.max(3, Math.round(w * 0.03)), P = Math.max(1, Math.floor(L / 2));
  const d = (a: number, b: number) => Math.max(Math.abs(out[a * 3] - out[b * 3]), Math.abs(out[a * 3 + 1] - out[b * 3 + 1]), Math.abs(out[a * 3 + 2] - out[b * 3 + 2]));
  const open = (i: number) => hole[i] && !filled[i];
  // The strip of L rows above row y0 at column x: known, and repeating down with a period (0: it does not).
  const periodAt = (x: number, y0: number) => {
    if (x < 0 || x >= w || y0 - L - P < 0) return 0;
    for (let k = 1; k <= L + P; k++) { const q = (y0 - k) * w + x; if (hole[q] || oneOff[q]) return 0; }
    let bestP = 0, bestMiss = Infinity;
    for (let p = 1; p <= P; p++) { let miss = 0; for (let k = 1; k <= L; k++) if (d((y0 - k) * w + x, (y0 - k - p) * w + x) > 20) miss++; if (miss < bestMiss) { bestMiss = miss; bestP = p; } }
    return bestMiss <= L * 0.1 ? bestP : 0;
  };
  const meanOf = (x: number, y0: number) => { const m = [0, 0, 0]; for (let k = 1; k <= L; k++) { const q = ((y0 - k) * w + x) * 3; m[0] += out[q]; m[1] += out[q + 1]; m[2] += out[q + 2]; } return m.map(v => v / L); };
  const far = (a: number[], b: number[]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  let count = 0;
  // The top of each hole run (where a hole starts below known pixels), per column; neighbouring columns' tops are joined
  // when within L rows of each other (a curved edge, a crown, meets a column's pixel columns at different rows).
  const tops: number[][] = Array.from({ length: w }, () => []);
  for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (open(i) && !hole[i - w]) tops[x].push(y); }
  const used = new Set<number>(), key = (x: number, y: number) => y * w + x;
  const beyond = Math.max(2, Math.round(Math.max(w, h) * 0.007));
  for (let x = 0; x < w; x++) for (const y0 of tops[x]) {
    if (used.has(key(x, y0))) continue;
    // The run: from here to the right, each column's top nearest the previous one (within L rows).
    const run: { x: number; y0: number; p: number }[] = [];
    for (let cx = x, cy = y0; cx < w; cx++) {
      const t = tops[cx].filter(v => !used.has(key(cx, v)) && Math.abs(v - cy) <= L).sort((a, b) => Math.abs(a - cy) - Math.abs(b - cy))[0];
      if (t === undefined) break;
      used.add(key(cx, t)); run.push({ x: cx, y0: t, p: periodAt(cx, t) }); cy = t;
    }
    // Strips of one colour among the run's repeating columns (a new one where the colour jumps by more than 40).
    const strips: { a: number; b: number }[] = [];
    for (let k = 0, prev: number[] | undefined; k <= run.length; k++) {
      const c = run[k], m = c && c.p ? meanOf(c.x, c.y0) : undefined;
      if (strips.length && strips[strips.length - 1].b === k - 1 && m && prev && far(m, prev) <= 40) strips[strips.length - 1].b = k;
      else if (m) strips.push({ a: k, b: k });
      prev = m;
    }
    // A structure: neighbouring narrow strips (each at most a third of maxW, adjacent) between wide ones or the run's ends,
    // at most maxW across, at least two strips (a frame's outline, band and dots; one plain strip is wall).
    for (let k = 0; k < strips.length;) {
      if (strips[k].b - strips[k].a + 1 > maxW / 3) { k++; continue; }
      let j = k; while (j + 1 < strips.length && strips[j + 1].a === strips[j].b + 1 && strips[j + 1].b - strips[j + 1].a + 1 <= maxW / 3) j++;
      const from = strips[k].a, to = strips[j].b;
      const bounded = (from === 0 || !run[from - 1].p || strips[k - 1]?.b === from - 1) && (to === run.length - 1 || !run[to + 1].p || strips[j + 1]?.a === to + 1);
      // Its whole width, one pixel more each side (its outline and soft edges too: a gap let rays through to the far side).
      const lo = Math.max(0, from - 1), hi = Math.min(run.length - 1, to + 1);
      if (j > k && bounded && run[to].x - run[from].x + 1 <= maxW) for (let r = lo; r <= hi; r++) {
        const { x: cx, y0: top } = run[r], p = run[r].p || 1, colour = meanOf(cx, top);
        if (periodAt(cx, top) === 0 && (top - L - P < 0)) continue;
        for (let y = top; y < h && open(y * w + cx); y++) {
          // A band across the hole at this row (the same colour just left and right of it, continuing outwards, unlike
          // the column): the column ends there.
          let l = cx, rr = cx; while (l > 0 && hole[y * w + l]) l--; while (rr < w - 1 && hole[y * w + rr]) rr++;
          const li = y * w + l, ri = y * w + rr;
          if (!hole[li] && !hole[ri] && d(li, ri) <= 16 && far([out[li * 3], out[li * 3 + 1], out[li * 3 + 2]], colour) > 40) {
            let band = true;
            for (let q = 1; band && q <= beyond; q++) { const a = l - q, b = rr + q; band = a >= 0 && b < w && !hole[y * w + a] && !hole[y * w + b] && d(y * w + a, li) <= 16 && d(y * w + b, ri) <= 16; }
            if (band) break;
          }
          const src = (y - p * Math.ceil((y - top + 1) / p)) * w + cx, i = y * w + cx;
          for (let c = 0; c < 3; c++) out[i * 3 + c] = out[src * 3 + c];
          filled[i] = FILL.column; count++;
        }
      }
      k = j + 1;
    }
  }
  return count;
}

/**
 * The stage's own rows (after its repeating ones): on a row where some of a round podium is seen (not the wall seen just
 * above its box), a hidden pixel between its ends — an end not seen taken as the seen one's mirror about the box's
 * centre — takes the nearest seen pixel of the podium on its row: its top's shading runs across it (patches from its
 * gold bands had made a dark flat box of its top where the products stood). A row where none of it is seen is above
 * its back rim (the wall): not the stage's. Returns how many it filled and the stage's shape (its rows' spans).
 */
function podiumRows(out: Uint8Array, w: number, h: number, hole: Uint8Array, filled: Uint8Array, stage: Box): { count: number; shape: Uint8Array } {
  const x0 = Math.max(0, Math.floor(stage.x)), x1 = Math.min(w, Math.ceil(stage.x + stage.width)), y0 = Math.max(0, Math.floor(stage.y)), y1 = Math.min(h, Math.ceil(stage.y + stage.height));
  const shape = new Uint8Array(w * h), cx = (x0 + x1 - 1) / 2;
  // The wall: the colours seen in a strip just above the box.
  const wallColours: number[][] = [];
  for (let y = Math.max(0, y0 - 4); y < y0; y++) for (let x = x0; x < x1; x++) {
    const i = y * w + x; if (hole[i]) continue; const c = [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]];
    if (!wallColours.some(q => Math.max(Math.abs(q[0] - c[0]), Math.abs(q[1] - c[1]), Math.abs(q[2] - c[2])) <= 12)) wallColours.push(c);
  }
  const wall = (i: number) => wallColours.some(q => Math.max(Math.abs(q[0] - out[i * 3]), Math.abs(q[1] - out[i * 3 + 1]), Math.abs(q[2] - out[i * 3 + 2])) <= 18);
  let count = 0;
  for (let y = y0; y < y1; y++) {
    const seen: number[] = [];
    for (let x = x0; x < x1; x++) { const i = y * w + x; if ((!hole[i] || filled[i]) && !wall(i)) seen.push(x); }
    // (A few stray pixels — an ornament at the far end of a row of floor and stands — are no podium seen on that row: a
    // dishwasher's foot took a dark ornament colour from 1800 px away.)
    if (seen.length < Math.max(3, (x1 - x0) * 0.1)) continue;
    const L = seen[0], R = seen[seen.length - 1], from = Math.max(x0, Math.round(Math.min(L, 2 * cx - R))), to = Math.min(x1 - 1, Math.round(Math.max(R, 2 * cx - L)));
    let k = 0;
    for (let x = from; x <= to; x++) {
      const i = y * w + x; shape[i] = 1;
      if (!hole[i] || filled[i]) continue;
      while (k + 1 < seen.length && Math.abs(seen[k + 1] - x) <= Math.abs(seen[k] - x)) k++;
      const j = y * w + seen[k];
      for (let c = 0; c < 3; c++) out[i * 3 + c] = out[j * 3 + c];
      filled[i] = FILL.stage; count++;
    }
  }
  return { count, shape };
}

/** The stage step (see the file's comment): fills `filled` (FILL.stage) and `out`; returns how many. */
function stageRows(out: Uint8Array, w: number, h: number, hole: Uint8Array, filled: Uint8Array, stage: Box): number {
  const x0 = Math.max(0, Math.floor(stage.x)), x1 = Math.min(w, Math.ceil(stage.x + stage.width)), y0 = Math.max(0, Math.floor(stage.y)), y1 = Math.min(h, Math.ceil(stage.y + stage.height));
  const maxP = Math.max(4, Math.min(Math.round(w * 0.15), x1 - x0 >> 2)), open = (i: number) => hole[i] && !filled[i];
  const d = (a: number, b: number) => Math.max(Math.abs(out[a * 3] - out[b * 3]), Math.abs(out[a * 3 + 1] - out[b * 3 + 1]), Math.abs(out[a * 3 + 2] - out[b * 3 + 2]));
  let count = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * w; let holes = 0; for (let x = x0; x < x1; x++) if (open(row + x)) holes++;
    if (!holes) continue;
    // The row's period: the shift (at least pMin: at a shift of one pixel every smooth row matches itself) its seen pixels
    // match themselves best at; a plain row matches at any, and takes pMin.
    const stepX = Math.max(1, Math.round((x1 - x0) / 400)), pMin = Math.max(4, Math.round(w * 0.004));
    let bestP = 0, bestErr = Infinity;
    for (let p = pMin; p <= maxP; p++) {
      let err = 0, pairs = 0;
      for (let x = x0; x + p < x1; x += stepX) { const a = row + x, b = a + p; if (hole[a] || hole[b]) continue; err += d(a, b); pairs++; }
      if (pairs >= Math.max(8, ((x1 - x0) / stepX) * 0.2) && err / pairs < bestErr - 0.5) { bestErr = err / pairs; bestP = p; }
    }
    if (!bestP || bestErr > 14) continue;
    // Each hidden pixel: the nearest seen pixel a whole number of periods away along the row, within the box.
    for (let x = x0; x < x1; x++) {
      const i = row + x; if (!open(i)) continue;
      let src = -1;
      for (let k = 1; k * bestP < x1 - x0 && src < 0; k++) for (const sx of [x + k * bestP, x - k * bestP]) if (sx >= x0 && sx < x1 && !hole[row + sx]) { src = row + sx; break; }
      if (src < 0) continue;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = out[src * 3 + c];
      filled[i] = FILL.stage; count++;
    }
  }
  return count;
}

/** A background stand's rows (see the file's comment, stage): fills `filled` (FILL.stage) and `out`; returns how many. */
function standRows(out: Uint8Array, w: number, h: number, hole: Uint8Array, filled: Uint8Array, stand: Box): number {
  const x0 = Math.max(0, Math.floor(stand.x)), x1 = Math.min(w, Math.ceil(stand.x + stand.width)), y0 = Math.max(0, Math.floor(stand.y)), y1 = Math.min(h, Math.ceil(stand.y + stand.height));
  const d = (a: number, b: number) => Math.max(Math.abs(out[a * 3] - out[b * 3]), Math.abs(out[a * 3 + 1] - out[b * 3 + 1]), Math.abs(out[a * 3 + 2] - out[b * 3 + 2]));
  // The stand's own colour: the median of what is seen in its box; a run's ends must be of it (a speaker standing on a
  // platform is no end of the platform's row).
  const seen: number[][] = [[], [], []];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * w + x; if (!hole[i]) for (let c = 0; c < 3; c++) seen[c].push(out[i * 3 + c]); }
  if (!seen[0].length) return 0;
  const med = seen.map(v => { v.sort((p, q) => p - q); return v[v.length >> 1]; }), own = (i: number) => Math.max(Math.abs(out[i * 3] - med[0]), Math.abs(out[i * 3 + 1] - med[1]), Math.abs(out[i * 3 + 2] - med[2])) <= 45;
  let count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * w + x; if (!hole[i] || filled[i]) continue;
    let e = x; while (e + 1 < x1 && hole[y * w + e + 1] && !filled[y * w + e + 1]) e++;
    const L = y * w + x - 1, R = y * w + e + 1;
    if (x - 1 >= x0 && e + 1 < x1 && !hole[L] && !hole[R] && d(L, R) <= 30 && own(L) && own(R)) for (let u = x; u <= e; u++) {
      const t = (u - x + 1) / (e - x + 2), j = y * w + u;
      for (let c = 0; c < 3; c++) out[j * 3 + c] = Math.round(out[L * 3 + c] + (out[R * 3 + c] - out[L * 3 + c]) * t);
      filled[j] = FILL.stage; count++;
    }
    x = e;
  }
  return count;
}

/** The burst step: the burst given, or found here; returns it and how many pixels it filled. */
function burstStep(rgb: Uint8Array, w: number, h: number, hole: Uint8Array, guide: BackgroundGuide, oneOff: Uint8Array, filled: Uint8Array, out: Uint8Array, stageShape?: Uint8Array): { burst?: Burst; count: number } {
  const n = w * h, burst = guide.burst === null ? undefined : guide.burst ?? (n <= 1.5e6 ? findBurst(rgb, w, h, i => !hole[i] && !oneOff[i]) : undefined);
  if (!burst) return { count: 0 };
  // (The stage as shaped by its seen rows when known: above its back rim, inside its box, the wall's rays run on.)
  const same = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const stands = boxesMask([...(guide.stands ?? []).filter(b => !(stageShape && guide.stage && same(b, guide.stage))), ...(guide.stage && !stageShape ? [guide.stage] : [])], w, h), F = guide.floor;
  if (stageShape) for (let i = 0; i < n; i++) if (stageShape[i]) stands[i] = 1;
  const scene: BurstScene = { known: i => !hole[i], stage: i => stands[i] === 1 || F?.[i] === 1 || filled[i] === FILL.floor, through: i => oneOff[i] === 1 };
  // Bands across the hole that are not the burst's (a border below it): continued first, so the rays end at them.
  const stripe = (i: number) => Math.min(Math.max(Math.abs(out[i * 3] - burst.a[0]), Math.abs(out[i * 3 + 1] - burst.a[1]), Math.abs(out[i * 3 + 2] - burst.a[2])),
    Math.max(Math.abs(out[i * 3] - burst.b[0]), Math.abs(out[i * 3 + 1] - burst.b[1]), Math.abs(out[i * 3 + 2] - burst.b[2]))) <= burst.tol;
  const bands = straightFill(out, w, h, hole, filled, oneOff, { rows: true, ends: (a, b) => !stripe(a) && !stripe(b) });
  const done = Uint8Array.from(filled, v => (v ? 1 : 0)), count = bands + burstFill(rgb, w, h, hole, burst, scene, done, out);
  for (let i = 0; i < n; i++) if (done[i] && !filled[i]) filled[i] = FILL.burst;
  return { burst, count };
}

/** The straight step (see the file's comment); memory: a run length and a colour per pixel. */
function straightFill(out: Uint8Array, w: number, h: number, hole: Uint8Array, filled: Uint8Array, oneOff: Uint8Array, only?: { rows: true; ends: (a: number, b: number) => boolean }): number {
  // Straight continuation: what is left between two known pixels of one structure along its column or its row — the same
  // colour at both ends, and continuing so beyond each end (a frame column behind a character, a band across it) — is
  // interpolated between them; the shorter such run wins. Anything else is left to the patches.
  const n = w * h, known = (i: number) => (!hole[i] || filled[i] > 0) && !oneOff[i];
  const same = (a: number, b: number) => Math.max(Math.abs(out[a * 3] - out[b * 3]), Math.abs(out[a * 3 + 1] - out[b * 3 + 1]), Math.abs(out[a * 3 + 2] - out[b * 3 + 2])) <= 16;
  const NONE = 65535, bestLen = new Uint16Array(n).fill(NONE), value = new Uint8Array(n * 3), beyond = Math.max(2, Math.round(Math.max(w, h) * 0.007));
  const runs = (count: number, length: number, at: (k: number, t: number) => number, maxLen: number) => {
    for (let k = 0; k < count; k++) for (let t = 0; t < length; t++) {
      if (known(at(k, t))) continue;
      let t1 = t; while (t1 + 1 < length && !known(at(k, t1 + 1))) t1++;
      const len = t1 - t + 1, a = t - 1, b = t1 + 1;
      // A longer run (up to 3 × the limit) only where its colour runs on beyond each end for half its length, or to (a
      // few pixels from) the edge of the creative: a band across it behind a wide object (a terminal, a character), not two pixels alike by
      // chance.
      const long = len > maxLen, far = long ? Math.ceil(len / 2) : beyond;
      if (a >= beyond && b < length - beyond && len <= maxLen * 3 && known(at(k, a)) && known(at(k, b))) {
        const ia = at(k, a), ib = at(k, b);
        const runsOn = (from: number, dir: number, ref: number) => { let q = 1; while (q <= far && from + dir * q >= 0 && from + dir * q < length) { const p = at(k, from + dir * q); if (!known(p) || !same(p, ref)) break; q++; } const end = from + dir * q; return q > far || (long && q > 4 * beyond && (end < beyond || end >= length - beyond)); };
        const ok = same(ia, ib) && (!only || only.ends(ia, ib)) && runsOn(a, -1, ia) && runsOn(b, 1, ib);
        if (ok) for (let u = t; u <= t1; u++) { const i = at(k, u); if (len >= bestLen[i]) continue; bestLen[i] = len; const f = (u - a) / (b - a); for (let c = 0; c < 3; c++) value[i * 3 + c] = Math.round(out[ia * 3 + c] + (out[ib * 3 + c] - out[ia * 3 + c]) * f); }
      }
      t = t1;
    }
  };
  if (!only) runs(w, h, (x, y) => y * w + x, Math.min(NONE - 1, Math.round(h * 0.2)));
  runs(h, w, (y, x) => y * w + x, Math.min(NONE - 1, Math.round(w * 0.12)));
  let straight = 0;
  for (let i = 0; i < n; i++) if (bestLen[i] !== NONE) { for (let c = 0; c < 3; c++) out[i * 3 + c] = value[i * 3 + c]; filled[i] = FILL.straight; straight++; }
  return straight;
}

export function guidedFill(rgb: Uint8Array, w: number, h: number, hole: Uint8Array, guide: BackgroundGuide): GuidedFill {
  const n = w * h, out = Uint8Array.from(rgb), filled = new Uint8Array(n), oneOff = boxesMask(guide.oneOff, w, h);
  let mirrorCount = 0, axis: GuidedFill['axis'];
  const floorCount = guide.floor ? floorFill(rgb, w, h, hole, guide.floor, guide.floorTop, filled, out) : 0;
  const column = columnFill(out, w, h, hole, filled, oneOff), podium = guide.stage ? (stageRows(out, w, h, hole, filled, guide.stage), podiumRows(out, w, h, hole, filled, guide.stage)) : undefined;
  const stageCount = filled.reduce((sum, v) => sum + (v === FILL.stage ? 1 : 0), 0) + (guide.stands ?? []).reduce((sum, b) => sum + standRows(out, w, h, hole, filled, b), 0);
  const burst = burstStep(rgb, w, h, hole, guide, oneOff, filled, out, podium?.shape);

  // Mirror (never into a stand's or the stage's box: one-off structures, not mirror images).
  const usable = (i: number) => !hole[i] && !oneOff[i], standing = boxesMask([...(guide.stands ?? []), ...(guide.stage ? [guide.stage] : [])], w, h);
  // Compared as structures, not stitch by stitch: lightly blurred (over known pixels only), and a pixel agrees with its
  // mirror when one of the mirror's near neighbours matches it (an ornament band, a podium centred a little off the
  // poster's axis still mirror each other).
  const soft = blurKnown(rgb, w, h, usable, Math.max(1, Math.round(Math.max(w, h) * 0.004))), slack = Math.max(1, Math.round(Math.max(w, h) * 0.005));
  const agrees = (i: number, y: number, m: number) => {
    for (let dy = -slack; dy <= slack; dy += slack) for (let dx = -slack; dx <= slack; dx += slack) {
      const X = m + dx, Y = y + dy; if (X < 0 || X >= w || Y < 0 || Y >= h) continue; const j = Y * w + X; if (usable(j) && diff2(soft, i, soft, j) <= 24) return true;
    }
    return false;
  };
  // The axis: x' = x2 − x, the one where most known pixels match their mirror (a sample grid).
  const step = Math.max(1, Math.round(Math.max(w, h) / 200));
  let best = { x2: -1, score: 0 };
  for (let x2 = Math.round(w * 0.8); x2 <= Math.round(w * 1.2); x2++) {
    let pairs = 0, agree = 0, samples = 0;
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      samples++; const m = x2 - x; if (m < 0 || m >= w) continue;
      const i = y * w + x, j = y * w + m; if (!usable(i) || !usable(j)) continue;
      pairs++; if (agrees(i, y, m)) agree++;
    }
    if (pairs >= samples * 0.15 && agree / pairs > best.score) best = { x2, score: agree / pairs };
  }
  // The slack lets neighbouring axes score alike: the exact one is the one its pixels match best without it.
  if (best.x2 >= 0) {
    let exact = { x2: best.x2, score: -1 };
    for (let x2 = best.x2 - 2 * slack; x2 <= best.x2 + 2 * slack; x2++) {
      let pairs = 0, agree = 0;
      for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) { const m = x2 - x; if (m < 0 || m >= w) continue; const i = y * w + x, j = y * w + m; if (!usable(i) || !usable(j)) continue; pairs++; if (diff2(soft, i, soft, j) <= 24) agree++; }
      if (pairs && agree / pairs > exact.score) exact = { x2, score: agree / pairs };
    }
    best = { x2: exact.x2, score: best.score };
    axis = { x2: best.x2, score: Math.round(best.score * 1000) / 1000 };
  }
  if (best.x2 >= 0 && best.score >= 0.6) {
    // Agreement around each pixel: the known pixels (with a known mirror) that match it, as running sums.
    const W1 = w + 1, sa = new Int32Array(W1 * (h + 1)), sm = new Int32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, m = best.x2 - x, j = y * w + m, has = m >= 0 && m < w && usable(i) && usable(j) ? 1 : 0, ok = has && agrees(i, y, m) ? 1 : 0;
      const k = (y + 1) * W1 + x + 1; sa[k] = ok + sa[k - 1] + sa[k - W1] - sa[k - W1 - 1]; sm[k] = has + sm[k - 1] + sm[k - W1] - sm[k - W1 - 1];
    }
    const box = (s: Int32Array, x0: number, y0: number, x1: number, y1: number) => s[y1 * W1 + x1] - s[y0 * W1 + x1] - s[y1 * W1 + x0] + s[y0 * W1 + x0];
    const r0 = Math.max(4, Math.round(Math.max(w, h) * 0.03));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, m = best.x2 - x; if (!hole[i] || filled[i] || standing[i] || m < 0 || m >= w) continue;
      const j = y * w + m; if (!usable(j)) continue;
      let conf = -1;
      for (const r of [r0, 2 * r0, 4 * r0]) {
        const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1), known = box(sm, x0, y0, x1, y1);
        if (known >= (x1 - x0) * (y1 - y0) * 0.08) { conf = box(sa, x0, y0, x1, y1) / known; break; }
      }
      if (conf < 0.8) continue;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = rgb[j * 3 + c];
      filled[i] = FILL.mirror; mirrorCount++;
    }
  }
  const straight = straightFill(out, w, h, hole, filled, oneOff);
  return { rgb: out, filled, floor: floorCount, burst: burst.count, mirror: mirrorCount, straight, column, stage: stageCount, ...(axis ? { axis } : {}), ...(burst.burst ? { burstUsed: burst.burst } : {}) };
}

/**
 * A large picture's structure drawn at full size: the working copy's fill decided where each step applies (`work`, on
 * the grid of `ws`); here the floor, the burst and the straight runs are made again from full-size pixels, and a pixel
 * the working copy mirrored takes its full-size mirror (the axis refined at full size). `guide` is in full-size pixels.
 */
export function fullSizeFill(rgb: Uint8Array, w: number, h: number, hole: Uint8Array, guide: BackgroundGuide, work: { filled: Uint8Array; axis?: { x2: number }; ws: { w: number; h: number; fx: number; fy: number } }): GuidedFill {
  const n = w * h, out = Uint8Array.from(rgb), filled = new Uint8Array(n), oneOff = boxesMask(guide.oneOff, w, h), { ws } = work;
  const at = (x: number, y: number) => Math.min(ws.h - 1, Math.floor(y * ws.fy)) * ws.w + Math.min(ws.w - 1, Math.floor(x * ws.fx));
  const floorCount = guide.floor ? floorFill(rgb, w, h, hole, guide.floor, guide.floorTop, filled, out) : 0;
  const column = columnFill(out, w, h, hole, filled, oneOff), podium = guide.stage ? (stageRows(out, w, h, hole, filled, guide.stage), podiumRows(out, w, h, hole, filled, guide.stage)) : undefined;
  const stageCount = filled.reduce((sum, v) => sum + (v === FILL.stage ? 1 : 0), 0) + (guide.stands ?? []).reduce((sum, b) => sum + standRows(out, w, h, hole, filled, b), 0);
  const burst = guide.burst ? burstStep(rgb, w, h, hole, guide, oneOff, filled, out, podium?.shape) : { count: 0 };
  // The mirror: where the working copy mirrored; the axis x' = X2 − x, refined at full size (the best match of raw pixels).
  let mirrorCount = 0, axis: GuidedFill['axis'];
  if (work.axis) {
    const guess = (work.axis.x2 + 1) / ws.fx - 1, step = Math.max(1, Math.round(Math.max(w, h) / 300)), usable = (i: number) => !hole[i] && !oneOff[i];
    let X2 = Math.round(guess), bestScore = -1;
    for (let c = Math.round(guess - 2 / ws.fx); c <= Math.round(guess + 2 / ws.fx); c++) {
      let pairs = 0, agree = 0;
      for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
        const m = c - x; if (m < 0 || m >= w) continue; const i = y * w + x, j = y * w + m; if (!usable(i) || !usable(j)) continue;
        pairs++; if (Math.max(Math.abs(rgb[i * 3] - rgb[j * 3]), Math.abs(rgb[i * 3 + 1] - rgb[j * 3 + 1]), Math.abs(rgb[i * 3 + 2] - rgb[j * 3 + 2])) <= 24) agree++;
      }
      if (pairs && agree / pairs > bestScore) { bestScore = agree / pairs; X2 = c; }
    }
    axis = { x2: X2, score: Math.round(bestScore * 1000) / 1000 };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!hole[i] || filled[i] || work.filled[at(x, y)] !== FILL.mirror) continue;
      const m = X2 - x; if (m < 0 || m >= w) continue; const j = y * w + m; if (!usable(j)) continue;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = rgb[j * 3 + c];
      filled[i] = FILL.mirror; mirrorCount++;
    }
  }
  const straight = straightFill(out, w, h, hole, filled, oneOff);
  return { rgb: out, filled, floor: floorCount, burst: burst.count, mirror: mirrorCount, straight, column, stage: stageCount, ...(axis ? { axis } : {}), ...(burst.burst ? { burstUsed: burst.burst } : {}) };
}
