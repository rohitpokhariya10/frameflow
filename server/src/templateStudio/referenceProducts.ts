/** Adapter for FrameFlow's existing mask validation, masked-edit inputs and exact-pixel compositor. */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { checkMask, composeVariant, cutoutFiles, generationInputs, maskBox, maskPng, maskRaster, sourceRaster, type Raster, type VariantSubject } from '../decomposition/creativeTemplates/variantCompose.js';
import { ingestAsset } from './assets/ingest.js';
import { reserveBudget, settleUsage } from './costs/budget.js';
import { FAL_RATES } from './costs/rateCard.js';
import { readStorageFile } from './storage.js';
import { newId, now, type ReferencePolicy } from './store.js';
import { JobStageError, type StageContext } from './jobs/runner.js';
import type { GeneratePosterInput } from './jobs/kinds/generatePoster.js';

type Box = { x: number; y: number; width: number; height: number };
export interface PreparedReference {
  sourceAssetId: string; width: number; height: number;
  products: { id: string; label: string; maskAssetId: string; cutoutAssetId: string; region: Box }[];
  subjects: GeneratePosterInput['subjects'];
  removedMaskAssetIds: string[]; warnings: string[];
}
const pixelBox = (b: Box, w: number, h: number) => {
  const x = Math.round(b.x * w), y = Math.round(b.y * h);
  return { x, y, width: Math.max(1, Math.min(w - x, Math.round(b.width * w))), height: Math.max(1, Math.min(h - y, Math.round(b.height * h))) };
};
const union = (masks: Uint8Array[], n: number) => {
  const out = new Uint8Array(n);
  for (const m of masks) for (let i = 0; i < n; i++) out[i] = Math.max(out[i], m[i]);
  return out;
};
async function save(ctx: StageContext, bytes: Buffer, label: string, role: 'cutout' | 'generated_scene' = 'cutout') {
  return (await ingestAsset({ buffer: bytes, role, label, filename: `${label}.png` }, { db: ctx.db, storageDir: ctx.deps.storageDir })).asset;
}
const bytes = (ctx: StageContext, id: string) => readStorageFile(ctx.deps.storageDir, ctx.db.assets.require(id).normalisedPath);

/** Conservative guard before spending on masks or planning. Ambiguous/occluded geometry needs a human, never a redraw. */
export function validateReferenceEdit(policy: ReferencePolicy) {
  if (policy.localReuse || !policy.scene) return;
  if (policy.scene.confidence < 0.7) throw new JobStageError('reference_review_required', 'The primary product inventory is uncertain. Review the reference and analyse it again before editing; unchanged reuse is available.');
  for (const p of policy.scene.products) {
    if (p.confidence < 0.7 || p.transparent) throw new JobStageError('reference_review_required', `${p.label}: uncertain or transparent edges require manual review. Use unchanged reference reuse; automatic editing will not redraw this product.`);
    const action = policy.actions.find(a => a.productId === p.id)?.action ?? 'keep';
    if (p.overlaps.length && (action !== 'keep' || p.overlaps.some(id => policy.actions.find(a => a.productId === id)?.action !== 'keep'))) {
      throw new JobStageError('reference_review_required', `${p.label} overlaps a changed product. Hidden surfaces cannot be recovered from source pixels; review or separate the products before editing.`);
    }
  }
}

export async function prepareReference(ctx: StageContext, input: GeneratePosterInput): Promise<PreparedReference | null> {
  const policy = input.referencePolicy;
  if (!policy || policy.localReuse || !policy.scene?.products.length) return null;
  validateReferenceEdit(policy);
  const source = await sourceRaster(await bytes(ctx, policy.primaryAssetId));
  const { width, height } = source;
  const products: PreparedReference['products'] = [], subjects: GeneratePosterInput['subjects'] = [];
  const removedMaskAssetIds: string[] = [], allMasks: Uint8Array[] = [];
  const segmenter = ctx.deps.segmenter?.();
  const env = ctx.deps.env!;
  for (const p of policy.scene.products) {
    const action = policy.actions.find(a => a.productId === p.id)!;
    const cache = createHash('sha256').update(JSON.stringify([ctx.db.assets.require(policy.primaryAssetId).sha256, p, 'studio-mask/1'])).digest('hex');
    const cacheLabel = `Reference mask ${cache}`;
    let maskAsset = ctx.db.assets.find(a => a.label === cacheLabel);
    if (!maskAsset) {
      if (!segmenter || segmenter.provider !== 'sam3') throw new JobStageError('segmentation_required', 'Reference editing requires FrameFlow SAM-3 masks (FAL_KEY and CREATIVE_CUTOUT_PROVIDER=sam3). Unchanged Match reuse works without masks.');
      const key = `reference_mask:${p.id}`;
      try { reserveBudget(ctx.db, env, { jobId: ctx.job.id, jobKind: ctx.job.kind, stage: key, estimateMicroUsd: FAL_RATES.cutoutSam3.perRequest }); }
      catch (err) { throw new JobStageError('budget_exceeded', (err as Error).message); }
      let result;
      try {
        result = await segmenter.segment({ image: await bytes(ctx, policy.primaryAssetId), width, height, targets: [{ label: p.label, box: pixelBox(p.box, width, height) }] }, () => {});
      } catch (err) { throw new JobStageError('segmentation_failed', `Product ${p.label} could not be segmented. The request may have been billed and was not retried. ${(err as Error).message}`, { outcomeUnknown: true }); }
      settleUsage(ctx.db, { jobId: ctx.job.id, stage: key, model: `fal ${segmenter.provider}`, usage: null, providerRequestId: result.requestIds.join(','), estimateMicroUsd: FAL_RATES.cutoutSam3.perRequest });
      const mask = await maskRaster(result.masks?.[0] ?? result.mask, width, height);
      const check = checkMask(mask, width, height, [{ label: p.label, box: pixelBox(p.box, width, height) }], []);
      if (!check.ok) throw new JobStageError('segmentation_review_required', `${p.label}: ${check.problems.join(' ')} No image generated. Review the mask or use unchanged reference reuse.`);
      maskAsset = await save(ctx, await maskPng(mask, width, height), cacheLabel);
    }
    const mask = await maskRaster(await bytes(ctx, maskAsset.id), width, height);
    // Two unrelated instances must not silently resolve to the same mask.
    for (const prior of allMasks) {
      let hit = 0, count = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i] >= 128) { count++; if (prior[i] >= 128) hit++; }
      if (count && hit / count > 0.2) throw new JobStageError('segmentation_review_required', 'Product masks overlap ambiguously or identify the same instance. No products were removed; manual mask review is required.');
    }
    allMasks.push(mask);
    if (action.action !== 'keep') removedMaskAssetIds.push(maskAsset.id);
    if (action.action === 'remove') continue;
    let own = mask, region = p.box;
    if (action.action === 'replace') {
      const replacement = ctx.db.assets.require(action.replacementAssetId);
      if (!replacement.hasAlpha) throw new JobStageError('cutout_required', 'Replacement products need transparent cutouts.');
      const target = pixelBox(p.box, width, height);
      const trimmed = await sharp(await bytes(ctx, replacement.id)).ensureAlpha().trim({ threshold: 1 }).toBuffer();
      const placed = await sharp(trimmed).resize(target.width, target.height, { fit: 'contain', background: '#00000000' }).ensureAlpha().raw().toBuffer();
      own = new Uint8Array(width * height);
      for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
        const i = (target.y + y) * width + target.x + x, j = (y * target.width + x) * 4;
        own[i] = placed[j + 3];
        if (own[i]) for (let c = 0; c < 3; c++) source.rgb[i * 3 + c] = placed[j + c];
      }
      const bounds = maskBox(own, width, height).box;
      if (!bounds) throw new JobStageError('empty_cutout', 'Replacement cutout is empty.');
      region = { x: bounds.x / width, y: bounds.y / height, width: bounds.width / width, height: bounds.height / height };
    }
    const full = await cutoutFiles(source, own);
    const cutout = await save(ctx, await sharp(full.subject).trim({ threshold: 1 }).png().toBuffer(), `${p.label} source pixels`);
    const ownAsset = action.action === 'keep' ? maskAsset : await save(ctx, full.mask, `${p.id} replacement mask`);
    const name = action.action === 'replace' ? input.subjects.find(s => s.assetId === action.replacementAssetId)!.name : p.label;
    const subject = ctx.db.subjects.find(s => s.primaryAssetId === cutout.id) ?? ctx.db.subjects.insert({
      id: newId('sub'), primaryAssetId: cutout.id, name, subjectType: p.identity, isSku: true,
      analysis: null, analysisModel: null, analysisCacheKey: null, analysisConfidence: p.confidence, createdAt: now(), updatedAt: now(),
    });
    subjects.push({ subjectId: subject.id, assetId: cutout.id, name, subjectType: p.identity, isSku: true, referenceProductId: p.id });
    products.push({ id: p.id, label: name, maskAssetId: ownAsset.id, cutoutAssetId: cutout.id, region });
  }
  const prepared = await save(ctx, await sharp(source.rgb, { raw: { width, height, channels: 3 } }).png().toBuffer(), `Prepared reference ${ctx.job.id}`, 'generated_scene');
  return { sourceAssetId: prepared.id, width, height, products, subjects, removedMaskAssetIds,
    warnings: ['Protected products retain their source camera view and geometry. New lighting, reflections and hidden surfaces need visual review; they are not proven by the pixel check.'] };
}

async function rasters(ctx: StageContext, prep: PreparedReference) {
  const source = await sourceRaster(await bytes(ctx, prep.sourceAssetId));
  const subjects: VariantSubject[] = await Promise.all(prep.products.map(async p => ({ id: p.id, label: p.label, mask: await maskRaster(await bytes(ctx, p.maskAssetId), source.width, source.height), shadow: false })));
  return { source, subjects, mask: union(subjects.map(s => s.mask), source.width * source.height) };
}
function fillRegions(mask: Uint8Array, source: Raster, regions: Box[], value: number) {
  for (const b of regions) {
    const r = pixelBox(b, source.width, source.height);
    for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) mask[y * source.width + x] = value;
  }
}

export async function referenceEditInputs(ctx: StageContext, input: GeneratePosterInput, prep: PreparedReference, size: { width: number; height: number }) {
  const { source, mask } = await rasters(ctx, prep);
  const policy = input.referencePolicy!;
  const editSource = { ...source, rgb: Buffer.from(source.rgb) };
  const protectedMask = Uint8Array.from(mask);
  if (input.fidelityMode !== 'match') {
    // No blue studio pixels can enter Explore's primary image: only protected product pixels on neutral grey.
    for (let i = 0; i < mask.length; i++) if (!mask[i]) for (let c = 0; c < 3; c++) editSource.rgb[i * 3 + c] = 220;
  }
  if (policy.text === 'keep') fillRegions(protectedMask, source, policy.scene!.textRegions.map(t => t.box), 255);
  if (input.fidelityMode === 'match' && !input.direction && !input.occasion) {
    protectedMask.fill(255);
    fillRegions(protectedMask, source, policy.actions.filter(a => a.action !== 'keep').map(a => policy.scene!.products.find(p => p.id === a.productId)!.box), 0);
    if (policy.text === 'remove') fillRegions(protectedMask, source, policy.scene!.textRegions.map(t => t.box), 0);
    for (let i = 0; i < mask.length; i++) protectedMask[i] = Math.max(protectedMask[i], mask[i]);
  }
  const inputs = await generationInputs(editSource, protectedMask, size);
  return inputs;
}

export async function composeReference(ctx: StageContext, input: GeneratePosterInput, prep: PreparedReference, generated: Buffer, placement: Box, providerSize: string) {
  const { source, subjects, mask: productMask } = await rasters(ctx, prep);
  const generatedMeta = await sharp(generated).metadata();
  const [gw, gh] = providerSize.split('x').map(Number);
  const actual = { x: Math.round(placement.x * generatedMeta.width! / gw), y: Math.round(placement.y * generatedMeta.height! / gh), width: Math.round(placement.width * generatedMeta.width! / gw), height: Math.round(placement.height * generatedMeta.height! / gh) };
  const composed = subjects.length ? await composeVariant(generated, actual, source, subjects) : null;
  let composite = composed?.composite ?? await sharp(generated).extract({ left: actual.x, top: actual.y, width: actual.width, height: actual.height }).resize(source.width, source.height).png().toBuffer();
  if (composed && !composed.preservation.ok) throw new JobStageError('preservation_failed', 'Exact source-pixel verification failed. The generated redraw was not accepted.');
  const policy = input.referencePolicy!;
  const restore = new Uint8Array(source.width * source.height);
  if (input.fidelityMode === 'match' && !input.direction && !input.occasion) {
    restore.fill(255);
    fillRegions(restore, source, policy.actions.filter(a => a.action !== 'keep').map(a => policy.scene!.products.find(p => p.id === a.productId)!.box), 0);
    if (policy.text === 'remove') fillRegions(restore, source, policy.scene!.textRegions.map(t => t.box), 0);
  }
  if (policy.text === 'keep') fillRegions(restore, source, policy.scene!.textRegions.map(t => t.box), 255);
  const rgb = await sharp(composite).removeAlpha().raw().toBuffer();
  const plateRgb = await sharp(composed?.plate ?? composite).removeAlpha().raw().toBuffer();
  for (let i = 0; i < restore.length; i++) if (restore[i] && !productMask[i]) for (let c = 0; c < 3; c++) plateRgb[i * 3 + c] = source.rgb[i * 3 + c];
  const plate = await sharp(plateRgb, { raw: { width: source.width, height: source.height, channels: 3 } }).png().toBuffer();
  for (let i = 0; i < restore.length; i++) if (restore[i]) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = source.rgb[i * 3 + c];
  composite = await sharp(rgb, { raw: { width: source.width, height: source.height, channels: 3 } }).png().toBuffer();
  const layers = [];
  for (const layer of composed?.subjects ?? []) {
    const asset = await save(ctx, layer.png, `Protected layer ${ctx.job.id} ${layer.id}`);
    layers.push({ productId: layer.id, assetId: asset.id, box: layer.placement });
  }
  return { composite, plate, layers, detail: `${subjects.length} selected products composed from source pixels; ${composed?.preservation.checkedPixels ?? 0} opaque pixels verified. Mask quality and scene integration still require visual review.` };
}
