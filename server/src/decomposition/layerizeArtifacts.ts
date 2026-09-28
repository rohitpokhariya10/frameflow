/**
 * Seedream layerize output → local artifacts, shared by the direct prompt experiment and the OpenAI → Seedream runner.
 * The coordinate system is the decoded base layer (z_index 0). A layer is placed only when its geometry is resolved:
 * full-canvas, a crop matching its bbox, or a crop uniformly scaled to its bbox (bboxScaleFit). Anything else stays
 * unresolved and is flagged, never stretched. Raw returned PNGs are kept as downloaded.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { normalizeProviderOutput, type ProviderLayerMetadata } from './providers/adapters.js';
import { bboxScaleFit } from './phases/discovery.js';

export type PlacementKind = 'base' | 'full-canvas' | 'bbox-crop' | 'bbox-scaled' | 'unresolved';
/** x/y/width/height are base-canvas pixels. For unresolved layers they are the layer's natural size at 0,0 (not placed). */
export type Placement = { kind: PlacementKind; x: number; y: number; width: number; height: number; reason?: string };
export type LayerInfo = {
  index: number; file: string; zIndex: number; name?: string; description?: string;
  bboxAbsolute?: [number, number, number, number]; bboxNormalized?: [number, number, number, number];
  pixelWidth: number; pixelHeight: number; opaquePercent: number; placement: Placement;
};
export type Canvas = { width: number; height: number };
const SIZE_TOLERANCE = 2;

/** Provider box in base pixels: absolute when given, else normalized [0, 1000] scaled to the base. */
function boxOf(meta: ProviderLayerMetadata, canvas: Canvas): [number, number, number, number] | undefined {
  if (meta.bboxAbsolute) return meta.bboxAbsolute;
  const n = meta.bboxNormalized;
  return n && [n[0] * canvas.width / 1000, n[1] * canvas.height / 1000, n[2] * canvas.width / 1000, n[3] * canvas.height / 1000];
}

export function placeLayer(size: Canvas, meta: ProviderLayerMetadata, canvas: Canvas): Placement {
  const natural = { x: 0, y: 0, width: size.width, height: size.height };
  if (size.width === canvas.width && size.height === canvas.height) return { kind: 'full-canvas', x: 0, y: 0, width: canvas.width, height: canvas.height };
  const box = boxOf(meta, canvas);
  if (!box) return { kind: 'unresolved', ...natural, reason: `No bounding box and ${size.width}×${size.height} differs from the base ${canvas.width}×${canvas.height}.` };
  if (box[2] > canvas.width + SIZE_TOLERANCE || box[3] > canvas.height + SIZE_TOLERANCE) return { kind: 'unresolved', ...natural, reason: `Bounding box [${box.join(', ')}] lies outside the base ${canvas.width}×${canvas.height}.` };
  const [x0, y0] = [Math.round(box[0]), Math.round(box[1])];
  if (Math.abs(size.width - (box[2] - box[0])) <= SIZE_TOLERANCE && Math.abs(size.height - (box[3] - box[1])) <= SIZE_TOLERANCE) return { kind: 'bbox-crop', x: x0, y: y0, width: size.width, height: size.height };
  const fit = bboxScaleFit(size.width, size.height, box);
  if (fit.ok) return { kind: 'bbox-scaled', x: x0, y: y0, width: Math.max(1, Math.round(fit.boxWidth)), height: Math.max(1, Math.round(fit.boxHeight)) };
  return { kind: 'unresolved', ...natural, reason: `${size.width}×${size.height} does not fit bbox ${Math.round(fit.boxWidth)}×${Math.round(fit.boxHeight)} uniformly (aspect error ${(fit.aspectError * 100).toFixed(1)}%, scale ${fit.scale.toFixed(2)}).` };
}

/** The base is z_index 0 (fal: "base image always has z_index 0"); otherwise the lowest layer without a box. */
export function placeLayers(layers: { width: number; height: number; meta: ProviderLayerMetadata }[]): { canvas: Canvas; placements: Placement[]; warnings: string[] } {
  const warnings: string[] = [];
  let base = layers.findIndex(l => l.meta.zIndex === 0);
  if (base < 0) {
    const candidates = layers.map((l, i) => ({ l, i })).filter(({ l }) => !l.meta.bboxAbsolute && !l.meta.bboxNormalized).sort((a, b) => a.l.meta.zIndex - b.l.meta.zIndex);
    base = candidates[0]?.i ?? -1;
    warnings.push(base < 0 ? 'NO_BASE_LAYER: no z_index 0 layer; the largest layer defines the canvas and nothing is marked as base.' : 'NO_Z0_BASE: the lowest unboxed layer is used as base.');
  }
  const canvas = base >= 0 ? { width: layers[base].width, height: layers[base].height } : [...layers].sort((a, b) => b.width * b.height - a.width * a.height).map(l => ({ width: l.width, height: l.height }))[0];
  const placements = layers.map((l, i) => i === base ? { kind: 'base' as const, x: 0, y: 0, width: canvas.width, height: canvas.height } : placeLayer(l, l.meta, canvas));
  const unresolved = placements.filter(p => p.kind === 'unresolved').length;
  if (unresolved) warnings.push(`UNRESOLVED_PLACEMENT: ${unresolved} layer(s) could not be placed without distortion; they are kept raw and left out of the reconstruction.`);
  return { canvas, placements, warnings };
}

export const escapeXml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
export const checker = (width: number, height: number, cell = 16) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><pattern id="c" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse"><rect width="${cell * 2}" height="${cell * 2}" fill="#fff"/><rect width="${cell}" height="${cell}" fill="#e6e4de"/><rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="#e6e4de"/></pattern></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`);

/** Every layer on a checkerboard with its z-order, name and a second line of detail. */
export async function writeContactSheet(file: string, tiles: { png: Buffer; title: string; sub: string }[]) {
  const cell = 320, label = 64, cols = Math.max(1, Math.min(4, tiles.length)), rows = Math.max(1, Math.ceil(tiles.length / cols));
  const overlays: OverlayOptions[] = [];
  for (const [i, t] of tiles.entries()) {
    const x = (i % cols) * cell, y = Math.floor(i / cols) * (cell + label);
    const fitted = await sharp(t.png).resize(cell - 16, cell - 16, { fit: 'inside' }).png().toBuffer();
    const m = await sharp(fitted).metadata();
    overlays.push({ input: checker(cell - 16, cell - 16), left: x + 8, top: y + 8 }, { input: fitted, left: x + 8 + Math.floor((cell - 16 - m.width!) / 2), top: y + 8 + Math.floor((cell - 16 - m.height!) / 2) });
    overlays.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${label}"><text x="8" y="22" font-family="Helvetica, Arial" font-size="15" font-weight="700" fill="#1d2622">${escapeXml(t.title.slice(0, 44))}</text><text x="8" y="44" font-family="Helvetica, Arial" font-size="12" fill="#5b625d">${escapeXml(t.sub.slice(0, 60))}</text></svg>`), left: x, top: y + cell });
  }
  await sharp({ create: { width: cols * cell, height: rows * (cell + label), channels: 4, background: '#f7f6f2' } }).composite(overlays).png().toFile(file);
}

/** Back-to-front composite of resolved layers only, on transparency. The original image is never placed underneath. */
export async function composeLayers(file: string, canvas: Canvas, items: { png: Buffer; zIndex: number; placement: Placement }[]) {
  const stack: OverlayOptions[] = [];
  for (const item of [...items].sort((a, b) => a.zIndex - b.zIndex)) {
    const p = item.placement;
    if (p.kind === 'unresolved') continue;
    const needsResize = p.kind === 'bbox-scaled' || p.kind === 'base';
    let png = needsResize ? await sharp(item.png).resize(p.width, p.height, { fit: 'fill' }).png().toBuffer() : item.png;
    // Clip to the canvas: sharp rejects overlays that extend beyond it.
    const left = Math.max(0, p.x), top = Math.max(0, p.y);
    const meta = await sharp(png).metadata();
    const width = Math.min(meta.width! - (left - p.x), canvas.width - left), height = Math.min(meta.height! - (top - p.y), canvas.height - top);
    if (width < 1 || height < 1) continue;
    if (width !== meta.width || height !== meta.height) png = await sharp(png).extract({ left: left - p.x, top: top - p.y, width, height }).png().toBuffer();
    stack.push({ input: png, left, top });
  }
  await sharp({ create: { width: canvas.width, height: canvas.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(stack).png().toFile(file);
}

/**
 * Rebuilds all local outputs from a saved raw fal response. Layer files already on disk are reused, so re-rendering
 * never downloads twice and never calls the model. Writes layer-NN.png, layers.json, contact-sheet.png, reconstructed.png.
 */
export async function renderLayerizeOutputs(dir: string, raw: unknown, download: (url: string) => Promise<Buffer>): Promise<{ canvas: Canvas; layers: LayerInfo[]; warnings: string[] }> {
  const output = normalizeProviderOutput('seedream', raw);
  const decoded: { png: Buffer; file: string; width: number; height: number; opaque: number; meta: ProviderLayerMetadata }[] = [];
  for (const [i, image] of output.images.entries()) {
    const file = `layer-${String(i).padStart(2, '0')}.png`, local = join(dir, file);
    const png = existsSync(local) ? readFileSync(local) : await download(image.url);
    if (!existsSync(local)) writeFileSync(local, png);
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let opaque = 0; for (let p = 3; p < data.length; p += 4) if (data[p] > 127) opaque++;
    decoded.push({ png, file, width: info.width, height: info.height, opaque: opaque / (info.width * info.height), meta: output.layers?.[i] ?? { zIndex: i } });
  }
  const { canvas, placements, warnings } = placeLayers(decoded);
  const layers: LayerInfo[] = decoded.map((d, i) => ({ index: i, file: d.file, zIndex: d.meta.zIndex, name: d.meta.name, description: d.meta.description, bboxAbsolute: d.meta.bboxAbsolute, bboxNormalized: d.meta.bboxNormalized,
    pixelWidth: d.width, pixelHeight: d.height, opaquePercent: Math.round(d.opaque * 1000) / 10, placement: placements[i] }));
  writeFileSync(join(dir, 'layers.json'), JSON.stringify({ canvas, warnings, layers }, null, 2));
  await writeContactSheet(join(dir, 'contact-sheet.png'), decoded.map((d, i) => ({ png: d.png,
    title: `${d.meta.zIndex}. ${d.meta.name ?? (placements[i].kind === 'base' ? '(base image)' : 'layer')}`, sub: `${placements[i].kind} · ${d.width}×${d.height} · ${layers[i].opaquePercent}% opaque` })));
  await composeLayers(join(dir, 'reconstructed.png'), canvas, decoded.map((d, i) => ({ png: d.png, zIndex: d.meta.zIndex, placement: placements[i] })));
  return { canvas, layers, warnings };
}
