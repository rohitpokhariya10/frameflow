/**
 * The automatic scan of an offer creative (a Text & Graphics master template): what can change, found once per source.
 * Local only: the OCR engine of textRecognition/ (tesseract, on this server) and arithmetic on the source pixels.
 *
 *   words       one OCR reading of the whole poster; each reading tightened to its own ink. Kept only when it reads like
 *               text: decoration (border dots, pattern), a logo card's own lettering and illegible scraps are left out
 *   logo cards  a grid of light cards (bank logos) becomes one slot per card (measure.ts detectLogoTiles)
 *   QR codes    the three finder squares of a QR code, found by their 1:1:3:1:1 run pattern
 *   blocks      lines of words close below each other, in one colour, form a block; each block becomes one region
 *   brand marks a short block in the header band of the poster is a brand logo, kept as an image slot
 *   plates      a line set on a solid shape of its own (a pill, a button) records that shape, so it can be recoloured
 *
 * Every result is an estimate an administrator reviews; nothing here is final, and nothing calls a provider.
 */
import sharp from 'sharp';
import type { Rgba } from '../pixels.js';
import { detectLogoTiles, inkBounds, type PixelBox, type Tile } from '../../../textRecognition/measure.js';
import type { RecognizedWord, WordRecognizer } from '../../../textRecognition/recognizer.js';

export interface ScanWord {
  text: string; confidence: number;
  /** Source pixels, tight around the word's ink. */
  box: PixelBox;
  /** The engine's line baseline under the word, in source pixels, when it gave one. */
  baseline?: { x0: number; y0: number; x1: number; y1: number };
  /** The median colour of the word's ink and of the ring just around it; ringUniform: share of the ring near its median. */
  ink: string; ring: string; ringUniform: number;
  /** Distinct colours around the word: 1–2 for text on a ground or a pattern, more on a badge or illustration. */
  ringColours: number;
  mode: string;
}
export interface ScanDropped { text: string; confidence: number; box: PixelBox; reason: string }
export interface ScanPlate { box: PixelBox; fill: string; stroke: { color: string; width: number } | null; radius: number; confidence: number }
export interface ScanLine { words: ScanWord[]; box: PixelBox; plate?: ScanPlate }
export type ScanBlockKind = 'text' | 'legal' | 'brand-logo';
export interface ScanBlock { lines: ScanLine[]; box: PixelBox; kind: ScanBlockKind; reason: string }
export interface ScanGraphic { box: PixelBox; kind: 'qr' | 'brand-logo' | 'badge'; confidence: number; reason: string; text?: string }
export interface PosterScan {
  size: { width: number; height: number };
  blocks: ScanBlock[]; tiles: Tile[]; graphics: ScanGraphic[];
  dropped: ScanDropped[];
  recognizerCalls: number; durationMs: number;
  engine: WordRecognizer['engine'];
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const parseHex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
export const colourDistance = (a: string, b: string) => { const p = parseHex(a), q = parseHex(b); return Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2])); };
const median = (v: number[]) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
const alnum = (text: string) => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
const union = (boxes: PixelBox[]): PixelBox => {
  const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y)), x1 = Math.max(...boxes.map(b => b.x + b.width)), y1 = Math.max(...boxes.map(b => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};
const insideShare = (a: PixelBox, b: PixelBox) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.max(1e-9, a.width * a.height) : 0;
};
const pad = (b: PixelBox, p: number, size: { width: number; height: number }): PixelBox => {
  const x = Math.max(0, Math.floor(b.x - p)), y = Math.max(0, Math.floor(b.y - p));
  return { x, y, width: Math.min(size.width, Math.ceil(b.x + b.width + p)) - x, height: Math.min(size.height, Math.ceil(b.y + b.height + p)) - y };
};
const px = (s: Rgba, x: number, y: number) => { const i = (y * s.width + x) * 4; return [s.data[i], s.data[i + 1], s.data[i + 2]]; };
const diff = (p: number[], q: number[]) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));

/** Pixels on the ring `inset`..`inset + thickness` outside a box (clipped to the image), sampled every `step` pixels. */
function ringPixels(s: Rgba, b: PixelBox, inset: number, thickness: number, step = 1): number[][] {
  const out: number[][] = [];
  const x0 = Math.round(b.x - inset - thickness), y0 = Math.round(b.y - inset - thickness), x1 = Math.round(b.x + b.width + inset + thickness), y1 = Math.round(b.y + b.height + inset + thickness);
  const ix0 = Math.round(b.x - inset), iy0 = Math.round(b.y - inset), ix1 = Math.round(b.x + b.width + inset), iy1 = Math.round(b.y + b.height + inset);
  for (let y = Math.max(0, y0); y < Math.min(s.height, y1); y += step) for (let x = Math.max(0, x0); x < Math.min(s.width, x1); x += step) {
    if (x >= ix0 && x < ix1 && y >= iy0 && y < iy1) continue;
    out.push(px(s, x, y));
  }
  return out;
}
const medianColour = (pixels: number[][]) => hex(median(pixels.map(p => p[0])), median(pixels.map(p => p[1])), median(pixels.map(p => p[2])));
/**
 * The most common colour of a set of pixels: the 5-bit bucket with the most pixels in and next to it (so one colour split
 * across a bucket edge by noise still wins), averaged over the pixels near it. The background behind text.
 */
export function dominantColour(pixels: number[][]): string {
  const counts = new Map<number, number>(), key = (r: number, g: number, b: number) => (r << 10) | (g << 5) | b;
  for (const p of pixels) { const k = key(p[0] >> 3, p[1] >> 3, p[2] >> 3); counts.set(k, (counts.get(k) ?? 0) + 1); }
  let best = -1, bestScore = -1;
  for (const k of counts.keys()) {
    const r = k >> 10, g = (k >> 5) & 31, b = k & 31;
    let score = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) score += counts.get(key(r + dr, g + dg, b + db)) ?? 0;
    if (score > bestScore) { bestScore = score; best = k; }
  }
  if (best < 0) return '#ffffff';
  const c = [(best >> 10) * 8 + 4, ((best >> 5) & 31) * 8 + 4, (best & 31) * 8 + 4], near = pixels.filter(p => diff(p, c) <= 14);
  return near.length ? medianColour(near) : hex(c[0], c[1], c[2]);
}
/** Share of pixels within `tolerance` of a colour. 72 keeps a light pattern on its ground (cream lines on mint) together. */
function uniformity(pixels: number[][], around: string, tolerance = 72) {
  if (!pixels.length) return 0;
  const m = parseHex(around);
  return pixels.filter(p => diff(p, m) <= tolerance).length / pixels.length;
}

/** The ink colour of a word: the median of its pixels that differ most from the ring around it. */
function inkColour(s: Rgba, b: PixelBox, ring: string): string {
  const bg = parseHex(ring), strong: number[][] = [];
  let max = 0;
  const x0 = Math.max(0, Math.floor(b.x)), y0 = Math.max(0, Math.floor(b.y)), x1 = Math.min(s.width, Math.ceil(b.x + b.width)), y1 = Math.min(s.height, Math.ceil(b.y + b.height));
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000)));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) max = Math.max(max, diff(px(s, x, y), bg));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) { const p = px(s, x, y); if (diff(p, bg) >= max * 0.75) strong.push(p); }
  return strong.length ? medianColour(strong) : ring;
}

// ---------------------------------------------------------------------------------------------------------------------
// QR codes: the finder squares (dark 1, light 1, dark 3, light 1, dark 1 modules across their centre)
// ---------------------------------------------------------------------------------------------------------------------
function finderRatio(runs: number[]): number | undefined {
  const total = runs.reduce((a, b) => a + b, 0);
  if (total < 7) return undefined;
  const m = total / 7, ok = (v: number, k: number) => Math.abs(v - k * m) <= Math.max(1, k * m * 0.5);
  return ok(runs[0], 1) && ok(runs[1], 1) && ok(runs[2], 3) && ok(runs[3], 1) && ok(runs[4], 1) ? m : undefined;
}
/** Runs of dark/light along a line through (x, y), centred on it: the five runs around the centre, or none. */
function runsThrough(dark: (x: number, y: number) => boolean, x: number, y: number, dx: number, dy: number, limit: number): number[] | undefined {
  const count = (sx: number, sy: number, want: boolean, max: number) => { let n = 0; while (n < max && dark(x + sx * n, y + sy * n) === want) n++; return n; };
  if (!dark(x, y)) return undefined;
  // From the centre outwards on both sides: centre dark run, then light, then dark.
  const back = (s: number) => {
    let cx = x, cy = y;
    const out: number[] = [];
    for (const want of [true, false, true]) {
      let n = 0; while (n < limit && dark(cx, cy) === want) { cx += s * dx; cy += s * dy; n++; }
      out.push(n);
    }
    return out;
  };
  void count;
  const a = back(-1), b = back(1);
  // Centre run counted twice (both sides start on it).
  return [a[2], a[1], a[0] + b[0] - 1, b[1], b[2]];
}
export function findQrCodes(s: Rgba): PixelBox[] {
  const { width: W, height: H } = s;
  const lum = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = (s.data[i * 4] * 299 + s.data[i * 4 + 1] * 587 + s.data[i * 4 + 2] * 114) / 1000;
  const dark = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && lum[y * W + x] < 110;
  const centres: { x: number; y: number; m: number }[] = [];
  const step = 2;
  for (let y = 0; y < H; y += step) {
    // Row runs, alternating; test every window of five starting with a dark run.
    const runs: { start: number; len: number; dark: boolean }[] = [];
    let start = 0;
    for (let x = 1; x <= W; x++) if (x === W || dark(x, y) !== dark(x - 1, y)) { runs.push({ start, len: x - start, dark: dark(start, y) }); start = x; }
    for (let i = 0; i + 4 < runs.length; i++) {
      if (!runs[i].dark) continue;
      const m = finderRatio(runs.slice(i, i + 5).map(r => r.len));
      if (!m || m < 1.5) continue;
      const cx = Math.round(runs[i + 2].start + runs[i + 2].len / 2);
      const v = runsThrough(dark, cx, y, 0, 1, Math.ceil(m * 5));
      const mv = v && finderRatio(v);
      if (!mv || Math.abs(mv - m) > m * 0.4) continue;
      // Vertical centre of the square.
      let top = y; while (dark(cx, top - 1)) top--;
      let bottom = y; while (dark(cx, bottom + 1)) bottom++;
      const cy = Math.round((top + bottom) / 2);
      const d = runsThrough(dark, cx, cy, 1, 1, Math.ceil(m * 5));
      if (!d || !finderRatio(d)) continue;
      centres.push({ x: cx, y: cy, m: (m + mv) / 2 });
    }
  }
  // One centre per finder square.
  const finders: { x: number; y: number; m: number; n: number }[] = [];
  for (const c of centres) {
    const f = finders.find(o => Math.abs(o.x - c.x) <= o.m * 2 && Math.abs(o.y - c.y) <= o.m * 2);
    if (f) { f.x = (f.x * f.n + c.x) / (f.n + 1); f.y = (f.y * f.n + c.y) / (f.n + 1); f.m = (f.m * f.n + c.m) / (f.n + 1); f.n++; } else finders.push({ ...c, n: 1 });
  }
  const strong = finders.filter(f => f.n >= 2);
  // Three finders of one module size at the corners of a square: top-left, top-right, bottom-left.
  const out: PixelBox[] = [], used = new Set<number>();
  for (let i = 0; i < strong.length; i++) for (let j = 0; j < strong.length; j++) for (let k = 0; k < strong.length; k++) {
    if (i === j || j === k || i === k || used.has(i) || used.has(j) || used.has(k)) continue;
    const a = strong[i], b = strong[j], c = strong[k], m = (a.m + b.m + c.m) / 3;
    if ([a, b, c].some(f => Math.abs(f.m - m) > m * 0.3)) continue;
    const ab = { x: b.x - a.x, y: b.y - a.y }, ac = { x: c.x - a.x, y: c.y - a.y }, lab = Math.hypot(ab.x, ab.y), lac = Math.hypot(ac.x, ac.y);
    if (lab < m * 10 || Math.abs(lab - lac) > 0.1 * lab || Math.abs(ab.x * ac.x + ab.y * ac.y) > 0.15 * lab * lac || ab.x <= 0 || ac.y <= 0) continue;
    const r = 3.5 * m, xs = [a.x, b.x, c.x], ys = [a.y, b.y, c.y];
    const x0 = Math.min(...xs) - r, y0 = Math.min(...ys) - r, x1 = Math.max(...xs) + r, y1 = Math.max(...ys) + r;
    out.push({ x: Math.max(0, Math.floor(x0)), y: Math.max(0, Math.floor(y0)), width: Math.ceil(x1 - x0), height: Math.ceil(y1 - y0) });
    used.add(i); used.add(j); used.add(k);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Plates: a solid shape just around a line of text (a pill, a button), in a colour of its own
// ---------------------------------------------------------------------------------------------------------------------
export function findPlate(s: Rgba, line: PixelBox, lineHeight: number, ink?: string): ScanPlate | undefined {
  const near = ringPixels(s, line, Math.max(2, lineHeight * 0.08), Math.max(2, lineHeight * 0.07), 2);
  const fill = medianColour(near);
  if (uniformity(near, fill, 28) < 0.8) return undefined;
  // The panel the line sits on (the commonest colour further out, other text left out) must differ: a "plate" in the
  // panel's own colour is just the background between other content.
  const inkRgb = ink ? parseHex(ink) : undefined, wide = ringPixels(s, line, lineHeight * 1.0, lineHeight * 1.5, 3).filter(p => !inkRgb || diff(p, inkRgb) > 60);
  if (wide.length && colourDistance(dominantColour(wide), fill) < 40) return undefined;
  // The shape's extent: from the line outwards while the colour holds (rows and columns mostly of the fill).
  const f = parseHex(fill), is = (x: number, y: number) => x >= 0 && y >= 0 && x < s.width && y < s.height && diff(px(s, x, y), f) <= 34;
  const rowShare = (y: number, x0: number, x1: number) => { let n = 0, t = 0; for (let x = x0; x < x1; x += 2) { t++; if (is(x, y)) n++; } return t ? n / t : 0; };
  const colShare = (x: number, y0: number, y1: number) => { let n = 0, t = 0; for (let y = y0; y < y1; y += 2) { t++; if (is(x, y)) n++; } return t ? n / t : 0; };
  // A plate hugs its line: a little above and below it, a little more at its ends.
  const maxGrow = lineHeight * 0.9;
  let top = Math.round(line.y), bottom = Math.round(line.y + line.height), left = Math.round(line.x), right = Math.round(line.x + line.width);
  while (top > 0 && line.y - top < maxGrow && rowShare(top - 1, left, right) >= 0.6) top--;
  while (bottom < s.height - 1 && bottom - (line.y + line.height) < maxGrow && rowShare(bottom + 1, left, right) >= 0.6) bottom++;
  // Sideways along the clear bands of fill above and below the text (beside the text, its anti-aliased letters would stop
  // the growth at once); the middle rows when those bands are too thin.
  const bands = [[top + 1, Math.round(line.y) - 2], [Math.round(line.y + line.height) + 2, bottom - 1]].filter(([a, b]) => b - a >= 2);
  const middle = (x: number) => colShare(x, Math.round(top + (bottom - top) * 0.25), Math.round(bottom - (bottom - top) * 0.25));
  // Rounded ends: near them the bands curve out of the fill while the middle rows are still in it.
  const sideShare = (x: number) => Math.max(middle(x), bands.length ? bands.reduce((sum, [a, b]) => sum + colShare(x, a, b + 1), 0) / bands.length : 0);
  while (left > 0 && line.x - left < maxGrow * 2 && sideShare(left - 1) >= 0.6) left--;
  while (right < s.width - 1 && right - (line.x + line.width) < maxGrow * 2 && sideShare(right + 1) >= 0.6) right++;
  const box = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  // Grown to the edge of the search (it never closed), far taller or wider than the line, or no taller: not a shape.
  if (line.y - top >= maxGrow || bottom - (line.y + line.height) >= maxGrow || box.height > lineHeight * 2.8 || box.height < lineHeight * 1.05 || box.width > line.width + lineHeight * 3) return undefined;
  // A plate is closed: just outside it lies one ground colour all around, which differs from the fill. Otherwise the
  // "plate" is a patch of the poster's own background between other content.
  const boundary = ringPixels(s, box, Math.max(2, lineHeight * 0.1), Math.max(3, lineHeight * 0.2), 2), around = dominantColour(boundary);
  if (colourDistance(around, fill) < 40 || uniformity(boundary, around) < 0.6) return undefined;
  // And closed for real: a fill through its colour (and colours close to it, a pattern's lines) from beside the text
  // stays inside the shape; a patch of the background runs out into the rest of the panel.
  {
    const m = Math.round(lineHeight * 0.6), wx0 = Math.max(0, box.x - m), wy0 = Math.max(0, box.y - m), wx1 = Math.min(s.width, box.x + box.width + m), wy1 = Math.min(s.height, box.y + box.height + m);
    const W = wx1 - wx0, seen = new Uint8Array(W * (wy1 - wy0)), stack: number[] = [];
    const ok = (x: number, y: number) => diff(px(s, x, y), f) <= 72;
    for (let x = Math.round(line.x); x < line.x + line.width; x += 3) for (const y of [Math.round(line.y - lineHeight * 0.1), Math.round(line.y + line.height + lineHeight * 0.1)]) if (y >= wy0 && y < wy1 && ok(x, y) && !seen[(y - wy0) * W + x - wx0]) { seen[(y - wy0) * W + x - wx0] = 1; stack.push(x, y); }
    let escaped = 0, inside = 0;
    while (stack.length) {
      const y = stack.pop()!, x = stack.pop()!;
      const e = Math.max(2, lineHeight * 0.15);
      if (x < box.x - e || y < box.y - e || x > box.x + box.width + e || y > box.y + box.height + e) escaped++; else inside++;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < wx0 || ny < wy0 || nx >= wx1 || ny >= wy1) continue;
        const k = (ny - wy0) * W + nx - wx0;
        if (!seen[k] && ok(nx, ny)) { seen[k] = 1; stack.push(nx, ny); }
      }
    }
    if (escaped > 0.03 * Math.max(1, inside)) return undefined;
  }
  // Corner radius: how far in from the corner the fill starts along the top-left diagonal.
  let r = 0;
  while (r < box.height / 2 && !is(box.x + r, box.y + r)) r++;
  const radius = Math.min(box.height / 2, Math.round(r / (1 - Math.SQRT1_2)));
  // An outline: across the top and bottom edges, a run of pixels that are neither the fill nor the ground.
  const g = parseHex(around), runs: number[] = [], colours: number[][] = [];
  for (let k = 1; k <= 12; k++) for (const [y0, dy] of [[box.y, -1], [box.y + box.height - 1, 1]] as const) {
    const x = Math.round(box.x + box.width * (0.2 + 0.6 * k / 13));
    let y = y0, n = 0;
    while (Math.abs(y - y0) < lineHeight * 0.4 && y >= 0 && y < s.height && diff(px(s, x, y), f) <= 40) y += dy;
    let peak: number[] | undefined, best = 0;
    while (Math.abs(y - y0) < lineHeight * 0.4 && y >= 0 && y < s.height && diff(px(s, x, y), g) > 40 && diff(px(s, x, y), f) > 40) {
      const p = px(s, x, y), d = Math.min(diff(p, g), diff(p, f));
      if (d > best) { best = d; peak = p; }
      n++; y += dy;
    }
    if (peak) colours.push(peak);
    runs.push(n);
  }
  let stroke: ScanPlate['stroke'] = null;
  if (runs.filter(n => n >= 1).length >= runs.length * 0.6) {
    const c = medianColour(colours);
    // The anti-aliased run is wider than the line itself: about half of it is the outline's own colour.
    if (colourDistance(c, around) > 40) stroke = { color: c, width: Math.max(1, Math.round(median(runs.filter(n => n >= 1)) * 0.6)) };
  }
  return { box, fill, stroke, radius, confidence: 0.75 };
}

/** Colours around a word: clusters of ring pixels (within 72 of each other) that hold at least 12% of the ring. */
function colourClusters(pixels: number[][]): number {
  let rest = pixels, clusters = 0;
  while (rest.length >= pixels.length * 0.12) {
    const c = parseHex(dominantColour(rest)), inside = rest.filter(p => diff(p, c) <= 72);
    if (inside.length >= pixels.length * 0.12) clusters++;
    if (!inside.length) break;
    rest = rest.filter(p => diff(p, c) > 72);
  }
  return clusters;
}

/**
 * A line's box grown sideways along its own band while its ink colour continues with small gaps: a letter or a full stop
 * the OCR left out of every word ("NO-" and "OS" read for "NO-COST", "available" without its ".").
 */
export function extendLineToInk(s: Rgba, line: PixelBox, lineHeight: number, ink: string): PixelBox {
  const c = parseHex(ink), inkAt = (x: number, y: number) => diff(px(s, x, y), c) <= 60;
  const y0 = Math.max(0, Math.round(line.y + line.height * 0.15)), y1 = Math.min(s.height, Math.round(line.y + line.height * 0.95));
  const column = (x: number) => { if (x < 0 || x >= s.width) return false; let n = 0; for (let y = y0; y < y1; y++) if (inkAt(x, y)) n++; return n >= Math.max(1, (y1 - y0) * 0.04); };
  const maxGap = Math.max(4, Math.min(lineHeight * 0.25, 30));
  let right = Math.round(line.x + line.width), left = Math.round(line.x);
  for (let x = right, gap = 0; x < s.width && gap <= maxGap; x++) { if (column(x)) { right = x + 1; gap = 0; } else gap++; }
  for (let x = left - 1, gap = 0; x >= 0 && gap <= maxGap; x--) { if (column(x)) { left = x; gap = 0; } else gap++; }
  return { x: left, y: line.y, width: right - left, height: line.height };
}

/**
 * Ink of a line's colour along its band that none of the poster's words covers: text the whole-poster reading skipped beside
 * words it read ("3-6-9-12-18-24" before "months" on a dark pill). The band is walked outward from the line; pieces are
 * split at a word space and the walk ends at a wider gap. A piece too small or too flat for a word is left out (a full stop
 * beside the line is extendLineToInk's), and so is one another reading already covers.
 */
export function unreadInk(s: Rgba, line: PixelBox, lineHeight: number, ink: string, taken: PixelBox[]): PixelBox[] {
  const c = parseHex(ink), inkAt = (x: number, y: number) => diff(px(s, x, y), c) <= 60, h = lineHeight;
  const y0 = Math.max(0, Math.round(line.y + line.height * 0.1)), y1 = Math.min(s.height, Math.round(line.y + line.height * 0.95));
  const need = Math.max(1, (y1 - y0) * 0.04), column = (x: number) => { let n = 0; for (let y = y0; y < y1; y++) if (inkAt(x, y)) n++; return n >= need; };
  const spans: [number, number][] = [];
  const walk = (from: number, step: 1 | -1) => {
    let cur: [number, number] | undefined, gap = 0;
    for (let x = from; x >= 0 && x < s.width && gap <= h * 1.2; x += step) {
      if (!column(x)) { gap++; continue; }
      if (cur && gap > h * 0.35) { spans.push(cur); cur = undefined; }
      cur = cur ? [Math.min(cur[0], x), Math.max(cur[1], x)] : [x, x];
      gap = 0;
    }
    if (cur) spans.push(cur);
  };
  walk(Math.round(line.x + line.width), 1); walk(Math.round(line.x) - 1, -1);
  const top = Math.max(0, Math.round(line.y - h * 0.3)), bottom = Math.min(s.height, Math.round(line.y + line.height + h * 0.3)), out: PixelBox[] = [];
  for (const [a, b] of spans) {
    let ty = -1, by = -1;
    for (let y = top; y < bottom; y++) { let any = false; for (let x = a; x <= b && !any; x++) any = inkAt(x, y); if (any) { if (ty < 0) ty = y; by = y; } }
    if (ty < 0) continue;
    const box = { x: a, y: ty, width: b - a + 1, height: by - ty + 1 };
    if (box.width >= h * 0.25 && box.height >= h * 0.4 && box.height <= h * 1.6 && !taken.some(t => insideShare(box, t) > 0.3)) out.push(box);
  }
  return out;
}
/**
 * A piece read on its own, keyed to its ink: its letters dark on white whatever its colours (an engine reads light text on
 * a dark plate poorly). Same scale as the poster, so the engine's boxes map back by the region's offset.
 */
async function readKeyed(s: Rgba, recognizer: WordRecognizer, piece: PixelBox, ink: string, lineHeight: number): Promise<{ text: string; confidence: number; box: PixelBox; mode: string }[]> {
  const c = parseHex(ink), region = pad(piece, Math.max(4, lineHeight * 0.3), { width: s.width, height: s.height }), bytes = Buffer.alloc(region.width * region.height);
  for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) bytes[y * region.width + x] = diff(px(s, region.x + x, region.y + y), c) <= 70 ? 0 : 255;
  const png = await sharp(bytes, { raw: { width: region.width, height: region.height, channels: 1 } }).png().toBuffer();
  const read = await recognizer.recognize({ image: png, region, purpose: 'template' });
  return read.map(w => ({ text: w.text.trim(), confidence: w.confidence, mode: `keyed ${w.mode}`, box: { x: region.x + w.box.x0, y: region.y + w.box.y0, width: w.box.x1 - w.box.x0, height: w.box.y1 - w.box.y0 } }))
    .filter(w => alnum(w.text) >= 1 && !DECORATION.test(w.text));
}

/** The poster's ground: its most common colours (each at least 6% of a coarse sample), lightest first. */
export function groundPalette(s: Rgba): number[][] {
  const sample: number[][] = [];
  for (let y = 0; y < s.height; y += 8) for (let x = 0; x < s.width; x += 8) sample.push(px(s, x, y));
  const out: number[][] = [];
  let rest = sample;
  while (rest.length >= sample.length * 0.06 && out.length < 4) {
    const c = parseHex(dominantColour(rest)), inside = rest.filter(p => diff(p, c) <= 60);
    if (inside.length < sample.length * 0.06) break;
    out.push(c); rest = rest.filter(p => diff(p, c) > 60);
  }
  return out;
}
/**
 * A graphic's box (a badge) grown from where its lettering was read while the rows and columns at its edge are still
 * largely artwork (not the poster's ground). A thin line of artwork running past it (a dotted border) does not carry it.
 */
export function growGraphic(s: Rgba, box: PixelBox, ground: number[][], reach: number): PixelBox {
  const art = (x: number, y: number) => ground.every(c => diff(px(s, x, y), c) > 60);
  let x0 = Math.floor(box.x), y0 = Math.floor(box.y), x1 = Math.ceil(box.x + box.width), y1 = Math.ceil(box.y + box.height);
  const rowShare = (y: number) => { let n = 0, t = 0; for (let x = x0; x < x1; x += 2) { t++; if (art(x, y)) n++; } return t ? n / t : 0; };
  const colShare = (x: number) => { let n = 0, t = 0; for (let y = y0; y < y1; y += 2) { t++; if (art(x, y)) n++; } return t ? n / t : 0; };
  const limit = { x0: box.x - reach, y0: box.y - reach, x1: box.x + box.width + reach, y1: box.y + box.height + reach };
  for (let changed = true, guard = 0; changed && guard < 6000; guard++) {
    changed = false;
    if (y0 > 0 && y0 > limit.y0 && rowShare(y0 - 1) >= 0.12) { y0--; changed = true; }
    if (y1 < s.height && y1 < limit.y1 && rowShare(y1) >= 0.12) { y1++; changed = true; }
    if (x0 > 0 && x0 > limit.x0 && colShare(x0 - 1) >= 0.12) { x0--; changed = true; }
    if (x1 < s.width && x1 < limit.x1 && colShare(x1) >= 0.12) { x1++; changed = true; }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * A logo card's box grown to its whole card: the tile detection finds the card's light inside, without the edge of the
 * card and its outline, which would otherwise stay behind in the clean background as a thin line. Each side grows while
 * its edge line is mostly not the poster's ground around the card.
 */
export function fitToCard<T extends PixelBox>(s: Rgba, tile: T): T {
  const ring = ringPixels(s, tile, 14, 14, 2), grounds: number[][] = [];
  let rest = ring;
  while (rest.length >= ring.length * 0.15 && grounds.length < 2) { const c = parseHex(dominantColour(rest)); grounds.push(c); rest = rest.filter(p => diff(p, c) > 40); }
  const ground = (x: number, y: number) => grounds.some(c => diff(px(s, x, y), c) <= 30);
  const lineShare = (x0: number, y0: number, x1: number, y1: number) => { let n = 0, t = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { if (x < 0 || y < 0 || x >= s.width || y >= s.height) continue; t++; if (!ground(x, y)) n++; } return t ? n / t : 0; };
  let x0 = Math.round(tile.x), y0 = Math.round(tile.y), x1 = Math.round(tile.x + tile.width) - 1, y1 = Math.round(tile.y + tile.height) - 1;
  for (let k = 0; k < 10 && lineShare(x0, y0 - 1, x1, y0 - 1) > 0.25; k++) y0--;
  for (let k = 0; k < 10 && lineShare(x0, y1 + 1, x1, y1 + 1) > 0.25; k++) y1++;
  for (let k = 0; k < 10 && lineShare(x0 - 1, y0 + (y1 - y0) * 0.3, x0 - 1, y0 + (y1 - y0) * 0.7) > 0.25; k++) x0--;
  for (let k = 0; k < 10 && lineShare(x1 + 1, y0 + (y1 - y0) * 0.3, x1 + 1, y0 + (y1 - y0) * 0.7) > 0.25; k++) x1++;
  return { ...tile, x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Words, lines and blocks
// ---------------------------------------------------------------------------------------------------------------------
/** Decoration that OCR reads as letters: dotted borders (o, 0, O, °), pattern scraps, punctuation alone. */
const DECORATION = /^[oO0°•·.,:;'"`()[\]{}|8\-_~*=]+$/;
const BUSY = 'on busy artwork (a badge or illustration)';
const LEGAL = /^\*?t&cs?\b|^\*?t&c|terms|conditions|^\*?t\s?&\s?c|disclaimer|^apply\.?$/i;

interface Candidate extends ScanWord { alnum: number }
function linesOf(words: Candidate[]): Candidate[][] {
  const out: Candidate[][] = [];
  const centre = (w: Candidate) => w.box.y + w.box.height / 2;
  for (const w of [...words].sort((a, b) => a.box.x - b.box.x)) {
    const line = out.find(row => {
      const last = row[row.length - 1], h = median(row.map(r => r.box.height));
      const overlap = Math.min(last.box.y + last.box.height, w.box.y + w.box.height) - Math.max(last.box.y, w.box.y);
      const gap = w.box.x - (last.box.x + last.box.width), ratio = w.box.height / h;
      return overlap >= 0.5 * Math.min(h, w.box.height) && Math.abs(centre(w) - centre(last)) <= 0.45 * Math.max(h, w.box.height) && gap <= 1.6 * Math.max(h, w.box.height) && gap >= -0.3 * h && ratio > 0.45 && ratio < 2.2;
    });
    if (line) line.push(w); else out.push([w]);
  }
  return out.sort((a, b) => Math.min(...a.map(w => w.box.y)) - Math.min(...b.map(w => w.box.y)));
}

export interface ScanOptions { headerBand?: number; at?: () => number }
/**
 * Reads the whole poster once, then sorts what it read: words that are text, decoration left out, logo cards and QR
 * codes as image slots, short header lines as brand marks. `recognizer` is called exactly once.
 */
export async function scanPoster(source: Rgba, recognizer: WordRecognizer, options: ScanOptions = {}): Promise<PosterScan> {
  const started = Date.now(), size = { width: source.width, height: source.height };
  const png = await sharp(source.data, { raw: { width: source.width, height: source.height, channels: 4 } }).png().toBuffer();
  const read: RecognizedWord[] = await recognizer.recognize({ image: png, region: { x: 0, y: 0, width: size.width, height: size.height }, purpose: 'template' });
  const tiles = detectLogoTiles(source, { x: 0, y: 0, width: size.width, height: size.height }).map(t => fitToCard(source, t));
  const qr = findQrCodes(source);
  const dropped: ScanDropped[] = [];
  const engineBoxes = read.map(w => ({ x: w.box.x0, y: w.box.y0, width: w.box.x1 - w.box.x0, height: w.box.y1 - w.box.y0 }));
  const candidates: Candidate[] = [];
  for (const [k, w] of read.entries()) {
    const own = engineBoxes[k], smaller = engineBoxes.filter((b, j) => j !== k && b.width * b.height < own.width * own.height && insideShare(b, own) > 0.8);
    const box = inkBounds(source, own, smaller), text = w.text.trim(), n = alnum(text);
    const drop = (reason: string) => dropped.push({ text, confidence: w.confidence, box, reason });
    if (!n || DECORATION.test(text)) { drop('decoration (dots, pattern or punctuation)'); continue; }
    if (tiles.some(t => insideShare(box, t) > 0.5)) { drop('lettering of a logo card'); continue; }
    if (qr.some(q => insideShare(box, q) > 0.3)) { drop('inside a QR code'); continue; }
    // A reading inside a larger, more confident one is a piece of it ("M" inside "EMI").
    if (candidates.some(c => insideShare(box, c.box) > 0.8 && c.confidence >= w.confidence)) { drop('part of a larger word'); continue; }
    for (let i = candidates.length - 1; i >= 0; i--) if (insideShare(candidates[i].box, box) > 0.8 && w.confidence >= candidates[i].confidence) { dropped.push({ text: candidates[i].text, confidence: candidates[i].confidence, box: candidates[i].box, reason: 'part of a larger word' }); candidates.splice(i, 1); }
    const reach = Math.min(20, Math.max(3, box.height * 0.15)), ringPx = ringPixels(source, box, reach, reach, Math.max(1, Math.floor(box.height / 60)));
    const ring = dominantColour(ringPx);
    candidates.push({ text, confidence: w.confidence, box, ...(w.baseline ? { baseline: w.baseline } : {}), ink: inkColour(source, box, ring), ring, ringUniform: Math.round(uniformity(ringPx, ring) * 100) / 100, ringColours: colourClusters(ringPx), mode: w.mode, alnum: n });
  }
  // Lines decide: a line is text when it has a clearly read word on a calm background; its other words follow it.
  const strong = (w: Candidate) => w.confidence >= 0.8 && w.alnum >= 2 && w.ringColours <= 2;
  const lines: ScanLine[] = [];
  for (const row of linesOf(candidates)) {
    const h = median(row.map(w => w.box.height));
    if (!row.some(strong)) { for (const w of row) dropped.push({ text: w.text, confidence: w.confidence, box: w.box, reason: w.ringColours > 2 ? BUSY : 'not read clearly enough to be text' }); continue; }
    const kept = row.filter(w => {
      const ok = w.alnum >= 2 ? w.confidence >= 0.45 : w.confidence >= 0.85 && w.box.height >= 0.6 * h && w.box.height <= 1.4 * h;
      if (!ok) dropped.push({ text: w.text, confidence: w.confidence, box: w.box, reason: 'a scrap beside a line of text' });
      return ok;
    });
    if (kept.length) lines.push({ words: kept, box: extendLineToInk(source, union(kept.map(w => w.box)), median(kept.map(w => w.box.height)), kept[0].ink) });
  }
  // Words the whole-poster reading skipped on a line it did read: each piece of unread ink read again on its own, keyed to the
  // line's colour. A piece that still reads as nothing is noted, never invented as text.
  // A weak reading dropped as a scrap is no reason to skip a piece: only words kept on lines cover it.
  let recognizerCalls = 1;
  const kept = () => lines.flatMap(l => l.words.map(w => w.box));
  for (const line of lines) {
    const h = median(line.words.map(w => w.box.height)), ink = line.words[0].ink, near = { width: size.width, height: size.height };
    for (const piece of unreadInk(source, line.box, h, ink, kept())) {
      recognizerCalls++;
      const found = (await readKeyed(source, recognizer, piece, ink, h)).filter(w => w.confidence >= 0.3 && insideShare(w.box, pad(piece, h * 0.3, near)) > 0.5);
      if (!found.length) { dropped.push({ text: '', confidence: 0, box: piece, reason: 'ink beside a line of text that could not be read: check it' }); continue; }
      for (const w of found) {
        const box = inkBounds(source, w.box), reach = Math.min(20, Math.max(3, box.height * 0.15)), ringPx = ringPixels(source, box, reach, reach, Math.max(1, Math.floor(box.height / 60))), ring = dominantColour(ringPx);
        line.words.push({ text: w.text, confidence: w.confidence, box, ink, ring, ringUniform: Math.round(uniformity(ringPx, ring) * 100) / 100, ringColours: colourClusters(ringPx), mode: w.mode });
      }
    }
    line.words.sort((a, b) => a.box.x - b.box.x);
    line.box = extendLineToInk(source, union(line.words.map(w => w.box)), h, ink);
  }
  // Plates first (a line on its own shape is a block of its own), then blocks of lines close below each other in one colour.
  for (const line of lines) { const p = findPlate(source, line.box, median(line.words.map(w => w.box.height)), line.words[0].ink); if (p) line.plate = p; }
  const blocks: ScanBlock[] = [];
  for (const line of [...lines].sort((a, b) => a.box.y - b.box.y)) {
    const h = median(line.words.map(w => w.box.height)), ink = line.words[0].ink;
    const block = line.plate ? undefined : blocks.find(b => {
      const last = b.lines[b.lines.length - 1];
      if (last.plate) return false;
      const lh = median(last.words.map(w => w.box.height)), gap = line.box.y - (last.box.y + last.box.height);
      const overlapX = Math.min(line.box.x + line.box.width, last.box.x + last.box.width) - Math.max(line.box.x, last.box.x);
      return gap >= -0.2 * Math.min(h, lh) && gap <= 0.8 * Math.min(h, lh) && overlapX > 0 && colourDistance(ink, last.words[0].ink) <= 60;
    });
    if (block) { block.lines.push(line); block.box = union(block.lines.map(l => l.box)); } else blocks.push({ lines: [line], box: line.plate ? union([line.box, line.plate.box]) : line.box, kind: 'text', reason: '' });
  }
  const headerBand = (options.headerBand ?? 0.11) * size.height, maxHeight = Math.max(...lines.map(l => median(l.words.map(w => w.box.height))), 1);
  for (const b of blocks) {
    const words = b.lines.flatMap(l => l.words), text = words.map(w => w.text).join(' ');
    if (words.some(w => LEGAL.test(w.text)) || /t\s?&\s?c/i.test(text)) { b.kind = 'legal'; b.reason = 'reads as terms and conditions'; continue; }
    const short = words.length <= 6 && b.box.width < size.width * 0.4, small = Math.max(...b.lines.map(l => median(l.words.map(w => w.box.height)))) < maxHeight * 0.45;
    const centre = (b.box.x + b.box.width / 2) / size.width, cornered = centre < 0.4 || centre > 0.6;
    if (b.box.y + b.box.height <= headerBand && short && (small || cornered)) { b.kind = 'brand-logo'; b.reason = `a short line in the poster's header band: most often a brand logo ("${text.slice(0, 40)}")`; continue; }
    b.reason = 'text';
  }
  const graphics: ScanGraphic[] = qr.map(box => ({ box, kind: 'qr' as const, confidence: 0.9, reason: 'three QR finder squares' }));
  const ground = groundPalette(source);
  // Badges: lettering read on busy artwork, two readings or more close together (a campaign badge's words).
  const busy = dropped.filter(d => d.reason === BUSY && d.confidence >= 0.6 && alnum(d.text) >= 2), clusters: ScanDropped[][] = [];
  for (const d of busy) {
    const c = clusters.find(cl => cl.some(o => insideShare(d.box, pad(o.box, Math.max(o.box.height, d.box.height) * 1.5, size)) > 0));
    if (c) c.push(d); else clusters.push([d]);
  }
  for (const c of clusters.filter(cl => cl.length >= 2)) {
    const box = union(c.map(d => d.box));
    if (graphics.some(g => insideShare(box, g.box) > 0.3)) continue;
    graphics.push({ box: growGraphic(source, box, ground, Math.max(box.width, box.height)), kind: 'badge', confidence: 0.45, reason: `lettering on artwork (${c.map(d => `"${d.text}"`).join(', ')}): probably a badge; check its outline`, text: c.map(d => d.text).join(' ') });
  }
  // Pieces of one lock-up (a name above a smaller tagline, letter-spaced words) become one logo.
  const marks: { box: PixelBox; h: number; text: string; reason: string }[] = [];
  for (const b of blocks.filter(x => x.kind === 'brand-logo')) {
    // Lettering inside a badge is the badge's own.
    if (graphics.some(g => g.kind === 'badge' && insideShare(b.box, g.box) > 0.5)) { for (const l of b.lines) for (const w of l.words) dropped.push({ text: w.text, confidence: w.confidence, box: w.box, reason: 'lettering of a badge' }); continue; }
    const h = Math.max(...b.lines.map(l => median(l.words.map(w => w.box.height)))), text = b.lines.flatMap(l => l.words.map(w => w.text)).join(' ');
    const near = marks.find(m => { const g = pad(m.box, Math.max(m.h, h) * 0.9, size); return insideShare(b.box, g) > 0 && Math.abs(b.box.y - m.box.y) < Math.max(m.h, h) * 2; });
    if (near) { near.box = union([near.box, b.box]); near.h = Math.max(near.h, h); near.text = `${near.text} ${text}`; } else marks.push({ box: b.box, h, text, reason: b.reason });
  }
  for (const m of marks) graphics.push({ box: expandToInk(source, m.box, m.h), kind: 'brand-logo', confidence: 0.6, reason: m.reason, text: m.text });
  return { size, blocks: blocks.filter(b => b.kind !== 'brand-logo'), tiles, graphics, dropped, recognizerCalls, durationMs: Date.now() - started, engine: recognizer.engine };
}

/**
 * A logo's box grown to its whole mark: lettering found by OCR is often only part of it (an icon beside the name, the dot
 * of an "i", a swash). Grows while ink touches the edge, up to `reach` on each side, against the colour around it.
 */
export function expandToInk(s: Rgba, box: PixelBox, lineHeight: number, reachShare = 0.45): PixelBox {
  const ring = medianColour(ringPixels(s, box, lineHeight * 0.8, 4, 2)), bg = parseHex(ring), reach = lineHeight * reachShare;
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < s.width && y < s.height && diff(px(s, x, y), bg) > 60;
  let { x: x0, y: y0 } = box, x1 = box.x + box.width, y1 = box.y + box.height;
  const rowHas = (y: number) => { for (let x = Math.floor(x0); x < x1; x++) if (ink(x, y)) return true; return false; };
  const colHas = (x: number) => { for (let y = Math.floor(y0); y < y1; y++) if (ink(x, y)) return true; return false; };
  for (let changed = true, guard = 0; changed && guard < 4000; guard++) {
    changed = false;
    if (y0 > 0 && box.y - y0 < reach && rowHas(Math.floor(y0) - 1)) { y0--; changed = true; }
    if (y1 < s.height && y1 - (box.y + box.height) < reach && rowHas(Math.ceil(y1))) { y1++; changed = true; }
    if (x0 > 0 && box.x - x0 < reach && colHas(Math.floor(x0) - 1)) { x0--; changed = true; }
    if (x1 < s.width && x1 - (box.x + box.width) < reach && colHas(Math.ceil(x1))) { x1++; changed = true; }
  }
  return pad({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, Math.max(2, lineHeight * 0.08), s);
}
export { union as unionBoxes, pad as padBox, insideShare as boxInsideShare };
