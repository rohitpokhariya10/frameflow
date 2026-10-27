/**
 * What a master's clean background removes from the source: the ink of every line of replaceable text, every text plate
 * with its outline, and every logo slot. Nothing of the original text may be left to show behind new editable text, and
 * no artwork is removed that need not be:
 *
 *   text    by colour, around its line: every piece of ink of the line's colour that touches the line's box and lies within
 *           the reach of its letters (ascenders, i-dots, accents, descenders, a full stop just beside it), plus the soft
 *           anti-aliased edge (pixels that blend between the ink and the ground around it). A piece that runs on beyond
 *           that reach is artwork or another element: only its part inside the line's box goes
 *   plates  whole, with a margin for the outline's soft fringe
 *   logos   tiles (partner logo cards, QR codes) whole: the tile is the slot. A free-standing mark, a badge or a graphic
 *           area: only what differs from the ground around it, with what it encloses, so background inside its box (a
 *           margin, a frame, a pattern) is kept. Never beyond its box: a creative draws the slot from a crop of exactly
 *           that box, so anything removed outside it would be lost
 */
import type { Rgba } from '../pixels.js';
import { dominantColour } from './scan.js';

export interface RemovalLine { box: { x: number; y: number; width: number; height: number }; ink: string; lineHeight: number }
export interface RemovalPlate { box: { x: number; y: number; width: number; height: number; rotation?: number }; strokeWidth: number }
export interface RemovalLogo { box: { x: number; y: number; width: number; height: number }; category?: string }
/** Slots removed whole: the tile (a card, a code) is the replaceable thing. */
const TILES = new Set(['partner-logo', 'qr']);

type Rect = { x0: number; y0: number; x1: number; y1: number };
const parse = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const dist = (d: Buffer, i: number, c: number[]) => Math.max(Math.abs(d[i] - c[0]), Math.abs(d[i + 1] - c[1]), Math.abs(d[i + 2] - c[2]));
const cdist = (a: number[], b: number[]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/** Up to `most` ground colours of the ring between `inner` and `outer` (each at least `share` of it), colours near `skip` left out. */
function groundsOf(source: Rgba, inner: Rect, outer: Rect, skip?: number[], share = 0.12, most = 3): number[][] {
  const { width: w, data } = source, ring: number[][] = [];
  for (let y = outer.y0; y < outer.y1; y += 2) for (let x = outer.x0; x < outer.x1; x += 2) if (x < inner.x0 || x >= inner.x1 || y < inner.y0 || y >= inner.y1) { const i = (y * w + x) * 4; ring.push([data[i], data[i + 1], data[i + 2]]); }
  const ground = skip ? ring.filter(p => cdist(p, skip) > 60) : ring, out: number[][] = [];
  let rest = ground;
  while (rest.length >= Math.max(20, ground.length * share) && out.length < most) { const c = parse(dominantColour(rest)); out.push(c); rest = rest.filter(p => cdist(p, c) > 40); }
  return out;
}
/** A window's mask grown by r pixels (square). */
function dilate(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const row = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { let last = -1e9; for (let x = 0; x < W; x++) { if (m[y * W + x]) last = x; if (x - last <= r) row[y * W + x] = 1; } last = 1e9; for (let x = W - 1; x >= 0; x--) { if (m[y * W + x]) last = x; if (last - x <= r) row[y * W + x] = 1; } }
  for (let x = 0; x < W; x++) { let last = -1e9; for (let y = 0; y < H; y++) { if (row[y * W + x]) last = y; if (y - last <= r) out[y * W + x] = 1; } last = 1e9; for (let y = H - 1; y >= 0; y--) { if (row[y * W + x]) last = y; if (last - y <= r) out[y * W + x] = 1; } }
  return out;
}
/** Unmasked pixels of a window that its border cannot reach without crossing the mask (a mark's enclosed inside). */
function enclosed(m: Uint8Array, W: number, H: number): Uint8Array {
  const seen = new Uint8Array(W * H), stack: number[] = [];
  const push = (i: number) => { if (!m[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) { const i = stack.pop()!, x = i % W, y = (i - x) / W; if (x > 0) push(i - 1); if (x < W - 1) push(i + 1); if (y > 0) push(i - W); if (y < H - 1) push(i + W); }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (!m[i] && !seen[i]) out[i] = 1;
  return out;
}

export function removalMask(source: Rgba, input: { lines: RemovalLine[]; plates: RemovalPlate[]; logos: RemovalLogo[] }): Uint8Array {
  const { width: w, height: h, data } = source, mask = new Uint8Array(w * h);
  const rect = (b: { x: number; y: number; width: number; height: number }, l: number, t = l, r = l, bt = t): Rect =>
    ({ x0: Math.max(0, Math.floor(b.x - l)), y0: Math.max(0, Math.floor(b.y - t)), x1: Math.min(w, Math.ceil(b.x + b.width + r)), y1: Math.min(h, Math.ceil(b.y + b.height + bt)) });
  const paint = (local: Uint8Array, win: Rect) => { const W = win.x1 - win.x0; for (let y = win.y0; y < win.y1; y++) for (let x = win.x0; x < win.x1; x++) if (local[(y - win.y0) * W + x - win.x0]) mask[y * w + x] = 1; };

  for (const line of input.lines) {
    const lh = Math.max(4, line.lineHeight), ink = parse(line.ink), box = line.box;
    const inner = rect(box, Math.min(12, Math.max(3, lh * 0.06)));
    // The reach of the line's letters beyond its box (in proportion, capped: a large line's box is already exact, and
    // outlines of artwork near it share black text's colour), and a margin for their soft edge.
    const up = Math.min(lh * 0.5, 40), down = Math.min(lh * 0.45, 36), side = Math.min(lh * 0.3, 24);
    const reach = rect(box, side, up, side, down), grow = Math.min(6, Math.max(2, Math.round(lh * 0.05))), edge = grow + Math.min(8, Math.max(4, Math.round(lh * 0.08)));
    const win = { x0: Math.max(0, reach.x0 - edge), y0: Math.max(0, reach.y0 - edge), x1: Math.min(w, reach.x1 + edge), y1: Math.min(h, reach.y1 + edge) };
    const W = win.x1 - win.x0, H = win.y1 - win.y0;
    if (W <= 0 || H <= 0) continue;
    // The ground: colours around the reach (text of the line's own colour nearby is not ground).
    const grounds = groundsOf(source, reach, rect(box, side + 8, up + 8, side + 8, down + 8), ink);
    const inkLike = (gi: number) => { const dInk = dist(data, gi, ink); return dInk <= 70 || dInk < (grounds.length ? Math.min(...grounds.map(g => dist(data, gi, g))) : 255); };
    // Ink pieces inside the reach (4-connected): kept whole when they touch the box and end within the reach; small marks
    // (a dot, an accent, a full stop) beside or above the letters too; anything running on past the reach only inside the box.
    const comp = new Int32Array(W * H).fill(-1), local = new Uint8Array(W * H);
    const inReach = (x: number, y: number) => x >= reach.x0 && x < reach.x1 && y >= reach.y0 && y < reach.y1;
    let next = 0;
    for (let sy = reach.y0; sy < reach.y1; sy++) for (let sx = reach.x0; sx < reach.x1; sx++) {
      const s = (sy - win.y0) * W + sx - win.x0;
      if (comp[s] !== -1 || !inkLike((sy * w + sx) * 4)) continue;
      const id = next++, pixels: number[] = [s];
      let x0 = sx, y0 = sy, x1 = sx, y1 = sy, border = false, inBox = false;
      comp[s] = id;
      for (let k = 0; k < pixels.length; k++) {
        const p = pixels[k], px = p % W + win.x0, py = Math.floor(p / W) + win.y0;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (px === reach.x0 || px === reach.x1 - 1 || py === reach.y0 || py === reach.y1 - 1) border = true;
        if (px >= inner.x0 && px < inner.x1 && py >= inner.y0 && py < inner.y1) inBox = true;
        for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
          if (!inReach(nx, ny)) continue;
          const q = (ny - win.y0) * W + nx - win.x0;
          if (comp[q] === -1 && inkLike((ny * w + nx) * 4)) { comp[q] = id; pixels.push(q); }
        }
      }
      const mark = !inBox && !border && y1 - y0 + 1 <= Math.min(lh * 0.5, 40) && x1 - x0 + 1 <= Math.min(lh * 0.7, 48) && x0 >= box.x - side && x1 <= box.x + box.width + side;
      if ((inBox && !border) || mark) for (const p of pixels) local[p] = 1;
      else if (inBox) for (const p of pixels) { const px = p % W + win.x0, py = Math.floor(p / W) + win.y0; if (px >= inner.x0 && px < inner.x1 && py >= inner.y0 && py < inner.y1) local[p] = 1; }
    }
    if (!local.some(Boolean)) continue;
    // The soft edge: the ink grown a little, and around it every pixel that blends between the ink and its ground (even a
    // faint blend: JPEG keeps a halo of rings a few levels off the ground, a ghost of the letters).
    const grown = dilate(local, W, H, grow), band = dilate(local, W, H, edge);
    for (let i = 0; i < W * H; i++) {
      if (grown[i] || !band[i]) continue;
      const gi = ((Math.floor(i / W) + win.y0) * w + i % W + win.x0) * 4, pixel = [data[gi], data[gi + 1], data[gi + 2]];
      let g = grounds[0], dg = Infinity;
      for (const c of grounds) { const d = cdist(pixel, c); if (d < dg) { dg = d; g = c; } }
      const span = g ? cdist(g, ink) : 0;
      if (g && span >= 40 && dg >= Math.max(4, span * 0.02) && cdist(pixel, ink) <= span * 1.05) grown[i] = 1;
    }
    paint(grown, win);
  }
  // A plate's outline has a soft fringe beyond its measured width: a wide margin keeps none of it (the fill is exact there).
  for (const p of input.plates) { const r = rect(p.box, Math.max(6, p.strokeWidth * 2 + 5)); for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) mask[y * w + x] = 1; }
  for (const l of input.logos) {
    const r = rect(l.box, 3), W = r.x1 - r.x0, H = r.y1 - r.y0;
    const whole = () => { for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) mask[y * w + x] = 1; };
    if (W <= 0 || H <= 0) continue;
    if (!l.category || TILES.has(l.category)) { whole(); continue; }
    // The ground: the one or two colours that most of a ring around the slot is (a frame's dots or a flourish nearby are not).
    const past = Math.round(Math.min(l.box.width, l.box.height) * 0.15), win = rect(l.box, 3 + past), ringW = Math.max(6, Math.min(24, Math.round(Math.min(l.box.width, l.box.height) * 0.12)));
    const grounds = groundsOf(source, win, rect(l.box, 3 + past + ringW), undefined, 0.25, 2);
    if (!grounds.length) { whole(); continue; }
    const WW = win.x1 - win.x0, WH = win.y1 - win.y0, differs = new Uint8Array(WW * WH);
    for (let y = win.y0; y < win.y1; y++) for (let x = win.x0; x < win.x1; x++) { const gi = (y * w + x) * 4; if (Math.min(...grounds.map(g => dist(data, gi, g))) > 28) differs[(y - win.y0) * WW + x - win.x0] = 1; }
    const local = new Uint8Array(W * H);
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (differs[(y - win.y0) * WW + x - win.x0]) local[(y - r.y0) * W + x - r.x0] = 1;
    const inside = enclosed(local, W, H);
    for (let i = 0; i < W * H; i++) if (inside[i]) local[i] = 1;
    const grown = dilate(local, W, H, 2);
    paint(grown, r);
  }
  return mask;
}
