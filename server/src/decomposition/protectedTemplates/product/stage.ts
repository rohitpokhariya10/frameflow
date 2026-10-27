/**
 * The stage in new artwork, and the products and characters seated on it.
 *
 *   findStage    the podium or platform the artwork drew for the products: an ellipse (its top surface seen from a
 *                little above) whose back rim and front rim both show as edges, with a smoother top between them. Found
 *                by a coarse-to-fine search over (centre, half-width, top-surface depth) on the edge map, inside the
 *                area the layout planned for the products. Null when nothing stage-like is there.
 *   seatOnStage  the product group (its arrangement kept) scaled to at most 3/4 of the stage's width and standing on its
 *                top surface a little in front of its middle; the character beside it, nearer (its feet at the front
 *                of the stage) and in front of it, at the template's own character-to-products height ratio; a soft
 *                contact shadow under each, their own layers.
 */
import sharp from 'sharp';
import type { ProductCreative, ProductCreativeObject } from '@frameflow/shared';

export interface Stage { cx: number; cy: number; a: number; b: number; score: number }
type Box = { x: number; y: number; width: number; height: number };

/** The stage in a picture, searched in `area` (canvas pixels). */
export async function findStage(png: Buffer, area: Box): Promise<Stage | null> {
  const meta = await sharp(png).metadata(), W0 = meta.width!, H0 = meta.height!, k = Math.min(1, 320 / Math.max(W0, H0));
  const W = Math.max(1, Math.round(W0 * k)), H = Math.max(1, Math.round(H0 * k));
  const { data } = await sharp(png).removeAlpha().resize(W, H).raw().toBuffer({ resolveWithObject: true });
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2];
  // Vertical edge strength (any direction of change), and a softened copy for the coarse search.
  const G = new Float32Array(W * H);
  for (let y = 2; y < H - 2; y++) for (let x = 0; x < W; x++) { const i = y * W + x; G[i] = Math.abs(L[i + W] + L[i + 2 * W] - L[i - W] - L[i - 2 * W]) / 2; }
  const S = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 0; x < W; x++) { const i = y * W + x; S[i] = Math.max(G[i - W], G[i], G[i + W]); }
  const ax0 = Math.max(0, area.x * k), ax1 = Math.min(W, (area.x + area.width) * k), ay0 = Math.max(2, area.y * k), ay1 = Math.min(H - 3, (area.y + area.height) * k);
  const at = (map: Float32Array, x: number, y: number) => { const X = Math.round(x), Y = Math.round(y); return X < 0 || Y < 2 || X >= W || Y >= H - 2 ? 0 : map[Y * W + X]; };
  const score = (map: Float32Array, cx: number, cy: number, a: number, b: number) => {
    let front = 0, back = 0, mid = 0, n = 0;
    for (let u = -0.88; u <= 0.88; u += 0.04) {
      const x = cx + u * a, r = Math.sqrt(1 - u * u) * b;
      front += at(map, x, cy + r); back += at(map, x, cy - r); mid += at(map, x, cy); n++;
    }
    // Both rims must be edges (the weaker one counts most), the top surface between them calmer.
    return (Math.min(front, back) * 1.5 + Math.max(front, back) * 0.5 - mid * 0.8) / n;
  };
  let best: Stage | null = null;
  const minA = Math.max(10, (ax1 - ax0) * 0.28), maxA = Math.max(minA + 1, (ax1 - ax0) * 0.62);
  for (let a = minA; a <= maxA; a += 4) for (let cx = ax0 + a * 0.8; cx <= ax1 - a * 0.8; cx += 3)
    for (let b = 3; b <= Math.max(4, H * 0.07); b += 1) for (let cy = Math.max(ay0 + b, H * 0.3); cy <= ay1 - b; cy += 1.5) {
      const s = score(S, cx, cy, a, b);
      if (!best || s > best.score) best = { cx, cy, a, b, score: s };
    }
  if (!best) return null;
  // A stage seen from a little above is a top surface on a front band: when the ellipse found is the band (its back rim
  // is the top surface's front rim), the surface is the ellipse resting on it (same centre, front rim on that back rim).
  const found: Stage = best;
  let upper: Stage | null = null;
  for (let a = found.a * 0.85; a <= Math.min(maxA * 1.2, found.a * 1.7); a += 3) for (let cx = found.cx - found.a * 0.12; cx <= found.cx + found.a * 0.12; cx += 3)
    for (let b = Math.max(3, found.b * 0.5); b <= found.b * 2.2; b += 1) {
      const cy = found.cy - found.b - b;
      if (cy - b < ay0 - 1) continue;
      const s = score(S, cx, cy, a, b);
      if (!upper || s > upper.score) upper = { cx, cy, a, b, score: s };
    }
  if (upper && upper.score >= found.score * 0.55) best = upper;
  // Refined on the sharp edge map around the coarse answer.
  let fine = { ...best, score: score(G, best.cx, best.cy, best.a, best.b) };
  for (let a = best.a - 4; a <= best.a + 4; a += 1) for (let cx = best.cx - 3; cx <= best.cx + 3; cx += 1) for (let b = Math.max(2, best.b - 1.5); b <= best.b + 1.5; b += 0.5) for (let cy = best.cy - 2; cy <= best.cy + 2; cy += 0.5) {
    const s = score(G, cx, cy, a, b); if (s > fine.score) fine = { cx, cy, a, b, score: s };
  }
  // A stage is a clear ellipse: strong rims (well above the picture's ordinary edges), wide and flat.
  let total = 0, count = 0; for (let y = Math.round(ay0); y < ay1; y++) for (let x = Math.round(ax0); x < ax1; x++) { total += G[y * W + x]; count++; }
  const ordinary = total / Math.max(1, count);
  if (fine.score < Math.max(6, ordinary * 2.2) || fine.a / fine.b < 4) return null;
  return { cx: fine.cx / k, cy: fine.cy / k, a: fine.a / k, b: fine.b / k, score: Math.round(fine.score * 10) / 10 };
}

/** A soft contact shadow (an elliptical blur of dark), as a transparent picture. */
export async function shadowPng(width: number, height: number): Promise<Buffer> {
  const w = Math.max(8, Math.round(width)), h = Math.max(4, Math.round(height));
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><radialGradient id="s"><stop offset="0" stop-color="#000" stop-opacity="0.42"/><stop offset="0.6" stop-color="#000" stop-opacity="0.2"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs><ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="url(#s)"/></svg>`)).png().toBuffer();
}

/**
 * The products (as one group) and characters seated on a stage. `ratio`: the template's character height over its
 * product group's height (their sizes stay true to each other); `ceiling`: the highest the products may reach (the
 * layout's text above them). Returns the placements of the contact shadows to add.
 */
export function seatOnStage(c: ProductCreative, stage: Stage, ratio: number, ceiling: number, lane: { x0: number; x1: number } = { x0: 0, x1: c.canvas.width }): { group?: Box; character?: Box } {
  const products = c.objects.filter(o => o.kind === 'product' && !o.hidden), characters = c.objects.filter(o => o.kind === 'character' && !o.hidden);
  const out: { group?: Box; character?: Box } = {};
  const floor = stage.cy + stage.b * 0.35, front = Math.min(c.canvas.height - 2, stage.cy + stage.b * 0.92);
  let group: Box | undefined;
  if (products.length) {
    const x0 = Math.min(...products.map(o => o.box.x)), y0 = Math.min(...products.map(o => o.box.y)), x1 = Math.max(...products.map(o => o.box.x + o.box.width)), y1 = Math.max(...products.map(o => o.box.y + o.box.height));
    // At most 3/4 of the stage's width, below the text above, and (with a character) leaving room for it in the lane.
    const room = (lane.x1 - lane.x0) * (characters.length ? 0.8 : 0.98);
    const s = Math.min(1.25 * Math.min(c.canvas.width, c.canvas.height) / Math.max(1, y1 - y0), (stage.a * 1.5) / Math.max(1, x1 - x0), (floor - ceiling) / Math.max(1, y1 - y0), room / Math.max(1, x1 - x0));
    const width = (x1 - x0) * s, height = (y1 - y0) * s;
    // Beside a character the group moves a little to the side the character is not on; always inside the lane.
    const side = characters.length ? Math.sign((characters[0].box.x + characters[0].box.width / 2) - (x0 + x1) / 2) || -1 : 0;
    let cx = Math.min(stage.cx + stage.a - width / 2, Math.max(stage.cx - stage.a + width / 2, stage.cx - side * stage.a * 0.14));
    cx = Math.min(lane.x1 - width / 2, Math.max(lane.x0 + width / 2, cx));
    const left = cx - width / 2, top = floor - height;
    for (const o of products) o.box = { x: Math.round(left + (o.box.x - x0) * s), y: Math.round(top + (o.box.y - y0) * s), width: Math.max(1, Math.round(o.box.width * s)), height: Math.max(1, Math.round(o.box.height * s)) };
    group = { x: left, y: top, width, height }; out.group = group;
  }
  for (const ch of characters) {
    const aspect = ch.box.width / Math.max(1, ch.box.height);
    let height = group ? group.height * ratio : (front - ceiling) * 0.85;
    height = Math.min(height, (front - ceiling) * 0.98);
    const width = height * aspect;
    const onLeft = !group || ch.box.x + ch.box.width / 2 <= group.x + group.width / 2;
    let w = width, h = height;
    let x = group ? (onLeft ? group.x - w * 0.78 : group.x + group.width - w * 0.22) : stage.cx - w / 2;
    // Inside the lane (never into the text column); when it does not fit beside the products, smaller, overlapping them a little more.
    const free = group ? (onLeft ? group.x + w * 0.35 - lane.x0 : lane.x1 - (group.x + group.width - w * 0.35)) : lane.x1 - lane.x0;
    if (w > free && free > 0) { const k = Math.max(0.55, free / w); w *= k; h *= k; x = group ? (onLeft ? group.x - w * 0.65 : group.x + group.width - w * 0.35) : x; }
    x = Math.max(lane.x0, Math.min(lane.x1 - w, x));
    ch.box = { x: Math.round(x), y: Math.round(front - h), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
    // Nearer than the products (its feet lower on the stage): drawn in front of them.
    ch.z = Math.max(0, ...products.map(p => p.z)) + 1;
    out.character = { ...ch.box };
  }
  return out;
}

/** The shadow layers (decorations under everything else on the stage). */
export function shadowObject(id: string, label: string, file: string, sha256: string, box: Box, size: { width: number; height: number }): ProductCreativeObject {
  return { id, objectId: null, kind: 'decoration', label, asset: { kind: 'upload', file, sha256, width: size.width, height: size.height, background: 'transparent' }, box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }, hidden: false, z: 0 };
}
