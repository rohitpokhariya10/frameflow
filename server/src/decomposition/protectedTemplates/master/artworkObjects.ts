/**
 * A template's background artwork split into its objects, locally (no provider, no cost): what a creative's decomposition
 * shows instead of one flat picture.
 *
 *   ground   the colours spread over the whole picture (a page, a panel's field, a pattern's lines) and the blends between
 *            them: the template's base, never an object
 *   objects  everything else (an illustration, a border of dots, a corner ornament), in connected pieces: a small area of
 *            ground inside one (a white ring, a petal's centre) belongs to it; pieces of one repeated small shape (the dots
 *            of a border) are one layer; other pieces close together (leaves and the flower over them) are one layer
 *   base     the picture with the objects taken out and the field continued behind them (the clean background's own fill:
 *            plain fields exactly, patterns from one repeat away, anything else a smooth estimate), so moving or hiding an
 *            object shows the field, not a hole
 *
 * Every object keeps the picture's exact pixels (with a 1 px edge) and the base keeps every pixel outside the objects, so
 * the layers over each other are the picture again, pixel for pixel. What is behind an object is an estimate.
 * Touching objects stay one layer (telling a flower from the leaves it lies on needs image decomposition).
 */
import sharp from 'sharp';
import { flattenRgb, type Rgba } from '../pixels.js';
import { label } from '../../backgroundContamination.js';
import { absorbHalo, cleanBackground } from './patternFill.js';
import { borderGrid, fillLevels, levelsOf, patternShows, residualsOf, unmix } from './artworkRebuild.js';

type Box = { x: number; y: number; width: number; height: number };
export interface ArtworkObject { name: string; kind: 'border' | 'ornaments' | 'object'; png: Buffer; placement: Box; pixels: number }
export interface ArtworkSplit {
  /** The base: the picture without its objects, the field continued behind them (full size, opaque). */
  base: Buffer;
  /** Back to front: a border or repeated ornaments first, then the other objects, larger ones behind smaller. */
  objects: ArtworkObject[];
  /** Share of the picture behind objects (estimated in the base), and of that how much was continued as plain or pattern. */
  filledPercent: number; trustedPercent: number; durationMs: number;
  /** Of the pixels behind objects, the share rebuilt from the template's structure (its page and its panel's repeats). */
  rebuiltPercent: number;
  /** Border dots drawn again where an illustration hid them. */
  borderDotsAdded: number;
  /** The layers over each other against the picture (levels of 255): rims are blends, so not every pixel is exact. */
  reconstruction: { mean: number; max: number; visiblePercent: number };
}
const GRID = 24;
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * The ground colours: common, and filling areas of the picture: present in a cell and in the four cells around it, in a
 * tenth of the picture at least (a page, a field, a pattern's lines). An illustration's colours are common only in one
 * place; outlines drawn round a frame (a ring of dots) are thin, never an area.
 */
export function groundColours(rgb: Uint8Array, w: number, h: number): number[][] {
  const n = w * h, bins = new Map<number, { n: number; r: number; g: number; b: number; cells: Int32Array }>(), cw = Math.ceil(w / GRID), ch = Math.ceil(h / GRID);
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = y * w + x, k = ((rgb[i * 3] >> 4) << 8) | ((rgb[i * 3 + 1] >> 4) << 4) | (rgb[i * 3 + 2] >> 4);
    let bin = bins.get(k);
    if (!bin) bins.set(k, bin = { n: 0, r: 0, g: 0, b: 0, cells: new Int32Array(GRID * GRID) });
    bin.n++; bin.r += rgb[i * 3]; bin.g += rgb[i * 3 + 1]; bin.b += rgb[i * 3 + 2]; bin.cells[Math.floor(y / ch) * GRID + Math.floor(x / cw)]++;
  }
  const sampled = n / 4, cellSampled = (cw * ch) / 4, out: number[][] = [];
  for (const bin of [...bins.values()].sort((a, b) => b.n - a.n)) {
    if (bin.n < sampled * 0.003) break;
    // At a share a pattern's thin lines still reach; beyond the picture's edge counts as present.
    const at = (r: number, c: number) => r < 0 || c < 0 || r >= GRID || c >= GRID || bin.cells[r * GRID + c] >= cellSampled * 0.004;
    let inside = 0; for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) if (at(r, c) && at(r - 1, c) && at(r + 1, c) && at(r, c - 1) && at(r, c + 1)) inside++;
    if (inside < GRID * GRID * 0.1) continue;
    const col = [bin.r / bin.n, bin.g / bin.n, bin.b / bin.n];
    if (!out.some(o => Math.max(...o.map((v, k) => Math.abs(v - col[k]))) <= 12)) out.push(col);
    if (out.length >= 6) break;
  }
  return out;
}
/** Ground: near a ground colour, or on the blend between two (an anti-aliased line of the pattern). */
export function groundMask(rgb: Uint8Array, w: number, h: number, grounds: number[][]): Uint8Array {
  const n = w * h, out = new Uint8Array(n), pairs: [number[], number[]][] = [];
  for (let a = 0; a < grounds.length; a++) for (let b = a + 1; b < grounds.length; b++) pairs.push([grounds[a], grounds[b]]);
  for (let i = 0; i < n; i++) {
    const p = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
    if (grounds.some(g => Math.hypot(p[0] - g[0], p[1] - g[1], p[2] - g[2]) <= 26)) { out[i] = 1; continue; }
    for (const [a, b] of pairs) {
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / len));
      if (Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1], p[2] - a[2] - t * d[2]) <= 14) { out[i] = 1; break; }
    }
  }
  return out;
}
const boxOf = (pixels: ArrayLike<number>, w: number) => { let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1; for (let k = 0; k < pixels.length; k++) { const i = pixels[k], x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }; };
/** Where an object is, in plain words (its centre in thirds of the picture). */
const placeName = (b: Box, w: number, h: number) => {
  const cx = (b.x + b.width / 2) / w, cy = (b.y + b.height / 2) / h;
  const v = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'middle', u = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'centre';
  return v === 'middle' && u === 'centre' ? 'centre' : `${v} ${u}`;
};

/**
 * `region`: where the artwork is drawn on a larger canvas (its colours are measured there, at its own proportions);
 * `grounds`: colours known to be ground (the colour a creative puts around its artwork).
 */
export async function splitArtwork(source: Rgba, options: { region?: Box; grounds?: string[]; log?: (line: string) => void } = {}): Promise<ArtworkSplit> {
  const started = Date.now(), { width: w, height: h } = source, n = w * h, rgb = flattenRgb(source), stage = (what: string) => options.log?.(`${what}: ${Date.now() - started} ms`);
  const r = options.region && { x: Math.max(0, Math.round(options.region.x)), y: Math.max(0, Math.round(options.region.y)), width: Math.min(w - Math.max(0, Math.round(options.region.x)), Math.round(options.region.width)), height: Math.min(h - Math.max(0, Math.round(options.region.y)), Math.round(options.region.height)) };
  let measured = rgb, mw = w, mh = h;
  if (r && r.width > 0 && r.height > 0) { measured = new Uint8Array(r.width * r.height * 3); for (let y = 0; y < r.height; y++) measured.set(rgb.subarray(((r.y + y) * w + r.x) * 3, ((r.y + y) * w + r.x + r.width) * 3), y * r.width * 3); mw = r.width; mh = r.height; }
  const grounds = groundColours(measured, mw, mh);
  for (const hex of options.grounds ?? []) { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); if (c.every(Number.isFinite) && !grounds.some(g => Math.max(...g.map((v, k) => Math.abs(v - c[k]))) <= 12)) grounds.push(c); }
  const ground = groundMask(rgb, w, h, grounds);
  stage('ground');
  // Ground enclosed by drawing (a ring's inside, between petals) is part of that drawing; the open field is not.
  const open = label(ground, w, h), touches = new Uint8Array(open.count + 1), size = new Int32Array(open.count + 1);
  for (let i = 0; i < n; i++) { const l = open.labels[i]; if (!l) continue; size[l]++; const x = i % w, y = (i - x) / w; if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches[l] = 1; }
  const drawn = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const l = open.labels[i]; drawn[i] = !l || (!touches[l] && size[l] < n * 0.01) ? 1 : 0; }
  const pieces = label(drawn, w, h), members: number[][] = Array.from({ length: pieces.count + 1 }, () => []);
  for (let i = 0; i < n; i++) if (pieces.labels[i]) members[pieces.labels[i]].push(i);
  stage('pieces');
  type Piece = { pixels: number[]; box: Box };
  const all: Piece[] = members.slice(1).filter(p => p.length >= 24 && p.length < n * 0.25).map(p => ({ pixels: p, box: boxOf(p, w) }));
  // Many pieces of one size and shape: a border of dots, a scatter of stars (one layer).
  const key = (p: Piece) => `${Math.round(Math.log2(p.pixels.length) * 2)}:${Math.round(Math.log2(p.box.width / p.box.height) * 2)}`;
  const byKey = new Map<string, Piece[]>();
  for (const p of all) if (p.pixels.length <= n * 0.002) (byKey.get(key(p)) ?? byKey.set(key(p), []).get(key(p))!).push(p);
  const repeated = new Set<Piece>(), groups: { kind: ArtworkObject['kind']; pieces: Piece[] }[] = [];
  for (const list of [...byKey.values()].sort((a, b) => b.length - a.length)) {
    if (list.length < 12) continue;
    // Neighbouring sizes of the same shape belong to it (a dot drawn a pixel larger).
    const members = all.filter(p => !repeated.has(p) && p.pixels.length <= n * 0.002 && Math.abs(Math.log2(p.pixels.length) - Math.log2(list[0].pixels.length)) <= 0.75 && Math.abs(Math.log2(p.box.width / p.box.height) - Math.log2(list[0].box.width / list[0].box.height)) <= 0.5);
    if (members.length < 12) continue;
    // A frame: the pieces along the four sides of their own rectangle (a few strays beside it do not move its sides).
    const centre = (p: Piece) => [p.box.x + p.box.width / 2, p.box.y + p.box.height / 2], xs = members.map(p => centre(p)[0]).sort((a, b) => a - b), ys = members.map(p => centre(p)[1]).sort((a, b) => a - b);
    const q = (v: number[], f: number) => v[Math.floor((v.length - 1) * f)], x0 = q(xs, 0.02), x1 = q(xs, 0.98), y0 = q(ys, 0.02), y1 = q(ys, 0.98), tol = Math.max(x1 - x0, y1 - y0) * 0.03;
    const onFrame = (p: Piece) => { const [cx, cy] = centre(p); return cx >= x0 - tol && cx <= x1 + tol && cy >= y0 - tol && cy <= y1 + tol && Math.min(Math.abs(cx - x0), Math.abs(x1 - cx), Math.abs(cy - y0), Math.abs(y1 - cy)) <= tol; };
    const frame = members.filter(onFrame), isFrame = x1 - x0 >= w * 0.5 && y1 - y0 >= h * 0.5 && frame.length >= members.length * 0.8;
    // A frame's strays go with what they are beside (dots on the leaves); a scatter stays together.
    const kept = isFrame ? frame : members;
    for (const p of kept) repeated.add(p);
    groups.push({ kind: isFrame ? 'border' : 'ornaments', pieces: kept });
  }
  // The other pieces, joined with the ones near them (one illustration of several drawn parts).
  const rest = all.filter(p => !repeated.has(p)), gap = Math.max(8, Math.round(Math.max(w, h) * 0.012)), parent = rest.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let a = 0; a < rest.length; a++) for (let b = a + 1; b < rest.length; b++) {
    const p = rest[a].box, q = rest[b].box;
    if (p.x - gap < q.x + q.width && q.x - gap < p.x + p.width && p.y - gap < q.y + q.height && q.y - gap < p.y + p.height) parent[find(a)] = find(b);
  }
  const clusters = new Map<number, Piece[]>();
  rest.forEach((p, i) => (clusters.get(find(i)) ?? clusters.set(find(i), []).get(find(i))!).push(p));
  for (const list of [...clusters.values()].sort((a, b) => b.reduce((s, p) => s + p.pixels.length, 0) - a.reduce((s, p) => s + p.pixels.length, 0))) {
    if (list.reduce((s, p) => s + p.pixels.length, 0) < 64) continue;
    groups.push({ kind: 'object', pieces: list });
  }
  stage('groups');
  const owner = new Int32Array(n);
  groups.forEach((g, gi) => { for (const p of g.pieces) for (const i of p.pixels) owner[i] = gi + 1; });
  // A border's dots where none is visible: hidden behind an illustration, or joined to it where they touch. A touching dot's
  // own pixels (its colours where it is drawn) go back to the border.
  const bi = groups.findIndex(g => g.kind === 'border');
  let border: BorderPlan | undefined;
  if (bi >= 0) {
    const dots = groups[bi].pieces, colourOf = (p: Piece) => [0, 1, 2].map(c => p.pixels.reduce((s, i) => s + rgb[i * 3 + c], 0) / p.pixels.length);
    const centres = dots.map(p => ({ cx: p.box.x + p.box.width / 2, cy: p.box.y + p.box.height / 2, colour: colourOf(p) })), { dots: grid, aligned } = borderGrid(centres);
    // A dot off the border's grid (an illustration's own dot beside it) goes with the nearest illustration.
    const objectsBoxes = groups.map((g, gi) => ({ gi, box: boxOf(g.pieces.flatMap(p => [p.box.y * w + p.box.x, (p.box.y + p.box.height - 1) * w + p.box.x + p.box.width - 1]), w) })).filter(o => groups[o.gi].kind === 'object');
    dots.forEach((p, k) => {
      if (aligned.has(k)) return;
      const c = centres[k], to = objectsBoxes.map(o => ({ gi: o.gi, d: Math.max(0, o.box.x - c.cx, c.cx - (o.box.x + o.box.width), o.box.y - c.cy, c.cy - (o.box.y + o.box.height)) })).sort((a, b) => a.d - b.d)[0];
      if (to && to.d <= gap * 3) for (const i of p.pixels) owner[i] = to.gi + 1;
    });
    const missing = grid.filter(g => !centres.some((c, k) => aligned.has(k) && Math.hypot(c.cx - g.cx, c.cy - g.cy) <= 3));
    for (const m of missing) {
      // Only a dot that is there (most of its shape in its colours where it should be): a hidden one keeps the pixels over it.
      const t = dots[m.template], tx = Math.round(t.box.x + t.box.width / 2), ty = Math.round(t.box.y + t.box.height / 2), hits: number[] = [];
      for (const i of t.pixels) {
        const x = i % w, y = (i - x) / w, X = m.cx + x - tx, Y = m.cy + y - ty;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (Math.max(...[0, 1, 2].map(c => Math.abs(rgb[j * 3 + c] - rgb[i * 3 + c]))) <= 36) hits.push(j);
      }
      if (hits.length >= t.pixels.length * 0.7) for (const j of hits) if (owner[j] && owner[j] !== bi + 1) owner[j] = bi + 1;
    }
    border = { id: bi + 1, missing: missing.map(m => ({ cx: m.cx, cy: m.cy, from: dots[m.template] })), dots: grid.length };
  }
  return cut(source, rgb, owner, groups.map(g => ({ kind: g.kind })), started, stage, border);
}
/** A border's dots to draw again (each from a visible one), and how many dots the border has in all. */
type BorderPlan = { id: number; missing: { cx: number; cy: number; from: { pixels: number[]; box: Box } }[]; dots: number };

/**
 * The artwork split along a decomposition's layers (the master's Seedream layers, mapped onto this picture): each layer's
 * shape cuts this picture's own pixels (a later layer over an earlier one), so the result is exact for any tint or size.
 */
export async function splitByLayers(source: Rgba, layers: { name: string; mask: Uint8Array }[], options: { log?: (line: string) => void } = {}): Promise<ArtworkSplit> {
  const started = Date.now(), n = source.width * source.height, owner = new Int32Array(n);
  layers.forEach((l, li) => { for (let i = 0; i < n; i++) if (l.mask[i]) owner[i] = li + 1; });
  return cut(source, flattenRgb(source), owner, layers.map(l => ({ kind: 'object' as const, name: l.name })), started, (what: string) => options.log?.(`${what}: ${Date.now() - started} ms`));
}

/**
 * Cuts the objects `owner` marks (1-based; 0 is the base) out of the picture: the base rebuilt behind them, a border made
 * whole, every object with its true transparency at its rim.
 */
async function cut(source: Rgba, rgb: Uint8Array, owner: Int32Array, groups: { kind: ArtworkObject['kind']; name?: string }[], started: number, stage: (what: string) => void, border?: BorderPlan): Promise<ArtworkSplit> {
  const { width: w, height: h } = source, n = w * h;
  if (!owner.some(Boolean)) return { base: await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(), objects: [], filledPercent: 0, trustedPercent: 100, rebuiltPercent: 100, borderDotsAdded: 0, reconstruction: { mean: 0, max: 0, visiblePercent: 0 }, durationMs: Date.now() - started };
  // A pixel between two parts of one illustration (a white stroke of it, the gap between its petals): the illustration's own,
  // unless a panel's pattern shows there (the background seen through a gap). Not between a border's dots.
  {
    const free = (o: number) => o && groups[o - 1].kind === 'object' && o !== border?.id, between: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (owner[i]) continue;
      const x = i % w, y = (i - x) / w;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        let a = 0, b = 0;
        for (let k = 1; k <= 3 && !a; k++) { const X = x + dx * k, Y = y + dy * k; if (X < 0 || Y < 0 || X >= w || Y >= h) break; a = owner[Y * w + X]; }
        if (!free(a)) continue;
        for (let k = 1; k <= 3 && !b; k++) { const X = x - dx * k, Y = y - dy * k; if (X < 0 || Y < 0 || X >= w || Y >= h) break; b = owner[Y * w + X]; }
        if (a === b) { between.push([i, a]); break; }
      }
    }
    const covered = Uint8Array.from(owner, v => (v ? 1 : 0)), first = levelsOf(rgb, w, h, covered), shows = patternShows(rgb, w, h, covered, first, between.map(([i]) => i));
    for (const [i, o] of between) if (!shows.has(i)) owner[i] = o;
  }
  // The drawn pixels, then each object's rim: 1 px, and the soft edge around it that is not the field's colour. A pixel
  // belongs to one object only.
  const drawn = Uint8Array.from(owner, v => (v ? 1 : 0));
  const next = (i: number) => { const x = i % w; return x > 0 && owner[i - 1] ? owner[i - 1] : x < w - 1 && owner[i + 1] ? owner[i + 1] : i >= w && owner[i - w] ? owner[i - w] : i + w < n && owner[i + w] ? owner[i + w] : 0; };
  { const add: [number, number][] = []; for (let i = 0; i < n; i++) { if (owner[i]) continue; const o = next(i); if (o) add.push([i, o]); } for (const [i, o] of add) owner[i] = o; }
  const union = new Uint8Array(n); for (let i = 0; i < n; i++) if (owner[i]) union[i] = 1;
  const halo = absorbHalo(rgb, union, w, h);
  for (let pass = 0; pass < 8; pass++) { let left = false; const add: [number, number][] = []; for (let i = 0; i < n; i++) { if (!halo[i] || owner[i]) continue; left = true; const o = next(i); if (o) add.push([i, o]); } for (const [i, o] of add) owner[i] = o; if (!left) break; }
  for (let i = 0; i < n; i++) union[i] = owner[i] ? 1 : 0;
  stage('edges');
  // What still is not the background (in its panel unlike the pattern's repeats, on its page not the page's colour), where it
  // touches an object: that object's (an illustration's white stroke over the pattern, its soft edge).
  const levels = levelsOf(rgb, w, h, union), residual = residualsOf(rgb, w, h, union, levels);
  stage(`levels ${JSON.stringify(levels.map(l => ({ ...l.rect, rule: l.offsets ? `repeat ${JSON.stringify(l.offsets)}` : l.plain ? 'plain' : 'none' })))}`);
  for (let pass = 0; pass < 4; pass++) {
    const add: [number, number][] = [];
    for (let i = 0; i < n; i++) { if (!residual[i] || owner[i]) continue; const o = next(i); if (o) add.push([i, o]); }
    if (!add.length) break;
    for (const [i, o] of add) { owner[i] = o; union[i] = 1; drawn[i] = 1; }
  }
  stage('residuals');
  // The base: from the template's own structure (its page and its panel's pattern); what that cannot rebuild, from the
  // clean background's fill around it. Every pixel outside the objects stays the picture's own.
  const rebuilt = fillLevels(rgb, w, h, union, levels), base = Buffer.from(rebuilt.out);
  let removed = 0, structural = 0, trusted = 100; const rest = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (union[i]) { removed++; if (rebuilt.filled[i]) structural++; else rest[i] = 1; }
  if (structural < removed) {
    const known = Buffer.alloc(n * 4); for (let i = 0; i < n; i++) { known[i * 4] = base[i * 3]; known[i * 4 + 1] = base[i * 3 + 1]; known[i * 4 + 2] = base[i * 3 + 2]; known[i * 4 + 3] = 255; }
    const clean = await cleanBackground({ data: known, width: w, height: h }, rest), fill = await sharp(clean.png).removeAlpha().raw().toBuffer();
    for (let i = 0; i < n; i++) if (rest[i]) for (let c = 0; c < 3; c++) base[i * 3 + c] = fill[i * 3 + c];
    trusted = clean.trustedPercent;
  }
  stage('base');
  // The colour of each object pixel's nearest inner pixel (drawn, not at its rim): the object's own colour at its rim.
  const inner = new Int32Array(n).fill(-1), depth = new Uint8Array(n), queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (!owner[i] || !drawn[i]) continue;
    const x = i % w, o = owner[i];
    if ((x > 0 && owner[i - 1] === o && drawn[i - 1]) && (x < w - 1 && owner[i + 1] === o && drawn[i + 1]) && (i >= w && owner[i - w] === o && drawn[i - w]) && (i + w < n && owner[i + w] === o && drawn[i + w])) { inner[i] = i; queue[tail++] = i; }
  }
  while (head < tail) {
    const i = queue[head++], x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < n && inner[j] < 0 && owner[j] === owner[i]) { inner[j] = inner[i]; depth[j] = Math.min(255, depth[i] + 1); queue[tail++] = j; }
  }
  // A rim pixel close to the object's inside (a thin line has none near: it stays as drawn).
  const rim = (i: number) => owner[i] && inner[i] !== i && inner[i] >= 0 && depth[i] <= 3;
  // Layers as RGBA over the whole canvas while they are made: the border first (its dots, then the hidden ones drawn again).
  const layer = groups.map(() => null as Buffer | null), get = (gi: number) => (layer[gi] ??= Buffer.alloc(n * 4));
  const behind = Buffer.from(base);
  const put = (gi: number, i: number, back: Buffer) => {
    const px = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]], L = get(gi);
    if (!rim(i)) { L[i * 4] = px[0]; L[i * 4 + 1] = px[1]; L[i * 4 + 2] = px[2]; L[i * 4 + 3] = 255; return; }
    const k = inner[i] >= 0 ? inner[i] : i, u = unmix(px, [back[i * 3], back[i * 3 + 1], back[i * 3 + 2]], [rgb[k * 3], rgb[k * 3 + 1], rgb[k * 3 + 2]]);
    L[i * 4] = u.rgb[0]; L[i * 4 + 1] = u.rgb[1]; L[i * 4 + 2] = u.rgb[2]; L[i * 4 + 3] = Math.round(u.alpha * 255);
  };
  let added = 0;
  if (border) {
    const bi = border.id - 1;
    for (let i = 0; i < n; i++) if (owner[i] === border.id) put(bi, i, base);
    // A hidden dot: the visible one's pixels (with their transparency), only where an illustration covers that place.
    const L = get(bi);
    for (const m of border.missing) {
      const t = m.from, tx = Math.round(t.box.x + t.box.width / 2), ty = Math.round(t.box.y + t.box.height / 2), r = 3;
      let drew = false;
      for (let y = t.box.y - r; y < t.box.y + t.box.height + r; y++) for (let x = t.box.x - r; x < t.box.x + t.box.width + r; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x, X = m.cx + x - tx, Y = m.cy + y - ty;
        if (X < 0 || Y < 0 || X >= w || Y >= h || !L[i * 4 + 3]) continue;
        const j = Y * w + X;
        if (!owner[j] || owner[j] === border.id || L[j * 4 + 3]) continue;
        L[j * 4] = L[i * 4]; L[j * 4 + 1] = L[i * 4 + 1]; L[j * 4 + 2] = L[i * 4 + 2]; L[j * 4 + 3] = L[i * 4 + 3]; drew = true;
      }
      if (drew) added++;
    }
    for (let i = 0; i < n; i++) { const a = L[i * 4 + 3] / 255; if (a) for (let c = 0; c < 3; c++) behind[i * 3 + c] = Math.round(L[i * 4 + c] * a + behind[i * 3 + c] * (1 - a)); }
  }
  for (let i = 0; i < n; i++) if (owner[i] && owner[i] !== border?.id) put(owner[i] - 1, i, behind);
  stage('layers');
  // The layers over each other, against the picture: how close the rebuilt layers come to it.
  const recon = Buffer.from(base);
  const over = (L: Buffer) => { for (let i = 0; i < n; i++) { const a = L[i * 4 + 3] / 255; if (a) for (let c = 0; c < 3; c++) recon[i * 3 + c] = Math.round(L[i * 4 + c] * a + recon[i * 3 + c] * (1 - a)); } };
  if (border && layer[border.id - 1]) over(layer[border.id - 1]!);
  layer.forEach((L, gi) => { if (L && gi !== (border ? border.id - 1 : -1)) over(L); });
  let sum = 0, max = 0, visible = 0;
  for (let i = 0; i < n * 3; i += 3) { const d = Math.max(Math.abs(recon[i] - rgb[i]), Math.abs(recon[i + 1] - rgb[i + 1]), Math.abs(recon[i + 2] - rgb[i + 2])); sum += d; if (d > max) max = d; if (d > 24) visible++; }
  const objects: ArtworkObject[] = [], names = new Map<string, number>();
  for (let gi = 0; gi < groups.length; gi++) {
    const L = layer[gi];
    if (!L) continue;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, pixels = 0;
    for (let i = 0; i < n; i++) if (L[i * 4 + 3]) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; pixels++; }
    if (!pixels) continue;
    const b = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }, crop = Buffer.alloc(b.width * b.height * 4);
    for (let y = 0; y < b.height; y++) L.copy(crop, y * b.width * 4, ((y + b.y) * w + b.x) * 4, ((y + b.y) * w + b.x + b.width) * 4);
    const g = groups[gi], place = placeName(b, w, h), label = g.name ?? (g.kind === 'border' ? 'Border' : g.kind === 'ornaments' ? `Repeated ornaments · ${place}` : `Artwork · ${place}`);
    const count = (names.get(label) ?? 0) + 1; names.set(label, count);
    objects.push({ name: count > 1 ? `${label} ${count}` : label, kind: g.kind, placement: b, pixels, png: await sharp(crop, { raw: { width: b.width, height: b.height, channels: 4 } }).png().toBuffer() });
  }
  // A name used more than once is numbered from 1.
  for (const o of objects) if ((names.get(o.name) ?? 0) > 1) o.name = `${o.name} 1`;
  return { base: await sharp(base, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(), objects, filledPercent: round(100 * removed / n, 2), trustedPercent: trusted, rebuiltPercent: removed ? round(100 * structural / removed) : 100,
    borderDotsAdded: added, reconstruction: { mean: round(sum / n, 3), max, visiblePercent: round(100 * visible / n, 3) }, durationMs: Date.now() - started };
}
