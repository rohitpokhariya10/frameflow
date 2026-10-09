/**
 * Where a variant's products go on its own canvas (a set made for an aspect ratio):
 *
 *   placeGroup     the product group as ONE unit — its products keep their arrangement, overlaps and proportions — at
 *                  the concept's position and share of the canvas, inside a safe margin and clear of the concept's open
 *                  space, scaled down when the canvas needs it and never enlarged past the source's own pixels
 *   placeProducts  the source's own product pixels (and each product's mask) moved there: one uniform resample when the
 *                  group must shrink, an exact copy otherwise. Pixels outside every mask are never carried: the canvas
 *                  holds only the products and a plain fill the model paints over.
 */
import sharp from 'sharp';
import type { ConceptComposition } from '@frameflow/shared';
import { pushPull } from '../outerBackground.js';
import { band, maskBox, type PixelBox, type Raster } from './variantCompose.js';

/** The margin kept clear on every side, and the share of the canvas a concept's open space takes. */
export const SAFE_MARGIN = 0.05, OPEN_SPACE = 0.3;
/** Where a concept without its own composition puts the products: centred, a little low, filling about 60%. */
export const DEFAULT_COMPOSITION: ConceptComposition = { x: 0.5, y: 0.56, scale: 0.62, copySpace: 'none' };
/** Which edges of the source the product group touches (a figure or product the frame cuts off). */
export type FrameEdges = { top: boolean; bottom: boolean; left: boolean; right: boolean };
export const touchedEdges = (group: PixelBox, source: { width: number; height: number }): FrameEdges => {
  const t = Math.max(2, Math.round(0.01 * Math.max(source.width, source.height)));
  return { top: group.y <= t, bottom: group.y + group.height >= source.height - t, left: group.x <= t, right: group.x + group.width >= source.width - t };
};
export type GroupPlacement = { scale: number; box: PixelBox };
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/**
 * The group's box on the canvas, and its scale (≤ 1) against its source pixels. A group the source's frame cuts off
 * stays against the same canvas edges, so the cut never floats inside the new picture.
 */
export function placeGroup(group: PixelBox, canvas: { width: number; height: number }, composition: ConceptComposition, edges: FrameEdges = { top: false, bottom: false, left: false, right: false }): GroupPlacement {
  const mx = Math.round(canvas.width * SAFE_MARGIN), my = Math.round(canvas.height * SAFE_MARGIN);
  let left = edges.left ? 0 : mx, top = edges.top ? 0 : my, right = canvas.width - (edges.right ? 0 : mx), bottom = canvas.height - (edges.bottom ? 0 : my);
  const open = composition.copySpace;
  if (open === 'top') top = Math.max(top, Math.round(canvas.height * OPEN_SPACE));
  if (open === 'bottom') bottom = Math.min(bottom, Math.round(canvas.height * (1 - OPEN_SPACE)));
  if (open === 'left') left = Math.max(left, Math.round(canvas.width * OPEN_SPACE));
  if (open === 'right') right = Math.min(right, Math.round(canvas.width * (1 - OPEN_SPACE)));
  // The concept's share of the canvas, limited by the free area, and never more than the source's own size.
  const want = composition.scale * Math.min(canvas.width / group.width, canvas.height / group.height);
  const fit = Math.min((right - left) / group.width, (bottom - top) / group.height);
  const scale = Math.min(1, want, fit);
  const width = Math.max(1, Math.round(group.width * scale)), height = Math.max(1, Math.round(group.height * scale));
  let x = Math.round(clamp(composition.x * canvas.width - width / 2, left, right - width)), y = Math.round(clamp(composition.y * canvas.height - height / 2, top, bottom - height));
  if (edges.bottom) y = canvas.height - height; else if (edges.top) y = 0;
  if (edges.left) x = 0; else if (edges.right) x = canvas.width - width;
  return { scale: Math.round(scale * 10000) / 10000, box: { x, y, width, height } };
}

/** The products' group box in the source: every product's mask together. */
export function groupBox(masks: Uint8Array[], width: number, height: number): PixelBox {
  const all = new Uint8Array(width * height);
  for (const m of masks) for (let i = 0; i < all.length; i++) if (m[i] > all[i]) all[i] = m[i];
  const { box } = maskBox(all, width, height, 1);
  if (!box) throw new Error('The products\' masks are empty.');
  return box;
}

/**
 * The source's product pixels and masks moved onto a canvas of `canvas` size at `placement`. Before a resample, every
 * pixel outside the products is replaced by its nearest product colour, so no old background bleeds into the edges.
 */
export async function placeProducts(source: Raster, masks: Uint8Array[], group: PixelBox, placement: GroupPlacement, canvas: { width: number; height: number }, fill: [number, number, number]) {
  const { width: W, height: H } = canvas, { box } = placement, n = W * H, gw = group.width, gh = group.height;
  // The group's crop: product pixels kept, everything else padded with the nearest product colour.
  const crop = new Float32Array(gw * gh * 3), inside = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const s = (group.y + y) * source.width + (group.x + x), i = y * gw + x;
    let a = 0; for (const m of masks) a = Math.max(a, m[s]);
    if (a > 0) inside[i] = 1;
    for (let c = 0; c < 3; c++) crop[i * 3 + c] = source.rgb[s * 3 + c];
  }
  const padded = pushPull(crop, inside, gw, gh);
  const cropRgb = Buffer.alloc(gw * gh * 3);
  for (let i = 0; i < gw * gh; i++) for (let c = 0; c < 3; c++) cropRgb[i * 3 + c] = inside[i] ? crop[i * 3 + c] : Math.max(0, Math.min(255, Math.round(padded[i * 3 + c])));
  const exact = box.width === gw && box.height === gh;
  const rgb = exact ? cropRgb : (await sharp(cropRgb, { raw: { width: gw, height: gh, channels: 3 } }).resize(box.width, box.height, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
  const placedMasks: Uint8Array[] = [];
  for (const m of masks) {
    const own = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) own[y * gw + x] = m[(group.y + y) * source.width + (group.x + x)];
    const scaled = exact ? own : await band(sharp(Buffer.from(own), { raw: { width: gw, height: gh, channels: 1 } }).resize(box.width, box.height, { fit: 'fill', kernel: 'lanczos3' }));
    const full = new Uint8Array(n);
    for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
      const X = box.x + x, Y = box.y + y;
      if (X >= 0 && Y >= 0 && X < W && Y < H) full[Y * W + X] = scaled[y * box.width + x];
    }
    placedMasks.push(full);
  }
  const union = new Uint8Array(n);
  for (const m of placedMasks) for (let i = 0; i < n; i++) if (m[i] > union[i]) union[i] = m[i];
  // The canvas: the plain fill, and the products' pixels where any product is.
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) out.set(fill, i * 3);
  for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
    const X = box.x + x, Y = box.y + y, i = Y * W + X;
    if (X < 0 || Y < 0 || X >= W || Y >= H || !union[i]) continue;
    const j = (y * box.width + x) * 3; out[i * 3] = rgb[j]; out[i * 3 + 1] = rgb[j + 1]; out[i * 3 + 2] = rgb[j + 2];
  }
  return { reference: { rgb: out, width: W, height: H } as Raster, masks: placedMasks, union };
}
/** The average colour of the source outside the products: the canvas fill the model paints over (it keeps the light familiar). */
export function backgroundColour(source: Raster, union: Uint8Array): [number, number, number] {
  let r = 0, g = 0, b = 0, k = 0;
  for (let i = 0; i < union.length; i += 7) if (!union[i]) { r += source.rgb[i * 3]; g += source.rgb[i * 3 + 1]; b += source.rgb[i * 3 + 2]; k++; }
  return k ? [Math.round(r / k), Math.round(g / k), Math.round(b / k)] : [200, 200, 200];
}
/** The image model's inputs on the variant's own canvas: the placed products on the fill, and an edit mask keeping only them. */
export async function canvasInputs(reference: Raster, union: Uint8Array) {
  const { width, height } = reference, rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = union[i] >= 128 ? 255 : 0;
  return { image: await sharp(reference.rgb, { raw: { width, height, channels: 3 } }).png().toBuffer(), mask: await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer(), placement: { x: 0, y: 0, width, height } };
}
