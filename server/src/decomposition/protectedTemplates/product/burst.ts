/**
 * A radial burst (sunburst rays: two related colours alternating around a centre, the commonest festive background)
 * rebuilt behind objects from its own geometry, never from copied patches:
 *
 *   find     on a small copy: two frequent, related colours, and the centre around which they alternate by angle while
 *            staying the same along each ray (high angular purity, many stripes, a wide range of angles)
 *   profile  each fine angle's stripe (from the visible pixels on that ray), and each stripe's colour by distance from
 *            the centre (the burst's own gradient)
 *   fill     a hidden pixel belongs to the burst when it is reached from visible stripes through the hidden area without
 *            crossing the stage, a stand, the floor or a structure continued there (a frame column), and lies no farther
 *            from the centre than stripes are seen at its angle; it takes its angle's stripe colour at its distance,
 *            blended at a stripe edge. (Following each ray to what it meets missed every hidden pixel whose ray met the
 *            stage one way and a hidden frame column the other.)
 *
 * An estimate like every rebuilt pixel, but one that continues the stripes straight and sharp: patches broke them and
 * left object-shaped seams where fills of different kinds met.
 */
export interface Burst {
  /** The centre (pixels of the picture it was found in; may lie outside it). */
  cx: number; cy: number;
  /** The two stripe colours and how far a pixel may be from one to count as it. */
  a: [number, number, number]; b: [number, number, number]; tol: number;
  /** Share of the sampled stripe pixels agreeing with their angle's stripe, and the stripes seen. */
  purity: number; stripes: number;
}

const far = (r: number, g: number, b: number, c: readonly number[]) => Math.max(Math.abs(r - c[0]), Math.abs(g - c[1]), Math.abs(b - c[2]));
/** 0: stripe a, 1: stripe b, -1: neither. */
const classOf = (rgb: Uint8Array, i: number, s: Pick<Burst, 'a' | 'b' | 'tol'>) => {
  const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2], da = far(r, g, b, s.a), db = far(r, g, b, s.b);
  return Math.min(da, db) > s.tol ? -1 : da <= db ? 0 : 1;
};

/** The burst of a picture (best on a copy about 768 px across), or undefined when there is none. */
export function findBurst(rgb: Uint8Array, w: number, h: number, usable: (i: number) => boolean): Burst | undefined {
  const n = w * h;
  // Colour clusters: 8-step buckets, merged into a cluster only when within 10 of the colour it started from (merging by a
  // drifting mean chained a burst's two close stripe colours, 28 apart, into one).
  const buckets = new Map<number, { n: number; s: number[] }>(); let total = 0;
  for (let i = 0; i < n; i++) {
    if (!usable(i)) continue; total++;
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2], key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let e = buckets.get(key); if (!e) buckets.set(key, e = { n: 0, s: [0, 0, 0] });
    e.n++; e.s[0] += r; e.s[1] += g; e.s[2] += b;
  }
  if (total < 1000) return undefined;
  const clusters: { n: number; m: number[]; f: number[] }[] = [];
  for (const e of [...buckets.values()].sort((p, q) => q.n - p.n)) {
    const m = e.s.map(v => v / e.n), near = clusters.find(c => far(m[0], m[1], m[2], c.f) <= 10);
    if (near) { const t = near.n + e.n; near.m = near.m.map((v, c) => (v * near.n + m[c] * e.n) / t); near.n = t; } else if (clusters.length < 12) clusters.push({ n: e.n, m, f: m });
  }
  const top = clusters.sort((p, q) => q.n - p.n).slice(0, 6).filter(c => c.n >= total * 0.02);
  let best: Burst | undefined;
  for (let p = 0; p < top.length; p++) for (let q = p + 1; q < top.length; q++) {
    const A = top[p].m, B = top[q].m, d = far(A[0], A[1], A[2], B);
    if (d < 8 || d > 140) continue;
    const s = { a: A.map(Math.round) as [number, number, number], b: B.map(Math.round) as [number, number, number], tol: Math.max(6, Math.min(30, Math.floor(d / 2) - 1)) };
    // The stripe pixels (at most 40 000, spread over the picture).
    const xs: number[] = [], ys: number[] = [], cs: number[] = [];
    let count = 0; for (let i = 0; i < n; i++) if (usable(i) && classOf(rgb, i, s) >= 0) count++;
    if (count < total * 0.1) continue;
    const stride = Math.max(1, Math.floor(count / 40000));
    for (let i = 0, k = 0; i < n; i++) { if (!usable(i)) continue; const c = classOf(rgb, i, s); if (c < 0) continue; if (k++ % stride) continue; xs.push(i % w); ys.push(Math.floor(i / w)); cs.push(c); }
    // Half-degree bins: a burst's rays can be 3° wide (34 of them in 126° seen, on a 606 px creative), and 2° bins
    // straddling their edges held a real burst under the purity bar while a ray colour and a side panel's passed.
    const K = 720, deg = 360 / K;
    // (Every fifth sample for the coarse search and the first refinements; all of them for the last.)
    const few = { xs: xs.filter((_, k) => k % 5 === 0), ys: ys.filter((_, k) => k % 5 === 0), cs: cs.filter((_, k) => k % 5 === 0) }, full = { xs, ys, cs };
    const score = (cx: number, cy: number, S: typeof full = full) => {
      const ca = new Int32Array(K), cb = new Int32Array(K), min = S === full ? 3 : 1;
      for (let k = 0; k < S.xs.length; k++) { const t = Math.floor(((Math.atan2(S.ys[k] - cy, S.xs[k] - cx) + Math.PI) / (2 * Math.PI)) * K) % K; if (S.cs[k]) cb[t]++; else ca[t]++; }
      let agree = 0, all = 0, bins = 0, stripes = 0, last = -1, first = -1;
      for (let t = 0; t < K; t++) {
        const tot = ca[t] + cb[t]; if (tot < min) continue;
        bins++; agree += Math.max(ca[t], cb[t]); all += tot;
        const major = ca[t] >= cb[t] ? 0 : 1; if (first < 0) first = major; if (last >= 0 && major !== last) stripes++; last = major;
      }
      if (bins * deg >= 300 && last >= 0 && last !== first) stripes++;
      const purity = all ? agree / all : 0;
      // At least 16 stripes over 100°: two regions split by a line, a page beside a wall, or a few blocks around a point
      // (a layout's side panels: 12 "stripes" at half-degree bins) are not a burst; real ones showed 34 to 42.
      return { purity, stripes, ok: stripes >= 16 && bins * deg >= 100 };
    };
    // Coarse to fine over a range around the picture (a burst's centre is often off it): the best few coarse centres
    // refined (the best coarse one is not always nearest the true centre).
    const coarse = Math.max(w, h) / 8, seeds: { x: number; y: number; purity: number }[] = [];
    for (let y = -0.5 * h; y <= 1.5 * h; y += coarse) for (let x = -0.5 * w; x <= 1.5 * w; x += coarse) { const r = score(x, y, few); if (r.ok) seeds.push({ x, y, purity: r.purity }); }
    if (!seeds.length) continue;
    let cx = w / 2, cy = h / 2, bestHere = { purity: 0, stripes: 0, ok: false };
    for (const seed of seeds.sort((p, q) => q.purity - p.purity).slice(0, 3)) {
      let sx = seed.x, sy = seed.y, step = coarse;
      for (let round = 0; round < 4; round++) {
        const S = round < 3 ? few : full; step /= 4; const ox = sx, oy = sy;
        let here = score(ox, oy, S);
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const r = score(ox + dx * step, oy + dy * step, S); if (r.ok && r.purity > here.purity) { here = r; sx = ox + dx * step; sy = oy + dy * step; } }
      }
      const here = score(sx, sy);
      if (here.ok && here.purity > bestHere.purity) { bestHere = here; cx = sx; cy = sy; }
    }
    // Between candidates: purity weighted by how many stripes (a page beside a wall is pure but has only a few, from noise).
    const rank = (b: { purity: number; stripes: number }) => b.purity * Math.min(1, b.stripes / 24);
    if (bestHere.purity >= 0.88 && (!best || rank(bestHere) > rank(best))) best = { cx, cy, ...s, purity: Math.round(bestHere.purity * 1000) / 1000, stripes: bestHere.stripes };
  }
  return best;
}

/** What bounds the burst: `stage` the stage, stands and floor in front of it; `through` visible decorations in front of it (not stripes). */
export interface BurstScene { known: (i: number) => boolean; stage: (i: number) => boolean; through: (i: number) => boolean }
/**
 * Fills `hole` pixels that belong to the burst (not `done` already) in `out`, from the visible pixels `scene.known`
 * allows; marks them in `done`. Returns how many it filled.
 */
export function burstFill(rgb: Uint8Array, w: number, h: number, hole: Uint8Array, burst: Burst, scene: BurstScene, done: Uint8Array, out: Uint8Array): number {
  const known = scene.known;
  const { cx, cy } = burst, n = w * h;
  const maxR = Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy));
  // Fine angles: about one pixel of arc halfway out (720–7200 of them).
  const K = Math.max(720, Math.min(7200, Math.round(Math.PI * maxR))), RB = 48;
  const angleBin = (x: number, y: number) => { const t = ((Math.atan2(y - cy, x - cx) + Math.PI) / (2 * Math.PI)) * K; return t >= K ? t - K : t; };
  const ca = new Int32Array(K), cb = new Int32Array(K), rs = [new Float64Array(RB * 3), new Float64Array(RB * 3)], rc = [new Int32Array(RB), new Int32Array(RB)], reach = new Float64Array(K).fill(-1);
  const stride = n > 4e6 ? 2 : 1;
  for (let y = 0; y < h; y += stride) for (let x = 0; x < w; x += stride) {
    const i = y * w + x; if (hole[i] || !known(i)) continue;
    const c = classOf(rgb, i, burst); if (c < 0) continue;
    const t = Math.floor(angleBin(x, y)) % K, r = Math.hypot(x - cx, y - cy); if (c) cb[t]++; else ca[t]++;
    if (r > reach[t]) reach[t] = r;
    const rb = Math.min(RB - 1, Math.floor((r / maxR) * RB));
    rc[c][rb]++; for (let k = 0; k < 3; k++) rs[c][rb * 3 + k] += rgb[i * 3 + k];
  }
  // Each angle's stripe; an angle nobody saw takes its nearest seen one within 2° (a wider gap stays unknown).
  const seen = new Int8Array(K).fill(-1);
  for (let t = 0; t < K; t++) if (ca[t] + cb[t] >= 2) seen[t] = ca[t] >= cb[t] ? 0 : 1;
  const profile = Int8Array.from(seen), gap = Math.round(K / 180);
  for (let t = 0; t < K; t++) {
    if (seen[t] >= 0) continue;
    for (let d = 1; d <= gap; d++) { const l = seen[(t - d + K) % K], r = seen[(t + d) % K]; if (l >= 0 || r >= 0) { profile[t] = l >= 0 ? l : r; break; } }
  }
  // Angles hidden all along (a character covering part of the burst): the stripes' own rhythm continued into them from
  // each side (the median stripe width), meeting in the middle. Where nothing on either side was seen they stay unknown.
  const edges: number[] = []; for (let t = 0, last = -1; t < K; t++) { if (profile[t] < 0) continue; if (last >= 0 && profile[t] !== profile[last]) edges.push(t); last = t; }
  const widths = edges.slice(1).map((e, k) => e - edges[k]).filter(v => v > 0).sort((p, q) => p - q), half = widths.length >= 4 ? widths[widths.length >> 1] : 0;
  if (half > 0) for (let t = 0; t < K; t++) {
    if (profile[t] >= 0) continue;
    let t1 = t; while (t1 + 1 < K && profile[t1 + 1] < 0) t1++;
    const left = t > 0 ? t - 1 : -1, right = t1 + 1 < K ? t1 + 1 : -1;
    // The edge each side's stripe started at (to keep its phase).
    const startOf = (from: number, dir: number) => { let e = from; while (e - dir >= 0 && e - dir < K && profile[e - dir] === profile[from]) e -= dir; return e; };
    const sl = left >= 0 ? startOf(left, 1) : -1, sr = right >= 0 ? startOf(right, -1) : -1, mid = (t + t1) / 2;
    for (let u = t; u <= t1; u++) {
      const fromLeft = left >= 0 && (right < 0 || u <= mid);
      if (fromLeft) profile[u] = (Math.floor((u - sl) / half) % 2 === 0 ? profile[left] : 1 - profile[left]) as 0 | 1;
      else if (right >= 0) profile[u] = (Math.floor((sr - u) / half) % 2 === 0 ? profile[right] : 1 - profile[right]) as 0 | 1;
    }
    t = t1;
  }
  // Each stripe's colour by distance (a distance nobody saw takes the nearest seen one).
  const colour = [0, 1].map(c => {
    const m = new Float64Array(RB * 3), has = Array.from({ length: RB }, (_, k) => rc[c][k] >= 4);
    for (let k = 0; k < RB; k++) {
      let j = k; if (!has[k]) { let best = -1; for (let d = 1; d < RB && best < 0; d++) { if (k - d >= 0 && has[k - d]) best = k - d; else if (k + d < RB && has[k + d]) best = k + d; } j = best; }
      for (let q = 0; q < 3; q++) m[k * 3 + q] = j < 0 ? (c ? burst.b[q] : burst.a[q]) : rs[c][j * 3 + q] / rc[c][j];
    }
    return m;
  });
  // Membership: the hidden pixels reached from visible stripes through the hole without crossing the stage, a stand, the
  // floor or anything filled already (a continued frame column), and no farther from the centre than stripes are seen at
  // their angle (the burst ends at a border below the stage, not behind it).
  const member = new Uint8Array(n), queue = new Int32Array(n), barrier = (q: number) => done[q] === 1 || scene.stage(q);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (!hole[i] || barrier(i)) continue;
    const x = i % w;
    for (const q of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (q < 0 || q >= n || hole[q] || scene.through(q) || !known(q) || classOf(rgb, q, burst) < 0) continue;
      member[i] = 1; queue[tail++] = i; break;
    }
  }
  while (head < tail) {
    const i = queue[head++], x = i % w;
    for (const q of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (q < 0 || q >= n || !hole[q] || member[q] || barrier(q)) continue;
      member[q] = 1; queue[tail++] = q;
    }
  }
  const spread = Math.max(1, Math.round(K / 360)), limit = new Float64Array(K).fill(-1);
  // (An angle with no stripe seen has no such limit: the hole's own bounds, a continued column or band, end it.)
  for (let t = 0; t < K; t++) { let m = -1; for (let d = -spread; d <= spread; d++) m = Math.max(m, reach[(t + d + K) % K]); limit[t] = m < 0 ? Infinity : m * 1.03 + 2; }
  let filled = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!hole[i] || done[i]) continue;
    const tf = angleBin(x + 0.5, y + 0.5), t = Math.floor(tf) % K, c = profile[t]; if (c < 0) continue;
    if (!member[i] || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > limit[t]) continue;
    const rf = (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / maxR) * RB - 0.5, r0 = Math.max(0, Math.min(RB - 1, Math.floor(rf))), r1 = Math.min(RB - 1, r0 + 1), u = Math.max(0, Math.min(1, rf - r0));
    const at = (cls: number, q: number) => colour[cls][r0 * 3 + q] * (1 - u) + colour[cls][r1 * 3 + q] * u;
    // At a stripe edge (the neighbouring angle is the other stripe): blended by how far into the bin the pixel is.
    const frac = tf - Math.floor(tf), side = frac < 0.5 ? profile[(t - 1 + K) % K] : profile[(t + 1) % K], mix = side >= 0 && side !== c ? 0.5 - Math.abs(frac - 0.5) : 0;
    for (let q = 0; q < 3; q++) out[i * 3 + q] = Math.round(at(c, q) * (1 - mix) + (side >= 0 ? at(side, q) : at(c, q)) * mix);
    done[i] = 1; filled++;
  }
  return filled;
}

/** The burst of a working copy, in the coordinates of the full-size picture it was made from. */
export const burstAtFullSize = (b: Burst, fx: number, fy: number): Burst => ({ ...b, cx: (b.cx + 0.5) / fx - 0.5, cy: (b.cy + 0.5) / fy - 0.5 });
