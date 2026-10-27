/**
 * A product-free stage for Reuse Template: the template's prepared base with what stood on its podium (display risers,
 * stands, old product footprints painted into the background) rebuilt from the scene's own structure, on this computer.
 *
 *   zone       across the template's old products (decorations such as a badge excluded), from the tops of the old
 *              stands (the products' contact lines) down to the podium's front rim
 *   podium     the top surface is an ellipse: its front rim (down each column of the podium, where its saturated gold
 *              or dark trim begins: cream, pastel risers and a light background never are) fitted; above its back rim the
 *              scene is background, inside it the podium's top
 *   rays       a radial sunburst behind the stage: its centre is fitted from the stripe edges just above the zone, and every
 *              background pixel of the zone is taken along its own ray from the clean background above (stripes continue
 *              exactly; nothing is mirrored, stretched or blurred)
 *   top        the podium's top surface keeps every pixel that already is its own colour; the rest (a riser's foot, its
 *              shadow) gets the surface's colour at that depth, learnt from its visible parts
 *
 * Reliable only when both fits are: a template without a podium or without a radial background is reported as not
 * cleaned (`reliable: false`), never passed off as clean. The base is only read.
 */
import sharp from 'sharp';

export type Box = { x: number; y: number; width: number; height: number };
export interface StageCleanup {
  png: Buffer; reliable: boolean; reason?: string;
  zone: { x0: number; x1: number; y0: number };
  ellipse: { cx: number; cy: number; a: number; b: number; rms: number };
  /** The top's back rim (same centre and half-width as the front rim); `points: 0` when it was not visible enough to fit. */
  back?: { cy: number; b: number; rms: number; points: number };
  burst?: { x: number; y: number; residual: number; samples: number };
  /** Share of the zone's podium-top pixels rebuilt (risers' feet, shadows), and of the zone rebuilt in all. */
  rebuilt: { top: number; zone: number; behindDecorations?: number; notContinued?: number; decorationKept?: number };
}

export async function cleanStage(basePng: Buffer, input: { podium: Box; products: (Box & { contactY?: number })[]; avoid: Box[] }): Promise<StageCleanup> {
  const { data, info } = await sharp(basePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), out = new Uint8ClampedArray(px);
  const at = (x: number, y: number, c: number) => px[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4 + c];
  const { podium } = input, fail = (reason: string, partial: Partial<StageCleanup> = {}): StageCleanup => ({ png: basePng, reliable: false, reason, zone: { x0: 0, x1: 0, y0: 0 }, ellipse: { cx: 0, cy: 0, a: 0, b: 0, rms: 0 }, rebuilt: { top: 0, zone: 0 }, ...partial });
  if (!input.products.length) return fail('The template has no products on its stage.');
  // The zone: across the old products, left of any decoration that reaches into it, from the stands' tops down.
  let x0 = Math.max(podium.x, Math.min(...input.products.map(p => p.x)) - W * 0.02), x1 = Math.min(podium.x + podium.width, Math.max(...input.products.map(p => p.x + p.width)) + W * 0.01);
  const y0 = Math.max(0, Math.min(...input.products.map(p => p.contactY ?? p.y + p.height)) - H * 0.01);
  for (const d of input.avoid) {
    if (d.y > podium.y + podium.height || d.y + d.height < y0 || d.x >= x1 || d.x + d.width <= x0) continue;
    if (d.x + d.width / 2 > (x0 + x1) / 2) x1 = Math.min(x1, d.x - 2); else x0 = Math.max(x0, d.x + d.width + 2);
  }
  x0 = Math.round(x0); x1 = Math.round(x1);
  if (x1 - x0 < W * 0.1) return fail('The stage area is too narrow to rebuild.');
  // The podium's front rim: down each column, the first row of its saturated trim (two rows running).
  const trim = (x: number, y: number) => { const r = at(x, y, 0), b = at(x, y, 2); return b < 70 && r - b > 80; };
  const rim: { x: number; y: number }[] = [];
  for (let x = Math.round(podium.x + podium.width * 0.03); x < podium.x + podium.width * 0.97; x += 4) {
    if (input.avoid.some(d => x >= d.x && x <= d.x + d.width && d.y < podium.y + podium.height * 0.8 && d.y + d.height > podium.y)) continue;
    for (let y = Math.round(podium.y + podium.height * 0.02); y < podium.y + podium.height * 0.8; y++) if (trim(x, y) && trim(x, y + 1)) { rim.push({ x, y }); break; }
  }
  if (rim.length < 40) return fail('The podium’s front edge could not be found.');
  // An ellipse through the rim: for each centre and half-width, the depth and height by least squares (outliers dropped once).
  const fit = (pts: typeof rim) => {
    let bestFit = { cx: 0, cy: 0, a: 0, b: 0, rms: Infinity };
    const cx0 = podium.x + podium.width / 2;
    for (let cx = cx0 - podium.width * 0.06; cx <= cx0 + podium.width * 0.06; cx += 6) for (let a = podium.width * 0.4; a <= podium.width * 0.58; a += 6) {
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const p of pts) { const u = (p.x - cx) / a; if (Math.abs(u) >= 0.98) continue; const s = Math.sqrt(1 - u * u); n++; sx += s; sy += p.y; sxx += s * s; sxy += s * p.y; }
      if (n < pts.length * 0.7) continue;
      const b = (n * sxy - sx * sy) / Math.max(1e-6, n * sxx - sx * sx), cy = (sy - b * sx) / n;
      if (!(b > 0)) continue;
      let e = 0; for (const p of pts) { const u = (p.x - cx) / a; if (Math.abs(u) >= 0.98) continue; e += (p.y - (cy + b * Math.sqrt(1 - u * u))) ** 2; }
      const rms = Math.sqrt(e / n); if (rms < bestFit.rms) bestFit = { cx, cy, a, b, rms };
    }
    return bestFit;
  };
  let ellipse = fit(rim);
  const kept = rim.filter(p => { const u = (p.x - ellipse.cx) / ellipse.a; return Math.abs(u) < 0.98 && Math.abs(p.y - (ellipse.cy + ellipse.b * Math.sqrt(1 - u * u))) < Math.max(6, ellipse.rms * 2.5); });
  if (kept.length >= 40) ellipse = fit(kept);
  if (!(ellipse.rms < 8) || ellipse.b < 10) return fail('The podium’s shape could not be fitted reliably.', { ellipse });
  const front = (x: number) => { const u = (x - ellipse.cx) / ellipse.a; return Math.abs(u) >= 1 ? -Infinity : ellipse.cy + ellipse.b * Math.sqrt(1 - u * u); };
  // The sunburst's centre: each stripe boundary traced down the rows above the zone (in the blue channel, which separates
  // pale stripes best) and fitted as a line; the centre is where those lines meet (least squares, disagreeing lines
  // dropped twice). Above or below the stage (a burst from behind the podium) both continue along their rays.
  const band = { top: Math.max(2, Math.round(y0 - H * 0.1)), bottom: Math.round(y0 - 4) };
  const xs = { from: Math.max(2, Math.round(x0 - W * 0.05)), to: Math.min(W - 3, Math.round(x1 + W * 0.05)) };
  const clear = (x: number, y: number) => !input.avoid.some(d => x >= d.x && x <= d.x + d.width && y >= d.y && y <= d.y + d.height) && !input.products.some(p => x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height);
  const blues: number[] = [];
  for (let y = band.top; y < band.bottom; y += 8) for (let x = xs.from; x < xs.to; x += 8) if (clear(x, y)) blues.push(at(x, y, 2));
  blues.sort((p, q) => p - q);
  const lo = blues[Math.floor(blues.length * 0.1)] ?? 0, hi = blues[Math.floor(blues.length * 0.9)] ?? 0, level = (lo + hi) / 2;
  if (hi - lo < 10) return fail('No striped background was found above the stage.', { ellipse, zone: { x0, x1, y0 } });
  type Track = { pts: { x: number; y: number }[]; up: boolean };
  const tracks: Track[] = [], open: Track[] = [];
  for (let y = band.top; y < band.bottom; y += 3) {
    const found: { x: number; up: boolean }[] = [];
    for (let x = xs.from; x < xs.to; x++) {
      const a = at(x, y, 2), b = at(x + 1, y, 2);
      if ((a - level) * (b - level) < 0 && clear(x, y)) found.push({ x: x + (level - a) / (b - a), up: b > a });
    }
    for (const t of [...open]) {
      const last = t.pts.at(-1)!, near = found.find(f => f.up === t.up && Math.abs(f.x - last.x) <= 8);
      if (near) { t.pts.push({ x: near.x, y }); found.splice(found.indexOf(near), 1); } else { open.splice(open.indexOf(t), 1); if (t.pts.length >= 20) tracks.push(t); }
    }
    for (const f of found) open.push({ pts: [{ x: f.x, y }], up: f.up });
  }
  for (const t of open) if (t.pts.length >= 20) tracks.push(t);
  // Each track a line x = m·y + c, i.e. the points (x, y) with x - m·y - c = 0 (normal (1, -m)).
  let lines = tracks.map(t => {
    const n = t.pts.length, sy = t.pts.reduce((v, p) => v + p.y, 0), sx = t.pts.reduce((v, p) => v + p.x, 0), syy = t.pts.reduce((v, p) => v + p.y * p.y, 0), sxy = t.pts.reduce((v, p) => v + p.x * p.y, 0);
    const m = (n * sxy - sx * sy) / Math.max(1e-6, n * syy - sy * sy), c = (sx - m * sy) / n, k = Math.hypot(1, m);
    return { nx: 1 / k, ny: -m / k, d: c / k, length: n };
  });
  const meet = (list: typeof lines) => {
    let A = 0, B = 0, C = 0, D = 0, E = 0;
    for (const l of list) { const w = l.length; A += w * l.nx * l.nx; B += w * l.nx * l.ny; C += w * l.ny * l.ny; D += w * l.nx * l.d; E += w * l.ny * l.d; }
    const det = A * C - B * B;
    return Math.abs(det) < 1e-9 ? undefined : { x: (C * D - B * E) / det, y: (A * E - B * D) / det };
  };
  const away = (l: (typeof lines)[number], c: { x: number; y: number }) => Math.abs(l.nx * c.x + l.ny * c.y - l.d);
  let centre = lines.length >= 6 ? meet(lines) : undefined;
  for (let round = 0; centre && round < 2; round++) {
    const sorted = lines.map(l => away(l, centre!)).sort((p, q) => p - q), limit = Math.max(6, sorted[sorted.length >> 1] * 3);
    lines = lines.filter(l => away(l, centre!) <= limit);
    centre = lines.length >= 6 ? meet(lines) : undefined;
  }
  if (!centre) return fail('No radial background was found above the stage.', { ellipse, zone: { x0, x1, y0 } });
  const bx = centre.x, by = centre.y, samples = lines.length, residual = lines.reduce((v, l) => v + away(l, centre!), 0) / lines.length;
  // The stripes' lines must meet in one point (within a few pixels on average), away from the band itself.
  if (!(by < band.top - H * 0.05 || by > band.bottom + H * 0.05) || Math.abs(bx) > 3 * W || Math.abs(by) > 3 * H || residual > Math.max(4, H * 0.0015))
    return fail('The background above the stage is not a radial pattern this cleanup can continue.', { ellipse, zone: { x0, x1, y0 }, burst: { x: bx, y: by, residual, samples } });
  // The two stripe colours (pixels where green leads: the burst's pale yellow-greens), from the band above the zone.
  const greenish = (x: number, y: number) => at(x, y, 1) >= at(x, y, 0) && at(x, y, 1) >= at(x, y, 2);
  const groups = [[0, 0, 0, 0], [0, 0, 0, 0]];
  for (let y = band.top; y < band.bottom; y += 4) for (let x = xs.from; x < xs.to; x += 4) if (clear(x, y) && greenish(x, y)) { const g = groups[at(x, y, 2) < level ? 0 : 1]; for (let c = 0; c < 3; c++) g[c] += at(x, y, c); g[3]++; }
  if (!groups[0][3] || !groups[1][3]) return fail('No striped background was found above the stage.', { ellipse, zone: { x0, x1, y0 } });
  const stripe = groups.map(g => [g[0] / g[3], g[1] / g[3], g[2] / g[3]]);
  const stripeOf = (x: number, y: number) => { const d = stripe.map(col => Math.max(...[0, 1, 2].map(c => Math.abs(at(x, y, c) - col[c])))); return d[0] <= 16 ? 0 : d[1] <= 16 ? 1 : -1; };

  // The podium top's back rim, where it is visible (stripes, its thin gold lip, then cream): its own fit (same centre and
  // half-width). The podium's own warm cream (yellow leads blue clearly); pastel riser faces are pinker (green ≈ blue) or greener.
  const cream = (x: number, y: number) => { const r = at(x, y, 0), g = at(x, y, 1), b = at(x, y, 2); return r >= 225 && r >= g && g >= b && g - b >= 20 && r - g <= 30; };
  const backPts: { x: number; y: number }[] = [];
  for (let x = Math.round(ellipse.cx - ellipse.a * 0.95); x < ellipse.cx + ellipse.a * 0.95; x += 4) {
    if (input.avoid.some(d => x >= d.x - 4 && x <= d.x + d.width + 4 && d.y < front(x) && d.y + d.height > y0 - 20)) continue;
    let run = 0;
    for (let y = Math.round(y0 - 20); y < front(x) - 4; y++) {
      if (stripeOf(x, y) >= 0) { run++; continue; }
      if (run >= 12 && cream(x, y + 8) && cream(x, y + 10) && cream(x, y + 12)) backPts.push({ x, y });
      break;
    }
  }
  let rimPts: typeof backPts = [];
  let backFit = { cy: ellipse.cy, b: ellipse.b, rms: 0, points: 0 };
  const backLine = (pts: typeof backPts) => {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const q of pts) { const u = (q.x - ellipse.cx) / ellipse.a; if (Math.abs(u) >= 0.98) continue; const v = -Math.sqrt(1 - u * u); n++; sx += v; sy += q.y; sxx += v * v; sxy += v * q.y; }
    const b = (n * sxy - sx * sy) / Math.max(1e-6, n * sxx - sx * sx), cy = (sy - b * sx) / Math.max(1, n);
    const off = (q: { x: number; y: number }) => q.y - (cy - b * Math.sqrt(Math.max(0, 1 - ((q.x - ellipse.cx) / ellipse.a) ** 2)));
    return { cy, b, off, rms: Math.sqrt(pts.reduce((v, q) => v + off(q) ** 2, 0) / Math.max(1, pts.length)) };
  };
  if (backPts.length >= 15) {
    // A stand's top seen in front of the back rim reads as a rim higher up: such points are dropped (twice) before the fit.
    let pts = backPts, line = backLine(pts);
    for (let round = 0; round < 2; round++) { const keep = pts.filter(q => Math.abs(line.off(q)) <= Math.max(4, line.rms * 2)); if (keep.length < 15) break; pts = keep; line = backLine(pts); }
    if (line.b > ellipse.b * 0.4 && line.b < ellipse.b * 2 && line.rms < 8) { backFit = { cy: line.cy, b: line.b, rms: Math.round(line.rms * 100) / 100, points: pts.length }; rimPts = pts; }
  }
  const back = (x: number) => { const u = (x - ellipse.cx) / ellipse.a; return Math.abs(u) >= 1 ? Infinity : backFit.cy - backFit.b * Math.sqrt(1 - u * u); };
  // The front rim column by column (the fit drifts by up to ~15 px towards the ends): the first row of its trim near the
  // fit. Above it the top surface ends in a bevel (a bright line, then the trim's gradient), rebuilt with the rest.
  const reach = { x0: Math.max(0, Math.ceil(ellipse.cx - ellipse.a)), x1: Math.min(W - 1, Math.floor(ellipse.cx + ellipse.a)) };
  const trimRow = new Float64Array(W).fill(NaN);
  for (let x = reach.x0; x <= reach.x1; x++) {
    const f = front(x); if (!Number.isFinite(f)) continue;
    // The trim's first gold row (its embossed band alternates gold and light rows, so one row is enough here).
    for (let y = Math.round(f - 25); y <= f + 10; y++) { const r = at(x, y, 0), b = at(x, y, 2); if (b < 110 && r - b > 80) { trimRow[x] = y; break; } }
  }
  const bottom = (x: number) => { const t = trimRow[x]; return Number.isFinite(t) ? t - 1 : front(x) - 2; };
  // The burst: each angle's stripe (majority) and colour, from stripe pixels anywhere around the stage outside the zone.
  const STEP = 0.0004, bins = new Map<number, number[]>();
  const around = { x0: Math.max(0, Math.round(x0 - W * 0.14)), x1: Math.min(W - 1, Math.round(x1 + W * 0.14)), y0: band.top, y1: Math.round(Math.min(H - 1, ellipse.cy)) };
  for (let y = around.y0; y <= around.y1; y += 1) for (let x = around.x0; x <= around.x1; x += 1) {
    if ((x >= x0 && x <= x1 && y >= y0) || y >= back(x) - 1 || !clear(x, y)) continue;
    const k = stripeOf(x, y); if (k < 0) continue;
    const key = Math.round(Math.atan2(y - by, x - bx) / STEP), e = bins.get(key) ?? bins.set(key, [0, 0]).get(key)!;
    e[k]++;
  }
  const stripeAt = (x: number, y: number) => {
    const key = Math.round(Math.atan2(y - by, x - bx) / STEP);
    for (let d = 0; d < 60; d++) for (const k of d ? [key - d, key + d] : [key]) { const e = bins.get(k); if (e && e[0] + e[1] > 0) return stripe[e[1] > e[0] ? 1 : 0]; }
    return undefined;
  };
  const solve6 = (M: number[][], v: number[]) => {
    const a = M.map((row, r) => [...row, v[r]]);
    for (let c = 0; c < 6; c++) {
      let p = c; for (let r = c + 1; r < 6; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      [a[c], a[p]] = [a[p], a[c]];
      if (Math.abs(a[c][c]) < 1e-9) continue;
      for (let r = 0; r < 6; r++) if (r !== c) { const f = a[r][c] / a[c][c]; for (let k = c; k < 7; k++) a[r][k] -= f * a[c][k]; }
    }
    return a.map((row, r) => (Math.abs(row[r]) < 1e-9 ? 0 : row[6] / row[r]));
  };
  // The podium top's own shading: a smooth fit (in its own elliptical coordinates) to its visibly cream pixels, refitted
  // twice to the pixels that agree with it (a pale pink riser top is cream-like but not the podium's own colour).
  const terms = (u: number, v: number) => [1, u, u * u, v, v * v, u * v], LIP = 14;
  let coef: number[][] | undefined;
  for (let round = 0; round < 3; round++) {
    const XtX = Array.from({ length: 6 }, () => new Array(6).fill(0)), XtY = [0, 1, 2].map(() => new Array(6).fill(0));
    let creamCount = 0;
    for (let x = Math.ceil(ellipse.cx - ellipse.a * 0.99); x < ellipse.cx + ellipse.a * 0.99; x += 3) for (let y = Math.ceil(back(x) + LIP); y < front(x) - 3; y += 3) {
      if (!cream(x, y) || input.avoid.some(d => x >= d.x && x <= d.x + d.width && y >= d.y && y <= d.y + d.height)) continue;
      const t = terms((x - ellipse.cx) / ellipse.a, (y - ellipse.cy) / ellipse.b);
      if (coef && Math.max(...[0, 1, 2].map(ch => Math.abs(at(x, y, ch) - coef![ch].reduce((v, k, n) => v + k * t[n], 0)))) > 10) continue;
      for (let r = 0; r < 6; r++) { for (let c = 0; c < 6; c++) XtX[r][c] += t[r] * t[c]; for (let ch = 0; ch < 3; ch++) XtY[ch][r] += t[r] * at(x, y, ch); }
      creamCount++;
    }
    if (creamCount < 200) return fail('Too little of the podium’s top is visible to rebuild it.', { ellipse, zone: { x0, x1, y0 }, burst: { x: bx, y: by, residual, samples } });
    coef = [0, 1, 2].map(ch => solve6(XtX.map(r => [...r]), XtY[ch]));
  }
  const shade = (x: number, y: number) => { const t = terms((x - ellipse.cx) / ellipse.a, (y - ellipse.cy) / ellipse.b); return coef!.map(cf => cf.reduce((v, k, n) => v + k * t[n], 0)); };
  // The back rim's lip (a few rows of gold before the cream): its average profile down from the rim, as a difference from
  // the shading, where the rim is visible; the rebuilt rim gets the same lip.
  const lip = Array.from({ length: LIP }, () => [0, 0, 0, 0]);
  for (const q of rimPts) {
    const ys = Math.ceil(back(q.x));
    for (let k = 0; k < LIP; k++) { const want = shade(q.x, ys + k); for (let c = 0; c < 3; c++) lip[k][c] += at(q.x, ys + k, c) - want[c]; lip[k][3]++; }
  }
  // The front bevel (the last rows above the trim) varies along the rim: kept as it is (as a difference from the
  // shading) in every column a stand did not touch, and interpolated between the nearest such columns where one did.
  const standLike = (x: number, y: number) => { const r = at(x, y, 0), g = at(x, y, 1), b = at(x, y, 2), avg = (r + g + b) / 3; return Math.max(r, g, b) - Math.min(r, g, b) <= 45 && avg >= 110 && avg <= 225 && stripeOf(x, y) < 0; };
  const FRONT = 12, rw = reach.x1 - reach.x0 + 1, bevel = new Float32Array(rw * FRONT * 3), bevelOk = new Uint8Array(rw);
  for (let x = reach.x0; x <= reach.x1; x++) {
    const t = trimRow[x];
    if (!Number.isFinite(t) || input.avoid.some(d => x >= d.x && x <= d.x + d.width && t >= d.y && t - FRONT - 4 <= d.y + d.height)) continue;
    let clean = true;
    for (let y = t - FRONT - 4; y < t && clean; y++) if (standLike(x, y) || (at(x, y, 0) + at(x, y, 1) + at(x, y, 2)) / 3 < 150) clean = false;
    if (!clean) continue;
    bevelOk[x - reach.x0] = 1;
    for (let k = 1; k <= FRONT; k++) { const want = shade(x, t - k); for (let c = 0; c < 3; c++) bevel[((x - reach.x0) * FRONT + k - 1) * 3 + c] = at(x, t - k, c) - want[c]; }
  }
  {
    const left = new Int32Array(rw).fill(-1), right = new Int32Array(rw).fill(-1);
    for (let j = 0, last = -1; j < rw; j++) { if (bevelOk[j]) last = j; left[j] = last; }
    for (let j = rw - 1, next = -1; j >= 0; j--) { if (bevelOk[j]) next = j; right[j] = next; }
    for (let j = 0; j < rw; j++) {
      if (bevelOk[j]) continue;
      const l = left[j], r = right[j];
      if (l < 0 && r < 0) continue;
      const t = l < 0 ? 1 : r < 0 ? 0 : (j - l) / (r - l);
      for (let n = 0; n < FRONT * 3; n++) bevel[j * FRONT * 3 + n] = (l < 0 ? 0 : bevel[l * FRONT * 3 + n] * (1 - t)) + (r < 0 ? 0 : bevel[r * FRONT * 3 + n] * t);
    }
  }
  const topColour = (x: number, y: number) => {
    const want = shade(x, y), f = trimRow[x] - y;
    if (f >= 1 && f <= FRONT) return want.map((v, c) => v + bevel[((x - reach.x0) * FRONT + f - 1) * 3 + c]);
    const k = y - Math.ceil(back(x));
    return k >= 0 && k < LIP && lip[k][3] ? want.map((v, c) => v + lip[k][c] / lip[k][3]) : want;
  };
  // A stand's pixels: pastel, neither the stripes nor the podium's cream. A decoration's: an outline (dark), saturated
  // colour or near white that is neither either. A decoration whose art reaches out of its box into the zone (a badge's
  // ribbon tail) is followed from the box, and kept as it is (with a pixel of its edge).
  const differs = (x: number, y: number) => {
    const want = topColour(x, y), r = at(x, y, 0), g = at(x, y, 1), b = at(x, y, 2);
    return Math.abs((r - g) - (want[0] - want[1])) > 8 || Math.abs((g - b) - (want[1] - want[2])) > 8 || Math.abs((r + g + b - want[0] - want[1] - want[2]) / 3) > 12;
  };
  const decorLike = (x: number, y: number) => {
    const r = at(x, y, 0), g = at(x, y, 1), b = at(x, y, 2), avg = (r + g + b) / 3;
    if (stripeOf(x, y) >= 0 || standLike(x, y) || (y >= back(x) && !differs(x, y))) return false;
    return Math.max(r, g, b) - Math.min(r, g, b) > 60 || avg < 110 || avg > 232;
  };
  const keep = new Uint8Array(W * H), inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= bottom(x);
  const seeds: number[] = [];
  for (const d of input.avoid) for (let y = Math.max(Math.ceil(y0), d.y - 6); y <= Math.min(H - 1, d.y + d.height + 6); y++) for (let x = Math.max(x0, d.x - 6); x <= Math.min(x1, d.x + d.width + 6); x++) {
    if (inside(x, y) && !keep[y * W + x] && decorLike(x, y)) { keep[y * W + x] = 1; seeds.push(y * W + x); }
  }
  while (seeds.length) {
    const k = seeds.pop()!, x = k % W, y = (k - x) / W;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, nk = ny * W + nx;
      if (keep[nk] || !inside(nx, ny) || !decorLike(nx, ny)) continue;
      keep[nk] = 1; seeds.push(nk);
    }
  }
  let keptCount = 0;
  for (let y = Math.ceil(y0); y < H; y++) for (let x = x0; x <= x1; x++) if (keep[y * W + x] === 1) {
    keptCount++;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!keep[(y + dy) * W + x + dx] && inside(x + dx, y + dy) && !standLike(x + dx, y + dy)) keep[(y + dy) * W + x + dx] = 2;
  }
  // Rebuild the zone: background by its angle's stripe; the podium top where it is not its own colour (and around it).
  let zoneCount = 0, topCount = 0, topRebuilt = 0, missing = 0;
  const dirty = new Uint8Array(W * H);
  for (let y = Math.ceil(y0); y < H; y++) for (let x = x0; x <= x1; x++) {
    if (y > bottom(x)) continue;
    const i = (y * W + x) * 4;
    zoneCount++;
    if (keep[y * W + x]) continue;
    if (y < back(x)) {
      const colour = stripeAt(x, y);
      if (!colour) { missing++; continue; }
      for (let c = 0; c < 3; c++) out[i + c] = colour[c];
      out[i + 3] = 255;
      continue;
    }
    topCount++;
    // Not the podium's own colour at that place (a riser's foot or top, its shadow): rebuilt. Hue is compared more
    // strictly than brightness: a pale pink riser top is about as light as the podium but not as yellow.
    if (differs(x, y)) dirty[y * W + x] = 1;
  }
  if (missing > zoneCount * 0.01) return fail('Part of the background behind the stage could not be continued from its stripes.', { ellipse, zone: { x0, x1, y0 }, burst: { x: bx, y: by, residual, samples } });
  // A stand wider than its product, or reaching behind a decoration's box (up to the decoration's art): the connected
  // pastel pixels from the zone's edges outwards over the podium; cream, stripes and a decoration's outline (dark,
  // saturated or near white) stop it.
  const beyond = new Set<number>(), queue: number[] = [];
  for (const [edge, step, limit] of [[x1, 1, reach.x1], [x0, -1, reach.x0]] as const) {
    if (edge === limit) continue;
    for (let y = Math.ceil(y0); y <= bottom(edge + step); y++) if (standLike(edge + step, y)) { beyond.add(y * W + edge + step); queue.push(y * W + edge + step); }
    while (queue.length) {
      const k = queue.pop()!, x = k % W, y = (k - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, nk = ny * W + nx;
        if (beyond.has(nk) || (step > 0 ? nx <= x1 || nx > limit : nx >= x0 || nx < limit) || ny < y0 || ny > bottom(nx) || !standLike(nx, ny)) continue;
        beyond.add(nk); queue.push(nk);
      }
    }
  }
  for (const k of beyond) {
    const x = k % W, y = (k - x) / W, i = k * 4, colour = y < back(x) ? stripeAt(x, y) : topColour(x, y);
    if (keep[k]) continue;
    if (!colour) continue;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(colour[c]);
    out[i + 3] = 255;
  }
  // Rebuilt: every flagged pixel and 4 px around it; the 8 px beyond fade into the kept surface (no hard seam).
  const yTop = Math.ceil(y0), yBottom = Math.min(H - 1, Math.ceil(ellipse.cy + ellipse.b) + 12), bw = x1 - x0 + 1, bh = yBottom - yTop + 1;
  const mask = new Float32Array(bw * bh), tmp = new Float32Array(bw * bh);
  for (let y = yTop; y <= yBottom; y++) for (let x = x0; x <= x1; x++) if (dirty[y * W + x]) mask[(y - yTop) * bw + x - x0] = 1;
  const spread = (src: Float32Array, dst: Float32Array, radius: number, mode: 'max' | 'mean') => {
    for (let pass = 0; pass < 2; pass++) {
      const from = pass ? tmp : src, to = pass ? dst : tmp;
      for (let j = 0; j < (pass ? bw : bh); j++) for (let k = 0; k < (pass ? bh : bw); k++) {
        let v = 0, n = 0;
        for (let d = -radius; d <= radius; d++) {
          const kk = k + d; if (kk < 0 || kk >= (pass ? bh : bw)) continue;
          const s = pass ? from[kk * bw + j] : from[j * bw + kk];
          if (mode === 'max') v = Math.max(v, s); else v += s; n++;
        }
        to[pass ? k * bw + j : j * bw + k] = mode === 'max' ? v : v / n;
      }
    }
  };
  const grown = new Float32Array(bw * bh), weight = new Float32Array(bw * bh);
  spread(mask, grown, 4, 'max');
  spread(grown, weight, 8, 'mean');
  for (let y = yTop; y <= yBottom; y++) for (let x = x0; x <= x1; x++) {
    if (y > bottom(x) || y < back(x)) continue;
    const m = (y - yTop) * bw + x - x0, w = grown[m] ? 1 : Math.min(1, weight[m] * 2);
    if (!w || keep[y * W + x]) continue;
    const i = (y * W + x) * 4, want = topColour(x, y);
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(want[c] * w + px[i + c] * (1 - w));
    out[i + 3] = 255; if (grown[m]) topRebuilt++;
  }
  const png = await sharp(Buffer.from(out.buffer), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return { png, reliable: true, zone: { x0, x1, y0 }, ellipse, back: backFit, burst: { x: bx, y: by, residual: Math.round(residual * 100) / 100, samples }, rebuilt: { top: Math.round(topRebuilt / Math.max(1, topCount) * 1000) / 10, zone: zoneCount, behindDecorations: beyond.size, notContinued: missing, decorationKept: keptCount } };
}
