/**
 * The master's clean background as the artwork of its AI style variations. Local pixel work only (sharp), never a provider:
 *
 *   analyse  the grounds the master's content sat on, sampled in the clean background where its words and logos were (the
 *            field inside a frame, a white margin, …), and a grid of cells: which ground each matches, or drawn artwork
 *            (illustrations, borders, an old pill), with each cell's own colour (what is behind a line of text)
 *   frame    where it sits on a creative's canvas: whole and centred (`contain`), with a margin around it in another format
 *   derive   the picture a creative uses: scaled to its frame, its main field recoloured to the variation's tint (pattern,
 *            frame and illustrations kept as they are)
 *   backing  a logo crop whose edge is the master's field: that surrounding field (connected to the crop's edge) recoloured
 *            to the tint; pixels not connected to the edge (the logo itself) are never changed
 *
 * Nothing here is new artwork: it is the master's own clean background, placed and tinted.
 */
import sharp from 'sharp';
import type { MasterSnapshot } from '@frameflow/shared';

export const ARTWORK_PLACEMENTS = ['none', 'start', 'center', 'end'] as const;
export type ArtworkPlacement = typeof ARTWORK_PLACEMENTS[number];
type Rgb = [number, number, number];
type Size = { width: number; height: number };
/** A ground colour content sat on; the first one is the main field (where most words were). */
export interface ArtworkGround { color: string; tolerance: number; share: number }
export interface ArtworkInfo {
  width: number; height: number; grounds: ArtworkGround[];
  /** Row-major cells: the index of the ground a cell matches, or '.' where the artwork is drawn. */
  cols: number; rows: number; cells: string;
  /** Each cell's median colour (row-major): what is actually behind a point of drawn artwork. */
  colours: string[];
  /** Share of cells on a ground (not drawn). */
  openShare: number;
}
const LONG = 240, CELL = 6;

const rgb = (hex: string): Rgb => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hexOf = (c: readonly number[]) => `#${c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const dist = (d: ArrayLike<number>, i: number, c: Rgb) => Math.hypot(d[i] - c[0], d[i + 1] - c[1], d[i + 2] - c[2]);
const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const quantile = (v: number[], q: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0; };

export async function analyseArtwork(bytes: Buffer, snapshot: Pick<MasterSnapshot, 'canvas' | 'words' | 'logoSlots'>): Promise<ArtworkInfo> {
  const meta = await sharp(bytes).metadata(), width = meta.width ?? snapshot.canvas.width, height = meta.height ?? snapshot.canvas.height;
  const k = LONG / Math.max(width, height), w = Math.max(1, Math.round(width * k)), h = Math.max(1, Math.round(height * k));
  const { data } = await sharp(bytes).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const sx = w / snapshot.canvas.width, sy = h / snapshot.canvas.height;
  // One sample per element: the pixels where it was, which the clean background filled with the ground it sat on.
  const samples: { offsets: number[]; word: boolean }[] = [];
  const boxes = [...snapshot.words.filter(x => x.review.status !== 'rejected').map(x => ({ b: x.box, word: true })), ...snapshot.logoSlots.filter(l => l.review.status !== 'rejected').map(l => ({ b: l.box, word: false }))];
  for (const { b, word } of boxes) {
    const x0 = Math.max(0, Math.floor((b.x + b.width * 0.15) * sx)), x1 = Math.min(w, Math.ceil((b.x + b.width * 0.85) * sx));
    const y0 = Math.max(0, Math.floor((b.y + b.height * 0.15) * sy)), y1 = Math.min(h, Math.ceil((b.y + b.height * 0.85) * sy)), offsets: number[] = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) offsets.push((y * w + x) * 3);
    if (offsets.length) samples.push({ offsets, word });
  }
  // Cluster the samples' median colours into grounds (near-identical ones are one ground).
  const clusters: { c: Rgb; n: number; words: number; offsets: number[] }[] = [];
  for (const s of samples) {
    const m = [0, 1, 2].map(ch => quantile(s.offsets.map(o => data[o + ch]), 0.5)) as Rgb;
    const hit = clusters.find(cl => Math.hypot(cl.c[0] - m[0], cl.c[1] - m[1], cl.c[2] - m[2]) <= 28);
    if (hit) { const t = hit.n + s.offsets.length; hit.c = hit.c.map((v, ch) => (v * hit.n + m[ch] * s.offsets.length) / t) as Rgb; hit.n = t; hit.words += s.word ? s.offsets.length : 0; hit.offsets.push(...s.offsets); }
    else clusters.push({ c: m, n: s.offsets.length, words: s.word ? s.offsets.length : 0, offsets: [...s.offsets] });
  }
  const total = clusters.reduce((n, c) => n + c.n, 0) || 1;
  const kept = clusters.filter(c => c.n / total >= 0.03).sort((a, b) => b.words - a.words || b.n - a.n).slice(0, 6);
  const grounds = kept.map(cl => ({ c: cl.c, tol: Math.max(16, Math.min(64, quantile(cl.offsets.map(o => dist(data, o, cl.c)), 0.9) + 10)), share: cl.n / total }));
  const cols = Math.ceil(w / CELL), rows = Math.ceil(h / CELL);
  let cells = '', open = 0;
  const colours: string[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const votes = new Array(grounds.length).fill(0), channels: number[][] = [[], [], []];
    let n = 0;
    for (let y = r * CELL; y < Math.min(h, (r + 1) * CELL); y++) for (let x = c * CELL; x < Math.min(w, (c + 1) * CELL); x++) {
      n++;
      const o = (y * w + x) * 3;
      for (let ch = 0; ch < 3; ch++) channels[ch].push(data[o + ch]);
      let best = -1, bestD = Infinity;
      grounds.forEach((g, gi) => { const d = dist(data, o, g.c); if (d <= g.tol && d < bestD) { best = gi; bestD = d; } });
      if (best >= 0) votes[best]++;
    }
    const top = votes.reduce((bi, v, i) => (v > votes[bi] ? i : bi), 0);
    const isOpen = grounds.length > 0 && votes.reduce((a, b) => a + b, 0) >= n * 0.85;
    cells += isOpen ? String(top) : '.';
    colours.push(hexOf(channels.map(v => quantile(v, 0.5))));
    if (isOpen) open++;
  }
  return { width, height, grounds: grounds.map(g => ({ color: hexOf(g.c), tolerance: Math.round(g.tol), share: Math.round(g.share * 1000) / 1000 })), cols, rows, cells, colours, openShare: open / (cols * rows) };
}

/**
 * Where the artwork sits on a canvas, in canvas pixels (the drawn rectangle; beyond the canvas when it covers it).
 * `contain`: always whole (style variations keep every element of the master, so nothing may be cropped).
 */
export function artworkFrame(art: Size, canvas: Size, placement: Exclude<ArtworkPlacement, 'none'>, fit: 'auto' | 'contain' = 'auto') {
  const cover = fit === 'auto' && Math.abs(Math.log((canvas.width / canvas.height) / (art.width / art.height))) <= 0.13;
  const scale = cover ? Math.max(canvas.width / art.width, canvas.height / art.height) : Math.min(canvas.width / art.width, canvas.height / art.height);
  const width = art.width * scale, height = art.height * scale, at = (free: number) => (placement === 'start' ? 0 : placement === 'end' ? free : free / 2);
  return { cover, x: at(canvas.width - width), y: at(canvas.height - height), width, height };
}
/** Moves the main field's colour (and colours near it) to the target; other grounds and the drawn artwork stay. */
function shiftField(data: Buffer, channels: number, info: ArtworkInfo, target: Rgb): boolean {
  const field = rgb(info.grounds[0].color), delta = target.map((v, i) => v - field[i]), others = info.grounds.slice(1).map(g => ({ c: rgb(g.color), tol: g.tolerance }));
  if (Math.hypot(...delta) < 10) return false;
  const d0 = info.grounds[0].tolerance, d1 = d0 * 2;
  for (let i = 0; i < data.length; i += channels) {
    const d = dist(data, i, field);
    if (d >= d1 || others.some(o => { const e = dist(data, i, o.c); return e <= o.tol && e < d; })) continue;
    const wgt = d <= d0 ? 1 : (d1 - d) / (d1 - d0);
    for (let ch = 0; ch < 3; ch++) data[i + ch] = clampByte(data[i + ch] + wgt * delta[ch]);
  }
  return true;
}
/** The creative's picture of the artwork at its frame (box in canvas pixels), its field recoloured to `ground`. */
export async function deriveArtwork(bytes: Buffer, info: ArtworkInfo, canvas: Size, placement: Exclude<ArtworkPlacement, 'none'>, ground: string, fit: 'auto' | 'contain' = 'auto') {
  const f = artworkFrame(info, canvas, placement, fit);
  let image: ReturnType<typeof sharp>, box: { x: number; y: number; width: number; height: number };
  if (f.cover) {
    const s = f.width / info.width, left = Math.max(0, Math.round(-f.x / s)), top = Math.max(0, Math.round(-f.y / s));
    const width = Math.max(1, Math.min(info.width - left, Math.round(canvas.width / s))), height = Math.max(1, Math.min(info.height - top, Math.round(canvas.height / s)));
    image = sharp(bytes).extract({ left, top, width, height }).resize(canvas.width, canvas.height, { fit: 'fill' });
    box = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  } else {
    const width = Math.max(1, Math.round(f.width)), height = Math.max(1, Math.round(f.height));
    image = sharp(bytes).resize(width, height, { fit: 'fill' });
    box = { x: Math.round(f.x), y: Math.round(f.y), width, height };
  }
  const { data, info: raw } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const recoloured = shiftField(data, 3, info, rgb(ground));
  return { png: await sharp(data, { raw: { width: raw.width, height: raw.height, channels: 3 } }).png().toBuffer(), box, recoloured };
}
/** The median colour of the picture's outermost pixels: the colour that continues it beyond its edges (a margin around it). */
export async function edgeColour(png: Buffer): Promise<string> {
  const { data, info } = await sharp(png).resize(240, 240, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ring: number[] = [];
  for (let x = 0; x < info.width; x++) ring.push(x, (info.height - 1) * info.width + x);
  for (let y = 1; y < info.height - 1; y++) ring.push(y * info.width, y * info.width + info.width - 1);
  return hexOf([0, 1, 2].map(ch => quantile(ring.map(p => data[p * 3 + ch]), 0.5)));
}
/**
 * A logo crop's surrounding field (connected to the crop's edge, near the master's field colour) recoloured to `ground`.
 * Null when there is nothing to change: no field at the edge, the ground already matches, or the field-coloured part is
 * most of the crop (a logo in the field's own colour is left exactly as it is).
 */
export async function matchBacking(crop: Buffer, info: ArtworkInfo, ground: string): Promise<Buffer | null> {
  if (!info.grounds.length) return null;
  const field = rgb(info.grounds[0].color), target = rgb(ground), tol = info.grounds[0].tolerance * 1.3, soft = tol * 1.6;
  if (Math.hypot(target[0] - field[0], target[1] - field[1], target[2] - field[2]) < 10) return null;
  const { data, info: raw } = await sharp(crop).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = raw.width, H = raw.height, queue = fieldRegion(data, W, H, field, soft);
  if (!queue) return null;
  for (const p of queue) {
    const i = p * 4, d = dist(data, i, field), wgt = d <= tol ? 1 : (soft - d) / (soft - tol);
    for (let ch = 0; ch < 3; ch++) data[i + ch] = clampByte(data[i + ch] + wgt * (target[ch] - data[i + ch]));
  }
  return sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}
const borderOf = (W: number, H: number) => {
  const border: number[] = [];
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x);
  for (let y = 1; y < H - 1; y++) border.push(y * W, y * W + W - 1);
  return border;
};
/** The field-coloured pixels connected to a crop's edge (RGBA), or null when the crop has no such backing. */
function fieldRegion(data: Buffer, W: number, H: number, field: Rgb, soft: number): number[] | null {
  const like = (p: number) => data[p * 4 + 3] > 0 && dist(data, p * 4, field) <= soft, border = borderOf(W, H);
  // A backing shows at the edge (a pill crop touches it only at its sides); a logo with no field at its edge has none.
  if (border.filter(like).length < border.length * 0.2) return null;
  const seen = new Uint8Array(W * H), queue = border.filter(like);
  for (const p of queue) seen[p] = 1;
  for (let q = 0; q < queue.length; q++) {
    const p = queue[q], x = p % W;
    for (const n of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) if (n >= 0 && n < W * H && !seen[n] && like(n)) { seen[n] = 1; queue.push(n); }
  }
  // Mostly field-coloured: a logo in the field's own colour, left exactly as it is.
  return queue.length > W * H * 0.5 ? null : queue;
}
/**
 * What surrounds a logo crop. Field-backed: the master's field, matched to any new ground (matchBacking). Otherwise its
 * edge colour when that is one plain colour (a white card, say: the logo then needs a ground of that colour), or null
 * (transparent or mixed edges: no constraint).
 */
export async function cropEdge(crop: Buffer, info: ArtworkInfo): Promise<{ edge: string | null; fieldBacked: boolean }> {
  const { data, info: raw } = await sharp(crop).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), W = raw.width, H = raw.height;
  if (info.grounds.length && fieldRegion(data, W, H, rgb(info.grounds[0].color), info.grounds[0].tolerance * 2.08)) return { edge: null, fieldBacked: true };
  const opaque = borderOf(W, H).filter(p => data[p * 4 + 3] >= 200);
  if (opaque.length < (2 * (W + H) - 4) * 0.5) return { edge: null, fieldBacked: false };
  const m = [0, 1, 2].map(ch => quantile(opaque.map(p => data[p * 4 + ch]), 0.5)) as Rgb;
  const plain = opaque.filter(p => dist(data, p * 4, m) <= 30).length >= opaque.length * 0.7;
  return { edge: plain ? hexOf(m) : null, fieldBacked: false };
}
