/**
 * The pixel work of a creative variant, all local (sharp), none of it a model call:
 *
 *   mask      validated against the analysis: present where each protected subject is, not spilling into the scene,
 *             and flagged where overlaid text or logos overlap it (they would stay in the cutout)
 *   inputs    the source placed (uncropped, undistorted) inside the image model's canvas, and an edit mask whose only
 *             opaque area is the subject: the model paints the scenery around a subject it can see, for its light
 *   compose   the generated scenery mapped back onto the source canvas; the subject's area filled locally into a clean
 *             plate; a soft contact shadow; and the subject's own source pixels on top. Preservation is measured on the
 *             result (every fully opaque subject pixel compared with the source), never assumed.
 */
import sharp from 'sharp';
import { fillMasked } from '../outerBackground.js';

export type PixelBox = { x: number; y: number; width: number; height: number };
export type Raster = { rgb: Buffer; width: number; height: number };
const WORK_SIDE = 1536;

/** The source as RGB at its own size (EXIF orientation applied; transparency flattened onto white). */
export async function sourceRaster(bytes: Buffer): Promise<Raster> {
  const { data, info } = await sharp(bytes).rotate().flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
}
/** An 8-bit mask (white = subject) at a size. */
export const maskRaster = async (png: Buffer, width: number, height: number) => new Uint8Array(await sharp(png).flatten({ background: '#000000' }).greyscale().resize(width, height, { fit: 'fill' }).raw().toBuffer());
export function maskBox(mask: Uint8Array, width: number, height: number, threshold = 128): { count: number; box?: PixelBox } {
  let count = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x] >= threshold) { count++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { count, ...(count ? { box: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } } : {}) };
}
const inBox = (b: PixelBox, x: number, y: number) => x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
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
  const margin = Math.round(0.06 * Math.max(width, height));
  const grown = subjects.map(s => ({ x: s.box.x - margin, y: s.box.y - margin, width: s.box.width + 2 * margin, height: s.box.height + 2 * margin }));
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
/** A user's cutout PNG, accepted only as the source's own pixels: same size, and every opaque pixel equal to the source's. */
export async function userCutoutMask(cutout: Buffer, source: Raster): Promise<Uint8Array> {
  const meta = await sharp(cutout).metadata();
  if (meta.format !== 'png' || !meta.hasAlpha) throw new Error('Upload the cutout as a PNG with a transparent background.');
  const { data, info } = await sharp(cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== source.width || info.height !== source.height) throw new Error(`The cutout is ${info.width}×${info.height}; it must have the reference image's size (${source.width}×${source.height}), exported from that same image.`);
  const mask = new Uint8Array(info.width * info.height);
  let opaque = 0, differing = 0;
  for (let i = 0; i < mask.length; i++) {
    const a = data[i * 4 + 3]; mask[i] = a;
    if (a < 250) continue;
    opaque++;
    if (Math.max(...[0, 1, 2].map(c => Math.abs(data[i * 4 + c] - source.rgb[i * 3 + c]))) > 3) differing++;
  }
  if (opaque < mask.length * 0.003) throw new Error('The cutout is (almost) fully transparent.');
  if (differing > opaque * 0.01) throw new Error('The cutout\'s pixels differ from the reference image: exact preservation needs a cutout exported from this same image, not a retouched or regenerated one.');
  return mask;
}

/** The source inside the image model's canvas (contained, centered, edges mirrored outward), and where it sits there. */
export async function generationInputs(source: Raster, mask: Uint8Array, size: { width: number; height: number }) {
  const scale = Math.min(size.width / source.width, size.height / source.height), sw = Math.max(1, Math.round(source.width * scale)), sh = Math.max(1, Math.round(source.height * scale));
  const x = Math.floor((size.width - sw) / 2), y = Math.floor((size.height - sh) / 2), placement = { x, y, width: sw, height: sh };
  const image = await sharp(source.rgb, { raw: { width: source.width, height: source.height, channels: 3 } }).resize(sw, sh, { fit: 'fill' })
    .extend({ top: y, bottom: size.height - sh - y, left: x, right: size.width - sw - x, extendWith: 'mirror' }).png().toBuffer();
  const small = await sharp(Buffer.from(mask), { raw: { width: source.width, height: source.height, channels: 1 } }).resize(sw, sh, { fit: 'fill' }).raw().toBuffer();
  // OpenAI edit masks: fully transparent = paint here. Only the subject is opaque (kept for the model's reference).
  const rgba = Buffer.alloc(size.width * size.height * 4, 255);
  for (let yy = 0; yy < size.height; yy++) for (let xx = 0; xx < size.width; xx++) {
    const i = yy * size.width + xx, inside = xx >= x && yy >= y && xx < x + sw && yy < y + sh;
    rgba[i * 4 + 3] = inside && small[(yy - y) * sw + (xx - x)] >= 128 ? 255 : 0;
  }
  return { image, mask: await sharp(rgba, { raw: { width: size.width, height: size.height, channels: 4 } }).png().toBuffer(), placement };
}
function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const row = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) { let last = -Infinity; for (let x = 0; x < width; x++) { if (mask[y * width + x] >= 128) last = x; row[y * width + x] = x - last <= r ? 1 : 0; } last = Infinity; for (let x = width - 1; x >= 0; x--) { if (mask[y * width + x] >= 128) last = x; if (last - x <= r) row[y * width + x] = 1; } }
  for (let x = 0; x < width; x++) { let last = -Infinity; for (let y = 0; y < height; y++) { if (row[y * width + x]) last = y; out[y * width + x] = y - last <= r ? 1 : 0; } last = Infinity; for (let y = height - 1; y >= 0; y--) { if (row[y * width + x]) last = y; if (last - y <= r) out[y * width + x] = 1; } }
  return out;
}
/** A soft elliptical contact shadow under the subject, as its own layer (black, blurred, partly transparent). */
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
export type ComposedVariant = { scenery: Buffer; plate: Buffer; shadow?: { png: Buffer; placement: PixelBox }; subject: { png: Buffer; placement: PixelBox }; composite: Buffer; preservation: { checkedPixels: number; maxDifference: number } };
/** The variant from the model's image: scenery back on the source canvas, a clean plate, a shadow, and the exact subject. */
export async function composeVariant(generated: Buffer, placement: PixelBox, source: Raster, mask: Uint8Array): Promise<ComposedVariant> {
  const { width, height } = source, meta = await sharp(generated).metadata();
  if (!meta.width || !meta.height || placement.x + placement.width > meta.width || placement.y + placement.height > meta.height) throw new Error('The generated image does not have the requested size.');
  const scenery = await sharp(generated).extract({ left: placement.x, top: placement.y, width: placement.width, height: placement.height }).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
  // The plate: the subject's area (slightly grown, so the model's own rendering of it goes too) continued from around it.
  const scale = Math.min(1, WORK_SIDE / Math.max(width, height)), ww = Math.max(1, Math.round(width * scale)), wh = Math.max(1, Math.round(height * scale));
  const smallScenery = await sharp(scenery, { raw: { width, height, channels: 3 } }).resize(ww, wh, { fit: 'fill' }).raw().toBuffer();
  const smallMask = new Uint8Array(await sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } }).resize(ww, wh, { fit: 'fill' }).raw().toBuffer());
  // Grown by 2.5%: an image model rarely keeps a masked subject to the pixel, and its own shifted rendering must not show as a ghost.
  const hole = dilate(smallMask, ww, wh, Math.max(4, Math.round(0.025 * Math.max(ww, wh))));
  const filled = fillMasked(Float32Array.from(smallScenery), hole, ww, wh).out;
  const filledFull = await sharp(filled, { raw: { width: ww, height: wh, channels: 3 } }).resize(width, height, { fit: 'fill' }).raw().toBuffer();
  const holeFull = await sharp(Buffer.from(hole.map(v => v * 255)), { raw: { width: ww, height: wh, channels: 1 } }).resize(width, height, { fit: 'fill' }).raw().toBuffer();
  const plate = Buffer.from(scenery);
  for (let i = 0; i < width * height; i++) if (holeFull[i] >= 128) for (let c = 0; c < 3; c++) plate[i * 3 + c] = filledFull[i * 3 + c];
  // The subject: the source's own pixels, the mask as alpha (edges softened by one pixel; the inside stays exact).
  const alpha = await sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } }).blur(0.6).raw().toBuffer();
  for (let i = 0; i < alpha.length; i++) if (mask[i] >= 250) alpha[i] = 255;
  const { box } = maskBox(mask, width, height);
  if (!box) throw new Error('The subject mask is empty.');
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { rgba[i * 4] = source.rgb[i * 3]; rgba[i * 4 + 1] = source.rgb[i * 3 + 1]; rgba[i * 4 + 2] = source.rgb[i * 3 + 2]; rgba[i * 4 + 3] = alpha[i]; }
  const subjectPng = await sharp(rgba, { raw: { width, height, channels: 4 } }).extract({ left: box.x, top: box.y, width: box.width, height: box.height }).png().toBuffer();
  const shadow = await contactShadow(box, width, height);
  const platePng = await sharp(plate, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const composite = await sharp(platePng).composite([...(shadow ? [{ input: shadow.png, left: shadow.placement.x, top: shadow.placement.y }] : []), { input: subjectPng, left: box.x, top: box.y }]).png().toBuffer();
  // Measured, not assumed: every fully opaque subject pixel of the result against the source.
  const result = await sharp(composite).removeAlpha().raw().toBuffer();
  let checkedPixels = 0, maxDifference = 0;
  for (let i = 0; i < width * height; i++) {
    if (mask[i] < 250) continue;
    checkedPixels++;
    for (let c = 0; c < 3; c++) maxDifference = Math.max(maxDifference, Math.abs(result[i * 3 + c] - source.rgb[i * 3 + c]));
  }
  return { scenery: await sharp(scenery, { raw: { width, height, channels: 3 } }).png().toBuffer(), plate: platePng, ...(shadow ? { shadow } : {}), subject: { png: subjectPng, placement: box }, composite, preservation: { checkedPixels, maxDifference } };
}
/** The full-canvas subject cutout (mask as alpha) and the mask itself, for the set's own files. */
export async function cutoutFiles(source: Raster, mask: Uint8Array) {
  const { width, height } = source, rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { rgba[i * 4] = source.rgb[i * 3]; rgba[i * 4 + 1] = source.rgb[i * 3 + 1]; rgba[i * 4 + 2] = source.rgb[i * 3 + 2]; rgba[i * 4 + 3] = mask[i]; }
  return { subject: await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer(), mask: await sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } }).png().toBuffer() };
}
