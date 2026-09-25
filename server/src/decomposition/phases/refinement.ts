import sharp from 'sharp';
import { clampRect, createTransform, nativeToModel } from '../image/coordinates.js';
import type { ImageTransform } from '../image/coordinates.js';
import { binaryMask, constrainMatte, decodeMask, mapMaskToNative, maskBounds, morphMask, overlapMasks, validateGuidance } from '../image/masks.js';
import type { Mask } from '../image/masks.js';
import type { Rect } from '../image/types.js';
import { ProviderError } from '../providers/adapters.js';
import type { Infer, InferenceRequest } from '../providers/inference.js';

export type RefinementObject = {
  id: string;
  label: string;
  /** Accepted visible support in working-master coordinates, including all disconnected components. */
  mask: Mask;
  points?: InferenceRequest['points'];
  boxes?: InferenceRequest['boxes'];
  box?: Rect;
  excludedMask?: Mask;
  /** Explicit user confirmation of visible ownership permits retaining the accepted mask on refinement failure. */
  ownershipConfirmed?: boolean;
  softEdges?: boolean;
};
export type RefinedObject = {
  id: string;
  label: string;
  visibleOwnership: Mask;
  alpha: Mask;
  transform: ImageTransform;
  warnings: string[];
  reviewRequired: boolean;
  refinementAccepted: boolean;
};

function paddedBounds(object: RefinementObject): Rect {
  const bounds = maskBounds(object.mask);
  if (!bounds) throw new ProviderError('EMPTY_MASK', 'The selected object has no visible pixels.');
  const padding = Math.max(16, Math.ceil(Math.max(bounds.width, bounds.height) * 0.1));
  let left = bounds.x - padding, top = bounds.y - padding, right = bounds.x + bounds.width + padding, bottom = bounds.y + bounds.height + padding;
  // Keep supplied face/finger exclusions in the actual model crop whenever points identify them.
  for (const point of object.points ?? []) {
    left = Math.min(left, point.x - 4); top = Math.min(top, point.y - 4);
    right = Math.max(right, point.x + 5); bottom = Math.max(bottom, point.y + 5);
  }
  for (const box of object.boxes ?? (object.box ? [object.box] : [])) {
    left = Math.min(left, box.x); top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height);
  }
  return clampRect({ x: left, y: top, width: right - left, height: bottom - top }, object.mask.width, object.mask.height);
}

function interiorPoint(mask: Mask): { x: number; y: number; label: 1 } {
  const interior = morphMask(binaryMask(mask), 2, 'erode');
  const candidates = interior.data.some(Boolean) ? interior : mask;
  const bounds = maskBounds(candidates)!;
  const centerX = bounds.x + bounds.width / 2, centerY = bounds.y + bounds.height / 2;
  let closest = Infinity, index = 0;
  for (let i = 0; i < candidates.data.length; i++) if (candidates.data[i]) {
    const distance = (i % mask.width - centerX) ** 2 + (Math.floor(i / mask.width) - centerY) ** 2;
    if (distance < closest) { closest = distance; index = i; }
  }
  return { x: index % mask.width, y: Math.floor(index / mask.width), label: 1 };
}

function mappedGuidance(object: RefinementObject, transform: ImageTransform) {
  const points = object.points?.some(point => point.label === 1) ? object.points : [interiorPoint(object.mask), ...(object.points ?? [])];
  const toPoint = (point: NonNullable<InferenceRequest['points']>[number]) => {
    const mapped = nativeToModel({ x: point.x + 0.5, y: point.y + 0.5 }, transform);
    return { x: Math.min(transform.modelWidth - 1, Math.max(0, Math.floor(mapped.x))), y: Math.min(transform.modelHeight - 1, Math.max(0, Math.floor(mapped.y))), label: point.label, ...(point.objectId === undefined ? {} : { objectId: point.objectId }) };
  };
  const boxes = (object.boxes ?? [object.box ?? maskBounds(object.mask)!]).map(box => {
    const origin = nativeToModel(box, transform);
    const result = clampRect({ x: origin.x, y: origin.y, width: box.width * transform.scaleX, height: box.height * transform.scaleY }, transform.modelWidth, transform.modelHeight);
    return result;
  });
  return { points: points.map(toPoint), boxes };
}

function ordinaryOutputFailure(error: unknown): boolean {
  return error instanceof ProviderError && ['PROVIDER_EMPTY_OUTPUT', 'PROVIDER_INVALID_IMAGE', 'PROVIDER_SCHEMA_CHANGED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_CANDIDATE_LIMIT'].includes(error.code);
}

/** Refine observed support on contextual master crops. Rejected refinements never replace accepted visible ownership. */
export async function refineObjects(master: Buffer, infer: Infer, objects: RefinementObject[]): Promise<{ objects: RefinedObject[]; warnings: string[]; reviewRequired: boolean }> {
  if (objects.length > 6) throw new ProviderError('OBJECT_LIMIT', 'Refinement supports at most six selected objects.');
  const metadata = await sharp(master).metadata();
  const results: RefinedObject[] = [];
  for (const object of objects) {
    if (object.mask.width !== metadata.width || object.mask.height !== metadata.height) throw new ProviderError('MASK_DIMENSION_MISMATCH', 'Refinement support must use working-master coordinates.');
    if (object.excludedMask && (object.excludedMask.width !== object.mask.width || object.excludedMask.height !== object.mask.height)) throw new ProviderError('MASK_DIMENSION_MISMATCH', 'Exclusion masks must use working-master coordinates.');
    const crop = paddedBounds(object);
    const transform = createTransform(object.mask.width, object.mask.height, 1024, crop);
    const image = await sharp(master).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).flatten({ background: '#ffffff' }).resize(transform.resizedWidth, transform.resizedHeight, { fit: 'fill' }).png().toBuffer();
    const support = binaryMask(object.mask);
    const required = morphMask(support, 1, 'erode');
    const permitted = morphMask(support, Math.max(2, Math.ceil(Math.max(object.mask.width, object.mask.height) / 1024)), 'dilate');
    const guidance = mappedGuidance(object, transform);
    let visibleOwnership = support;
    let alpha = object.mask;
    let refinementAccepted = false;
    const warnings: string[] = [];
    if (!object.ownershipConfirmed) warnings.push('OWNERSHIP_CONFIRMATION_REQUIRED');
    if (/\b(board|sign|placard|poster)\b/i.test(object.label) && (!object.excludedMask || (object.points?.filter(point => point.label === 0).length ?? 0) < 2)) warnings.push('BOARD_FACE_FINGERS_EXCLUSIONS_REQUIRED');
    // Verify the original selection too. Refinement is never permission to repair an unsafe ownership decision silently.
    warnings.push(...validateGuidance(support, { positivePoints: object.points?.filter(point => point.label === 1), negativePoints: object.points?.filter(point => point.label === 0), excludedMask: object.excludedMask }));
    for (let attempt = 0; attempt < 2; attempt++) {
      let outputs: Buffer[];
      try { outputs = await infer('sam3', { image, prompt: /^Object \d+$/.test(object.label) ? 'the selected foreground object' : object.label, ...guidance, maxMasks: 3, transform, key: `phase05-${object.id}-guided-${attempt}` }); }
      catch (error) {
        if (!ordinaryOutputFailure(error)) throw error;
        warnings.push((error as ProviderError).code); break;
      }
      const valid: { mask: Mask; score: number }[] = [];
      for (const bytes of outputs.slice(0, 3)) {
        let candidate: Mask;
        try {
          const modelMask = await decodeMask(bytes, { encoding: 'luminance', binary: true });
          if (modelMask.width !== transform.modelWidth || modelMask.height !== transform.modelHeight) continue;
          candidate = mapMaskToNative(modelMask, transform);
        } catch { continue; }
        const failures = validateGuidance(candidate, { positivePoints: object.points?.filter(point => point.label === 1), negativePoints: object.points?.filter(point => point.label === 0), excludedMask: object.excludedMask, requiredMask: required });
        if (overlapMasks(candidate, permitted).inclusionA < 0.995) failures.push('NEIGHBORING_OBJECT_LEAK');
        if (failures.length) continue;
        valid.push({ mask: candidate, score: overlapMasks(candidate, support).iou });
      }
      valid.sort((a, b) => b.score - a.score);
      if (valid[0] && valid[0].score >= 0.8) {
        visibleOwnership = valid[0].mask; alpha = visibleOwnership; refinementAccepted = true; break;
      }
      // One additional attempt is only useful with explicit user exclusions; identical unconstrained rerolls are omitted.
      if (!(object.points?.some(point => point.label === 0))) break;
    }
    if (!refinementAccepted) warnings.push('REFINEMENT_REJECTED_VISIBLE_SUPPORT_RETAINED');
    const softEdges = object.softEdges ?? /\b(person|portrait|hair|fur|cat|dog)\b/i.test(object.label);
    if (softEdges && refinementAccepted) {
      try {
        const outputs = await infer('birefnet', { image, transform, key: `phase05-${object.id}-matting` });
        if (outputs.length !== 1) throw new ProviderError('PROVIDER_INVALID_IMAGE', 'Matting returned an invalid mask count.');
        const matte = await decodeMask(outputs[0], { encoding: 'luminance' });
        if (matte.width !== transform.modelWidth || matte.height !== transform.modelHeight) throw new ProviderError('PROVIDER_INVALID_IMAGE', 'Matting geometry does not match the object crop.');
        const nativeMatte = mapMaskToNative(matte, transform, 'alpha');
        alpha = constrainMatte(visibleOwnership, nativeMatte, Math.max(2, Math.ceil(Math.max(object.mask.width, object.mask.height) / 1024)), object.excludedMask);
        warnings.push('SOFT_EDGE_VISUAL_REVIEW_REQUIRED');
      } catch (error) {
        if (!ordinaryOutputFailure(error)) throw error;
        warnings.push('MATTING_UNAVAILABLE_VISIBLE_SUPPORT_RETAINED');
      }
    }
    if (transform.scaleX < 1 || transform.scaleY < 1) warnings.push('MASK_RESAMPLED_FROM_MODEL_CROP');
    const reviewRequired = warnings.some(warning => warning !== 'MASK_RESAMPLED_FROM_MODEL_CROP');
    results.push({ id: object.id, label: object.label, visibleOwnership, alpha, transform, warnings: [...new Set(warnings)], reviewRequired, refinementAccepted });
  }
  return { objects: results, warnings: [...new Set(results.flatMap(object => object.warnings))], reviewRequired: results.some(object => object.reviewRequired) };
}
