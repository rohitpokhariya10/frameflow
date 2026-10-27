/**
 * What is behind a template's artwork objects, rebuilt from the template's own structure (artworkObjects.ts uses it):
 *
 *   base     nested rectangles: a plain page (its colour), inside it maybe another plain area, inside that a patterned
 *            panel; a removed pixel takes its rectangle's colour, or the panel's pattern copied from exact repeats of it
 *            (the lattice measured on the panel itself), keeping its distance to the panel's edge, so lines continue and
 *            edges stay straight. What is not like that (a gradient, a photo) is left to the clean background's fill.
 *   border   the dots of a border along the four sides of its rectangle, at their spacing and in their order of colours
 *            (lime, teal, lime, …): the hidden ones are drawn again from a visible one of the same colour.
 *   edges    an object's rim with its true transparency: the background behind it is known (rebuilt above), so each rim
 *            pixel is the object's colour over that background at some opacity, worked out from the two colours; the field's
 *            colour never stays in the object as a halo.
 */

type Rect = { x0: number; y0: number; x1: number; y1: number };
export type Level = { rect: Rect; plain?: number[]; offsets?: { x: number; y: number }[] };
const near = (rgb: Uint8Array, i: number, c: number[], t: number) => Math.abs(rgb[i * 3] - c[0]) <= t && Math.abs(rgb[i * 3 + 1] - c[1]) <= t && Math.abs(rgb[i * 3 + 2] - c[2]) <= t;
const q = (v: number[], f: number) => v[Math.min(v.length - 1, Math.max(0, Math.floor((v.length - 1) * f)))];

/**
 * A pattern's two repeats in a rectangle, measured on its own known pixels: the shifts that map it onto itself (the mean
 * colour difference far below that of other shifts). Faint lines count too: every channel of every pixel is compared.
 */
export function measureRepeat(rgb: Uint8Array, w: number, removed: Uint8Array, r: Rect): { a: { x: number; y: number }; b: { x: number; y: number } } | undefined {
  const inset = { x0: r.x0 + 6, y0: r.y0 + 6, x1: r.x1 - 6, y1: r.y1 - 6 }, all: number[] = [];
  // Compared a little blurred (3×3): an upscaled or slightly noisy pattern still lines up with itself, a fraction of a pixel off.
  const soft = (i: number, c: number) => { let v = 0; for (const o of [-w - 1, -w, -w + 1, -1, 0, 1, w - 1, w, w + 1]) v += rgb[(i + o) * 3 + c]; return v / 9; };
  for (let y = inset.y0; y < inset.y1; y += 5) for (let x = inset.x0; x < inset.x1; x += 5) if (!removed[y * w + x]) all.push(y * w + x);
  if (all.length < 400) return undefined;
  const pick = (count: number) => { const step = Math.max(1, Math.floor(all.length / count)); return all.filter((_, k) => k % step === 0); };
  const many = pick(4000), few = pick(1000);
  const error = (dx: number, dy: number, sample: number[]) => {
    let sum = 0, k = 0;
    for (const i of sample) {
      const x = i % w, y = (i - x) / w, x2 = x + dx, y2 = y + dy;
      if (x2 < inset.x0 || y2 < inset.y0 || x2 >= inset.x1 || y2 >= inset.y1) continue;
      const j = y2 * w + x2; if (removed[j]) continue;
      sum += Math.abs(soft(i, 0) - soft(j, 0)) + Math.abs(soft(i, 1) - soft(j, 1)) + Math.abs(soft(i, 2) - soft(j, 2)); k++;
    }
    return k >= sample.length / 6 ? sum / k : Infinity;
  };
  const W = inset.x1 - inset.x0, H = inset.y1 - inset.y0, xs: { d: number; e: number }[] = [];
  for (let d = 4; d <= Math.min(420, W / 2); d++) xs.push({ d, e: error(d, 0, many) });
  const finite = xs.filter(v => Number.isFinite(v.e)).map(v => v.e).sort((p, s) => p - s);
  if (finite.length < 10) return undefined;
  const typical = finite[Math.floor(finite.length / 2)];
  // A flat field: nothing to repeat.
  if (typical < 1.5) return undefined;
  const low = Math.min(...xs.filter(v => v.d >= 6).map(v => v.e));
  if (!(low < typical * 0.5)) return undefined;
  const a = { x: xs.find(v => v.d >= 6 && v.e <= Math.max(low * 1.25, low + 1))!.d, y: 0 };
  // The other repeat: a shift with a vertical part, at least a quarter of the first away (a small shift of a smooth field
  // scores low too, without being a repeat): the lowest, the shortest of near-equals (coarse, then ±2 px).
  const minY = Math.max(8, Math.round(a.x / 4));
  let best = { x: 0, y: 0, e: Infinity };
  const lowest: { x: number; y: number; e: number }[] = [];
  for (let dy = minY; dy <= Math.min(420, H / 2); dy += 2) for (let dx = -Math.floor(a.x / 2); dx < Math.ceil(a.x / 2); dx += 2) { const e = error(dx, dy, few); lowest.push({ x: dx, y: dy, e }); if (e < best.e) best = { x: dx, y: dy, e }; }
  if (!Number.isFinite(best.e)) return undefined;
  const near = lowest.filter(v => v.e <= best.e * 1.15 + 0.5).sort((p, s) => Math.hypot(p.x, p.y) - Math.hypot(s.x, s.y))[0];
  let b = { x: near.x, y: near.y, e: error(near.x, near.y, many) };
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { if (near.y + dy < minY) continue; const e = error(near.x + dx, near.y + dy, many); if (e < b.e) b = { x: near.x + dx, y: near.y + dy, e }; }
  return b.e < typical * 0.5 ? { a, b: { x: b.x, y: b.y } } : undefined;
}

/**
 * The background's nested rectangles (outermost first), from the pixels that are known (not under an object): a plain page
 * (judged on the picture's own edge), inside it the rectangle of what is not that colour, and so on; a rectangle with a
 * repeating pattern ends it. A rectangle that is neither plain nor a pattern is kept without a rule (its pixels are then
 * filled by the clean background's fill).
 */
export function levelsOf(rgb: Uint8Array, w: number, h: number, removed: Uint8Array): Level[] {
  const out: Level[] = [];
  const dominant = (pixels: number[]) => {
    const counts = new Map<number, number[]>();
    for (const i of pixels) { const k = ((rgb[i * 3] >> 4) << 8) | ((rgb[i * 3 + 1] >> 4) << 4) | (rgb[i * 3 + 2] >> 4); (counts.get(k) ?? counts.set(k, []).get(k)!).push(i); }
    const top = [...counts.values()].sort((a, b) => b.length - a.length)[0] ?? [];
    const colour = [0, 1, 2].map(c => q(top.map(i => rgb[i * 3 + c]).sort((a, b) => a - b), 0.5));
    return { colour, share: pixels.filter(i => near(rgb, i, colour, 10)).length / Math.max(1, pixels.length) };
  };
  // The page: the picture's own edge, one colour.
  const edge: number[] = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if ((x < 4 || y < 4 || x >= w - 4 || y >= h - 4) && !removed[y * w + x]) edge.push(y * w + x);
  const page = dominant(edge);
  if (page.share < 0.95) return out;
  let rect: Rect = { x0: 0, y0: 0, x1: w, y1: h }, colour = page.colour;
  out.push({ rect, plain: colour });
  for (let depth = 1; depth < 4; depth++) {
    // What is inside, of another colour: the next rectangle (a few stray pixels do not move its sides).
    const xs: number[] = [], ys: number[] = [];
    for (let y = rect.y0; y < rect.y1; y += 2) for (let x = rect.x0; x < rect.x1; x += 2) { const i = y * w + x; if (!removed[i] && !near(rgb, i, colour, 18)) { xs.push(x); ys.push(y); } }
    if (xs.length < ((rect.x1 - rect.x0) * (rect.y1 - rect.y0)) / 4 * 0.01) break;
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const next = { x0: q(xs, 0.003), y0: q(ys, 0.003), x1: q(xs, 0.997) + 2, y1: q(ys, 0.997) + 2 };
    // The panel's rows and columns: the longest run where the other colour covers most of where the picture shows (a
    // smudge or an illustration beside the panel covers only part of a row).
    const run = (from: number, to: number, cover: (k: number) => number) => {
      let bestRun = [from, from], start = -1, gapLeft = 0;
      for (let k = from; k <= to; k++) {
        const ok = k < to && cover(k) >= 0.6;
        if (ok) { if (start < 0) start = k; gapLeft = 3; continue; }
        if (start >= 0 && k < to && gapLeft-- > 0) continue;
        if (start >= 0) { const end = k - (3 - Math.max(0, gapLeft)); if (end - start > bestRun[1] - bestRun[0]) bestRun = [start, end]; start = -1; }
      }
      return bestRun;
    };
    const coverRow = (y: number) => { let known = 0, other = 0; for (let x = next.x0; x < next.x1; x += 2) { const i = y * w + x; if (removed[i]) continue; known++; if (!near(rgb, i, colour, 18)) other++; } return known >= (next.x1 - next.x0) / 2 * 0.1 ? other / known : 0; };
    const [ry0, ry1] = run(next.y0, next.y1, coverRow);
    if (ry1 - ry0 > 16) { next.y0 = ry0; next.y1 = ry1; }
    const coverCol = (x: number) => { let known = 0, other = 0; for (let y = next.y0; y < next.y1; y += 2) { const i = y * w + x; if (removed[i]) continue; known++; if (!near(rgb, i, colour, 18)) other++; } return known >= (next.y1 - next.y0) / 2 * 0.1 ? other / known : 0; };
    const [rx0, rx1] = run(next.x0, next.x1, coverCol);
    if (rx1 - rx0 > 16) { next.x0 = rx0; next.x1 = rx1; }
    // Its true sides: out as far as the line just outside is still mostly its colour where it shows (between a border's
    // dots only a narrow strip of the panel shows).
    const share = (x0: number, y0: number, x1: number, y1: number) => { let known = 0, other = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * w + x; if (removed[i]) continue; known++; if (!near(rgb, i, colour, 18)) other++; } return known >= Math.max(x1 - x0, y1 - y0) * 0.05 ? other / known : 0; };
    // At most a few pixels: what is further out is not the panel (a smudge above it, an illustration beside it).
    const limit = 16, start = { ...next };
    while (next.y0 > Math.max(rect.y0, start.y0 - limit) && share(next.x0, next.y0 - 1, next.x1, next.y0) >= 0.5) next.y0--;
    while (next.y1 < Math.min(rect.y1, start.y1 + limit) && share(next.x0, next.y1, next.x1, next.y1 + 1) >= 0.5) next.y1++;
    while (next.x0 > Math.max(rect.x0, start.x0 - limit) && share(next.x0 - 1, next.y0, next.x0, next.y1) >= 0.5) next.x0--;
    while (next.x1 < Math.min(rect.x1, start.x1 + limit) && share(next.x1, next.y0, next.x1 + 1, next.y1) >= 0.5) next.x1++;
    // A rectangle the other colour fills (a panel, not drawing scattered over the page).
    const inner: number[] = [];
    for (let y = next.y0 + 12; y < next.y1 - 12; y += 3) for (let x = next.x0 + 12; x < next.x1 - 12; x += 3) if (!removed[y * w + x]) inner.push(y * w + x);
    if (!inner.length || inner.filter(i => !near(rgb, i, colour, 18)).length < inner.length * 0.9) break;
    rect = next;
    const repeat = measureRepeat(rgb, w, removed, rect);
    if (repeat) { out.push({ rect, offsets: [repeat.a, repeat.b] }); break; }
    const inside = dominant(inner);
    if (inside.share < 0.95) { out.push({ rect }); break; }
    out.push({ rect, plain: inside.colour });
    colour = inside.colour;
  }
  return out;
}

/**
 * Fills `removed` from the levels (1 in `filled` where it did); `out` starts as a copy of the picture. A patterned panel's
 * pixel is copied from the nearest exact repeat that is known and inside the panel (at the same distance from a side it is
 * close to, so the panel's edge stays straight).
 */
export function fillLevels(rgb: Uint8Array, w: number, h: number, removed: Uint8Array, levels: Level[]): { out: Uint8Array; filled: Uint8Array } {
  const n = w * h, out = Uint8Array.from(rgb), filled = new Uint8Array(n);
  if (!levels.length) return { out, filled };
  const repeats = repeatsOf(rgb, w, h, removed, levels);
  for (let i = 0; i < n; i++) {
    if (!removed[i]) continue;
    const x = i % w, y = (i - x) / w;
    let level: Level | undefined; for (const l of levels) if (inRect(l.rect, x, y)) level = l;
    if (!level) continue;
    if (!level.plain && !level.offsets) continue;
    if (level.plain && !level.offsets) {
      // Inside a plain rectangle (not in a deeper one): its colour.
      for (let c = 0; c < 3; c++) out[i * 3 + c] = level.plain[c];
      filled[i] = 1; continue;
    }
    const j = repeatSource(level, repeats.get(level), x, y, w, removed);
    if (j < 0) continue;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = rgb[j * 3 + c];
    filled[i] = 1;
  }
  return { out, filled };
}
const inRect = (r: Rect, x: number, y: number) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
/** The nearest known pixel that repeats (x, y) in its panel, at the same distance from a side it is beside; -1 when none. */
function repeatSource(level: Level, list: { x: number; y: number }[] | undefined, x: number, y: number, w: number, removed: Uint8Array, skip = 0): number {
  if (!list?.length) return -1;
  const r = level.rect, dl = x - r.x0, dr = r.x1 - 1 - x, dt = y - r.y0, db = r.y1 - 1 - y, side = Math.min(dl, dr, dt, db);
  for (const o of list) {
    if (side <= 3 && ((side === dl || side === dr) ? o.x !== 0 : o.y !== 0)) continue;
    const x2 = x + o.x, y2 = y + o.y;
    if (!inRect(r, x2, y2)) continue;
    const j = y2 * w + x2;
    if (removed[j]) continue;
    if (skip-- > 0) continue;
    return j;
  }
  return -1;
}
/**
 * What is left in the background that is not the background: in a plain rectangle a pixel not of its colour, in a patterned
 * panel a pixel unlike both of its two nearest repeats (a white stroke of an illustration across the pattern, a soft edge).
 */
export function residualsOf(rgb: Uint8Array, w: number, h: number, removed: Uint8Array, levels: Level[]): Uint8Array {
  const n = w * h, out = new Uint8Array(n), repeats = repeatsOf(rgb, w, h, removed, levels);
  const diff = (i: number, j: number) => Math.max(Math.abs(rgb[i * 3] - rgb[j * 3]), Math.abs(rgb[i * 3 + 1] - rgb[j * 3 + 1]), Math.abs(rgb[i * 3 + 2] - rgb[j * 3 + 2]));
  for (let i = 0; i < n; i++) {
    if (removed[i]) continue;
    const x = i % w, y = (i - x) / w;
    let level: Level | undefined; for (const l of levels) if (inRect(l.rect, x, y)) level = l;
    if (!level || (!level.plain && !level.offsets)) continue;
    if (level.plain && !level.offsets) {
      // Not the soft edge of a rectangle inside it (that edge is the background's own).
      if (levels.some(l => l !== level && l.rect.x0 > level!.rect.x0 - 1 && inRect({ x0: l.rect.x0 - 3, y0: l.rect.y0 - 3, x1: l.rect.x1 + 3, y1: l.rect.y1 + 3 }, x, y))) continue;
      if (Math.max(...[0, 1, 2].map(c => Math.abs(rgb[i * 3 + c] - level!.plain![c]))) > 8) out[i] = 1;
      continue;
    }
    const a = repeatSource(level, repeats.get(level), x, y, w, removed), b = repeatSource(level, repeats.get(level), x, y, w, removed, 1);
    if (a >= 0 && b >= 0 && Math.min(diff(i, a), diff(i, b)) > 20) out[i] = 1;
  }
  return out;
}
/** The repeats of each patterned level: combinations of its two shifts, each checked against the pattern itself (±2 px). */
const measured = new WeakMap<Level, { x: number; y: number }[]>();
function repeatsOf(rgb: Uint8Array, w: number, h: number, removed: Uint8Array, levels: Level[]): Map<Level, { x: number; y: number }[]> {
  const n = w * h, repeats = new Map<Level, { x: number; y: number }[]>();
  for (const level of levels) {
    if (!level.offsets) continue;
    // Measured once per level (the same panel is asked again as objects grow by a pixel).
    const known = measured.get(level);
    if (known) { repeats.set(level, known); continue; }
    const [a, b] = level.offsets, r = level.rect, sample: number[] = [];
    for (let y = r.y0 + 4; y < r.y1 - 4; y += 7) for (let x = r.x0 + 4; x < r.x1 - 4; x += 7) if (!removed[y * w + x]) sample.push(y * w + x);
    const step = Math.max(1, Math.floor(sample.length / 2500)), error = (dx: number, dy: number) => {
      const d: number[] = [];
      for (let k = 0; k < sample.length; k += step) { const i = sample[k], x = i % w, y = (i - x) / w, x2 = x + dx, y2 = y + dy; if (!inRect(r, x2, y2)) continue; const j = y2 * w + x2; if (removed[j]) continue; d.push(Math.max(Math.abs(rgb[i * 3] - rgb[j * 3]), Math.abs(rgb[i * 3 + 1] - rgb[j * 3 + 1]), Math.abs(rgb[i * 3 + 2] - rgb[j * 3 + 2]))); }
      return d.length >= 100 ? q(d.sort((p, s) => p - s), 0.5) + q(d, 0.9) / 4 : Infinity;
    };
    // As far as the largest hole needs.
    let span = 0; for (let i = 0; i < n; i++) if (removed[i]) { const x = i % w, y = (i - x) / w; if (inRect(r, x, y)) span = Math.max(span, Math.min(r.x1 - r.x0, r.y1 - r.y0)); }
    const unit = Math.max(4, Math.min(Math.hypot(a.x, a.y), Math.hypot(b.x, b.y))), reach = Math.min(14, Math.ceil(Math.min(span, 1200) / unit) + 1), found: { x: number; y: number; e: number }[] = [];
    for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) {
      if (!i && !j) continue;
      const cx = i * a.x + j * b.x, cy = i * a.y + j * b.y;
      if (Math.hypot(cx, cy) > reach * unit * 1.5) continue;
      let bestShift = { x: cx, y: cy, e: error(cx, cy) };
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { if (!dx && !dy) continue; const e = error(cx + dx, cy + dy); if (e < bestShift.e) bestShift = { x: cx + dx, y: cy + dy, e }; }
      if (bestShift.e <= 6 && !found.some(f => f.x === bestShift.x && f.y === bestShift.y)) found.push(bestShift);
    }
    const sorted = found.sort((p, s) => Math.hypot(p.x, p.y) - Math.hypot(s.x, s.y));
    measured.set(level, sorted); repeats.set(level, sorted);
  }
  return repeats;
}
/** Pixels of a patterned panel that are its pattern (like one of their two nearest repeats): the panel showing through. */
export function patternShows(rgb: Uint8Array, w: number, h: number, removed: Uint8Array, levels: Level[], candidates: number[]): Set<number> {
  const out = new Set<number>(), repeats = repeatsOf(rgb, w, h, removed, levels);
  const diff = (i: number, j: number) => Math.max(Math.abs(rgb[i * 3] - rgb[j * 3]), Math.abs(rgb[i * 3 + 1] - rgb[j * 3 + 1]), Math.abs(rgb[i * 3 + 2] - rgb[j * 3 + 2]));
  for (const i of candidates) {
    const x = i % w, y = (i - x) / w;
    let level: Level | undefined; for (const l of levels) if (inRect(l.rect, x, y)) level = l;
    if (!level?.offsets) continue;
    const a = repeatSource(level, repeats.get(level), x, y, w, removed), b = repeatSource(level, repeats.get(level), x, y, w, removed, 1);
    if ((a >= 0 && diff(i, a) <= 12) || (b >= 0 && diff(i, b) <= 12)) out.add(i);
  }
  return out;
}

/**
 * A border's dots: the positions along its four sides at their spacing, each with a visible dot of the same place in the
 * order of colours to draw there. `aligned`: the dots on those positions (a dot beside them belongs to something else).
 */
export interface BorderDot { cx: number; cy: number; template: number }
export function borderGrid(centres: { cx: number; cy: number; colour: number[] }[]): { dots: BorderDot[]; aligned: Set<number> } {
  const aligned = new Set<number>(), dots: BorderDot[] = [];
  if (centres.length < 12) return { dots, aligned };
  const xs = centres.map(c => c.cx).sort((a, b) => a - b), ys = centres.map(c => c.cy).sort((a, b) => a - b);
  const x0 = q(xs, 0.02), x1 = q(xs, 0.98), y0 = q(ys, 0.02), y1 = q(ys, 0.98), tol = Math.max(x1 - x0, y1 - y0) * 0.03;
  const sides = [
    { along: 'x' as const, line0: y0, from: x0, to: x1 }, { along: 'x' as const, line0: y1, from: x0, to: x1 },
    { along: 'y' as const, line0: x0, from: y0, to: y1 }, { along: 'y' as const, line0: x1, from: y0, to: y1 },
  ];
  for (const s of sides) {
    const pos = (c: { cx: number; cy: number }) => (s.along === 'x' ? c.cx : c.cy), perp = (c: { cx: number; cy: number }) => (s.along === 'x' ? c.cy : c.cx);
    const on = centres.map((c, i) => ({ ...c, i })).filter(c => Math.abs(perp(c) - s.line0) <= tol).sort((p, r) => pos(p) - pos(r));
    if (on.length < 4) continue;
    const diffs = on.slice(1).map((c, k) => pos(c) - pos(on[k])).sort((a, b) => a - b), d = q(diffs.filter(v => v <= q(diffs, 0.25) * 1.5), 0.5);
    if (!(d > 2)) continue;
    const line = q(on.map(perp).sort((a, b) => a - b), 0.5);
    // The grid's phase from the dots themselves: the anchor that puts the most of them on it.
    const anchor = q(on.map(c => ((pos(c) % d) + d) % d).sort((a, b) => a - b), 0.5), index = (p: number) => Math.round((p - anchor) / d);
    const onGrid = on.filter(c => Math.abs(pos(c) - (anchor + index(pos(c)) * d)) <= d / 4 && Math.abs(perp(c) - line) <= Math.max(3, d / 6));
    for (const c of onGrid) aligned.add(c.i);
    // The order of colours: the shortest period that keeps each dot's colour (1: one colour, 2: alternating, …).
    const byIndex = new Map(onGrid.map(c => [index(pos(c)), c]));
    let period = 1;
    for (const p of [1, 2, 3]) { let ok = 0, all = 0; for (const [k, c] of byIndex) { const o = byIndex.get(k + p); if (!o) continue; all++; if (Math.max(...c.colour.map((v, ch) => Math.abs(v - o.colour[ch]))) <= 40) ok++; } if (all && ok >= all * 0.9) { period = p; break; } }
    // Each place in the order: its usual colour (a dot of another colour there is not a model for it).
    const usual = Array.from({ length: period }, (_, r) => { const of = onGrid.filter(c => (((index(pos(c)) % period) + period) % period) === r); return [0, 1, 2].map(ch => q(of.map(c => c.colour[ch]).sort((a, b) => a - b), 0.5)); });
    for (let k = Math.ceil((s.from - anchor) / d - 0.3); anchor + k * d <= s.to + d * 0.3; k++) {
      const p = anchor + k * d, cx = s.along === 'x' ? p : line, cy = s.along === 'x' ? line : p;
      if (dots.some(o => Math.hypot(o.cx - cx, o.cy - cy) < d / 3)) continue;
      const r = ((k % period) + period) % period;
      const same = onGrid.filter(c => (((index(pos(c)) - k) % period) + period) % period === 0 && Math.max(...c.colour.map((v, ch) => Math.abs(v - usual[r][ch]))) <= 40)
        .sort((a, b) => Math.abs(index(pos(a)) - k) - Math.abs(index(pos(b)) - k))[0];
      if (same) dots.push({ cx: Math.round(cx), cy: Math.round(cy), template: same.i });
    }
  }
  return { dots, aligned };
}

/**
 * The transparency of an object's rim pixels: `colour` the picture, `behind` what is behind the object there, `inside` the
 * object's own colour nearby; α so that inside·α + behind·(1−α) is the picture. Returns the object's colour and α.
 */
export function unmix(colour: number[], behind: number[], inside: number[]): { rgb: number[]; alpha: number } {
  const d = inside.map((v, c) => v - behind[c]), len = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, e = colour.map((v, c) => v - behind[c]);
  if (len < 24 ** 2) return Math.hypot(e[0], e[1], e[2]) < 12 ? { rgb: colour, alpha: 0 } : { rgb: colour, alpha: 1 };
  const alpha = Math.max(0, Math.min(1, (e[0] * d[0] + e[1] * d[1] + e[2] * d[2]) / len));
  if (alpha < 0.04) return { rgb: colour, alpha: 0 };
  return { rgb: colour.map((v, c) => Math.max(0, Math.min(255, Math.round((v - (1 - alpha) * behind[c]) / alpha)))), alpha };
}
