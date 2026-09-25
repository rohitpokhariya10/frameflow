import sharp from 'sharp';
import { binaryMask, decodeMask, deduplicateMasks, measureMask, overlapMasks, validateGuidance } from '../image/masks.js';
import type { Mask } from '../image/masks.js';
import { ProviderError } from '../providers/adapters.js';
import type { InferenceRequest, Infer } from '../providers/inference.js';
import type { LayerProposal } from './proposals.js';

export type SegmentationTarget = {
  label: string;
  points?: InferenceRequest['points'];
  boxes?: InferenceRequest['boxes'];
  /** Native semantic exclusions must first be mapped to this analysis image by the caller. */
  excludedMask?: Mask;
};
export type ObjectCandidate = {
  id: string; label: string; labelSource: 'target-prompt' | 'generic';
  source: 'sam2' | 'sam3'; mask: Mask;
  statistics: ReturnType<typeof measureMask>;
  proposalMatches: { proposalId: string; iou: number; visibleAgreement: number; proposedVisibleFraction: number }[];
  warnings: string[];
};
export type SegmentationResult = {
  candidates: ObjectCandidate[];
  selectedIds: string[];
  rejected: { id: string; reason: string; duplicateOf?: string }[];
  reviewRequired: boolean;
  warnings: string[];
};

/** Segmentation is evidence for observed ownership; bbox overlap and Qwen alpha are never used as ownership. */
export async function segmentObjects(analysis: Buffer, infer: Infer, options: { proposals?: LayerProposal[]; maxObjects?: number; targets?: SegmentationTarget[] } = {}): Promise<SegmentationResult> {
  const metadata = await sharp(analysis).metadata();
  const width = metadata.width!, height = metadata.height!;
  const maxObjects = Math.min(6, Math.max(1, options.maxObjects ?? 6));
  if ((options.targets?.length ?? 0) > maxObjects) throw new ProviderError('TARGET_LIMIT', 'Select fewer target objects.');
  const candidates: ObjectCandidate[] = [], rejected: SegmentationResult['rejected'] = [], warnings: string[] = [];
  const append = async (outputs: Buffer[], source: 'sam2' | 'sam3', target?: SegmentationTarget) => {
    if (candidates.length + outputs.length > 64) throw new ProviderError('PROVIDER_CANDIDATE_LIMIT', 'Too many candidates require a narrower selection.');
    for (const bytes of outputs) {
      const id = `candidate-${candidates.length + rejected.length + 1}`;
      let mask: Mask;
      try { mask = await decodeMask(bytes, { encoding: 'luminance', binary: true }); }
      catch { rejected.push({ id, reason: 'INVALID_MASK_ENCODING' }); continue; }
      if (mask.width !== width || mask.height !== height) { rejected.push({ id, reason: 'MASK_GEOMETRY_MISMATCH' }); continue; }
      const statistics = measureMask(mask);
      if (!statistics.area || statistics.areaFraction === 1) { rejected.push({ id, reason: statistics.area ? 'FULL_CANVAS_MASK' : 'EMPTY_MASK' }); continue; }
      const defects = target ? validateGuidance(mask, { positivePoints: target.points?.filter(point => point.label === 1), negativePoints: target.points?.filter(point => point.label === 0), excludedMask: target.excludedMask }) : [];
      const proposalMatches = (options.proposals ?? []).filter(proposal => proposal.registered && !proposal.warnings.length).map(proposal => {
        const agreement = overlapMasks(mask, binaryMask(proposal.alpha));
        return { proposalId: proposal.id, iou: agreement.iou, visibleAgreement: agreement.inclusionA, proposedVisibleFraction: agreement.inclusionB };
      }).filter(match => match.iou > 0.1).sort((a, b) => b.iou - a.iou);
      // Generic masks and amodal alpha do not prove semantic identity. A human confirms initial ownership.
      if (!target || !target.points?.some(point => point.label === 1)) defects.push('OWNERSHIP_CONFIRMATION_REQUIRED');
      if (target && /\b(board|sign|placard|poster)\b/i.test(target.label) && (!target.excludedMask || (target.points?.filter(point => point.label === 0).length ?? 0) < 2)) defects.push('BOARD_FACE_FINGERS_EXCLUSIONS_REQUIRED');
      candidates.push({ id, label: target?.label ?? `Object ${candidates.length + 1}`, labelSource: target ? 'target-prompt' : 'generic', source, mask, statistics, proposalMatches, warnings: defects });
    }
  };
  await append(await infer('sam2', { image: analysis, key: 'phase04-automatic' }), 'sam2');
  const automaticCount = candidates.length;
  for (const [index, target] of (options.targets ?? []).entries()) {
    await append(await infer('sam3', { image: analysis, prompt: target.label, points: target.points, boxes: target.boxes, maxMasks: 3, key: `phase04-target-${index}` }), 'sam3', target);
  }
  // Prefer prompted candidates when the same observed support was found automatically.
  const ordered = [...candidates.slice(automaticCount), ...candidates.slice(0, automaticCount)];
  const deduplicated = deduplicateMasks(ordered);
  rejected.push(...deduplicated.rejected);
  const kept = ordered.filter(candidate => deduplicated.selected.some(item => item.id === candidate.id));
  for (const [a, b] of deduplicated.nested) {
    kept.find(candidate => candidate.id === a)?.warnings.push('NESTED_OWNERSHIP_AMBIGUOUS');
    kept.find(candidate => candidate.id === b)?.warnings.push('NESTED_OWNERSHIP_AMBIGUOUS');
  }
  for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) {
    if (overlapMasks(kept[i].mask, kept[j].mask).intersection > 0) {
      kept[i].warnings.push('OVERLAPPING_VISIBLE_OWNERSHIP'); kept[j].warnings.push('OVERLAPPING_VISIBLE_OWNERSHIP');
    }
  }
  if (!kept.length) warnings.push('NO_VALID_CANDIDATES');
  if (kept.length > maxObjects) warnings.push('OBJECT_SELECTION_REQUIRED');
  const selected = (options.targets?.length ? kept.filter(candidate => candidate.source === 'sam3') : kept);
  if (options.targets?.some(target => !selected.some(candidate => candidate.label === target.label))) warnings.push('TARGET_NOT_FOUND');
  if (selected.length > maxObjects) warnings.push('OBJECT_SELECTION_REQUIRED');
  warnings.push(...selected.flatMap(candidate => candidate.warnings));
  if (rejected.some(candidate => ['MASK_GEOMETRY_MISMATCH', 'INVALID_MASK_ENCODING'].includes(candidate.reason))) warnings.push('REJECTED_INVALID_CANDIDATES');
  return { candidates: kept, selectedIds: selected.length <= maxObjects ? selected.map(candidate => candidate.id) : [], rejected, reviewRequired: warnings.length > 0, warnings: [...new Set(warnings)] };
}
