import sharp from 'sharp';
import type { SemanticTarget, DecompositionPoint, DecompositionBox } from '@frameflow/shared';
import { createTransform, nativeToModel } from '../image/coordinates.js';
import type { ImageTransform } from '../image/coordinates.js';
import { binaryMask, decodeMask, emptyMask, mapMaskToNative, maskBounds, measureMask, overlapMasks, unionMasks, validateGuidance } from '../image/masks.js';
import type { Mask } from '../image/types.js';
import type { Infer, InferenceOutput } from '../providers/inference.js';
import { ProviderError, endpointRegistry } from '../providers/adapters.js';

export function semanticTarget(label: string, id: string): SemanticTarget {
  const providerPrompt = label.trim().replaceAll('_', ' ').replace(/\s+/g, ' ');
  const members = providerPrompt.split(/\s+(?:with|holding|and|plus)\s+|\s*\+\s*/i).map(part => part.trim()).filter(Boolean);
  return { id, label, providerPrompt, origin: 'user', compositionMode: members.length > 1 ? 'group' : 'single', memberHints: members.length > 1 ? members : undefined };
}
export type MaskScore = { index: number; score: number; reasons: string[]; metrics: Record<string, number>; providerScore?: number; providerBox?: [number, number, number, number] };
export type SemanticEvidence = {
  target: SemanticTarget; points?: DecompositionPoint[]; box?: DecompositionBox;
  prior?: Mask; protectedMask?: Mask; members?: Mask[]; proposal?: Mask;
};
/** Geometry cannot prove a text label. Group membership needs independent member support. */
export function scoreSemanticMask(mask: Mask, evidence: SemanticEvidence, providerScore?: number, index = 0): MaskScore {
  const stats = measureMask(mask);
  const reasons = validateGuidance(mask, { positivePoints: evidence.points?.filter(p => p.label === 1), negativePoints: evidence.points?.filter(p => p.label === 0), excludedMask: evidence.protectedMask })
    .map(code => code === 'POSITIVE_POINT_OUTSIDE_MASK' ? 'POSITIVE_GUIDANCE_UNSATISFIED' : code === 'PROTECTED_REGION_LEAK' ? 'PROTECTED_OWNERSHIP_OVERLAP' : code);
  if (stats.areaFraction > 0.9) reasons.push('MASK_COVERS_MOST_OF_CANVAS');
  // A confident speck is never an object, a member, or a group.
  if (stats.area < mask.width * mask.height * 0.001) reasons.push('MASK_TINY_PATCH');
  if (stats.componentCount > 128) reasons.push('MASK_TOO_FRAGMENTED');
  if (providerScore !== undefined && providerScore < 0.5) reasons.push('SEMANTIC_MASK_LOW_CONFIDENCE');
  const memberCoverage = (evidence.members ?? []).map(member => overlapMasks(mask, member).inclusionB);
  if (evidence.target.compositionMode === 'group' && (!evidence.members?.length || evidence.members.length !== evidence.target.memberHints?.length)) reasons.push('GROUP_MEMBERS_UNVERIFIED');
  if (memberCoverage.some(value => value < 0.9)) reasons.push('TARGET_NOT_RECOVERED');
  let border = 0;
  for (let x = 0; x < mask.width; x++) border += Number(mask.data[x] > 0) + Number(mask.data[(mask.height - 1) * mask.width + x] > 0);
  for (let y = 0; y < mask.height; y++) border += Number(mask.data[y * mask.width] > 0) + Number(mask.data[y * mask.width + mask.width - 1] > 0);
  const borderFraction = border / (2 * mask.width + 2 * mask.height);
  if (borderFraction > 0.85) reasons.push('MASK_PATHOLOGICAL');
  const metrics: Record<string, number> = { coverage: stats.areaFraction, componentCount: stats.componentCount, borderFraction,
    memberCoverage: memberCoverage.length ? Math.min(...memberCoverage) : 1,
    priorOverlap: evidence.prior ? overlapMasks(mask, evidence.prior).iou : 0,
    proposalOverlap: evidence.proposal ? overlapMasks(mask, evidence.proposal).iou : 0 };
  if (evidence.box) {
    const bounds = maskBounds(mask), box = evidence.box;
    metrics['boxCoverage'] = bounds ? Math.max(0, Math.min(bounds.x + bounds.width, box.x + box.width) - Math.max(bounds.x, box.x)) * Math.max(0, Math.min(bounds.y + bounds.height, box.y + box.height) - Math.max(bounds.y, box.y)) / (box.width * box.height) : 0;
  }
  if (evidence.box && metrics.boxCoverage < 0.65) reasons.push('TARGET_NOT_RECOVERED');
  if (evidence.members?.length === 2 && overlapMasks(evidence.members[0], evidence.members[1]).iou > 0.95) reasons.push('GROUP_MEMBERS_UNVERIFIED');
  return { index, providerScore, metrics, reasons: [...new Set(reasons)], score: (providerScore ?? 0.5) * 0.4 + metrics.memberCoverage * 0.4 + metrics.priorOverlap * 0.05 + metrics.proposalOverlap * 0.1 + (1 - borderFraction) * 0.05 };
}
/** Rejections that only say the mask may miss or overreach its guidance. Any other reason (empty, tiny, full-canvas,
 * fragmented, border-hugging, low confidence, overlapping another target) means the mask is not a usable starting point. */
const COVERAGE_REASONS = new Set(['POSITIVE_GUIDANCE_UNSATISFIED', 'NEGATIVE_GUIDANCE_LEAK', 'GROUP_MEMBERS_UNVERIFIED', 'TARGET_NOT_RECOVERED']);
export const PROVISIONAL_MIN_PROVIDER_SCORE = 0.8;
/** A rejected, confidently scored model mask kept only as an unconfirmed starting point for the user. It never becomes ownership on its own. */
export type ProvisionalCandidate = { mask: Mask; score: MaskScore };
export function provisionalCandidate(options: { mask: Mask; index: number }[], scores: MaskScore[]): ProvisionalCandidate | undefined {
  const usable = scores.filter(s => s.index >= 0 && (s.providerScore ?? 0) >= PROVISIONAL_MIN_PROVIDER_SCORE && s.reasons.length && s.reasons.every(r => COVERAGE_REASONS.has(r)))
    .sort((a, b) => b.score - a.score)[0];
  const mask = usable && options.find(o => o.index === usable.index)?.mask;
  return mask && maskBounds(mask) ? { mask, score: usable } : undefined;
}
export type SemanticResult = { target: SemanticTarget; mask?: Mask; members: Mask[]; transform: ImageTransform; scores: MaskScore[]; memberScores: { hint: string; scores: MaskScore[] }[]; warnings: string[]; unionSources?: string[]; providerRequestIds: string[]; provisional?: ProvisionalCandidate };
export async function recoverSemanticOwnership(master: Buffer, infer: Infer, evidence: SemanticEvidence): Promise<SemanticResult> {
  const meta = await sharp(master).metadata();
  const width = meta.width!, height = meta.height!;
  for (const point of evidence.points ?? []) if (![point.x, point.y].every(Number.isFinite) || ![0, 1].includes(point.label) || point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) throw new ProviderError('GUIDANCE_BOUNDS', 'Points must lie inside the source.');
  if (evidence.box && (![evidence.box.x, evidence.box.y, evidence.box.width, evidence.box.height].every(Number.isFinite) || evidence.box.x < 0 || evidence.box.y < 0 || evidence.box.width <= 0 || evidence.box.height <= 0 || evidence.box.x + evidence.box.width > width || evidence.box.y + evidence.box.height > height)) throw new ProviderError('GUIDANCE_BOUNDS', 'Box must lie inside the source.');
  const transform = createTransform(width, height, 2048);
  const image = await sharp(master).flatten({ background: '#ffffff' }).resize(transform.resizedWidth, transform.resizedHeight).png().toBuffer();
  const points = evidence.points?.map(point => { const p = nativeToModel({ x: point.x + 0.5, y: point.y + 0.5 }, transform); return { x: Math.min(transform.modelWidth - 1, Math.floor(p.x)), y: Math.min(transform.modelHeight - 1, Math.floor(p.y)), label: point.label, objectId: 0 }; });
  const box = evidence.box;
  const boxes = box ? [{ x: Math.floor(box.x * transform.scaleX), y: Math.floor(box.y * transform.scaleY), width: Math.ceil((box.x + box.width) * transform.scaleX) - Math.floor(box.x * transform.scaleX), height: Math.ceil((box.y + box.height) * transform.scaleY) - Math.floor(box.y * transform.scaleY), objectId: 0 }] : undefined;
  const providerRequestIds: string[] = [];
  const memberScores: { hint: string; scores: MaskScore[] }[] = [];
  const decode = async (output: InferenceOutput) => {
    if (output.requestId) providerRequestIds.push(output.requestId);
    const decoded: { mask: Mask; providerScore?: number; providerBox?: [number, number, number, number]; index: number }[] = [];
    for (const [index, bytes] of output.slice(0, 6).entries()) {
      try { const mask = await decodeMask(bytes, { encoding: 'luminance', binary: true });
        if (mask.width === transform.modelWidth && mask.height === transform.modelHeight) decoded.push({ mask: mapMaskToNative(mask, transform), providerScore: output.scores?.[index], providerBox: output.boxes?.[index], index });
      } catch { /* Corrupt candidates never become ownership. */ }
    }
    return decoded;
  };
  const direct = await decode(await infer('sam3', { image, prompt: evidence.target.providerPrompt, points, boxes, maxMasks: 6, transform, key: `semantic-${evidence.target.id}` }));
  const members = [...(evidence.members ?? [])];
  // At most two atomic checks. They validate group membership, not an unbounded model search.
  if (evidence.target.compositionMode === 'group' && members.length < 2 && evidence.target.memberHints?.length === 2) {
    for (const [i, hint] of evidence.target.memberHints.entries()) {
      if (i < members.length) continue;
      const atomicTarget = { ...evidence.target, compositionMode: 'single' as const, memberHints: undefined, providerPrompt: hint };
      const options = await decode(await infer('sam3', { image, prompt: hint, maxMasks: 6, transform, key: `semantic-${evidence.target.id}-member-${i}` }));
      const evaluated = options.map(option => ({ ...option, score: scoreSemanticMask(option.mask, { target: atomicTarget, protectedMask: evidence.protectedMask }, option.providerScore, option.index) }));
      memberScores.push({ hint, scores: evaluated.map(item => ({ ...item.score, providerBox: item.providerBox })) });
      const ranked = evaluated.filter(item => !item.score.reasons.length).sort((a, b) => b.score.score - a.score.score);
      // Multiple similarly scored instances are ambiguous: ask for guidance instead of guessing a relationship.
      if (!ranked[0] || (ranked[1] && ranked[0].score.score - ranked[1].score.score < 0.05 && overlapMasks(ranked[0].mask, ranked[1].mask).iou < 0.8)) break;
      members.push(ranked[0].mask);
    }
  }
  const scores: MaskScore[] = direct.map(option => ({ ...scoreSemanticMask(option.mask, { ...evidence, members }, option.providerScore, option.index), providerBox: option.providerBox }));
  const best = scores.filter(item => !item.reasons.length).sort((a, b) => b.score - a.score)[0];
  let mask = best && direct.find(item => item.index === best.index)?.mask;
  let unionSources: string[] | undefined;
  if (!mask && evidence.target.compositionMode === 'group' && members.length === 2 && evidence.target.memberHints?.length === 2) {
    const a = maskBounds(members[0])!, b = maskBounds(members[1])!;
    const dx = Math.max(0, a.x - b.x - b.width, b.x - a.x - a.width), dy = Math.max(0, a.y - b.y - b.height, b.y - a.y - a.height);
    const relation = Math.hypot(dx, dy) <= Math.min(width, height) * 0.02;
    if (relation || evidence.target.userConfirmedGroup) {
      const combined = unionMasks(members[0], members[1]);
      const score = scoreSemanticMask(combined, { ...evidence, members }, undefined, -1); scores.push(score);
      if (!score.reasons.length) { mask = combined; unionSources = [...evidence.target.memberHints]; }
    }
  }
  const warnings = mask ? ['SEMANTIC_VISUAL_REVIEW_REQUIRED', ...(unionSources ? ['GROUP_RELATION_REQUIRES_REVIEW'] : [])] : [...new Set(['TARGET_NOT_RECOVERED', ...scores.flatMap(item => item.reasons)])];
  const provisional = mask ? undefined : provisionalCandidate(direct, scores);
  console.info(JSON.stringify({ event: 'semantic_quality', targetId: evidence.target.id, provider: endpointRegistry.sam3.endpoint, requestIds: providerRequestIds, accepted: !!mask, provisional: provisional ? provisional.score.index : undefined, scores, warnings }));
  return { target: evidence.target, mask, members, transform, scores, memberScores, warnings, unionSources, providerRequestIds, provisional };
}
/** Registered proposal geometry creates promptable intent without inventing a semantic label. */
export function proposalSeeds(mask: Mask): DecompositionPoint[] {
  const support = binaryMask(mask), bounds = maskBounds(support); if (!bounds) return [];
  const points: DecompositionPoint[] = [];
  for (const label of [1, 0] as const) {
    let best = -1, distance = Infinity;
    const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
    for (let y = 1; y < mask.height - 1; y += 2) for (let x = 1; x < mask.width - 1; x += 2) {
      const i = y * mask.width + x;
      if (Number(support.data[i] > 0) !== label || [i - 1, i + 1, i - mask.width, i + mask.width].some(j => Number(support.data[j] > 0) !== label)) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < distance) { distance = d; best = i; }
    }
    if (best >= 0) points.push({ x: best % mask.width, y: Math.floor(best / mask.width), label });
  }
  return points;
}
export { emptyMask };
