/**
 * A text group's own lettering, cut from the template's original picture: the pixels where the original differs from
 * the prepared base (the same picture with its text removed), around the group's words. Drawn over that base it gives
 * back the original exactly (typeface, weight, spacing, and whatever the text removal left behind or filled wrongly
 * under it); as a layer of its own it can be moved, resized or hidden. Nothing is redrawn or estimated.
 */
import sharp from 'sharp';

export type Box = { x: number; y: number; width: number; height: number };

/** Undefined: the two pictures differ in size (never resampled), or nothing of the text differs from the base. */
export async function textArt(sourceImage: Buffer, basePng: Buffer, words: Box[]): Promise<{ png: Buffer; box: Box } | undefined> {
  const [sm, bm] = await Promise.all([sharp(sourceImage).metadata(), sharp(basePng).metadata()]);
  const W = bm.width ?? 0, H = bm.height ?? 0;
  if (!words.length || sm.width !== W || sm.height !== H) return undefined;
  // The words' area with a margin for strokes and descenders the detected boxes cut off.
  const heights = words.map(w => w.height).sort((a, b) => a - b), pad = Math.max(12, Math.round(heights[heights.length >> 1] * 0.3));
  const x0 = Math.max(0, Math.floor(Math.min(...words.map(w => w.x)) - pad)), y0 = Math.max(0, Math.floor(Math.min(...words.map(w => w.y)) - pad));
  const x1 = Math.min(W, Math.ceil(Math.max(...words.map(w => w.x + w.width)) + pad)), y1 = Math.min(H, Math.ceil(Math.max(...words.map(w => w.y + w.height)) + pad));
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return undefined;
  const region = { left: x0, top: y0, width: w, height: h };
  const [s, b] = await Promise.all([sharp(sourceImage).extract(region).removeAlpha().raw().toBuffer(), sharp(basePng).extract(region).removeAlpha().raw().toBuffer()]);
  // Where they differ (beyond compression noise), grown by 3 px so every letter keeps its smooth edge.
  const differ = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (Math.max(Math.abs(s[i * 3] - b[i * 3]), Math.abs(s[i * 3 + 1] - b[i * 3 + 1]), Math.abs(s[i * 3 + 2] - b[i * 3 + 2])) > 28) differ[i] = 1;
  const grown = new Uint8Array(w * h), R = 3;
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let hit = 0;
    for (let dy = -R; dy <= R && !hit; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -R; dx <= R; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && differ[yy * w + xx]) { hit = 1; break; } } }
    if (!hit) continue;
    grown[y * w + x] = 1; bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
  }
  if (bx1 < 0) return undefined;
  // The original's pixels, opaque inside, fading over the outermost pixel (it sits on the same background it was cut from).
  const cw = bx1 - bx0 + 1, ch = by1 - by0 + 1, out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = (by0 + y) * w + bx0 + x, o = (y * cw + x) * 4;
    if (!grown[i]) continue;
    let edge = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = bx0 + x + dx, yy = by0 + y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h || !grown[yy * w + xx]) { edge = true; break; } }
    out[o] = s[i * 3]; out[o + 1] = s[i * 3 + 1]; out[o + 2] = s[i * 3 + 2]; out[o + 3] = edge ? 128 : 255;
  }
  const png = await sharp(out, { raw: { width: cw, height: ch, channels: 4 } }).png().toBuffer();
  return { png, box: { x: x0 + bx0, y: y0 + by0, width: cw, height: ch } };
}

/**
 * The prepared base with each word's surroundings taken from the original itself: its own background pixels (a badge's
 * panel, a ribbon, a plate, the stripes), and only the letters filled, from the nearest background pixels of their row
 * (or column). The master's text removal can leave strokes behind or fill a panel with the wrong colour; this cannot.
 * Words whose letters cannot be told from their background keep the base as it is.
 */
export async function clearResidue(sourceImage: Buffer, basePng: Buffer, words: Box[]): Promise<{ png: Buffer; cleared: number }> {
  const [{ data: src, info: si }, { data, info }] = await Promise.all([sharp(sourceImage).removeAlpha().raw().toBuffer({ resolveWithObject: true }), sharp(basePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true })]);
  const W = info.width, H = info.height;
  if (si.width !== W || si.height !== H || !words.length) return { png: basePng, cleared: 0 };
  const px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), region = new Uint8Array(W * H), ink = new Uint8Array(W * H);
  const d = (i: number, c: number[]) => Math.hypot(src[i * 3] - c[0], src[i * 3 + 1] - c[1], src[i * 3 + 2] - c[2]);
  // Every word's area (with room for descenders and letters its box cut off) and its letters (2 px around, for their
  // smooth edges), all words first: one word's area never brings back another word's letters.
  const areas: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const w of words) {
    const split = twoColours(src, W, H, w);
    if (!split) continue;
    const a = { x0: Math.max(0, Math.floor(w.x - w.height * 0.25)), y0: Math.max(0, Math.floor(w.y - w.height * 0.3)), x1: Math.min(W - 1, Math.ceil(w.x + w.width + w.height * 0.25)), y1: Math.min(H - 1, Math.ceil(w.y + w.height * 1.4)) };
    areas.push(a);
    for (let y = a.y0; y <= a.y1; y++) for (let x = a.x0; x <= a.x1; x++) {
      const i = y * W + x; region[i] = 1;
      if (d(i, split.ink) >= d(i, split.back)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const yy = y + dy, xx = x + dx; if (yy >= a.y0 && yy <= a.y1 && xx >= a.x0 && xx <= a.x1) ink[yy * W + xx] = 1; }
    }
  }
  // The original's own background where it shows; the letters filled across their shorter way from it.
  for (let i = 0; i < W * H; i++) if (region[i] && !ink[i]) { for (let c = 0; c < 3; c++) px[i * 4 + c] = src[i * 3 + c]; px[i * 4 + 3] = 255; }
  let cleared = 0;
  for (const a of areas) for (let y = a.y0; y <= a.y1; y++) for (let x = a.x0; x <= a.x1; x++) {
    const i = y * W + x;
    if (ink[i] !== 1) continue;
    let l = x - 1, r = x + 1, u = y - 1, dn = y + 1;
    while (l >= 0 && ink[y * W + l] === 1) l--;
    while (r < W && ink[y * W + r] === 1) r++;
    while (u >= 0 && ink[u * W + x] === 1) u--;
    while (dn < H && ink[dn * W + x] === 1) dn++;
    const across = l >= 0 && r < W ? r - l : Infinity, down = u >= 0 && dn < H ? dn - u : Infinity;
    const [p, q, t] = across <= down && across < Infinity ? [y * W + l, y * W + r, (x - l) / (r - l)] : down < Infinity ? [u * W + x, dn * W + x, (y - u) / (dn - u)] : [-1, -1, 0];
    if (p < 0) continue;
    for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.round(px[p * 4 + c] * (1 - t) + px[q * 4 + c] * t);
    px[i * 4 + 3] = 255; ink[i] = 2; cleared++;
  }
  return { png: cleared ? await sharp(Buffer.from(px.buffer, px.byteOffset, px.length), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer() : basePng, cleared };
}

/** A word box's two main colours (k-means): the letters (the smaller part) and what is behind them; undefined when close. */
function twoColours(data: Buffer, W: number, H: number, w: Box): { ink: number[]; back: number[] } | undefined {
  const x0 = Math.max(0, Math.floor(w.x)), y0 = Math.max(0, Math.floor(w.y)), x1 = Math.min(W - 1, Math.ceil(w.x + w.width)), y1 = Math.min(H - 1, Math.ceil(w.y + w.height));
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000))), pts: number[][] = [];
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) { const i = (y * W + x) * 3; pts.push([data[i], data[i + 1], data[i + 2]]); }
  if (pts.length < 30) return undefined;
  const lum = (p: number[]) => p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11;
  let a = pts.reduce((m, p) => (lum(p) < lum(m) ? p : m)), b = pts.reduce((m, p) => (lum(p) > lum(m) ? p : m)), na = 0, nb = 0;
  for (let round = 0; round < 8; round++) {
    const sa = [0, 0, 0], sb = [0, 0, 0]; na = 0; nb = 0;
    for (const p of pts) { const near = Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]) <= Math.hypot(p[0] - b[0], p[1] - b[1], p[2] - b[2]); const s = near ? sa : sb; for (let c = 0; c < 3; c++) s[c] += p[c]; if (near) na++; else nb++; }
    if (!na || !nb) return undefined;
    a = sa.map(v => v / na); b = sb.map(v => v / nb);
  }
  if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 80) return undefined;
  return na < nb ? { ink: a, back: b } : { ink: b, back: a };
}

/**
 * Each word's ink colour as the original shows it (hex), or undefined when unclear: the word's box split into its two
 * main colours (letters and what is behind them); the letters are the smaller part.
 */
export async function inkColours(sourceImage: Buffer, words: Box[]): Promise<(string | undefined)[]> {
  const { data, info } = await sharp(sourceImage).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const hex = (c: number[]) => `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  return words.map(w => { const split = twoColours(data, info.width, info.height, w); return split ? hex(split.ink) : undefined; });
}
