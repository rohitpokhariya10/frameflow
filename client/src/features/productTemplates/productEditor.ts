/** Product creatives use the existing Konva document, text adapters, asset store and revision APIs. */
import { centreRotationToOrigin, isOfferFont, type CreativeInstance, type DesignLayer, type DesignVariant, type ProductCreative, type ProjectDocument } from '@frameflow/shared';
import { assets } from '../../lib/assets/runtimeAssets';
import { isDesignVariant } from '../../lib/persistence/schema';
import { creativeAssetIdOf, creativeFromEditor, creativeScale, creativeTextElement, editorLayerBox, shapeLayer } from '../masterTemplates/creativeDocument';
import { loadCreativeFonts } from '../masterTemplates/creativeText';
import type { CreativeRun } from '../masterTemplates/creativeRun';
import { exportPng } from '../export/exportPng';
import { productApi } from './api';

const objectAssetId = (cid: string, id: string, file: string) => `product-${cid}-${id}-${file}`;
const baseAssetId = (cid: string, file: string) => `product-base-${cid}-${file}`;
type Deps = { file: (name: string) => Promise<Blob>; assets: { putAsset(id: string, blob: Blob): Promise<unknown>; deleteAsset(id: string): Promise<unknown>; getAsset?(id: string): Promise<{ blob: Blob } | null | undefined> }; newId?: () => string; now?: () => string };

export async function productRunDocument(run: CreativeRun, deps: Deps): Promise<ProjectDocument> {
  const native = run.creative.native!, c = native.creative, newId = deps.newId ?? (() => crypto.randomUUID()), at = deps.now?.() ?? new Date().toISOString();
  if (typeof document !== 'undefined') await loadCreativeFonts(c);
  const width = Math.floor(c.canvas.width * creativeScale(c.canvas, c)), s = width / c.canvas.width, height = Math.floor(c.canvas.height * s);
  const stored: string[] = [];
  const put = async (id: string, file: string) => {
    const raw = native.files[file]; if (!raw) throw new Error(`Missing native asset: ${file}`);
    const existed = !!(await deps.assets.getAsset?.(id));
    await deps.assets.putAsset(id, await deps.file(raw)); if (!existed) stored.push(id); return id;
  };
  try {
    const base = c.backgroundSource ?? { file: c.background!.file, box: { x: 0, y: 0, ...c.canvas, rotation: 0 }, opacity: 1, hidden: false, locked: true };
    const origin = centreRotationToOrigin({ ...base.box, x: base.box.x * s, y: base.box.y * s, width: base.box.width * s, height: base.box.height * s });
    const layers: DesignLayer[] = [{ id: 'art-background', type: 'image', assetId: await put(baseAssetId(c.id, base.file), base.file), name: 'Background', role: 'generic-image',
      x: origin.x, y: origin.y, width: base.box.width * s, height: base.box.height * s, rotation: base.box.rotation, opacity: base.opacity, visible: !base.hidden, locked: base.locked, zIndex: c.backgroundSource?.z ?? -1000 }];
    for (const o of c.objects) {
      const b = { ...o.box, rotation: o.box.rotation ?? 0 }, origin = centreRotationToOrigin({ ...b, x: b.x * s, y: b.y * s, width: b.width * s, height: b.height * s });
      layers.push({ id: `object-${o.id}`, type: 'image', assetId: await put(objectAssetId(c.id, o.id, o.asset.file), o.asset.file), name: o.label, role: 'generic-image',
        x: origin.x, y: origin.y, width: b.width * s, height: b.height * s, rotation: b.rotation, opacity: o.opacity ?? 1, visible: !o.hidden, locked: !!o.locked, zIndex: o.z });
    }
    for (const i of c.images) {
      const b = i.box, origin = centreRotationToOrigin({ ...b, x: b.x * s, y: b.y * s, width: b.width * s, height: b.height * s });
      layers.push({ id: `layer-${i.id}`, type: 'image', assetId: await put(creativeAssetIdOf(c.id, i), i.asset.file), name: i.label, role: 'logo',
        x: origin.x, y: origin.y, width: b.width * s, height: b.height * s, rotation: b.rotation, opacity: 1, visible: !i.hidden, locked: i.locked, zIndex: i.z, fit: 'contain', focalPoint: { x: 0.5, y: 0.5 } });
    }
    layers.push(...c.shapes.map(sh => shapeLayer(sh, s)));
    const variant: DesignVariant = { id: `product-${newId()}`, name: c.name.slice(0, 120), revision: 0, canvas: { width, height, backgroundColor: c.canvasFill?.color ?? '#FFFFFF', ...(c.canvasFill?.transparent ? { transparent: true } : {}) }, productTemplate: true,
      layers, elements: c.texts.map(t => creativeTextElement(t, s, { masterId: c.templateId, words: run.creative.words ?? [] }, true)),
      importedFrom: { templateId: c.templateId, resultId: `run-${run.id}`, runId: run.id },
      creative: { product: true, ...(c.masterEditing ? { masterEditing: true } : {}), masterId: c.templateId, masterRevision: c.templateRevision, creativeId: c.id, syncedRevision: c.revision, scale: s, size: { ...c.canvas }, warnings: native.warnings } };
    if (!isDesignVariant(variant)) throw new Error('The native layers did not pass the editor document checks.');
    return { schemaVersion: 1, id: `design-${newId()}`, name: c.name.slice(0, 120), createdAt: at, updatedAt: at, variants: [variant] };
  } catch (error) {
    await Promise.all(stored.map(id => deps.assets.deleteAsset(id).catch(() => undefined)));
    throw error;
  }
}

/** Save source coordinates and raw pictures; no rasterized text, no provider request and no write to the parent master. */
export async function saveProductVariant(variant: DesignVariant): Promise<ProductCreative> {
  const link = variant.creative;
  if (!link?.product) throw new Error('This design is not linked to a product creative.');
  const c = await productApi.getCreative(link.masterId, link.creativeId);
  if (c.revision !== link.syncedRevision) throw new Error('This creative changed elsewhere. Reopen the saved revision before saving.');
  const s = link.scale, canvas = link.size ? { ...link.size } : { width: Math.round(variant.canvas.width / s), height: Math.round(variant.canvas.height / s) };
  // One common ordering survives save/reopen, including text below an object or a logo.
  const order = [...(variant.layers ?? []), ...variant.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  const rank = new Map(order.map((el, i) => [el.id, i]));
  const mapped = { ...variant, elements: variant.elements.map(el => ({ ...el, zIndex: rank.get(el.id)! })), layers: (variant.layers ?? []).map(l => ({ ...l, zIndex: rank.get(l.id)! })) };
  const instance = { ...c, schemaVersion: 1, masterId: c.templateId, masterRevision: c.templateRevision, origin: { kind: 'master' }, editor: null, exports: [], history: [] } as unknown as CreativeInstance;
  const objectLayers = new Set(c.objects.map(o => `object-${o.id}`));
  const converted = creativeFromEditor({ ...mapped, layers: mapped.layers.filter(l => !objectLayers.has(l.id)) }, instance, isOfferFont);
  if (converted.problems.length) throw new Error(converted.problems.join(' '));
  const upload = async (assetId: string, name: string) => {
    const stored = await assets.getAsset(assetId); if (!stored) throw new Error(`The saved picture for ${name} is missing.`);
    return (await productApi.uploadAsset(c.templateId, c.id, stored.blob, name)).asset;
  };
  for (const u of converted.uploads) {
    const image = converted.creative.images.find(i => i.id === u.imageId);
    if (image) image.asset = await upload(u.assetId, u.name);
  }
  const objects: ProductCreative['objects'] = [];
  for (const o of c.objects) {
    const l = mapped.layers.find(l => l.id === `object-${o.id}`);
    if (!l || l.type !== 'image') continue;
    if (!l.assetId) throw new Error(`Choose a picture for ${l.name} before saving.`);
    const asset = l.assetId === objectAssetId(c.id, o.id, o.asset.file) ? o.asset : { ...await upload(l.assetId, l.name), kind: 'upload' as const, background: 'transparent' as const };
    objects.push({ ...o, asset, box: editorLayerBox(l, s), hidden: !l.visible, locked: l.locked, opacity: l.opacity, z: l.zIndex ?? 0 });
  }
  const bg = mapped.layers.find(l => l.id === 'art-background');
  let background = c.background;
  const originalBase = c.backgroundSource?.file ?? c.background?.file ?? (await productApi.snapshot(c.templateId, c.templateRevision)).base.file;
  const baseFile = bg?.type === 'image' && bg.assetId && bg.assetId !== baseAssetId(c.id, originalBase) ? (await upload(bg.assetId, 'background-source.png')).file : originalBase;
  const backgroundSource = { file: baseFile, box: bg ? editorLayerBox(bg, s) : { x: 0, y: 0, ...c.canvas, rotation: 0 }, opacity: bg?.opacity ?? 1, hidden: !bg?.visible, locked: bg?.locked ?? true, z: bg?.zIndex ?? -1000 };
  const canvasFill = { color: variant.canvas.backgroundColor, transparent: !!variant.canvas.transparent };
  const priorBase = c.backgroundSource ?? { file: originalBase, box: { x: 0, y: 0, ...c.canvas, rotation: 0 }, opacity: 1, hidden: false, locked: true };
  const unchangedBackground = backgroundSource.file === priorBase.file && JSON.stringify(backgroundSource.box) === JSON.stringify(priorBase.box) && backgroundSource.opacity === priorBase.opacity && backgroundSource.hidden === priorBase.hidden &&
    canvasFill.color === (c.canvasFill?.color ?? '#FFFFFF') && canvasFill.transparent === !!c.canvasFill?.transparent && canvas.width === c.canvas.width && canvas.height === c.canvas.height;
  if (!unchangedBackground) {
    const png = await exportPng({ ...variant, canvas: { ...variant.canvas, transparent: true }, elements: [], layers: bg ? [bg] : [] }, 1 / s, canvas);
    const a = (await productApi.uploadAsset(c.templateId, c.id, png, 'background.png')).asset;
    background = { file: a.file, sha256: a.sha256, ...canvas, method: 'template', restyled: false, filledPercent: 0 };
  }
  const out: ProductCreative = { ...c, name: variant.name, canvas, canvasFill, backgroundSource, objects, texts: converted.creative.texts, images: converted.creative.images, shapes: converted.creative.shapes, groups: converted.creative.groups, absoluteZOrder: true, ...(background ? { background } : {}) };
  return productApi.saveCreative(c.templateId, c.id, { expectedRevision: c.revision, creative: out });
}
