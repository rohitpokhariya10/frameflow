import { randomUUID } from 'node:crypto';
import type { DecompositionReview, SemanticTargetGroup } from '@frameflow/shared';
import type { PipelineContext } from '../context.js';
import { ProviderError } from '../providers/adapters.js';
import { applyBrush, decodeMask, emptyMask, measureMask, morphMask, unionMasks, validateGuidance } from '../image/masks.js';
import { semanticGate, saveTrio, type SemanticCandidate } from './semanticPipeline.js';
import { semanticTarget } from './semanticOwnership.js';

export async function regroupMasks(context: PipelineContext, master: Buffer, review: DecompositionReview) {
  const candidates = context.job.data.candidates as SemanticCandidate[];
  const selected = review.group!.memberIds.map(id => candidates.find(c => c.id === id));
  if (selected.some(c => !c)) throw new ProviderError('INVALID_CANDIDATE', 'Choose masks belonging to this job.');
  const members = selected as SemanticCandidate[];
  if (review.action === 'merge-targets') {
    if (members.length < 2) throw new ProviderError('GROUP_MEMBERS_REQUIRED', 'Select at least two targets to merge.');
    const source = context.repository.getSource(context.job.sourceId)!;
    let mask = emptyMask(source.width, source.height);
    for (const member of members) mask = unionMasks(mask, await decodeMask(await context.artifact(member.maskArtifactId), { encoding: 'luminance', binary: true }));
    const id = `group-${randomUUID()}`, target = semanticTarget(review.group!.label, id);
    target.compositionMode = 'group'; target.userConfirmedGroup = true; target.memberHints = members.map(m => m.label);
    const trio = await saveTrio(context, master, mask, mask, `04-review/${id}`, { operation: 'user-group' });
    const group: SemanticTargetGroup = { id, label: target.label, memberTargets: members.map(m => m.id), relationshipEvidence: ['user-confirmed-group'], groupMaskRevision: trio.revisionId, provenance: { operation: 'user-group', sourceRevision: review.expectedRevision, timestamp: new Date().toISOString() } };
    const groups = (context.job.data.targetGroups ?? []) as SemanticTargetGroup[]; groups.push(group); context.job.data.targetGroups = groups;
    context.job.data.candidates = [...candidates.filter(c => !members.includes(c)), { ...trio, id, groupId: id, label: target.label, target, source: 'sam3', memberArtifactIds: members.map(m => m.maskArtifactId), qualityStatus: members.some(m => m.qualityStatus === 'needs-correction') ? 'needs-correction' : 'needs-confirmation', qualityTier: 'REVIEW', selected: false, statistics: measureMask(mask), warnings: ['USER_GROUP_REQUIRES_CONFIRMATION'] }];
    context.job.data.groupMembers = { ...context.job.data.groupMembers as object, [id]: members };
  } else {
    if (members.length !== 1) throw new ProviderError('SPLIT_TARGET_REQUIRED', 'Choose one grouped target to split.');
    const original = members[0];
    const retained = (context.job.data.groupMembers as Record<string, SemanticCandidate[]> | undefined)?.[original.id];
    const separated: SemanticCandidate[] = retained ? [...retained] : [];
    if (!retained) for (const [i, id] of (original.memberArtifactIds ?? []).entries()) {
      const mask = await decodeMask(await context.artifact(id), { encoding: 'luminance', binary: true });
      const targetId = `${original.id}-part-${i + 1}`, label = original.target?.memberHints?.[i] ?? `Part ${i + 1}`;
      separated.push({ ...await saveTrio(context, master, mask, mask, `04-review/${targetId}`, { operation: 'user-split', parentRevision: original.revisionId }), id: targetId, label, target: semanticTarget(label, targetId), source: 'sam3', selected: false, memberArtifactIds: [], qualityTier: 'REVIEW', qualityStatus: 'needs-confirmation', statistics: measureMask(mask), warnings: ['SPLIT_REQUIRES_CONFIRMATION'] });
    }
    if (!separated.length) {
      const originalMask = await decodeMask(await context.artifact(original.maskArtifactId), { encoding: 'luminance', binary: true });
      for (let i = 0; i < 2; i++) {
        const id = `${original.id}-part-${i + 1}`, label = `${original.label} part ${i + 1}`, mask = i === 0 ? originalMask : emptyMask(originalMask.width, originalMask.height);
        separated.push({ ...await saveTrio(context, master, mask, mask, `04-review/${id}`, { operation: 'split-request', parentRevision: original.revisionId }), id, label, target: semanticTarget(label, id), source: 'sam3', selected: false, memberArtifactIds: [], qualityTier: 'FAIL', qualityStatus: 'needs-correction', statistics: measureMask(mask), warnings: ['SPLIT_REQUIRES_MANUAL_OR_AI_CORRECTION'] });
      }
    }
    if (candidates.length - 1 + separated.length > context.job.options.maxObjects) throw new ProviderError('TARGET_LIMIT', 'Splitting exceeds the object limit.');
    context.job.data.candidates = [...candidates.filter(c => c.id !== original.id), ...separated];
  }
  delete context.job.data.refined; delete context.job.data.reviewSubmission;
  semanticGate(context, 'Grouping saved locally. Inspect each target and confirm its source ownership.'); context.finish(4, 'Review source target grouping');
}

type Refined = SemanticCandidate & { semanticMaskArtifactId?: string; refinementAccepted: boolean; qualityStatus: string };
export async function reviewAlpha(context: PipelineContext, master: Buffer, review: DecompositionReview) {
  if (review.action === 'back-to-semantic') {
    delete context.job.data.refined; context.job.data.resultReviewed = false;
    semanticGate(context); context.finish(4, 'Source ownership reopened'); return;
  }
  const entries = context.job.data.refined as Refined[];
  if (!entries?.length) throw new ProviderError('ALPHA_REQUIRED', 'No current alpha revision is available.');
  for (const object of review.objects?.filter(o => o.selected !== false) ?? []) {
    const entry = entries.find(e => e.id === object.id);
    if (!entry) throw new ProviderError('INVALID_CANDIDATE', 'Choose a current refined target.');
    const ownership = await decodeMask(await context.artifact(entry.maskArtifactId), { encoding: 'luminance', binary: true });
    let alpha = await decodeMask(await context.artifact(entry.alphaArtifactId!), { encoding: 'luminance' });
    let mask = ownership;
    if (review.action === 'restore-interior') {
      const semantic = await decodeMask(await context.artifact(entry.semanticMaskArtifactId ?? entry.maskArtifactId), { encoding: 'luminance', binary: true });
      const interior = morphMask(semantic, Math.max(2, Math.ceil(Math.max(mask.width, mask.height) / 1024)), 'erode');
      alpha = { ...alpha, data: alpha.data.map((v, i) => interior.data[i] ? 255 : v) }; mask = unionMasks(mask, semantic);
    } else {
      for (const stroke of object.strokes ?? []) {
        const painted = applyBrush(emptyMask(mask.width, mask.height), [{ ...stroke, mode: 'add' }]);
        const value = stroke.mode === 'subtract' ? 0 : review.alphaValue ?? 255;
        alpha = { ...alpha, data: alpha.data.map((v, i) => painted.data[i] ? value : v) };
        mask = { ...mask, data: mask.data.map((v, i) => painted.data[i] ? value ? 255 : 0 : v) };
      }
    }
    let neighbors = emptyMask(mask.width, mask.height);
    for (const other of entries) if (other.id !== entry.id) neighbors = unionMasks(neighbors, await decodeMask(await context.artifact(other.maskArtifactId), { encoding: 'luminance', binary: true }));
    const errors = validateGuidance(alpha, { positivePoints: object.points?.filter(p => p.label === 1), negativePoints: object.points?.filter(p => p.label === 0), excludedMask: neighbors });
    if (errors.length) throw new ProviderError('ALPHA_REVIEW_REQUIRED', `Alpha correction rejected: ${errors.join(', ')}. Previous saved revision remains available.`);
    const trio = await saveTrio(context, master, mask, alpha, `05-refined/${entry.id}`, { operation: review.action, parentRevision: entry.revisionId, strokes: object.strokes });
    Object.assign(entry, trio);
    const candidate = (context.job.data.candidates as SemanticCandidate[]).find(c => c.id === entry.id); if (candidate) Object.assign(candidate, trio);
  }
  context.job.data.refined = entries;
  context.review('REFINEMENT_VISUAL_REVIEW', 'Inspect the saved mask, alpha and overlay before extraction.', ['approve-result', 'manual-alpha', 'restore-interior', 'back-to-semantic'], entries.map(e => e.overlayArtifactId));
  context.job.review!.gate = 'alpha-review'; context.finish(5, 'Alpha edits saved; final approval required');
}
