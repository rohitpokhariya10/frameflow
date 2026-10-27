import { presentFields } from '../../compose/build.js';
import { overlayDocSchema, OVERLAY_SCHEMA } from '../../compose/overlay.js';
import { renderDoc } from '../../posters/service.js';
import { newId, now } from '../../store.js';
import type { StageContext } from '../runner.js';
import type { GeneratePosterInput } from './generatePoster.js';

/** No provider calls, resizing, crop or redraw. Optional copy is deterministic, native and explicitly reviewable. */
export async function reuseReference(ctx: StageContext, input: GeneratePosterInput) {
  const policy = input.referencePolicy!;
  const asset = ctx.db.assets.require(policy.primaryAssetId, 'Primary reference');
  const fields = presentFields(input.copy);
  const notes = ['Local reference reuse: no AI image was generated and no provider was called. Original raster text and logos remain. The original canvas dimensions are retained.'];
  if (fields.length) notes.push('New copy is editable. Check its position against existing raster text to avoid duplication or covering products.');
  const doc = overlayDocSchema.parse({
    schema: OVERLAY_SCHEMA, formatId: input.formatId,
    canvas: { width: asset.width, height: asset.height }, crop: { x: 0, y: 0, width: asset.width, height: asset.height },
    sceneAssetId: asset.id, brandKitId: null, logo: null, notes,
    texts: fields.map((field, i) => ({
      id: `text-${field}`, kind: 'text', field, text: input.copy[field], box: { x: 0.06, y: 0.05 + i * 0.085, width: 0.88, height: 0.08 },
      align: 'left', verticalAlign: 'top', fontFamily: 'Poppins', fontWeight: field === 'headline' ? 700 : 400,
      fontSizePct: field === 'headline' ? 5 : 2.2, minFontSizePct: 1.2, lineHeight: 1.1, uppercase: false,
      color: '#ffffff', plate: null, hidden: false,
    })),
  });
  const report = (await renderDoc(ctx.db, ctx.deps.storageDir, doc, null, { format: 'png', width: 64 })).report;
  const existing = ctx.db.posters.find(p => p.jobId === ctx.job.id);
  const poster = existing ?? ctx.db.posters.insert({
    id: newId('pst'), campaignId: input.campaignId, jobId: ctx.job.id, sceneAssetId: asset.id, rawSceneAssetId: null,
    provenance: 'reference_reuse', expectedProductCount: policy.scene?.products.length,
    exactProducts: { requested: true, applied: true, ok: true, detail: 'The entire primary reference asset is reused unchanged. Every source pixel, including all original products, remains in the stored scene.' },
    overlay: doc, layoutReport: report, reviewStatus: fields.length ? 'needs_review' : 'ok', approvedAt: null, createdAt: now(), updatedAt: now(),
  });
  return { posterId: poster.id, reviewStatus: poster.reviewStatus };
}
