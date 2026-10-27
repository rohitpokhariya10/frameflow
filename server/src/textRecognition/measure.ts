/**
 * What a word looks like, measured from the source pixels inside its box, and where the logos of a logo grid are. Local
 * arithmetic on pixels only; every result is an estimate that an administrator reviews.
 *
 *   ink        pixels that differ clearly from the box's own background (the median of its border pixels)
 *   colour     the median of the most strongly differing ink pixels (anti-aliased edges left out)
 *   size       the ink height divided by the share of the em the word's letters cover (caps 0.72, x-height 0.52,
 *              with descenders +0.21): an em size close to the font size that was used
 *   weight     the typical horizontal stroke run as a share of the em
 *   italic     the shear that makes the ink's columns sharpest (slanted strokes stand up at their own angle)
 *   rotation   the baseline's slope, when the engine gave one
 */
import type { Rgba } from '../decomposition/protectedTemplates/pixels.js';

export interface MeasuredStyle {
  color: string; fontSize: number; fontWeight: 400 | 600 | 700; italic: boolean; italicAngle: number;
  /** Box top to baseline, source pixels. */
  baseline: number; rotation: number;
  /** Stroke width / em, ink coverage and how distinct the ink is from its background (0..1 each): what the estimate rests on. */
  evidence: { strokeEm: number; inkShare: number; separation: number };
  /** 0..1: how far the measurements can be trusted. */
  confidence: number;
}
export interface PixelBox { x: number; y: number; width: number; height: number }

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const median = (values: number[]) => { if (!values.length) return 0; const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const ASCENDERS = /[A-Z0-9bdfhklt!?&%$#@()[\]{}\\/|]/, DESCENDERS = /[gjpqyQ,;()[\]{}|]/;
/** Share of the em the ink of a text covers vertically, from its letters (typical Latin faces). */
export function inkEmShare(text: string): number {
  const up = ASCENDERS.test(text), down = DESCENDERS.test(text);
  if (up && down) return 0.93;
  if (up) return 0.72;
  if (down) return 0.73;
  return /[a-z]/.test(text) ? 0.52 : 0.72;
}
const hasDescender = (text: string) => DESCENDERS.test(text);

/**
 * The style of one word. `box` is the engine's box in source pixels (whole pixels); `baselineY` the source y of the line's
 * baseline under it, when known.
 */
export function measureWord(source: Rgba, box: PixelBox, text: string, baselineLine?: { x0: number; y0: number; x1: number; y1: number }): MeasuredStyle {
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(source.width, Math.ceil(box.x + box.width)), y1 = Math.min(source.height, Math.ceil(box.y + box.height));
  const W = Math.max(1, x1 - x0), H = Math.max(1, y1 - y0), px = (x: number, y: number) => { const i = ((y0 + y) * source.width + (x0 + x)) * 4; return [source.data[i], source.data[i + 1], source.data[i + 2]]; };
  // Background: the median of a ring just outside the box (the box hugs the ink), else its own border.
  const ring: number[][] = [];
  for (let x = x0 - 2; x < x1 + 2; x++) for (const y of [y0 - 2, y1 + 1]) if (x >= 0 && y >= 0 && x < source.width && y < source.height) { const i = (y * source.width + x) * 4; ring.push([source.data[i], source.data[i + 1], source.data[i + 2]]); }
  for (let y = y0; y < y1; y++) for (const x of [x0 - 2, x1 + 1]) if (x >= 0 && x < source.width) { const i = (y * source.width + x) * 4; ring.push([source.data[i], source.data[i + 1], source.data[i + 2]]); }
  const bg = [0, 1, 2].map(c => median(ring.map(p => p[c])));
  // A word on two backgrounds (a badge split orange over green): the ring's median is a mix of them, and the second
  // background then differs from it most and was taken for the ink. Each pixel is measured against the nearest of the
  // ring's own colours instead (each of a tenth of the ring or more; one colour: the median, as before).
  const buckets = new Map<number, number[][]>();
  for (const p of ring) { const k = (p[0] >> 4 << 8) | (p[1] >> 4 << 4) | (p[2] >> 4); const b = buckets.get(k); if (b) b.push(p); else buckets.set(k, [p]); }
  const grounds = [...buckets.values()].filter(b => b.length >= ring.length * 0.1).sort((a, b) => b.length - a.length).slice(0, 4).map(b => [0, 1, 2].map(c => median(b.map(p => p[c]))));
  const backgrounds = grounds.length >= 2 ? grounds : [bg];
  const diff = new Float32Array(W * H);
  let maxDiff = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = px(x, y), d = Math.min(...backgrounds.map(g => Math.max(Math.abs(p[0] - g[0]), Math.abs(p[1] - g[1]), Math.abs(p[2] - g[2]))));
    diff[y * W + x] = d; if (d > maxDiff) maxDiff = d;
  }
  const inkThreshold = Math.max(30, maxDiff * 0.45), ink = new Uint8Array(W * H);
  const strong: number[][] = [];
  for (let i = 0; i < W * H; i++) if (diff[i] >= inkThreshold) { ink[i] = 1; if (diff[i] >= maxDiff * 0.75) strong.push(px(i % W, Math.floor(i / W))); }
  const inkCount = ink.reduce((a, b) => a + b, 0);
  const color = strong.length ? hex(median(strong.map(p => p[0])), median(strong.map(p => p[1])), median(strong.map(p => p[2]))) : hex(bg[0] < 128 ? 255 : 0, bg[1] < 128 ? 255 : 0, bg[2] < 128 ? 255 : 0);
  // Vertical extent of the ink (the engine's box can include a little background).
  let top = H, bottom = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ink[y * W + x]) { if (y < top) top = y; if (y > bottom) bottom = y; }
  const inkHeight = bottom >= top ? bottom - top + 1 : H;
  const fontSize = Math.max(1, inkHeight / inkEmShare(text));
  // Stroke: the median length of horizontal ink runs (vertical stems dominate it in most letters).
  const runs: number[] = [];
  for (let y = top; y <= bottom; y++) { let run = 0; for (let x = 0; x <= W; x++) { if (x < W && ink[y * W + x]) run++; else if (run) { runs.push(run); run = 0; } } }
  const strokeEm = median(runs) / fontSize;
  const fontWeight: 400 | 600 | 700 = strokeEm >= 0.135 ? 700 : strokeEm >= 0.105 ? 600 : 400;
  // Italic: the shear (0–20°) whose column projection is sharpest, against the upright one.
  const sharpness = (deg: number) => {
    const t = Math.tan(deg * Math.PI / 180), cols = new Float64Array(W + 2 * H);
    for (let y = top; y <= bottom; y++) for (let x = 0; x < W; x++) if (ink[y * W + x]) { const c = Math.round(x + (y - bottom) * t) + H; if (c >= 0 && c < cols.length) cols[c]++; }
    let s = 0; for (const v of cols) s += v * v; return s;
  };
  // The sharpest shear from −6° to 24°: an italic is sharpest at its slant (8° or more), clearly sharper than upright.
  const upright = sharpness(0);
  let best = 0, bestScore = upright;
  for (let deg = -6; deg <= 24; deg += 2) { const s = sharpness(deg); if (s > bestScore) { best = deg; bestScore = s; } }
  const italic = best >= 8 && bestScore >= upright * 1.015 && inkHeight >= 10;
  // Baseline: the engine's line under the word, else the ink bottom (above the descenders when the word has some).
  let baseline: number, rotation = 0;
  if (baselineLine && baselineLine.x1 > baselineLine.x0) {
    const cx = box.x + box.width / 2, t = (cx - baselineLine.x0) / (baselineLine.x1 - baselineLine.x0);
    baseline = baselineLine.y0 + (baselineLine.y1 - baselineLine.y0) * t - box.y;
    const slope = Math.atan2(baselineLine.y1 - baselineLine.y0, baselineLine.x1 - baselineLine.x0) * 180 / Math.PI;
    rotation = Math.abs(slope) >= 0.5 ? Math.round(slope * 10) / 10 : 0;
  } else baseline = (y0 + (bottom >= 0 ? bottom + 1 : H)) - box.y - (hasDescender(text) ? fontSize * 0.21 : 0);
  if (!(baseline > 0 && baseline <= box.height + 2)) baseline = box.height * 0.8;
  const inkShare = inkCount / (W * H), separation = Math.min(1, maxDiff / 160);
  const confidence = Math.max(0.1, Math.min(1, separation * (inkShare > 0.03 && inkShare < 0.85 ? 1 : 0.5) * (inkHeight >= 8 ? 1 : 0.6)));
  return { color, fontSize: Math.round(fontSize * 10) / 10, fontWeight, italic, italicAngle: best, baseline: Math.round(baseline * 10) / 10, rotation, evidence: { strokeEm: Math.round(strokeEm * 1000) / 1000, inkShare: Math.round(inkShare * 1000) / 1000, separation: Math.round(separation * 100) / 100 }, confidence: Math.round(confidence * 100) / 100 };
}

export interface Tile { x: number; y: number; width: number; height: number; fill: number }
/**
 * Logo tiles in a region: light rounded cards (most channels above `light`) that are large, near-rectangular and repeat
 * at one size, as in a grid of bank logos. A region is eroded first so a thin light pattern behind the cards does not join
 * them. Fewer than two tiles of one size is no grid, and returns nothing.
 */
export function detectLogoTiles(source: Rgba, region: PixelBox, options: { light?: number; erode?: number } = {}): Tile[] {
  const light = options.light ?? 232, r = options.erode ?? 4;
  const X = Math.max(0, Math.floor(region.x)), Y = Math.max(0, Math.floor(region.y));
  const W = Math.min(source.width, Math.ceil(region.x + region.width)) - X, H = Math.min(source.height, Math.ceil(region.y + region.height)) - Y;
  if (W < 40 || H < 20) return [];
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = ((Y + y) * source.width + X + x) * 4; mask[y * W + x] = Math.min(source.data[i], source.data[i + 1], source.data[i + 2]) > light ? 1 : 0; }
  const erode = (m: Uint8Array) => {
    const t = new Uint8Array(W * H), o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = 1; for (let d = -r; d <= r && v; d++) { const xx = x + d; v = xx >= 0 && xx < W ? m[y * W + xx] : 0; } t[y * W + x] = v; }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = 1; for (let d = -r; d <= r && v; d++) { const yy = y + d; v = yy >= 0 && yy < H ? t[yy * W + x] : 0; } o[y * W + x] = v; }
    return o;
  };
  const core = erode(mask), label = new Int32Array(W * H), found: Tile[] = [];
  let n = 0;
  for (let i = 0; i < W * H; i++) if (core[i] && !label[i]) {
    n++; const stack = [i]; label[i] = n; let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0;
    while (stack.length) {
      const j = stack.pop()!, x = j % W, y = (j - x) / W; area++;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
      for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, j - W, j + W]) if (k >= 0 && k < W * H && core[k] && !label[k]) { label[k] = n; stack.push(k); }
    }
    // Grown back by the erosion radius.
    const w = x1 - x0 + 1 + 2 * r, h = y1 - y0 + 1 + 2 * r, fill = area / ((x1 - x0 + 1) * (y1 - y0 + 1));
    // A card's logo is not light, so the card's light area has holes: a low fill still makes a card.
    if (area > 1500 && w > 80 && h > 30 && fill > 0.3 && w < W * 0.9) found.push({ x: X + x0 - r, y: Y + y0 - r, width: w, height: h, fill: Math.round(fill * 100) / 100 });
  }
  if (found.length < 2) return [];
  // One grid: the tiles of the most common size (within 12%); a stray card of another size is left out.
  const sizeOf = (t: Tile) => found.filter(o => Math.abs(o.width - t.width) <= t.width * 0.12 && Math.abs(o.height - t.height) <= t.height * 0.12).length;
  const ref = [...found].sort((a, b) => sizeOf(b) - sizeOf(a))[0];
  const grid = found.filter(t => Math.abs(t.width - ref.width) <= ref.width * 0.12 && Math.abs(t.height - ref.height) <= ref.height * 0.12);
  if (grid.length < 2) return [];
  // Tiles cut by the pattern come out a little small: each takes the grid's typical size around its own centre.
  const w = median(grid.map(t => t.width)), h = median(grid.map(t => t.height));
  const sized = grid.map(t => ({ ...t, x: Math.round(t.x + t.width / 2 - w / 2), y: Math.round(t.y + t.height / 2 - h / 2), width: w, height: h }));
  // A card whose logo fills most of it has too little light area to be found: a free cell of the grid whose outline is a
  // light card edge is one too. Cells without a card edge (the pattern, an empty corner) are left out.
  const cluster = (values: number[], tolerance: number) => values.sort((a, b) => a - b).reduce<number[]>((acc, v) => (acc.length && v - acc[acc.length - 1] <= tolerance ? acc : [...acc, v]), []);
  const cols = cluster(sized.map(t => t.x), w / 4), rowsAt = cluster(sized.map(t => t.y), h / 4);
  const lightEdge = (bx: number, by: number) => {
    let n = 0, lit = 0;
    const inset = 4, at = (x: number, y: number) => { if (x < 0 || y < 0 || x >= source.width || y >= source.height) return; n++; const i = (y * source.width + x) * 4; if (Math.min(source.data[i], source.data[i + 1], source.data[i + 2]) > light) lit++; };
    for (let x = bx + inset; x < bx + w - inset; x += 2) { at(x, by + inset); at(x, by + h - 1 - inset); }
    for (let y = by + inset; y < by + h - inset; y += 2) { at(bx + inset + Math.round(h / 3), y); at(bx + w - 1 - inset - Math.round(h / 3), y); }
    return n ? lit / n : 0;
  };
  for (const cx of cols) for (const cy of rowsAt) {
    if (sized.some(t => Math.abs(t.x - cx) <= w / 4 && Math.abs(t.y - cy) <= h / 4)) continue;
    if (cx < X || cy < Y || cx + w > X + W || cy + h > Y + H) continue;
    if (lightEdge(cx, cy) >= 0.6) sized.push({ x: cx, y: cy, width: w, height: h, fill: 0 });
  }
  return sized.sort((a, b) => (Math.abs(a.y - b.y) < h / 2 ? a.x - b.x : a.y - b.y));
}

/**
 * The box around the word's own ink: the engine's box, shrunk (never grown) to the pixels that differ from the background,
 * leaving out any smaller word's box inside it (a sparse reading of a huge word can reach over a smaller word above it).
 */
export function inkBounds(source: Rgba, box: PixelBox, exclude: PixelBox[] = []): PixelBox {
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(source.width, Math.ceil(box.x + box.width)), y1 = Math.min(source.height, Math.ceil(box.y + box.height));
  const ring: number[][] = [];
  for (let x = x0; x < x1; x++) for (const y of [y0 - 2, y1 + 1]) if (y >= 0 && y < source.height) { const i = (y * source.width + x) * 4; ring.push([source.data[i], source.data[i + 1], source.data[i + 2]]); }
  for (let y = y0; y < y1; y++) for (const x of [x0 - 2, x1 + 1]) if (x >= 0 && x < source.width) { const i = (y * source.width + x) * 4; ring.push([source.data[i], source.data[i + 1], source.data[i + 2]]); }
  if (!ring.length) return box;
  const bg = [0, 1, 2].map(c => median(ring.map(p => p[c])));
  const skip = (x: number, y: number) => exclude.some(e => x >= e.x && x < e.x + e.width && y >= e.y && y < e.y + e.height);
  let maxDiff = 0;
  const diffAt = (x: number, y: number) => { const i = (y * source.width + x) * 4; return Math.max(Math.abs(source.data[i] - bg[0]), Math.abs(source.data[i + 1] - bg[1]), Math.abs(source.data[i + 2] - bg[2])); };
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!skip(x, y)) maxDiff = Math.max(maxDiff, diffAt(x, y));
  const threshold = Math.max(30, maxDiff * 0.45);
  const W = x1 - x0, H = y1 - y0, ink = new Uint8Array(W * H), rows = new Array<number>(H).fill(0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!skip(x0 + x, y0 + y) && diffAt(x0 + x, y0 + y) >= threshold) { ink[y * W + x] = 1; rows[y]++; }
  // The word's own rows: the longest band of rows carrying a fair share of ink. Decoration that the engine's box reaches
  // into (a leaf at a corner) carries little ink per row and falls outside it.
  const strong = Math.max(1, Math.max(...rows) * 0.12), gap = Math.max(2, Math.round(H * 0.04));
  let best = { top: 0, bottom: -1 }, start = -1, last = -1;
  for (let y = 0; y <= H; y++) {
    if (y < H && rows[y] >= strong) { if (start < 0 || y - last > gap) start = y; last = y; if (last - start > best.bottom - best.top) best = { top: start, bottom: last }; }
  }
  if (best.bottom < best.top) return box;
  // Then out through every row with some ink that touches it: ascenders, descenders, an accent. A separate decoration
  // beyond a blank gap stays out.
  const touch = Math.max(1, Math.round(H * 0.01));
  for (let y = best.top - 1, blank = 0; y >= 0 && blank <= touch; y--) { if (rows[y]) { best.top = y; blank = 0; } else blank++; }
  for (let y = best.bottom + 1, blank = 0; y < H && blank <= touch; y++) { if (rows[y]) { best.bottom = y; blank = 0; } else blank++; }
  let left = W, right = -1;
  for (let y = best.top; y <= best.bottom; y++) for (let x = 0; x < W; x++) if (ink[y * W + x]) { if (x < left) left = x; if (x > right) right = x; }
  if (right < left) return box;
  return { x: x0 + left, y: y0 + best.top, width: right - left + 1, height: best.bottom - best.top + 1 };
}

/** The median colour of a box of an image (#RRGGBB): the artwork behind a word, for a contrast check. */
export function medianColour(image: Rgba, box: PixelBox): string {
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y)), x1 = Math.min(image.width, Math.ceil(box.x + box.width)), y1 = Math.min(image.height, Math.ceil(box.y + box.height));
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
  const r: number[] = [], g: number[] = [], b: number[] = [];
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) { const i = (y * image.width + x) * 4; r.push(image.data[i]); g.push(image.data[i + 1]); b.push(image.data[i + 2]); }
  return hex(median(r), median(g), median(b));
}
