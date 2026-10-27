/**
 * A Product with Text creative opened in the editor: an ordinary decomposition run made from its own layers, locally and
 * free (no planner, no provider). Written with createComposedRun, so the run dashboard, Saved Runs, the artifacts
 * download and the editor import read it like a Text & Graphics creative's run:
 *
 *   layers   back to front: the template's base (everything behind the objects), the frame, decorations and podiums,
 *            the characters, products and brand logo (each its own picture at its place), then every text plate, bank or
 *            payment logo and text group
 *   editor   the base opens locked; decorations as pictures; characters, products and the brand logo as replaceable
 *            pictures; texts as editable text and plates as shapes (from the run's `creative` record)
 *
 * One run per creative revision: asking again returns it. The creative and its template are only read.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ProductCreative, ProductSnapshot } from '@frameflow/shared';
import { sha256 } from '../pixels.js';
import { createComposedRun, type VariantRunLayer } from '../../creativeTemplates/composedRun.js';
import { readRun, saveRunRecord, type RunRecord } from '../../layerizeExperiment.js';
import { imageSvg, shapeSvg, svgPng, textInk, textSvg } from '../../../templateStudio/masterCreatives/render.js';
import type { CreativeRunLayer } from '../master/creativeRun.js';

/**
 * How product creative runs are made; a run of an earlier version is not reused (it stays). Version 3: a creative's own
 * background (a variation's aspect ratio or style) and the run's provenance (variation, input files and their hashes, cost).
 */
export const PRODUCT_CREATIVE_RUN_VERSION = 6;
type Box = { x: number; y: number; width: number; height: number };
const rotatedBounds = (b: Box & { rotation?: number }): Box => {
  if (!b.rotation) return b;
  const a = b.rotation * Math.PI / 180, w = Math.abs(b.width * Math.cos(a)) + Math.abs(b.height * Math.sin(a)), h = Math.abs(b.width * Math.sin(a)) + Math.abs(b.height * Math.cos(a));
  return { x: b.x + (b.width - w) / 2, y: b.y + (b.height - h) / 2, width: w, height: h };
};
const placed = (b: Box, c: { width: number; height: number }): Box | null => {
  const x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y)), r = Math.min(c.width, Math.ceil(b.x + b.width)), d = Math.min(c.height, Math.ceil(b.y + b.height));
  return r > x && d > y ? { x, y, width: r - x, height: d - y } : null;
};

export function existingProductCreativeRun(runsDir: string, templateId: string, c: Pick<ProductCreative, 'id' | 'revision'>): RunRecord | null {
  if (!existsSync(runsDir)) return null;
  for (const id of readdirSync(runsDir).sort().reverse()) {
    if (!existsSync(join(runsDir, id, 'run.json'))) continue;
    try { const run = readRun(join(runsDir, id)); if (run.creative?.product && run.creative.masterId === templateId && run.creative.creativeId === c.id && run.creative.creativeRevision === c.revision && run.creative.version === PRODUCT_CREATIVE_RUN_VERSION) return run; } catch { /* another run's unreadable record */ }
  }
  return null;
}

type Layer = VariantRunLayer & { z: number; meta: CreativeRunLayer };
/** The creative's layers, back to front (the run's, and a preview's when drawn over each other). */
export async function productLayers(read: (file: string) => Buffer, snapshot: ProductSnapshot, c: ProductCreative): Promise<{ ordered: Layer[]; objects: ProductCreative['objects'] }> {
  const canvas = c.canvas, layers: Layer[] = [];
  let n = 1;
  const file = (kind: string) => `layer-${String(n++).padStart(2, '0')}-${kind}.png`;
  // The creative's own background (made at its canvas size) or the template's base (the template's size); never stretched.
  const own = c.background, baseFile = own?.file ?? snapshot.base.file, baseBytes = read(baseFile), meta = await sharp(baseBytes).metadata();
  if (meta.width !== canvas.width || meta.height !== canvas.height) throw new Error(`The background (${meta.width}×${meta.height}) does not match the creative's canvas (${canvas.width}×${canvas.height}).`);
  const base = await sharp(baseBytes).ensureAlpha().png().toBuffer();
  const fill = c.canvasFill?.transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : c.canvasFill?.color ?? '#ffffff';
  layers.push({ file: 'layer-00-canvas.png', name: 'Canvas fill', description: 'Canvas colour or transparency, below every editable layer.',
    png: await sharp({ create: { ...canvas, channels: 4, background: fill } }).png().toBuffer(), placement: { x: 0, y: 0, ...canvas }, kind: 'full-canvas',
    semantic: { id: 'canvas-fill', type: 'background' }, z: -100001, meta: { file: 'layer-00-canvas.png', kind: 'background', elementIds: [], hidden: false, z: -100001 } });
  const baseZ = c.backgroundSource?.z ?? -1;
  layers.push({ file: 'layer-00-background.png', name: 'Background', description: own ? `This creative's background (${own.method === 'letterbox' ? 'the template\'s artwork with plain margins added' : own.method === 'plain-bands' ? 'the template\'s artwork with its plain margins lengthened' : 'the template\'s artwork'}${own.restyled ? ', recoloured' : ''}); behind objects it is the template's estimate` : 'The template\'s background with its text, logos and objects taken out (behind them it is continued: an estimate)', png: base,
    placement: { x: 0, y: 0, ...canvas }, kind: 'full-canvas', semantic: { id: 'background', type: 'background' }, z: baseZ, meta: { file: 'layer-00-background.png', kind: 'background', elementIds: [], hidden: false, z: baseZ } });
  // Objects, back to front (decorations below the characters and products).
  const objects = [...c.objects].filter(o => !o.hidden).sort((a, b) => a.z - b.z);
  for (const o of objects) {
    const p = placed(rotatedBounds(o.box), canvas);
    if (!p) continue;
    // A display stand (a podium-kind object with its own cut-out) is an object like the products: movable on its own,
    // in the creative's order (under the products standing on it).
    const decoration = o.kind === 'frame' || o.kind === 'decoration', f = file(decoration ? 'artwork' : o.kind === 'podium' ? 'stand' : o.kind);
    const png = await sharp(read(o.asset.file)).resize(Math.max(1, Math.round(o.box.width)), Math.max(1, Math.round(o.box.height)), { fit: 'fill' }).png().toBuffer();
    const angle = o.box.rotation ?? 0, cx = o.box.x - p.x + o.box.width / 2, cy = o.box.y - p.y + o.box.height / 2;
    const cropped = await svgPng(p.width, p.height, `<image x="${o.box.x - p.x}" y="${o.box.y - p.y}" width="${o.box.width}" height="${o.box.height}" opacity="${o.opacity ?? 1}" transform="rotate(${angle} ${cx} ${cy})" preserveAspectRatio="none" href="data:image/png;base64,${png.toString('base64')}"/>`);
    layers.push({ file: f, name: o.label.slice(0, 120), description: o.kind === 'podium' ? 'A display stand the products stand on (its own layer; where products hid it, continued)' : decoration ? 'Part of the template\'s design (its own pixels)' : `The ${o.kind === 'brand-logo' ? 'brand logo' : o.kind} (a replaceable picture)`, png: cropped,
      placement: p, kind: 'bbox-crop', semantic: { id: o.id, type: o.kind }, z: o.z, meta: { file: f, kind: decoration ? 'artwork' : 'object', elementIds: [o.id], hidden: false, z: o.z } });
  }
  // The overlays above every object, in their own order.
  const overlays: typeof layers = [];
  for (const s of c.shapes.filter(x => !x.hidden)) {
    const e = s.stroke ? s.stroke.width / 2 + 1 : 0, p = placed(rotatedBounds({ ...s.box, x: s.box.x - e, y: s.box.y - e, width: s.box.width + 2 * e, height: s.box.height + 2 * e }), canvas);
    if (!p) continue;
    const f = file('shape');
    overlays.push({ file: f, name: `Shape · ${c.groups.find(g => g.id === s.groupId)?.label.slice(0, 40) ?? 'shape'}`, description: 'An editable shape (opens as a shape)', png: await svgPng(p.width, p.height, shapeSvg(s, p.x, p.y)),
      placement: p, kind: 'bbox-crop', semantic: { id: s.id, type: 'shape' }, z: s.z, meta: { file: f, kind: 'shape', elementIds: [s.id], hidden: false, z: s.z } });
  }
  for (const i of c.images.filter(x => !x.hidden)) {
    const p = placed(rotatedBounds(i.box), canvas);
    if (!p) continue;
    const f = file(i.category === 'qr' ? 'qr' : 'logo');
    overlays.push({ file: f, name: i.label.slice(0, 120), description: `${i.category} (its own picture, replaceable in the editor)`, png: await svgPng(p.width, p.height, await imageSvg(i, read(i.asset.file), p.x, p.y)),
      placement: p, kind: 'bbox-crop', semantic: { id: i.id, type: i.category }, z: i.z, meta: { file: f, kind: 'image', elementIds: [i.id], hidden: false, z: i.z } });
  }
  // Absolute order can interleave individual words with objects and logos; never flatten a whole group at its lowest z.
  const textGroups = c.absoluteZOrder ? c.texts.map(t => ({ id: t.id, label: t.text, textIds: [t.id] })) : c.groups.map(g => ({ ...g, textIds: c.texts.filter(t => t.groupId === g.id).map(t => t.id) }));
  for (const g of textGroups) {
    const texts = c.texts.filter(t => g.textIds.includes(t.id) && t.text.trim() && !t.hidden), inks = texts.map(textInk).filter((b): b is Box => !!b);
    if (!inks.length) continue;
    const x0 = Math.min(...inks.map(b => b.x)), y0 = Math.min(...inks.map(b => b.y)), p = placed({ x: x0, y: y0, width: Math.max(...inks.map(b => b.x + b.width)) - x0, height: Math.max(...inks.map(b => b.y + b.height)) - y0 }, canvas);
    if (!p) continue;
    const f = file('text'), z = Math.min(...texts.map(t => t.z));
    overlays.push({ file: f, name: `Text · ${g.label.slice(0, 60)}`, description: 'Editable text (opens as text, not as a picture)', png: await svgPng(p.width, p.height, texts.map(t => textSvg(t, p.x, p.y)).join('')),
      placement: p, kind: 'bbox-crop', semantic: { id: g.id, type: 'text' }, z, meta: { file: f, kind: 'text', elementIds: texts.map(t => t.id), hidden: false, z } });
  }
  return { ordered: c.absoluteZOrder ? [...layers, ...overlays].sort((a, b) => a.z - b.z) : [...layers, ...overlays.sort((a, b) => a.z - b.z)], objects };
}
export const flatten = (ordered: Pick<Layer, 'png' | 'placement'>[]) => sharp(ordered[0].png).composite(ordered.slice(1).map(l => ({ input: l.png, left: l.placement.x, top: l.placement.y }))).png().toBuffer();
/** The creative drawn as one picture (a variation's preview), at most `maxSide` pixels on its long side. */
export async function renderProductCreative(read: (file: string) => Buffer, snapshot: ProductSnapshot, c: ProductCreative, maxSide?: number): Promise<Buffer> {
  const png = await flatten((await productLayers(read, snapshot, c)).ordered), long = Math.max(c.canvas.width, c.canvas.height);
  return maxSide && long > maxSide ? sharp(png).resize(Math.round(c.canvas.width * maxSide / long), Math.round(c.canvas.height * maxSide / long)).png().toBuffer() : png;
}

export async function createProductCreativeRun(runsDir: string, read: (file: string) => Buffer, snapshot: ProductSnapshot, c: ProductCreative): Promise<RunRecord> {
  const canvas = c.canvas, { ordered, objects } = await productLayers(read, snapshot, c), composite = await flatten(ordered);
  const { dir } = await createComposedRun(runsDir, { composite, layers: ordered.map(({ z, meta, ...l }) => { void z; void meta; return l; }),
    origin: { kind: 'master-creative', generationId: c.templateId, variantId: c.id }, source: 'master-creative', editorLayerFiles: ordered.map(l => l.file) });
  const run = readRun(dir);
  // Overlay elements sit above the objects in the editor too: their order numbers start above every object's.
  const lift = c.absoluteZOrder ? 0 : Math.max(0, ...objects.map(o => o.z)) + 1;
  // Raw assets, including hidden/off-canvas objects, accompany the preview layers. Reopening never bakes transforms in.
  const files: Record<string, string> = {};
  for (const f of new Set([c.background?.file ?? snapshot.base.file, ...(c.backgroundSource ? [c.backgroundSource.file] : []), ...c.objects.map(o => o.asset.file), ...c.images.map(i => i.asset.file)])) {
    const raw = await sharp(read(f)).png().toBuffer(), name = `native-${sha256(raw).slice(0, 24)}.png`;
    writeFileSync(join(dir, name), raw); files[f] = name;
  }
  const native = { creative: { ...structuredClone(c), absoluteZOrder: true as const,
    texts: c.texts.map(t => ({ ...t, z: t.z + lift })), images: c.images.map(i => ({ ...i, z: i.z + lift })), shapes: c.shapes.map(s => ({ ...s, z: s.z + lift })),
    background: c.background ?? { ...snapshot.base, ...canvas, method: 'template' as const, restyled: false, filledPercent: 0 } }, files,
    warnings: snapshot.quality.issues.map(i => `${i.blocking ? 'Blocking: ' : ''}${i.message}`) };
  // What the run was made from: every picture layer's source file and hash (the cut-outs reused as they are), no provider.
  const inputs = [{ layer: 'layer-00-background.png', role: 'background', file: c.background?.file ?? snapshot.base.file, source: c.background ? 'creative-background' : 'template-base' },
    ...objects.map(o => ({ layer: ordered.find(l => l.semantic?.id === o.id)?.file ?? '', role: o.kind, file: o.asset.file, source: o.asset.kind === 'template' ? 'template-cutout' : 'uploaded-cutout' })),
    ...c.images.filter(i => !i.hidden).map(i => ({ layer: ordered.find(l => l.semantic?.id === i.id)?.file ?? '', role: 'logo', file: i.asset.file, source: i.asset.kind === 'master' ? 'template-logo' : 'uploaded-logo' })),
  ].filter(x => x.layer).map(x => ({ ...x, sha256: sha256(read(x.file)) }));
  run.creative = { version: PRODUCT_CREATIVE_RUN_VERSION, product: true, native, words: snapshot.words, masterId: c.templateId, masterRevision: c.templateRevision, creativeId: c.id, creativeRevision: c.revision, name: c.name, canvas: { ...canvas },
    texts: c.texts.filter(t => t.text.trim()).map(t => ({ ...t, z: t.z + lift })), shapes: c.shapes.map(s => ({ ...s, z: s.z + lift })), groups: c.groups,
    layers: ordered.map(l => (l.meta.kind === 'shape' || l.meta.kind === 'image' || l.meta.kind === 'text' ? { ...l.meta, z: l.meta.z + lift } : l.meta)), aiGenerated: c.origin.kind === 'variation',
    provenance: { ...(snapshot.preparation ? { preparation: snapshot.preparation.separation } : {}), processingVersion: PRODUCT_CREATIVE_RUN_VERSION, inputs, cost: { usd: 0, providerRequests: 0, segmentation: 'reused' },
      textLayersSentToProviders: 0, ...(c.layout ? { layout: c.layout } : {}),
      ...(c.variation && c.origin.kind === 'variation' ? { variation: { jobId: c.origin.jobId, index: c.origin.index, kind: c.variation.kind, title: c.variation.title, aspectRatio: c.variation.aspectRatio ?? 'original', checks: c.variation.checks?.status } } : {}) } };
  saveRunRecord(dir, run);
  return run;
}
