/**
 * The creatives on a reference sheet (a design tool's export of several artboards on a plain gutter): each one's exact
 * rectangle, so one of them can be chosen and cropped without resampling. A single creative (no gutter around several
 * rectangles) is not a sheet. Local pixel work only.
 */
import type { PixelRect } from '@frameflow/shared';
import type { Rgba } from '../pixels.js';

export interface SheetCreatives { sheet: boolean; gutter: number[] | null; boxes: PixelRect[] }

export function findSheetCreatives(source: Rgba): SheetCreatives {
  const { width: w, height: h, data } = source, at = (x: number, y: number) => (y * w + x) * 4;
  // The gutter: the colour nearly all of the picture's own edge has.
  const counts = new Map<number, { n: number; c: number[] }>();
  let edge = 0;
  for (let x = 0; x < w; x += 2) for (const y of [0, 1, h - 2, h - 1]) { const i = at(x, y), k = (data[i] >> 3 << 10) | (data[i + 1] >> 3 << 5) | (data[i + 2] >> 3); const e = counts.get(k) ?? counts.set(k, { n: 0, c: [data[i], data[i + 1], data[i + 2]] }).get(k)!; e.n++; edge++; }
  for (let y = 0; y < h; y += 2) for (const x of [0, 1, w - 2, w - 1]) { const i = at(x, y), k = (data[i] >> 3 << 10) | (data[i + 1] >> 3 << 5) | (data[i + 2] >> 3); const e = counts.get(k) ?? counts.set(k, { n: 0, c: [data[i], data[i + 1], data[i + 2]] }).get(k)!; e.n++; edge++; }
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  if (!top || top.n < edge * 0.9) return { sheet: false, gutter: null, boxes: [] };
  const g = top.c, gutter = (x: number, y: number) => { const i = at(x, y); return Math.abs(data[i] - g[0]) <= 8 && Math.abs(data[i + 1] - g[1]) <= 8 && Math.abs(data[i + 2] - g[2]) <= 8; };
  // Content cells (4 px), then their connected rectangles.
  const s = 4, W = Math.ceil(w / s), H = Math.ceil(h / s), cell = new Uint8Array(W * H);
  for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) { let c = 0, n = 0; for (let y = cy * s; y < Math.min(h, cy * s + s); y++) for (let x = cx * s; x < Math.min(w, cx * s + s); x++) { n++; if (!gutter(x, y)) c++; } cell[cy * W + cx] = c * 2 > n ? 1 : 0; }
  const seen = new Uint8Array(W * H), found: PixelRect[] = [];
  for (let i = 0; i < W * H; i++) {
    if (!cell[i] || seen[i]) continue;
    const stack = [i]; seen[i] = 1;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (stack.length) {
      const j = stack.pop()!, x = j % W, y = (j - x) / W;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, j - W, j + W]) if (k >= 0 && k < W * H && cell[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
    }
    found.push({ x: x0 * s, y: y0 * s, width: Math.min(w, (x1 + 1) * s) - x0 * s, height: Math.min(h, (y1 + 1) * s) - y0 * s });
  }
  // Creatives, not the sheet's own captions: large rectangles only, each a solid artboard (a row of logo cards on a white
  // page, with the page between them, is not one).
  const solid = (b: PixelRect) => { let n = 0, c = 0; for (let y = b.y; y < b.y + b.height; y += 4) for (let x = b.x; x < b.x + b.width; x += 4) { n++; if (!gutter(x, y)) c++; } return n ? c / n : 0; };
  const big = found.filter(b => b.width >= 128 && b.height >= 128 && b.width * b.height >= w * h * 0.04 && solid(b) >= 0.9);
  // Each side exact to the pixel: the first row or column inward that is mostly not the gutter.
  const share = (x0: number, y0: number, x1: number, y1: number) => { let n = 0, c = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { n++; if (!gutter(x, y)) c++; } return n ? c / n : 0; };
  const boxes = big.map(b => {
    let x0 = Math.max(0, b.x - s), x1 = Math.min(w, b.x + b.width + s), y0 = Math.max(0, b.y - s), y1 = Math.min(h, b.y + b.height + s);
    while (x0 < x1 - 1 && share(x0, y0, x0 + 1, y1) < 0.3) x0++;
    while (x1 > x0 + 1 && share(x1 - 1, y0, x1, y1) < 0.3) x1--;
    while (y0 < y1 - 1 && share(x0, y0, x1, y0 + 1) < 0.3) y0++;
    while (y1 > y0 + 1 && share(x0, y1 - 1, x1, y1) < 0.3) y1--;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }).sort((a, b) => (Math.abs(a.y - b.y) < 24 ? a.x - b.x : a.y - b.y));
  // Several artboards (one rectangle on a margin is a creative with a frame, not a sheet).
  const sheet = boxes.length >= 2;
  return { sheet, gutter: g, boxes };
}
