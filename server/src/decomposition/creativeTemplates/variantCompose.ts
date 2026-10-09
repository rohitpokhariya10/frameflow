/**
 * The pixel work of a creative variant, all local (sharp), none of it a model call:
 *
 *   mask      validated against the analysis: present where each protected product is, not spilling into the scene,
 *             and flagged where overlaid text or logos overlap it (they would stay in the cutout)
 *   inputs    the source placed (uncropped, undistorted) inside the image model's canvas, and an edit mask whose only
 *             opaque area is the products: the model paints the scenery around products it can see, for their light
 *   compose   the generated scenery mapped back onto the source canvas; where the model drew the products (found by
 *             measuring how far its rendering drifted from them, with a margin), the scenery is continued into a clean
 *             plate with its own texture, so no ghost remains and no smooth ring shows; a soft contact shadow under each
 *             grounded product only where the model painted none; and each product's own pixels on top, as its own
 *             layer. Preservation is measured on the result (every opaque product pixel, every soft edge pixel and
 *             every pixel outside the masks), never assumed.
 *   edges     a soft product edge is a mix of the product and the OLD background: its own opacity and the product's
 *             colour are recovered (refineEdges) before it is blended over the new scenery, so no old background tints
 *             it and a mask that spills onto old background stops at the product. Opaque product pixels never change.
 *
 * Masks are single-band 8-bit arrays (255 = product). sharp may hand a single band back as RGB after a resize or a blur,
 * so every mask passes through `band()`: a mask read as the wrong layout would land in the wrong place.
 */
import sharp, { type Sharp } from 'sharp';
import { boxBlur, maskedBlur, pushPull } from '../outerBackground.js';

export type PixelBox = { x: number; y: number; width: number; height: number };
export type Raster = { rgb: Buffer; width: number; height: number };
/** Plates are continued at full size up to this side (larger sources at this working size; the hole is pasted back). */
const WORK_SIDE = 2048;

/** One band of a raw sharp result, whatever channel count sharp hands back (it may expand one band to RGB). */
export async function band(pipeline: Sharp): Promise<Uint8Array> {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 1) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint8Array(info.width * info.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * info.channels];
  return out;
}
/** RGB of a raw sharp result: a greyscale image is expanded, an alpha band dropped. */
async function rgbOf(pipeline: Sharp): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 3) return { data, width: info.width, height: info.height };
  const out = Buffer.alloc(info.width * info.height * 3);
  for (let i = 0; i < info.width * info.height; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = data[i * info.channels + (info.channels >= 3 ? c : 0)];
  return { data: out, width: info.width, height: info.height };
}
const maskInput = (mask: Uint8Array, width: number, height: number) => sharp(Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength), { raw: { width, height, channels: 1 } });
/** A mask resized to another size (one band in, one band out). */
export const resizeMask = (mask: Uint8Array, from: { width: number; height: number }, to: { width: number; height: number }) =>
  from.width === to.width && from.height === to.height ? Promise.resolve(mask) : band(maskInput(mask, from.width, from.height).resize(to.width, to.height, { fit: 'fill' }));

/** The source as RGB at its own size (EXIF orientation applied; transparency flattened onto white). */
export async function sourceRaster(bytes: Buffer): Promise<Raster> {
  const { data, width, height } = await rgbOf(sharp(bytes).rotate().flatten({ background: '#ffffff' }).removeAlpha());
  return { rgb: data, width, height };
}
/** An 8-bit mask (white = subject) at a size. */
export const maskRaster = async (png: Buffer, width: number, height: number) => band(sharp(png).flatten({ background: '#000000' }).greyscale().resize(width, height, { fit: 'fill' }));
export function maskBox(mask: Uint8Array, width: number, height: number, threshold = 128): { count: number; box?: PixelBox } {
  let count = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x] >= threshold) { count++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { count, ...(count ? { box: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } } : {}) };
}
const inBox = (b: PixelBox, x: number, y: number) => x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
/** The margin around an approximate analysis box within which a mask still belongs to its product. */
export const boxMargin = (width: number, height: number) => Math.round(0.06 * Math.max(width, height));
const grow = (b: PixelBox, m: number): PixelBox => ({ x: b.x - m, y: b.y - m, width: b.width + 2 * m, height: b.height + 2 * m });
export type MaskCheck = { ok: boolean; checks: string[]; limitations: string[]; problems: string[]; coveragePercent: number; box?: PixelBox };
/**
 * Whether a mask is a usable cutout of these subjects: each subject's region is substantially covered, the mask stays
 * near the subjects (approximate boxes, so with a margin), and it is neither empty nor nearly the whole image.
 */
export function checkMask(mask: Uint8Array, width: number, height: number, subjects: { label: string; box: PixelBox }[], overlaps: { label: string; box: PixelBox }[]): MaskCheck {
  const { count, box } = maskBox(mask, width, height), total = width * height, coverage = 100 * count / total;
  const checks: string[] = [], problems: string[] = [], limitations: string[] = [];
  if (coverage < 0.3) problems.push('The mask is (almost) empty: the subject was not found.');
  else if (coverage > 92) problems.push('The mask covers almost the whole image: it is not a subject cutout.');
  const margin = boxMargin(width, height);
  const grown = subjects.map(s => grow(s.box, margin));
  let outside = 0;
  const inside = subjects.map(() => 0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (mask[y * width + x] < 128) continue;
    if (!grown.some(b => inBox(b, x, y))) outside++;
    subjects.forEach((s, i) => { if (inBox(s.box, x, y)) inside[i]++; });
  }
  subjects.forEach((s, i) => {
    const fill = 100 * inside[i] / Math.max(1, s.box.width * s.box.height);
    if (fill < 12) problems.push(`${s.label} is missing from the mask (${fill.toFixed(0)}% of its region).`);
    else checks.push(`${s.label}: ${fill.toFixed(0)}% of its approximate region is in the mask.`);
  });
  const spill = 100 * outside / Math.max(1, count);
  if (count && spill > 25) problems.push(`${spill.toFixed(0)}% of the mask lies away from the protected subjects: it may include background objects.`);
  else if (count) checks.push(`${(100 - spill).toFixed(0)}% of the mask lies on or near the protected subjects.`);
  for (const o of overlaps) {
    let hit = 0;
    for (let y = Math.max(0, o.box.y); y < Math.min(height, o.box.y + o.box.height); y++) for (let x = Math.max(0, o.box.x); x < Math.min(width, o.box.x + o.box.width); x++) if (mask[y * width + x] >= 128) hit++;
    if (hit / Math.max(1, o.box.width * o.box.height) > 0.08) limitations.push(`${o.label} overlaps the protected subject: it stays in the cutout, so this creative is not fully text-free there.`);
  }
  return { ok: !problems.length, checks, problems, limitations, coveragePercent: Math.round(coverage * 10) / 10, ...(box ? { box } : {}) };
}
/**
 * One mask of several products split into each product's own mask: a pixel belongs to the product whose (grown)
 * analysis box contains it, the nearest box (relative to its size) deciding between overlapping boxes. A pixel no grown
 * box contains belongs to none, so a matte of the whole image keeps only what lies at the chosen products.
 */
export function splitMaskByBoxes(mask: Uint8Array, width: number, height: number, boxes: PixelBox[]): Uint8Array[] {
  const margin = boxMargin(width, height), grown = boxes.map(b => grow(b, margin)), out = boxes.map(() => new Uint8Array(width * height));
  const centres = boxes.map(b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2, halfW: Math.max(1, b.width / 2), halfH: Math.max(1, b.height / 2) }));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, v = mask[i];
    if (!v) continue;
    let best = -1, bestDistance = Infinity;
    for (let k = 0; k < boxes.length; k++) {
      if (!inBox(grown[k], x, y)) continue;
      const d = Math.max(Math.abs(x - centres[k].x) / centres[k].halfW, Math.abs(y - centres[k].y) / centres[k].halfH);
      if (d < bestDistance) { bestDistance = d; best = k; }
    }
    if (best >= 0) out[best][i] = v;
  }
  return out;
}
/** A user's cutout PNG, accepted only as the source's own pixels: same size, and every opaque pixel equal to the source's. */
export async function userCutoutMask(cutout: Buffer, source: Raster): Promise<Uint8Array> {
  const meta = await sharp(cutout).metadata();
  if (meta.format !== 'png' || !meta.hasAlpha) throw new Error('Upload the cutout as a PNG with a transparent background.');
  const { data, info } = await sharp(cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== source.width || info.height !== source.height) throw new Error(`The cutout is ${info.width}×${info.height}; it must have the reference image's size (${source.width}×${source.height}), exported from that same image.`);
  const channels = info.channels, colour = (i: number, c: number) => data[i * channels + (channels >= 4 ? c : 0)];
  const mask = new Uint8Array(info.width * info.height);
  let opaque = 0, differing = 0;
  for (let i = 0; i < mask.length; i++) {
    const a = data[i * channels + channels - 1]; mask[i] = a;
    if (a < 250) continue;
    opaque++;
    if (Math.max(...[0, 1, 2].map(c => Math.abs(colour(i, c) - source.rgb[i * 3 + c]))) > 3) differing++;
  }
  if (opaque < mask.length * 0.003) throw new Error('The cutout is (almost) fully transparent.');
  if (differing > opaque * 0.01) throw new Error('The cutout\'s pixels differ from the reference image: exact preservation needs a cutout exported from this same image, not a retouched or regenerated one.');
  return mask;
}

/**
 * The source inside the image model's canvas (contained, centered, edges mirrored outward), and where it sits there.
 * keepPadding: the mirrored margin is protected too (a local edit paints only its own regions).
 */
export async function generationInputs(source: Raster, mask: Uint8Array, size: { width: number; height: number }, options: { keepPadding?: boolean } = {}) {
  const scale = Math.min(size.width / source.width, size.height / source.height), sw = Math.max(1, Math.round(source.width * scale)), sh = Math.max(1, Math.round(source.height * scale));
  const x = Math.floor((size.width - sw) / 2), y = Math.floor((size.height - sh) / 2), placement = { x, y, width: sw, height: sh };
  const image = await sharp(source.rgb, { raw: { width: source.width, height: source.height, channels: 3 } }).resize(sw, sh, { fit: 'fill' })
    .extend({ top: y, bottom: size.height - sh - y, left: x, right: size.width - sw - x, extendWith: 'mirror' }).png().toBuffer();
  const small = await resizeMask(mask, source, { width: sw, height: sh });
  // OpenAI edit masks: fully transparent = paint here. Only the products are opaque (kept for the model's reference).
  const rgba = Buffer.alloc(size.width * size.height * 4, 255);
  for (let yy = 0; yy < size.height; yy++) for (let xx = 0; xx < size.width; xx++) {
    const i = yy * size.width + xx, inside = xx >= x && yy >= y && xx < x + sw && yy < y + sh;
    rgba[i * 4 + 3] = inside ? small[(yy - y) * sw + (xx - x)] >= 128 ? 255 : 0 : options.keepPadding ? 255 : 0;
  }
  return { image, mask: await sharp(rgba, { raw: { width: size.width, height: size.height, channels: 4 } }).png().toBuffer(), placement };
}
function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const row = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) { let last = -Infinity; for (let x = 0; x < width; x++) { if (mask[y * width + x] >= 128) last = x; row[y * width + x] = x - last <= r ? 1 : 0; } last = Infinity; for (let x = width - 1; x >= 0; x--) { if (mask[y * width + x] >= 128) last = x; if (last - x <= r) row[y * width + x] = 1; } }
  for (let x = 0; x < width; x++) { let last = -Infinity; for (let y = 0; y < height; y++) { if (row[y * width + x]) last = y; out[y * width + x] = y - last <= r ? 1 : 0; } last = Infinity; for (let y = height - 1; y >= 0; y--) { if (row[y * width + x]) last = y; if (last - y <= r) out[y * width + x] = 1; } }
  return out;
}
/** A soft elliptical contact shadow under one product, as its own layer (black, blurred, partly transparent). */
async function contactShadow(box: PixelBox, width: number, height: number) {
  const rx = Math.max(6, Math.round(box.width * 0.45)), ry = Math.max(4, Math.round(box.height * 0.045)), blur = Math.max(3, Math.round(ry * 0.8));
  const lw = 2 * (rx + 2 * blur), lh = 2 * (ry + 2 * blur), cx = box.x + box.width / 2, cy = Math.min(height - 1, box.y + box.height - ry * 0.5);
  const full = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${lw}" height="${lh}"><ellipse cx="${lw / 2}" cy="${lh / 2}" rx="${rx}" ry="${ry}" fill="#000" fill-opacity="0.38"/></svg>`)).blur(blur).png().toBuffer();
  // Clipped to the canvas: the layer's placement is exactly the part that shows.
  const left = Math.round(cx - lw / 2), top = Math.round(cy - lh / 2), x0 = Math.max(0, left), y0 = Math.max(0, top), x1 = Math.min(width, left + lw), y1 = Math.min(height, top + lh);
  if (x1 - x0 < 2 || y1 - y0 < 2) return undefined;
  const png = await sharp(full).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
  return { png, placement: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}
/**
 * Each pixel's nearest pixel outside the hole (approximately Euclidean: two raster passes carrying the nearest seed).
 * -1 where the whole image is hole.
 */
function nearestOutside(hole: Uint8Array, width: number, height: number): Int32Array {
  const near = new Int32Array(width * height).fill(-1), dist = new Float32Array(width * height).fill(Infinity);
  for (let i = 0; i < hole.length; i++) if (!hole[i]) { near[i] = i; dist[i] = 0; }
  const relax = (i: number, j: number) => {
    const seed = near[j];
    if (seed < 0) return;
    const dx = (i % width) - (seed % width), dy = Math.floor(i / width) - Math.floor(seed / width), d = dx * dx + dy * dy;
    if (d < dist[i]) { dist[i] = d; near[i] = seed; }
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (x > 0) relax(i, i - 1); if (y > 0) { relax(i, i - width); if (x > 0) relax(i, i - width - 1); if (x < width - 1) relax(i, i - width + 1); }
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x;
    if (x < width - 1) relax(i, i + 1); if (y < height - 1) { relax(i, i + width); if (x < width - 1) relax(i, i + width + 1); if (x > 0) relax(i, i + width - 1); }
  }
  return near;
}
/**
 * The scenery continued into a hole WITH its texture: a smooth base of the surrounding colour and light (push-pull),
 * plus the surrounding detail mirrored across the hole's edge (each pixel takes the detail of the pixel as far outside
 * the edge as it is inside). Deep inside a large hole the mirrored detail fades a little toward the base. A 2-pixel seam
 * blends into the scenery at the hole's outer edge.
 */
export function continueScenery(rgb: Buffer, hole: Uint8Array, width: number, height: number): Buffer {
  const n = width * height, f = Float32Array.from(rgb), known = new Float32Array(n);
  for (let i = 0; i < n; i++) known[i] = hole[i] ? 0 : 1;
  const lowKnown = maskedBlur(f, known, width, height, 10);
  const base = boxBlur(pushPull(lowKnown, known, width, height), width, height, 3, 6);
  const near = nearestOutside(hole, width, height), out = Buffer.from(rgb);
  const isKnown = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && !hole[y * width + x];
  for (let i = 0; i < n; i++) {
    if (!hole[i]) continue;
    const q = near[i];
    if (q < 0) { for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(base[i * 3 + c]); continue; }
    const x = i % width, y = Math.floor(i / width), qx = q % width, qy = Math.floor(q / width), vx = qx - x, vy = qy - y, d = Math.hypot(vx, vy);
    // The mirror of this pixel across the edge; half as far when that lands in another hole or off the canvas.
    let src = q;
    if (isKnown(qx + vx, qy + vy)) src = (qy + vy) * width + qx + vx;
    else if (isKnown(qx + (vx >> 1), qy + (vy >> 1))) src = (qy + (vy >> 1)) * width + qx + (vx >> 1);
    const keep = d <= 32 ? 1 : Math.max(0.55, 1 - (d - 32) / 160), seam = Math.min(1, d / 2.5);
    for (let c = 0; c < 3; c++) {
      const filled = base[i * 3 + c] + (f[src * 3 + c] - lowKnown[src * 3 + c]) * keep;
      out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(f[i * 3 + c] * (1 - seam) + filled * seam)));
    }
  }
  return out;
}
/** Luminance edges (gradient magnitude), lightly blurred: an image's outlines and texture, whatever its brightness. */
function edgeMap(rgb: ArrayLike<number>, width: number, height: number): Float32Array {
  const lum = new Float32Array(width * height), out = new Float32Array(width * height);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) { const i = y * width + x; out[i] = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + width] - lum[i - width]); }
  return boxBlur(out, width, height, 1, 1);
}
/**
 * Where the model drew the products, measured on their OUTLINES and inner edges (so a re-render that is brighter or
 * darker, or a flat-coloured product, is still found): the shift (within 4% of the canvas) and slight scale (±6%, about
 * the products' centre) at which the model's edges best line up with the products' own, against how well they line up
 * where the products are. How closely the model kept their pixels is measured too. The hole is the products' area as
 * given and as the model drew it, grown by a margin: 3 px when the model kept them in place (its own contact shadows and
 * the scenery right next to them stay), more when it re-rendered them, so its own copy never shows as a ghost.
 */
export function ghostHole(sceneryRgb: Buffer, referenceRaster: Raster, union: Uint8Array, width: number, height: number) {
  // How closely the model kept the products' pixels, compared lightly blurred (resampling noise is not a change).
  const scenery = boxBlur(Float32Array.from(sceneryRgb), width, height, 3, 1), reference = boxBlur(Float32Array.from(referenceRaster.rgb), width, height, 3, 1);
  let keptSum = 0, keptCount = 0, cx = 0, cy = 0, area = 0;
  for (let i = 0; i < union.length; i++) if (union[i] >= 250) {
    cx += i % width; cy += Math.floor(i / width); area++;
    if (area % 3) continue;
    keptSum += Math.max(Math.abs(scenery[i * 3] - reference[i * 3]), Math.abs(scenery[i * 3 + 1] - reference[i * 3 + 1]), Math.abs(scenery[i * 3 + 2] - reference[i * 3 + 2])); keptCount++;
  }
  cx /= Math.max(1, area); cy /= Math.max(1, area);
  const kept = keptCount ? keptSum / keptCount : 0;
  // The products' own edges: their outline (from the mask) and their inner detail (from their pixels, inside the mask).
  const silhouette = edgeMap(Uint8Array.from({ length: union.length * 3 }, (_, k) => union[Math.floor(k / 3)]), width, height), inner = edgeMap(referenceRaster.rgb, width, height), model = edgeMap(sceneryRgb, width, height);
  const template: { i: number; w: number }[] = [];
  for (let i = 0; i < union.length; i++) { const w = silhouette[i] + (union[i] >= 250 ? inner[i] : 0); if (w > 8) template.push({ i, w }); }
  const stride = Math.max(1, Math.floor(template.length / 20_000)), used = template.filter((_, k) => k % stride === 0);
  // Normalized correlation of the template with the model's edges at a transform (1 = the same edges, there).
  const score = (dx: number, dy: number, scale: number) => {
    let dot = 0, norm = 0, own = 0;
    for (const t of used) {
      const x = Math.round(cx + ((t.i % width) - cx) * scale + dx), y = Math.round(cy + (Math.floor(t.i / width) - cy) * scale + dy);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const e = model[y * width + x]; dot += t.w * e; norm += e * e; own += t.w * t.w;
    }
    return norm > 0 && own > 0 ? dot / Math.sqrt(norm * own) : 0;
  };
  const here = score(0, 0, 1), reach = Math.max(4, Math.round(0.04 * Math.max(width, height))), step = Math.max(1, Math.round(reach / 10));
  let best = { dx: 0, dy: 0, scale: 1, s: here };
  for (const scale of [0.96, 0.98, 1, 1.02, 1.04, 1.06]) for (let dy = -reach; dy <= reach; dy += step) for (let dx = -reach; dx <= reach; dx += step) {
    const s = score(dx, dy, scale); if (s > best.s) best = { dx, dy, scale, s };
  }
  for (const scale of [best.scale - 0.01, best.scale, best.scale + 0.01]) for (let dy = best.dy - step; dy <= best.dy + step; dy++) for (let dx = best.dx - step; dx <= best.dx + step; dx++) {
    const s = score(dx, dy, scale); if (s > best.s) best = { dx, dy, scale, s };
  }
  // A shifted copy counts only when its edges line up clearly better than the products' own place does.
  const drifted = (best.dx !== 0 || best.dy !== 0 || Math.abs(best.scale - 1) > 0.001) && best.s > here * 1.1;
  const margin = kept <= 8 && !drifted ? 3 : Math.max(3, Math.round(0.015 * Math.max(width, height)));
  const hole = new Uint8Array(union.length);
  for (let i = 0; i < union.length; i++) {
    if (union[i] < 128) continue;
    hole[i] = 255;
    if (!drifted) continue;
    const x = Math.round(cx + ((i % width) - cx) * best.scale + best.dx), y = Math.round(cy + (Math.floor(i / width) - cy) * best.scale + best.dy);
    if (x >= 0 && y >= 0 && x < width && y < height) hole[y * width + x] = 255;
  }
  return { hole: Uint8Array.from(dilate(hole, width, height, margin), v => v * 255), drift: drifted ? { dx: best.dx, dy: best.dy, scale: Math.round(best.scale * 1000) / 1000 } : { dx: 0, dy: 0, scale: 1 },
    keptError: Math.round(kept * 10) / 10, alignment: { here: Math.round(here * 1000) / 1000, best: Math.round(best.s * 1000) / 1000 }, margin };
}
/** Whether the plate is already darker right under a product than a little further down (the model painted its shadow). */
function hasContactShadow(plate: Buffer, box: PixelBox, width: number, height: number): boolean {
  const lum = (y0: number, y1: number) => {
    let sum = 0, count = 0;
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) for (let x = Math.max(0, box.x + Math.round(box.width * 0.2)); x < Math.min(width, box.x + Math.round(box.width * 0.8)); x++) {
      const i = (y * width + x) * 3; sum += 0.299 * plate[i] + 0.587 * plate[i + 1] + 0.114 * plate[i + 2]; count++;
    }
    return count ? sum / count : NaN;
  };
  const bottom = box.y + box.height, near = lum(bottom - Math.round(height * 0.005), bottom + Math.round(height * 0.02)), far = lum(bottom + Math.round(height * 0.05), bottom + Math.round(height * 0.08));
  return Number.isFinite(near) && Number.isFinite(far) && near < far * 0.85;
}
/**
 * A soft product edge, refined from its colours. An edge pixel of colour C over the OLD background B is C = α·F + (1−α)·B,
 * with F the product's colour there. With B continued from the old background around it and P from the product's
 * opaque pixels nearby:
 *   α  where product and background differ enough, the pixel's own opacity is measured as the projection of C − B on
 *      P − B, and the mask's value is lowered to it (never raised): a mask that spills onto old background stops there
 *   F  = (C − (1−α)·B)/α, the product's colour without the old background's tint (P where α is too small to tell)
 * Only pixels with 0 < mask < 250 change; every opaque product pixel, and every mask value there, stays the source's.
 */
export function refineEdges(source: Raster, masks: Uint8Array[]): { reference: Raster; masks: Uint8Array[]; union: Uint8Array } {
  const { width, height } = source, union = new Uint8Array(width * height);
  for (const m of masks) for (let i = 0; i < union.length; i++) if (m[i] > union[i]) union[i] = m[i];
  const { box } = maskBox(union, width, height, 1);
  if (!box) return { reference: source, masks, union };
  const pad = 8, x0 = Math.max(0, box.x - pad), y0 = Math.max(0, box.y - pad), x1 = Math.min(width, box.x + box.width + pad), y1 = Math.min(height, box.y + box.height + pad), w = x1 - x0, h = y1 - y0;
  const crop = new Float32Array(w * h * 3), background = new Float32Array(w * h), product = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y0 + y) * width + (x0 + x), i = y * w + x;
    for (let c = 0; c < 3; c++) crop[i * 3 + c] = source.rgb[s * 3 + c];
    background[i] = union[s] === 0 ? 1 : 0; product[i] = union[s] >= 250 ? 1 : 0;
  }
  const B = pushPull(crop, background, w, h), P = pushPull(crop, product, w, h), out = Buffer.from(source.rgb), refined = new Uint8Array(union);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y0 + y) * width + (x0 + x), u = union[s], i = y * w + x;
    if (u === 0 || u >= 250) continue;
    let alpha = u / 255, dot = 0, span = 0;
    for (let c = 0; c < 3; c++) { const d = P[i * 3 + c] - B[i * 3 + c]; dot += (crop[i * 3 + c] - B[i * 3 + c]) * d; span += d * d; }
    // Product and background clearly apart: measure the pixel's own opacity (with a little slack for texture).
    if (span > 40 * 40) alpha = Math.min(alpha, Math.max(0, dot / span) + 0.1);
    if (alpha < 0.04) { refined[s] = 0; continue; }
    refined[s] = Math.max(1, Math.round(alpha * 255));
    for (let c = 0; c < 3; c++) out[s * 3 + c] = Math.max(0, Math.min(255, Math.round(alpha < 0.2 ? P[i * 3 + c] : (crop[i * 3 + c] - (1 - alpha) * B[i * 3 + c]) / alpha)));
  }
  // Each product's own mask, lowered where the edge was.
  const own = masks.map(m => Uint8Array.from(m, (v, i) => (v > 0 && v < 250 ? Math.min(v, refined[i]) : v)));
  return { reference: { rgb: out, width, height }, masks: own, union: refined };
}
/**
 * A product's alpha: exactly its mask (a near-opaque value counts as opaque). It is never widened or blurred outward:
 * a pixel outside the mask is old background and must never show. A mask's own soft edge (a matte, or a provider mask
 * upscaled to the source) is the only anti-aliasing, so as many product pixels as possible stay exactly the source's.
 */
function productAlpha(mask: Uint8Array): Uint8Array {
  const alpha = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) alpha[i] = mask[i] >= 250 ? 255 : mask[i];
  return alpha;
}
/** A protected product to compose: its mask on the source canvas, and whether it stands on something (gets a shadow). */
export type VariantSubject = { id: string; label: string; mask: Uint8Array; shadow: boolean };
export type ComposedLayer = { id: string; label: string; png: Buffer; placement: PixelBox };
export type PreservationReport = { checkedPixels: number; maxDifference: number; edgePixels: number; edgeMaxError: number; outsideAlphaPixels: number; ok: boolean };
export type ComposedVariant = {
  scenery: Buffer; plate: Buffer;
  /** Back to front: each grounded product's shadow, then each product (later ones in front). */
  shadows: ComposedLayer[]; subjects: ComposedLayer[];
  /** All products together, and the first shadow: what variants made before products were separated had. */
  subject: { png: Buffer; placement: PixelBox }; shadow?: { png: Buffer; placement: PixelBox };
  composite: Buffer; preservation: PreservationReport;
  /** How far the model's rendering of the products drifted, how closely it kept them, and the margin removed around them. */
  ghost: { drift: { dx: number; dy: number; scale: number }; keptError: number; margin: number; alignment: { here: number; best: number } };
};
const cropLayer = async (rgba: Buffer, width: number, height: number, alpha: Uint8Array) => {
  const { box } = maskBox(alpha, width, height, 1);
  if (!box) return undefined;
  return { png: await sharp(rgba, { raw: { width, height, channels: 4 } }).extract({ left: box.x, top: box.y, width: box.width, height: box.height }).png().toBuffer(), placement: box };
};
const withAlpha = (source: Raster, alpha: Uint8Array) => {
  const rgba = Buffer.alloc(source.width * source.height * 4);
  for (let i = 0; i < source.width * source.height; i++) { rgba[i * 4] = source.rgb[i * 3]; rgba[i * 4 + 1] = source.rgb[i * 3 + 1]; rgba[i * 4 + 2] = source.rgb[i * 3 + 2]; rgba[i * 4 + 3] = alpha[i]; }
  return rgba;
};
/**
 * Measured, not assumed: with A the products' combined alpha, every pixel of the composite must be the source where A is
 * opaque, the blend source·A + under·(1−A) on a soft edge (±2 for rounding), and untouched by any product where no mask
 * is (A = 0 there, or old background would show).
 */
export function measurePreservation(composite: Buffer, under: Buffer, source: Raster, alphas: Uint8Array[], union: Uint8Array): PreservationReport {
  let checkedPixels = 0, maxDifference = 0, edgePixels = 0, edgeMaxError = 0, outsideAlphaPixels = 0;
  for (let i = 0; i < source.width * source.height; i++) {
    let keep = 1, opaque = false;
    for (const a of alphas) { keep *= 1 - a[i] / 255; if (a[i] === 255) opaque = true; }
    // Opaque: some product is fully opaque here (compared exactly). Two soft edges overlapping are a blend (their exact
    // combined opacity), even when it would round to 255.
    const A = opaque ? 255 : 255 * (1 - keep);
    if (A >= 0.5 && union[i] === 0) outsideAlphaPixels++;
    if (opaque) { checkedPixels++; for (let c = 0; c < 3; c++) maxDifference = Math.max(maxDifference, Math.abs(composite[i * 3 + c] - source.rgb[i * 3 + c])); }
    else if (A >= 0.5) {
      edgePixels++;
      for (let c = 0; c < 3; c++) { const expected = source.rgb[i * 3 + c] * (A / 255) + under[i * 3 + c] * (1 - A / 255); edgeMaxError = Math.max(edgeMaxError, Math.abs(composite[i * 3 + c] - expected)); }
    }
  }
  edgeMaxError = Math.round(edgeMaxError * 10) / 10;
  return { checkedPixels, maxDifference, edgePixels, edgeMaxError, outsideAlphaPixels, ok: checkedPixels > 0 && maxDifference === 0 && edgeMaxError <= 2 && outsideAlphaPixels === 0 };
}
/**
 * The variant from the model's image: scenery back on the source canvas, a clean plate, a contact shadow per grounded
 * product, and each product's exact source pixels. `subjects` are back to front: a later product is in front, and its
 * opaque pixels are its own (an earlier one leaves them out, so moving it in the editor shows the product behind it).
 */
export async function composeVariant(generated: Buffer, placement: PixelBox, source: Raster, subjects: VariantSubject[]): Promise<ComposedVariant> {
  if (!subjects.length) throw new Error('No protected product to compose.');
  const { width, height } = source, meta = await sharp(generated).metadata(), n = width * height;
  if (!meta.width || !meta.height || placement.x + placement.width > meta.width || placement.y + placement.height > meta.height) throw new Error('The generated image does not have the requested size.');
  const scenery = (await rgbOf(sharp(generated).extract({ left: placement.x, top: placement.y, width: placement.width, height: placement.height }).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha())).data;
  const union = new Uint8Array(n);
  for (const s of subjects) for (let i = 0; i < n; i++) if (s.mask[i] > union[i]) union[i] = s.mask[i];
  if (!maskBox(union, width, height).box) throw new Error('The subject mask is empty.');
  // The plate: where the model drew the products (measured), continued from the scenery around it, with its texture.
  const ghost = ghostHole(scenery, source, union, width, height);
  let plate: Buffer;
  if (Math.max(width, height) <= WORK_SIDE) plate = continueScenery(scenery, ghost.hole, width, height);
  else {
    const scale = WORK_SIDE / Math.max(width, height), work = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
    const smallScenery = (await rgbOf(sharp(scenery, { raw: { width, height, channels: 3 } }).resize(work.width, work.height, { fit: 'fill' }))).data;
    const smallHole = Uint8Array.from(await resizeMask(ghost.hole, source, work), v => (v >= 128 ? 255 : 0)), filled = continueScenery(smallScenery, smallHole, work.width, work.height);
    const filledFull = (await rgbOf(sharp(filled, { raw: { width: work.width, height: work.height, channels: 3 } }).resize(width, height, { fit: 'fill' }))).data;
    plate = Buffer.from(scenery);
    for (let i = 0; i < n; i++) if (ghost.hole[i] >= 128) for (let c = 0; c < 3; c++) plate[i * 3 + c] = filledFull[i * 3 + c];
  }
  // Each product's alpha. Where a product is opaque, that pixel is its own alone (the frontmost opaque one): no other
  // layer's soft edge lies over or under it, so every opaque pixel comes from exactly one layer and stays exact.
  const alphas = subjects.map(s => productAlpha(s.mask));
  for (let i = 0; i < n; i++) {
    let owner = -1;
    for (let k = alphas.length - 1; k >= 0; k--) if (alphas[k][i] === 255) { owner = k; break; }
    if (owner >= 0) for (let k = 0; k < alphas.length; k++) if (k !== owner) alphas[k][i] = 0;
  }
  const subjectLayers: ComposedLayer[] = [];
  for (const [k, s] of subjects.entries()) { const layer = await cropLayer(withAlpha(source, alphas[k]), width, height, alphas[k]); if (layer) subjectLayers.push({ id: s.id, label: s.label, ...layer }); }
  const shadowLayers: ComposedLayer[] = [];
  for (const s of subjects) {
    const { box } = maskBox(s.mask, width, height);
    // The model's own contact shadow, where it painted one and the plate kept it, is better than a drawn one.
    if (!s.shadow || !box || hasContactShadow(plate, box, width, height)) continue;
    const shadow = await contactShadow(box, width, height);
    if (shadow) shadowLayers.push({ id: s.id, label: s.label, ...shadow });
  }
  const platePng = await sharp(plate, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const underPng = await sharp(platePng).composite(shadowLayers.map(l => ({ input: l.png, left: l.placement.x, top: l.placement.y }))).png().toBuffer();
  const composite = await sharp(underPng).composite(subjectLayers.map(l => ({ input: l.png, left: l.placement.x, top: l.placement.y }))).png().toBuffer();
  const [under, result] = await Promise.all([rgbOf(sharp(underPng)), rgbOf(sharp(composite))]);
  const preservation = measurePreservation(result.data, under.data, source, alphas, union);
  // All products together (as one layer), for what reads a variant made before products were separated.
  const combined = new Uint8Array(n);
  for (const a of alphas) for (let i = 0; i < n; i++) combined[i] = Math.max(combined[i], a[i]);
  const all = await cropLayer(withAlpha(source, combined), width, height, combined);
  return { scenery: await sharp(scenery, { raw: { width, height, channels: 3 } }).png().toBuffer(), plate: platePng, shadows: shadowLayers, subjects: subjectLayers,
    subject: all!, ...(shadowLayers[0] ? { shadow: { png: shadowLayers[0].png, placement: shadowLayers[0].placement } } : {}), composite, preservation,
    ghost: { drift: ghost.drift, keptError: ghost.keptError, margin: ghost.margin, alignment: ghost.alignment } };
}
/** The full-canvas subject cutout (mask as alpha) and the mask itself, for the set's own files. */
export async function cutoutFiles(source: Raster, mask: Uint8Array) {
  const { width, height } = source;
  return { subject: await sharp(withAlpha(source, mask), { raw: { width, height, channels: 4 } }).png().toBuffer(), mask: await maskInput(mask, width, height).png().toBuffer() };
}
/** One product's mask as a PNG (white = that product). */
export const maskPng = (mask: Uint8Array, width: number, height: number) => maskInput(mask, width, height).png().toBuffer();
