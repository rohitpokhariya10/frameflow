/**
 * Seedream layerize output → local artifacts, shared by the direct prompt experiment and the OpenAI → Seedream runner.
 * The coordinate system is the decoded base layer (z_index 0). A layer is placed only when its geometry is resolved:
 * full-canvas, a crop matching its bbox, or a crop uniformly scaled to its bbox (bboxScaleFit). Anything else stays
 * unresolved and is flagged, never stretched. Raw returned PNGs are kept as downloaded.
 * For framed layouts, the outer background layer is rebuilt locally as a clean full-canvas asset (outerBackground.ts);
 * its layer entry then points at outer-background.png and keeps the raw provider file in `rawFile`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { normalizeProviderOutput, type ProviderLayerMetadata } from './providers/adapters.js';
import { bboxScaleFit } from './phases/discovery.js';
import { rebuildOuterBackground } from './outerBackground.js';

export type PlacementKind = 'base' | 'full-canvas' | 'bbox-crop' | 'bbox-scaled' | 'unresolved';
/** x/y/width/height are base-canvas pixels. For unresolved layers they are the layer's natural size at 0,0 (not placed). */
export type Placement = { kind: PlacementKind; x: number; y: number; width: number; height: number; reason?: string };
export type LayerInfo = {
  index: number; file: string; zIndex: number; name?: string; description?: string;
  bboxAbsolute?: [number, number, number, number]; bboxNormalized?: [number, number, number, number];
  pixelWidth: number; pixelHeight: number; opaquePercent: number; placement: Placement;
  /** Set when this layer was rebuilt locally: `file` is the rebuilt asset, `rawFile` the untouched provider layer. */
  rawFile?: string; rebuilt?: { method: 'local-background-fill'; from: string[]; foreground: string[]; holePercent: number; texture: string; contaminationPercent: number; residualPercent: number;
    source?: 'original' | 'base'; enclosedPercent?: number };
  /** Runs with the recursive refinement (recursiveDecomposition.ts) only: which pass made this layer, and from what. */
  provenance?: LayerProvenance;
  /** Reconciled planner identity; type takes precedence over ambiguous provider names. */
  semantic?: { id: string; type: string; editableIndependently: boolean };
  /** A group made to protect a person or an interaction (interactionGrouping.ts): which layers it holds and why. */
  grouping?: LayerGrouping;
  /** The base layer of a refined run: how its clean background was made and whether it is verified clean. */
  cleanBackground?: { status: CleanBackgroundStatus; method: CleanBackgroundMethod };
};
/**
 * sourcePass: 0 = the initial decomposition of the uploaded image, 1–2 = residual passes. sourceImage: the image that
 * pass decomposed. role: background, or the foreground role read from the layer's name. bbox: its opaque pixels in
 * canvas pixels [left, top, right, bottom]. mask: the file whose alpha is its mask. groupedFrom: provider files merged
 * into this one layer (tiny residual fragments).
 */
export type LayerProvenance = { sourcePass: number; sourceImage: string; parentResidualId?: string; providerFile: string; providerRequestId?: string; providerZIndex: number;
  role: string; bbox?: [number, number, number, number]; mask: string; areaPercent?: number; confidence?: number; groupedFrom?: string[] };
/** Why a layer is part of a group: the parent, an object held with an interleaved grip, a worn ornament, a finger fragment,
 * a body part cut from its person, content on a held object, a tiny attached piece, or a small decoration. */
export type GroupMemberRole = 'parent' | 'held_object' | 'worn_ornament' | 'finger_fragment' | 'body_part' | 'object_content' | 'attached_fragment' | 'decoration' | 'cast_shadow' | 'text_effect';
/** groupedWithParent: members stay with `parent`; protectedInteraction: a hand and what it holds kept intact. */
export type LayerGrouping = { groupedWithParent: boolean; parent: string; protectedInteraction?: 'hand_holding_object'; attachmentReason: string;
  members: { file: string; name?: string; role: GroupMemberRole; reason: string }[] };
/** provider-clean: Seedream's base was clean; scene-clean: Seedream's own scene layers over its base were; continued-clean:
 * a plain background field (flat color, gradient, glow) continued locally, validated, with no call; ai-reconstructed: one
 * image edit, validated; contaminated: foreground remains; fallback: the edit was unusable or unavailable. */
export type CleanBackgroundStatus = 'provider-clean' | 'scene-clean' | 'continued-clean' | 'ai-reconstructed' | 'contaminated' | 'fallback';
export type CleanBackgroundMethod = 'provider-base' | 'scene-composite' | 'plain-field' | 'ai-reconstruction' | 'graphic-fill' | 'local-fill';
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

/** A resolved layer as a canvas overlay (resized when its placement is scaled, clipped to the canvas); undefined if unresolved or off-canvas. */
export async function placedOverlay(png: Buffer, p: Placement, canvas: Canvas): Promise<OverlayOptions | undefined> {
  if (p.kind === 'unresolved') return undefined;
  const needsResize = p.kind === 'bbox-scaled' || p.kind === 'base';
  let input = needsResize ? await sharp(png).resize(p.width, p.height, { fit: 'fill' }).png().toBuffer() : png;
  // Clip to the canvas: sharp rejects overlays that extend beyond it.
  const left = Math.max(0, p.x), top = Math.max(0, p.y);
  const meta = await sharp(input).metadata();
  const width = Math.min(meta.width! - (left - p.x), canvas.width - left), height = Math.min(meta.height! - (top - p.y), canvas.height - top);
  if (width < 1 || height < 1) return undefined;
  if (width !== meta.width || height !== meta.height) input = await sharp(input).extract({ left: left - p.x, top: top - p.y, width, height }).png().toBuffer();
  return { input, left, top };
}

/** Back-to-front composite of resolved layers only, on transparency. The original image is never placed underneath. */
export async function composeLayers(file: string, canvas: Canvas, items: { png: Buffer; zIndex: number; placement: Placement }[]) {
  const stack: OverlayOptions[] = [];
  for (const item of [...items].sort((a, b) => a.zIndex - b.zIndex)) {
    const overlay = await placedOverlay(item.png, item.placement, canvas);
    if (overlay) stack.push(overlay);
  }
  await sharp({ create: { width: canvas.width, height: canvas.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(stack).png().toFile(file);
}

/** Background role from the provider's layer name (the Template A prompt asks for role-based names). */
export function backgroundRole(name?: string): 'outer' | 'inner' | 'border' | undefined {
  if (!name) return undefined;
  if (/\bouter\b/i.test(name)) return 'outer';
  if (/backdrop|\binner\b/i.test(name)) return 'inner';
  if (/border|frame/i.test(name)) return 'border';
  return undefined;
}

/**
 * Rebuilds all local outputs from a saved raw fal response. Layer files already on disk are reused, so re-rendering
 * never downloads twice and never calls the model. Writes layer-NN.png, layers.json, contact-sheet.png, reconstructed.png.
 * `sourceImage`: the uploaded image, the preferred source of real outer-background pixels. `rebuildOuterBackground`
 * (default true): the framed-layout outer-background rebuild; templates whose backgrounds it does not fit turn it off.
 */
export async function renderLayerizeOutputs(dir: string, raw: unknown, download: (url: string) => Promise<Buffer>, options: { sourceImage?: Buffer; rebuildOuterBackground?: boolean } = {}): Promise<{ canvas: Canvas; layers: LayerInfo[]; warnings: string[] }> {
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
  writeFileSync(join(dir, 'raw-layers.json'), JSON.stringify({ canvas, warnings, layers }, null, 2));
  // Framed layouts: replace the provider's outer background (a placeholder so far) with a clean full-canvas rebuild from
  // the base, filled under the inner backdrop and border. Needs the base and at least one resolved inner backdrop.
  const pngs = decoded.map(d => d.png);
  const baseAt = placements.findIndex(p => p.kind === 'base');
  const roles = decoded.map((d, i) => (i === baseAt || placements[i].kind === 'unresolved' ? undefined : backgroundRole(d.meta.name)));
  const holeAt = roles.flatMap((role, i) => (role === 'inner' || role === 'border' ? [i] : []));
  // Foreground: every other resolved layer (subject, held objects). The base may still contain them, sometimes past the frame.
  const foregroundAt = roles.flatMap((role, i) => (i !== baseAt && !role && placements[i].kind !== 'unresolved' ? [i] : []));
  const overlays = async (at: number[]) => (await Promise.all(at.map(i => placedOverlay(pngs[i], placements[i], canvas)))).filter((o): o is OverlayOptions => !!o);
  const rebuilt = options.rebuildOuterBackground !== false && baseAt >= 0 && roles.includes('inner')
    ? await rebuildOuterBackground(pngs[baseAt], canvas, await overlays(holeAt), await overlays(foregroundAt), { source: options.sourceImage })
    : undefined;
  if (options.rebuildOuterBackground !== false && baseAt >= 0 && roles.includes('inner') && !rebuilt) {
    warnings.push('OUTER_BACKGROUND_NOT_REBUILT: less than 1% of the canvas is visible outer background, so the provider layer is kept as returned.');
  }
  if (rebuilt && rebuilt.residualPercent > 0.2) warnings.push(`OUTER_BACKGROUND_RESIDUAL: ${rebuilt.residualPercent}% of the rebuilt outer background still stands out from its surroundings.`);
  if (rebuilt) {
    writeFileSync(join(dir, 'outer-background.png'), rebuilt.png);
    const outerAt = roles.indexOf('outer');
    const info = { rebuilt: { method: 'local-background-fill' as const, from: [rebuilt.source === 'original' ? 'original image' : decoded[baseAt].file, ...holeAt.map(i => decoded[i].file)], foreground: foregroundAt.map(i => decoded[i].file),
      holePercent: rebuilt.holePercent, texture: rebuilt.texture, contaminationPercent: rebuilt.contaminationPercent, residualPercent: rebuilt.residualPercent, source: rebuilt.source, enclosedPercent: rebuilt.enclosedPercent },
      file: 'outer-background.png', pixelWidth: canvas.width, pixelHeight: canvas.height, opaquePercent: 100, placement: { kind: 'full-canvas' as const, x: 0, y: 0, width: canvas.width, height: canvas.height } };
    if (outerAt >= 0) {
      Object.assign(layers[outerAt], { rawFile: layers[outerAt].file, ...info });
      pngs[outerAt] = rebuilt.png;
    } else {
      // No outer layer returned: add the rebuilt one just above the base.
      layers.push({ index: layers.length, zIndex: decoded[baseAt].meta.zIndex + 0.5, name: 'Outer background (rebuilt)', ...info });
      pngs.push(rebuilt.png);
    }
  }
  writeFileSync(join(dir, 'layers.json'), JSON.stringify({ canvas, warnings, layers }, null, 2));
  await writeContactSheet(join(dir, 'contact-sheet.png'), layers.map((l, i) => ({ png: pngs[i],
    title: `${l.zIndex}. ${l.name ?? (l.placement.kind === 'base' ? '(base image)' : 'layer')}`, sub: `${l.placement.kind}${l.rebuilt ? ' · rebuilt locally' : ''} · ${l.pixelWidth}×${l.pixelHeight} · ${l.opaquePercent}% opaque` })));
  await composeLayers(join(dir, 'reconstructed.png'), canvas, layers.map((l, i) => ({ png: pngs[i], zIndex: l.zIndex, placement: l.placement })));
  return { canvas, layers, warnings };
}
