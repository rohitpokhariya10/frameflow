/**
 * The pixel work of a protected template, all local and deterministic (sharp and plain arrays; no model, no network):
 *
 *   ingestImage       decode and check an upload; EXIF orientation applied once, so source pixels mean what is seen
 *   extractRaster     an element's own pixels in the whole-pixel rectangle around its region, with an alpha mask
 *   localFill         the source with its protected regions continued from their surroundings, region by region, and
 *                     whether each continuation can be trusted (a plain field or flat colours) or is a smooth estimate
 *   baseChecks        whether a clean base really lacks the protected content, and matches the source elsewhere
 *   reconstruct       Seedream's editor layers back to front, the protected visuals on top, measured against the source
 *
 * What is exact and what is not: a raster's fully protected pixels are the source's own values, never resampled. Its
 * edge pixels (alpha between 0 and 1) are unmixed from the base, an estimate. A filled base is an estimate everywhere it
 * was filled. reconstruct measures both and says so; nothing here claims more.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { insideBox, onCanvasShare, pixelBounds, PROTECTED_LIMITS, type PixelRect, type ProtectedElement, type ProtectedFillRegion, type ProtectedReconstruction, type SourceBox, type SourceSize } from '@frameflow/shared';
import { backgroundDifficulty, graphicFill, plainFieldFill } from '../backgroundRecovery.js';
import { label } from '../backgroundContamination.js';
import { boxBlur, grow, maskedBlur, pushPull } from '../outerBackground.js';
import { placedOverlay, type LayerInfo } from '../layerizeArtifacts.js';
import type { RunRecord } from '../layerizeExperiment.js';
import { SEEDREAM_IMAGE_LIMITS } from '../providerImage.js';

export class ProtectedImageError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = 'ProtectedImageError'; } }
export const sha256 = (bytes: Buffer | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type Rgba = { data: Buffer; width: number; height: number };
const maxDiff = (a: Uint8Array, i: number, b: Uint8Array, j: number) => Math.max(Math.abs(a[i] - b[j]), Math.abs(a[i + 1] - b[j + 1]), Math.abs(a[i + 2] - b[j + 2]));
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * An upload as it will be used: format sniffed from its bytes, fully decoded (a corrupt file fails here), one frame,
 * oriented. `input` is what everything else reads: the original bytes, or a PNG of them with EXIF orientation applied.
 */
export async function ingestImage(bytes: Buffer, what: string, options: { seedream?: boolean; minSide?: number } = {}) {
  if (!bytes.length) throw new ProtectedImageError('EMPTY_UPLOAD', `Choose the ${what}.`);
  if (bytes.length > PROTECTED_LIMITS.maxSourceBytes) throw new ProtectedImageError('UPLOAD_TOO_LARGE', `The ${what} must be at most ${PROTECTED_LIMITS.maxSourceBytes / 1024 / 1024} MB.`);
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try { meta = await sharp(bytes, { failOn: 'error' }).metadata(); await sharp(bytes, { failOn: 'error' }).raw().toBuffer(); }
  catch { throw new ProtectedImageError('UNREADABLE_IMAGE', `The ${what} cannot be decoded. Upload a PNG, JPEG or WebP file.`); }
  if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || (meta.pages ?? 1) > 1 || !meta.width || !meta.height) throw new ProtectedImageError('UNSUPPORTED_IMAGE', `The ${what} must be a single-frame PNG, JPEG or WebP image.`);
  const rotate = !!meta.orientation && meta.orientation !== 1;
  const input = rotate ? await sharp(bytes).rotate().png().toBuffer() : bytes;
  const { width, height } = rotate ? await sharp(input).metadata() as { width: number; height: number } : { width: meta.width, height: meta.height };
  const minSide = options.minSide ?? 1;
  if (width < minSide || height < minSide) throw new ProtectedImageError('IMAGE_TOO_SMALL', `The ${what} is ${width}×${height}; it needs at least ${minSide} pixels on each side.`);
  if (options.seedream && (width * height < SEEDREAM_IMAGE_LIMITS.minPixels || width * height > SEEDREAM_IMAGE_LIMITS.maxPixels || width / height > SEEDREAM_IMAGE_LIMITS.maxAspect || height / width > SEEDREAM_IMAGE_LIMITS.maxAspect))
    throw new ProtectedImageError('IMAGE_SIZE_UNSUPPORTED', `The ${what} is ${width}×${height}: layer extraction needs between 512×512 and 6000×6000 pixels in total and an aspect ratio between 1:16 and 16:1.`);
  const ext = meta.format === 'jpeg' ? 'jpg' : meta.format!;
  return { ext, mime: `image/${meta.format}`, bytes, input, width, height, orientationNormalized: rotate, hasAlpha: !!meta.hasAlpha, sha256: sha256(bytes) };
}

/** RGBA pixels, optionally resampled to `size` (a base at another resolution with the same aspect). */
export async function decodeRgba(bytes: Buffer, size?: SourceSize): Promise<Rgba> {
  let image = sharp(bytes).rotate();
  if (size) image = image.resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' });
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
/** The same pixels on white, as RGB: an opaque view to compare and to fill. */
export function flattenRgb(image: Rgba): Uint8Array {
  const n = image.width * image.height, out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { const a = image.data[i * 4 + 3] / 255; for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(image.data[i * 4 + c] * a + 255 * (1 - a)); }
  return out;
}
/** 1 where a pixel's centre is inside the rotated box, over `rect` (rect-local indices). */
export function polygonMask(box: SourceBox, rect: PixelRect): Uint8Array {
  const mask = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) if (insideBox(box, rect.x + x + 0.5, rect.y + y + 0.5)) mask[y * rect.width + x] = 1;
  return mask;
}
/** Every protected region over the whole canvas (1 inside), grown by `margin` pixels to take anti-aliased edges with it. */
export function regionCore(elements: Pick<ProtectedElement, 'box'>[], size: SourceSize, margin = 0): Uint8Array {
  const core = new Uint8Array(size.width * size.height);
  for (const e of elements) {
    const rect = pixelBounds(e.box, size); if (!rect) continue;
    const local = polygonMask(e.box, rect);
    for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) if (local[y * rect.width + x]) core[(rect.y + y) * size.width + rect.x + x] = 1;
  }
  return margin > 0 ? grow(core, size.width, size.height, margin) : core;
}
export const fillMargin = (size: SourceSize) => Math.max(2, Math.round(0.002 * Math.max(size.width, size.height)));
/** Above this share of strongly different border pixels, a region's box probably cuts through text or a logo. */
export const EDGE_CONTENT_PERCENT = 3;
/**
 * The share (%) of the pixels just outside a filled region (a 3 px ring, other regions excluded) that differ strongly
 * (largest channel difference over 90) from the ring's median colour: content the box cuts through, which a continuation
 * would smear inward. A heuristic: a strong pattern in the background can raise it too.
 */
export function edgeContent(rgb: Uint8Array, comp: Uint8Array, core: Uint8Array, w: number, h: number): number {
  const ring = grow(comp, w, h, 3), pixels: number[] = [];
  for (let i = 0; i < ring.length; i++) if (ring[i] && !core[i]) pixels.push(i);
  if (!pixels.length) return 0;
  const median = [0, 1, 2].map(c => { const v = pixels.map(i => rgb[i * 3 + c]).sort((a, b) => a - b); return v[v.length >> 1]; });
  let strong = 0;
  for (const i of pixels) if (Math.max(Math.abs(rgb[i * 3] - median[0]), Math.abs(rgb[i * 3 + 1] - median[1]), Math.abs(rgb[i * 3 + 2] - median[2])) > 90) strong++;
  return round(100 * strong / pixels.length, 1);
}

/**
 * An element's own pixels in the whole-pixel rectangle around its region. opaque: every pixel inside the region, as it is.
 * difference: protected where the source differs from the base (the background under it) by at least `threshold`, those
 * pixels exactly as they are; below half the threshold, transparent; in between (anti-aliased edges), the colour of the
 * nearest fully protected pixel with the alpha that explains the source over the base. Outside a rotated region alpha is 0.
 */
export async function extractRaster(source: Rgba, base: Rgba | undefined, element: Pick<ProtectedElement, 'box' | 'mask'>): Promise<{ png: Buffer; placement: PixelRect; opaquePercent: number; protectedPercent: number }> {
  const size = { width: source.width, height: source.height }, rect = pixelBounds(element.box, size);
  if (!rect) throw new ProtectedImageError('OFF_CANVAS', 'The region is not on the image.');
  const inside = polygonMask(element.box, rect), out = Buffer.alloc(rect.width * rect.height * 4), t = element.mask.threshold, low = t / 2;
  const difference = element.mask.mode === 'difference';
  if (difference && !base) throw new ProtectedImageError('BASE_REQUIRED', 'A difference mask needs the prepared base.');
  const at = (x: number, y: number) => ((rect.y + y) * size.width + rect.x + x) * 4;
  const d = new Float32Array(rect.width * rect.height);
  if (difference) for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) d[y * rect.width + x] = maxDiff(source.data, at(x, y), base!.data, at(x, y));
  let opaque = 0, any = 0, area = 0;
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    const j = y * rect.width + x, o = j * 4, s = at(x, y);
    out[o] = source.data[s]; out[o + 1] = source.data[s + 1]; out[o + 2] = source.data[s + 2];
    if (!inside[j]) { out[o + 3] = 0; continue; }
    area++;
    let alpha = source.data[s + 3];
    if (difference) {
      if (d[j] >= t) alpha = Math.min(alpha, 255);
      else if (d[j] < low) alpha = 0;
      else {
        // An edge pixel: the nearest fully protected pixel (within 3) is its ink colour F; alpha is the share of F that
        // explains the source pixel O over the base B (O ≈ a·F + (1 − a)·B).
        let best = -1, bestDist = Infinity;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= rect.width || yy >= rect.height || !inside[yy * rect.width + xx] || d[yy * rect.width + xx] < t) continue;
          const dist = dx * dx + dy * dy; if (dist < bestDist) { bestDist = dist; best = yy * rect.width + xx; }
        }
        if (best >= 0) {
          const f = at(best % rect.width, Math.floor(best / rect.width));
          let num = 0, den = 0;
          for (let c = 0; c < 3; c++) { const fb = source.data[f + c] - base!.data[s + c]; num += (source.data[s + c] - base!.data[s + c]) * fb; den += fb * fb; }
          const a = den > 0 ? Math.max(0, Math.min(1, num / den)) : 0;
          for (let c = 0; c < 3; c++) out[o + c] = source.data[f + c];
          alpha = Math.round(a * alpha);
        } else alpha = Math.round(alpha * (d[j] - low) / (t - low));
      }
    }
    out[o + 3] = alpha;
    if (alpha === 255) opaque++;
    if (alpha > 0) any++;
  }
  const png = await sharp(out, { raw: { width: rect.width, height: rect.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  return { png, placement: rect, opaquePercent: round(100 * opaque / Math.max(1, area), 1), protectedPercent: round(100 * any / Math.max(1, area), 1) };
}

/**
 * The source with every protected region continued from its surroundings, region by region: a plain field (flat colour,
 * gradient, soft glow) by a fitted surface; a design of a few flat colours by continuing those colours; anything else
 * (a photo, texture, shading) by a smooth colour field that invents no detail but is only an estimate. The first two are
 * trusted continuations; the last never is. Pixels outside the regions are the source's own.
 */
export async function localFill(source: Rgba, elements: Pick<ProtectedElement, 'id' | 'box'>[]): Promise<{ png: Buffer; mask: Uint8Array; regions: ProtectedFillRegion[]; filledPercent: number }> {
  const { width: w, height: h } = source, n = w * h, size = { width: w, height: h };
  const rgb = flattenRgb(source), core = regionCore(elements, size, fillMargin(size));
  const plain = plainFieldFill(rgb, core, w, h), out = Buffer.from(plain.out);
  const { labels, count } = label(core, w, h);
  const members: number[][] = Array.from({ length: count + 1 }, () => []);
  for (let i = 0; i < n; i++) if (labels[i]) members[labels[i]].push(i);
  const owners = elements.map(e => ({ id: e.id, mask: regionCore([e], size) }));
  const regions: ProtectedFillRegion[] = [], untrusted = new Uint8Array(n), comp = new Uint8Array(n);
  for (let l = 1; l <= count; l++) {
    const pixels = members[l], elementIds = owners.filter(o => pixels.some(i => o.mask[i])).map(o => o.id), areaPercent = round(100 * pixels.length / n, 2);
    for (const i of pixels) comp[i] = 1;
    // A box that cuts through content leaves part of it at its edge, which any continuation smears inward: never trusted.
    const edgeContentPercent = edgeContent(rgb, comp, core, w, h), cut = edgeContentPercent > EDGE_CONTENT_PERCENT;
    const edgeNote = cut ? ` Its edge crosses other content (${edgeContentPercent}% of the pixels around it differ strongly): the box may cut through text or a logo. Enlarge it to cover the whole element.` : '';
    if (plain.regions[l - 1]?.plain) regions.push({ elementIds, areaPercent, method: 'plain-field', trusted: !cut, edgeContentPercent, reason: `The surroundings are a plain field (${plain.regions[l - 1].explainedPercent}% on one smooth surface).${edgeNote}` });
    else {
      const difficulty = backgroundDifficulty(rgb, comp, w, h), graphic = difficulty.flatGraphic ? graphicFill(rgb, comp, w, h) : undefined;
      if (graphic) { for (const i of pixels) for (let c = 0; c < 3; c++) out[i * 3 + c] = graphic[i * 3 + c]; regions.push({ elementIds, areaPercent, method: 'graphic-fill', trusted: !cut, edgeContentPercent, reason: `The surroundings are flat colours (${difficulty.flatColorPercent}% flat); their regions are continued.${edgeNote}` }); }
      else { for (const i of pixels) untrusted[i] = 1; regions.push({ elementIds, areaPercent, method: 'smooth-fill', trusted: false, edgeContentPercent, reason: `The surroundings are ${difficulty.simpleGraphic ? 'shaded or a gradient' : 'textured or photographic'} (${difficulty.flatColorPercent}% flat colours): what lies under this region is unknown, so it is filled with a smooth estimate of the colours around it.${edgeNote}` }); }
    }
    for (const i of pixels) comp[i] = 0;
  }
  if (untrusted.some(Boolean)) {
    // Low frequency only: the surrounding colour and lighting pushed inward and smoothed. No texture is borrowed from
    // elsewhere in the creative, so nothing (another logo, a line of text) can be copied into the hole.
    const f = Float32Array.from(rgb), known = new Float32Array(n);
    for (let i = 0; i < n; i++) known[i] = untrusted[i] ? 0 : 1;
    const field = boxBlur(pushPull(maskedBlur(f, known, w, h, 12), known, w, h), w, h, 3, 6);
    for (let i = 0; i < n; i++) if (untrusted[i]) for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(field[i * 3 + c])));
  }
  let filled = 0; for (let i = 0; i < n; i++) if (core[i]) filled++;
  const png = await sharp(out, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
  return { png, mask: core, regions, filledPercent: round(100 * filled / n, 2) };
}
/** The filled pixels drawn over the base for review: filled areas tinted (trusted green, estimated amber). */
export async function fillPreview(base: Buffer, mask: Uint8Array, size: SourceSize, regions: ProtectedFillRegion[], elements: Pick<ProtectedElement, 'id' | 'box'>[]): Promise<Buffer> {
  const n = size.width * size.height, overlay = Buffer.alloc(n * 4), untrusted = regionCore(elements.filter(e => regions.some(r => !r.trusted && r.elementIds.includes(e.id))), size, fillMargin(size));
  for (let i = 0; i < n; i++) if (mask[i]) { const warn = untrusted[i]; overlay[i * 4] = warn ? 245 : 40; overlay[i * 4 + 1] = warn ? 158 : 170; overlay[i * 4 + 2] = warn ? 11 : 90; overlay[i * 4 + 3] = 90; }
  return sharp(base).composite([{ input: overlay, raw: { width: size.width, height: size.height, channels: 4 }, left: 0, top: 0 }]).png().toBuffer();
}

/**
 * A base as Seedream would get it, checked against the source per element: inside a protected region a clean base must
 * differ from the source (else the content is still in it and Seedream would decompose it too); outside, it should be the
 * same artwork (else it is another image, or not aligned).
 */
export function baseChecks(source: Rgba, base: Rgba, elements: Pick<ProtectedElement, 'id' | 'box' | 'mask'>[]) {
  const size = { width: source.width, height: source.height }, all = regionCore(elements, size, fillMargin(size));
  const checks = elements.map(e => {
    const rect = pixelBounds(e.box, size);
    if (!rect) return { elementId: e.id, meanDiff: 0, differsFromSource: false };
    const inside = polygonMask(e.box, rect);
    let sum = 0, count = 0, changed = 0;
    for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
      if (!inside[y * rect.width + x]) continue;
      const i = ((rect.y + y) * size.width + rect.x + x) * 4, d = maxDiff(source.data, i, base.data, i);
      sum += d; count++; if (d >= e.mask.threshold) changed++;
    }
    // Text or a logo is a few percent of its box at least; a base with under 1% changed still shows it.
    return { elementId: e.id, meanDiff: round(sum / Math.max(1, count)), differsFromSource: changed >= Math.max(4, 0.01 * count) };
  });
  let outside = 0, outsideCount = 0;
  for (let i = 0; i < size.width * size.height; i++) if (!all[i]) { outside += maxDiff(source.data, i * 4, base.data, i * 4); outsideCount++; }
  return { checks, outsideMeanDiff: round(outside / Math.max(1, outsideCount)) };
}

/** Seedream's editor selection of a finished run (the same rule as the editor import): back to front, every one placed. */
export function runEditorLayers(run: Pick<RunRecord, 'layers' | 'outputLayers' | 'editorLayerFiles'>): LayerInfo[] {
  const source = run.outputLayers ?? run.layers ?? [];
  if (run.editorLayerFiles === undefined) return [...source].sort((a, b) => a.zIndex - b.zIndex);
  const byFile = new Map(source.map(l => [l.file, l]));
  const picked = run.editorLayerFiles.map(f => byFile.get(f));
  if (!picked.length || picked.some(l => !l || l.placement.kind === 'unresolved')) throw new ProtectedImageError('RUN_LAYERS_INCOMPLETE', 'The run has no complete editor selection of placed layers.');
  return (picked as LayerInfo[]).sort((a, b) => a.zIndex - b.zIndex);
}
/** Seedream's layers composed on its own canvas, then mapped onto the source size. */
export async function seedreamComposite(runDir: string, run: RunRecord, size: SourceSize): Promise<Rgba> {
  if (!run.canvas) throw new ProtectedImageError('RUN_LAYERS_INCOMPLETE', 'The run has no output canvas.');
  const stack: OverlayOptions[] = [];
  for (const layer of runEditorLayers(run)) { const overlay = await placedOverlay(readFileSync(join(runDir, layer.file)), layer.placement, run.canvas); if (overlay) stack.push(overlay); }
  let image = sharp({ create: { width: run.canvas.width, height: run.canvas.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(stack).png();
  if (run.canvas.width !== size.width || run.canvas.height !== size.height) image = sharp(await image.toBuffer()).resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' }).png();
  return decodeRgba(await image.toBuffer());
}
/** An image fitted inside the box (contain, centred) and rotated with it, as an overlay in whole pixels. */
export async function boxOverlay(png: Buffer, box: SourceBox): Promise<OverlayOptions> {
  const w = Math.max(1, Math.round(box.width)), h = Math.max(1, Math.round(box.height));
  let input = await sharp(png).resize(w, h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' }).png().toBuffer();
  if (box.rotation) input = await sharp(input).rotate(box.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const meta = await sharp(input).metadata();
  return { input, left: Math.round(box.x + box.width / 2 - meta.width! / 2), top: Math.round(box.y + box.height / 2 - meta.height! / 2) };
}
/** Overlays clipped to the canvas (sharp refuses overlays that leave it). */
async function clipped(overlay: OverlayOptions, size: SourceSize): Promise<OverlayOptions | undefined> {
  const input = overlay.input as Buffer, meta = await sharp(input).metadata(), left = overlay.left ?? 0, top = overlay.top ?? 0;
  const x0 = Math.max(0, left), y0 = Math.max(0, top), x1 = Math.min(size.width, left + meta.width!), y1 = Math.min(size.height, top + meta.height!);
  if (x1 <= x0 || y1 <= y0) return undefined;
  if (x0 === left && y0 === top && x1 === left + meta.width! && y1 === top + meta.height!) return overlay;
  return { input: await sharp(input).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }).png().toBuffer(), left: x0, top: y0 };
}
export type ProtectedVisual = { element: Pick<ProtectedElement, 'id' | 'label' | 'box' | 'representation' | 'zIndex'>; png: Buffer; placement: { kind: 'raster'; rect: PixelRect } | { kind: 'box'; box: SourceBox } };

/**
 * The reconstruction: Seedream's layers, then every protected visual in its order, on the source's canvas; and how it
 * compares with the source (per-pixel largest channel difference): over everything, outside the protected regions, and per
 * element (its fully protected pixels must be exact). A duplicate is suspected where Seedream's own layers, under a
 * removed element, look more like the source than like the base it was given.
 */
export async function reconstruct(input: { source: Rgba; base: Rgba; seedream: Rgba; visuals: ProtectedVisual[]; elements: Pick<ProtectedElement, 'id' | 'label' | 'box' | 'representation' | 'mask'>[]; tolerance?: number })
  : Promise<{ png: Buffer; metrics: ProtectedReconstruction['metrics']; duplicates: ProtectedReconstruction['duplicates'] }> {
  const { source, base, seedream } = input, size = { width: source.width, height: source.height }, n = size.width * size.height, tolerance = input.tolerance ?? 8;
  const overlays: OverlayOptions[] = [];
  for (const v of [...input.visuals].sort((a, b) => a.element.zIndex - b.element.zIndex)) {
    const overlay = v.placement.kind === 'raster' ? { input: v.png, left: v.placement.rect.x, top: v.placement.rect.y } : await boxOverlay(v.png, v.placement.box);
    const fitted = await clipped(overlay, size); if (fitted) overlays.push(fitted);
  }
  const seedreamPng = await sharp(seedream.data, { raw: { width: size.width, height: size.height, channels: 4 } }).png().toBuffer();
  const png = await sharp(seedreamPng).composite(overlays).png().toBuffer();
  const recon = flattenRgb(await decodeRgba(png)), src = flattenRgb(source), seed = flattenRgb(seedream), prepared = flattenRgb(base);
  const d3 = (a: Uint8Array, b: Uint8Array, i: number) => Math.max(Math.abs(a[i * 3] - b[i * 3]), Math.abs(a[i * 3 + 1] - b[i * 3 + 1]), Math.abs(a[i * 3 + 2] - b[i * 3 + 2]));
  const mean3 = (a: Uint8Array, b: Uint8Array, i: number) => (Math.abs(a[i * 3] - b[i * 3]) + Math.abs(a[i * 3 + 1] - b[i * 3 + 1]) + Math.abs(a[i * 3 + 2] - b[i * 3 + 2])) / 3;
  const core = regionCore(input.elements, size, fillMargin(size));
  let sum = 0, within = 0, outSum = 0, outWithin = 0, outCount = 0;
  for (let i = 0; i < n; i++) {
    const m = mean3(recon, src, i), ok = d3(recon, src, i) <= tolerance;
    sum += m; if (ok) within++;
    if (!core[i]) { outSum += m; outCount++; if (ok) outWithin++; }
  }
  const visualOf = new Map(input.visuals.map(v => [v.element.id, v]));
  const perElement: ProtectedReconstruction['metrics']['protected'] = [], duplicates: ProtectedReconstruction['duplicates'] = [];
  for (const e of input.elements) {
    const rect = pixelBounds(e.box, size); if (!rect || onCanvasShare(e.box, size) <= 0) continue;
    const inside = polygonMask(e.box, rect), visual = visualOf.get(e.id);
    const alpha = visual?.placement.kind === 'raster' ? (await decodeRgba(visual.png)).data : undefined;
    let pixels = 0, opaque = 0, opaqueExact = 0, exact = 0, max = 0, total = 0, inkToSource = 0, inkToBase = 0, ink = 0;
    for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
      const j = y * rect.width + x; if (!inside[j]) continue;
      const i = (rect.y + y) * size.width + rect.x + x, d = d3(recon, src, i);
      pixels++; total += mean3(recon, src, i); if (d === 0) exact++; if (d > max) max = d;
      if (alpha && alpha[j * 4 + 3] === 255) { opaque++; if (d === 0) opaqueExact++; }
      // Where the source shows the protected content (it differs from the base), compare Seedream's own pixels with both.
      if (d3(src, prepared, i) >= e.mask.threshold) { ink++; inkToSource += mean3(seed, src, i); inkToBase += mean3(seed, prepared, i); }
    }
    perElement.push({ elementId: e.id, label: (e as { label: string }).label, representation: e.representation, pixels, opaquePixels: opaque, opaqueExactPercent: opaque ? round(100 * opaqueExact / opaque, 2) : 0,
      exactPercent: round(100 * exact / Math.max(1, pixels), 2), maxDiff: max, meanAbsDiff: round(total / Math.max(1, pixels)) });
    const toSource = ink ? round(inkToSource / ink) : 0, toBase = ink ? round(inkToBase / ink) : 0;
    duplicates.push({ elementId: e.id, label: (e as { label: string }).label, suspected: ink >= 16 && toBase > 12 && toSource < 0.6 * toBase, toSource, toBase });
  }
  return { png, duplicates, metrics: { tolerance, overall: { meanAbsDiff: round(sum / n), withinTolerancePercent: round(100 * within / n) },
    outsideProtected: { meanAbsDiff: round(outSum / Math.max(1, outCount)), withinTolerancePercent: round(100 * outWithin / Math.max(1, outCount)) }, protected: perElement } };
}
