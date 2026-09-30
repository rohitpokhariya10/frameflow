import type { DecompositionBox, DecompositionPoint, QualityTier, SemanticTarget } from '@frameflow/shared';
import { maskBounds, measureMask, overlapMasks, validateGuidance } from '../image/masks.js';
import type { Mask } from '../image/types.js';

/**
 * Ownership quality gate, evaluated before any alpha refinement.
 * PASS: ownership looks valid. REVIEW: plausible but needs explicit user confirmation. FAIL: must not proceed.
 * A wrong mask must never be silently accepted, so every uncertain signal lands in REVIEW or FAIL.
 */
export type QualityCheck = { code: string; tier: Exclude<QualityTier, 'PASS'>; message: string };
export type OwnershipQuality = { tier: QualityTier; checks: QualityCheck[]; metrics: Record<string, number> };
export type OwnershipEvidence = {
  target?: SemanticTarget; points?: DecompositionPoint[]; box?: DecompositionBox;
  /** Reviewed provisional region (proposal guidance) the target is expected to cover. */
  provisional?: Mask; protectedMask?: Mask; members?: Mask[]; providerScore?: number; manual?: boolean;
};

const MESSAGES: Record<string, string> = {
  EMPTY_MASK: 'The mask is empty.',
  MASK_COVERS_MOST_OF_CANVAS: 'The mask covers more than 90% of the image.',
  TINY_PATCH: 'The mask is a tiny patch, not a complete object.',
  TARGET_INCOMPLETE: 'The mask covers only a small part of the reviewed region.',
  BOX_NOT_COVERED: 'The mask covers too little of the target box.',
  POSITIVE_GUIDANCE_UNSATISFIED: 'A positive point is outside the mask.',
  NEGATIVE_GUIDANCE_LEAK: 'A negative point is inside the mask.',
  PROTECTED_OWNERSHIP_OVERLAP: 'The mask overlaps another confirmed target.',
  GROUP_MEMBER_MISSING: 'A required group member is not covered.',
  GROUP_MEMBERS_UNVERIFIED: 'Group members could not be verified independently.',
  MASK_PATHOLOGICAL: 'The mask runs along almost the whole image border.',
  MASK_TOO_FRAGMENTED: 'The mask is split into very many pieces.',
  BORDER_CONTACT: 'The mask touches the image border; check for cropped subjects or background leaks.',
  DISJOINT_PIECES: 'The mask has several separate pieces.',
  INTERIOR_HOLES: 'The mask has interior holes.',
  LOW_PROVIDER_CONFIDENCE: 'The segmentation model reported low confidence.',
  MANUAL_OWNERSHIP: 'Manual edits need visual confirmation.',
};

function borderFraction(mask: Mask) {
  let border = 0;
  for (let x = 0; x < mask.width; x++) border += Number(mask.data[x] > 0) + Number(mask.data[(mask.height - 1) * mask.width + x] > 0);
  for (let y = 0; y < mask.height; y++) border += Number(mask.data[y * mask.width] > 0) + Number(mask.data[y * mask.width + mask.width - 1] > 0);
  return border / (2 * mask.width + 2 * mask.height);
}

export function ownershipQuality(mask: Mask, evidence: OwnershipEvidence = {}): OwnershipQuality {
  const checks: QualityCheck[] = [];
  const add = (code: string, tier: QualityCheck['tier']) => { if (!checks.some(c => c.code === code)) checks.push({ code, tier, message: MESSAGES[code] }); };
  const stats = measureMask(mask);
  const canvas = mask.width * mask.height;
  const metrics: Record<string, number> = { coverage: stats.areaFraction, componentCount: stats.componentCount, borderFraction: borderFraction(mask) };
  if (!stats.area) { add('EMPTY_MASK', 'FAIL'); return { tier: 'FAIL', checks, metrics }; }
  if (stats.areaFraction > 0.9) add('MASK_COVERS_MOST_OF_CANVAS', 'FAIL');
  if (stats.area < canvas * 0.001) add('TINY_PATCH', 'FAIL');
  if (evidence.provisional) {
    const provisional = measureMask(evidence.provisional).area;
    const covered = provisional ? overlapMasks(mask, evidence.provisional).inclusionB : 1;
    metrics.provisionalCoverage = covered;
    // A torso-sized patch inside a whole-person region is incomplete, whatever its label.
    if (provisional && covered < 0.35) add('TARGET_INCOMPLETE', 'FAIL');
  }
  if (evidence.box) {
    const b = maskBounds(mask)!, box = evidence.box;
    const inter = Math.max(0, Math.min(b.x + b.width, box.x + box.width) - Math.max(b.x, box.x)) * Math.max(0, Math.min(b.y + b.height, box.y + box.height) - Math.max(b.y, box.y));
    metrics.boxCoverage = inter / (box.width * box.height);
    if (metrics.boxCoverage < 0.5) add('BOX_NOT_COVERED', 'FAIL');
  }
  for (const code of validateGuidance(mask, { positivePoints: evidence.points?.filter(p => p.label === 1), negativePoints: evidence.points?.filter(p => p.label === 0) })) {
    add(code === 'POSITIVE_POINT_OUTSIDE_MASK' ? 'POSITIVE_GUIDANCE_UNSATISFIED' : code, 'FAIL');
  }
  if (evidence.protectedMask) {
    const overlap = overlapMasks(mask, evidence.protectedMask).inclusionA;
    metrics.protectedOverlap = overlap;
    if (overlap > 0.02) add('PROTECTED_OWNERSHIP_OVERLAP', 'FAIL');
  }
  if (evidence.target?.compositionMode === 'group') {
    const members = evidence.members ?? [];
    const coverage = members.map(member => overlapMasks(mask, member).inclusionB);
    metrics.memberCoverage = coverage.length ? Math.min(...coverage) : 0;
    if (coverage.some(value => value < 0.9)) add('GROUP_MEMBER_MISSING', 'FAIL');
    else if (members.length < (evidence.target.memberHints?.length ?? 2)) add('GROUP_MEMBERS_UNVERIFIED', 'REVIEW');
  }
  if (metrics.borderFraction > 0.85) add('MASK_PATHOLOGICAL', 'FAIL');
  else if (metrics.borderFraction > 0.02) add('BORDER_CONTACT', 'REVIEW');
  if (stats.componentCount > 128) add('MASK_TOO_FRAGMENTED', 'FAIL');
  else if (stats.components.filter(c => c.area >= stats.area * 0.01).length > 1) add('DISJOINT_PIECES', 'REVIEW');
  // Interior holes: background components enclosed by the mask.
  const inverse: Mask = { width: mask.width, height: mask.height, data: mask.data.map(v => (v ? 0 : 255)) };
  const holes = measureMask(inverse).components.filter(c => c.bbox.x > 0 && c.bbox.y > 0 && c.bbox.x + c.bbox.width < mask.width && c.bbox.y + c.bbox.height < mask.height && c.area >= stats.area * 0.01);
  metrics.holeCount = holes.length;
  if (holes.length) add('INTERIOR_HOLES', 'REVIEW');
  if (evidence.providerScore !== undefined && evidence.providerScore < 0.5) add('LOW_PROVIDER_CONFIDENCE', 'REVIEW');
  if (evidence.manual) add('MANUAL_OWNERSHIP', 'REVIEW');
  const tier: QualityTier = checks.some(c => c.tier === 'FAIL') ? 'FAIL' : checks.length ? 'REVIEW' : 'PASS';
  return { tier, checks, metrics };
}
