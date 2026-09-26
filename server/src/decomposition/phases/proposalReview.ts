import type { DecompositionReview, ProposalReviewTarget, ProposalSummary } from '@frameflow/shared';
import type { PipelineContext } from '../context.js';
import { DecompositionError } from '../errors.js';
import { applyBrush, decodeMask, emptyMask, mapMaskToNative, unionMasks } from '../image/masks.js';
import type { ImageTransform } from '../image/coordinates.js';
import { saveTrio } from './semanticPipeline.js';

export function proposalGate(context: PipelineContext) {
  context.review('QWEN_PROPOSAL_REVIEW', 'Choose what to isolate. Approve, rename, group or reject the discovered layers. Edit provisional regions on the original image; source segmentation will verify ownership.', ['save-proposals', 'approve-proposals']);
  context.job.review!.gate = 'qwen-proposal-review';
  context.job.phase = 3;
}
export async function initializeProposalReview(context: PipelineContext, master: Buffer) {
  context.job.data.reviewWorkflow = 2;
  const proposals = context.job.data.proposals as ProposalSummary[];
  const labels = context.job.options.targetLabels;
  const targets: ProposalReviewTarget[] = labels.length ? labels.map((label, i) => ({ id: `target-${i + 1}`, label, proposalIds: [], approved: false, rejected: false, groupMode: /\b(with|holding|and|plus)\b|\+/i.test(label.replaceAll('_', ' ')) ? 'group' : 'single', role: 'unknown' })) : proposals.map((p, i) => ({ id: `target-${i + 1}`, label: `Layer ${i + 1}`, proposalIds: [p.id], approved: false, rejected: false, groupMode: 'single', role: 'unknown' }));
  if (!targets.length) targets.push({ id: 'target-1', label: 'Object', proposalIds: [], approved: false, rejected: false, groupMode: 'single', role: 'unknown' });
  await persistProposalTargets(context, master, targets);
  proposalGate(context);
}
async function persistProposalTargets(context: PipelineContext, master: Buffer, targets: ProposalReviewTarget[]) {
  const proposals = context.job.data.proposals as ProposalSummary[];
  const prior = (context.job.data.proposalTargets ?? []) as ProposalReviewTarget[];
  const source = context.repository.getSource(context.job.sourceId)!;
  const saved: ProposalReviewTarget[] = [];
  for (const target of targets) {
    if (target.proposalIds.some(id => !proposals.some(p => p.id === id))) throw new DecompositionError('INVALID_PROPOSAL', 'Choose proposals belonging to this job.', 409);
    const old = prior.find(t => t.id === target.id);
    const sameMembers = old && JSON.stringify(old.proposalIds) === JSON.stringify(target.proposalIds);
    let mask = sameMembers && old.maskArtifactId ? await decodeMask(await context.artifact(old.maskArtifactId), { encoding: 'luminance', binary: true }) : emptyMask(source.width, source.height);
    if (!sameMembers) for (const id of target.proposalIds) {
      const p = proposals.find(p => p.id === id)!;
      // Geometry mismatches cannot be fixed by stretching generated RGB/alpha. Start empty and let the user paint source guidance.
      if (p.registered && !p.warnings.length) mask = unionMasks(mask, mapMaskToNative(await decodeMask(await context.artifact(p.artifactId), { encoding: 'alpha', binary: true }), context.job.data.analysisTransform as ImageTransform));
    }
    if (!sameMembers) for (const id of target.memberTargetIds ?? []) {
      const member = prior.find(t => t.id === id);
      if (!member?.maskArtifactId) throw new DecompositionError('INVALID_TARGET_GROUP', 'Group members must belong to this saved proposal review.');
      mask = unionMasks(mask, await decodeMask(await context.artifact(member.maskArtifactId), { encoding: 'luminance', binary: true }));
    }
    mask = applyBrush(mask, target.strokes ?? []);
    const trio = await saveTrio(context, master, mask, mask, `03-review/${target.id}`, { operation: 'proposal-guidance', parentRevision: old?.provisionalMaskRevision, strokes: target.strokes, proposalIds: target.proposalIds });
    saved.push({ ...target, points: [...(target.points ?? []), ...(target.strokes ?? []).flatMap(stroke => [stroke.points[0], stroke.points.at(-1)!].map(p => ({ ...p, label: stroke.mode === 'add' ? 1 as const : 0 as const })))].slice(-64), strokes: [], provisionalMaskRevision: trio.revisionId, maskArtifactId: trio.maskArtifactId, overlayArtifactId: trio.overlayArtifactId });
  }
  context.job.data.proposalTargets = saved;
  await context.put('proposal-review', Buffer.from(JSON.stringify({ targets: saved, inputRevision: context.job.data.reviewRevision, sourceSha256: source.workingMasterSha256 }, null, 2)), `03-review/targets-${context.job.revision}.json`, 'application/json');
  context.save();
}
export async function applyProposalReview(context: PipelineContext, master: Buffer, review: DecompositionReview): Promise<boolean> {
  if (context.job.data.proposalReviewApplied !== context.job.data.reviewRevision) {
    if (!review.targets?.length || review.targets.filter(t => t.approved && !t.rejected).length > context.job.options.maxObjects) throw new DecompositionError('TARGET_LIMIT', 'Keep the approved targets within the object limit.');
    await persistProposalTargets(context, master, review.targets);
    context.job.data.proposalReviewApplied = context.job.data.reviewRevision;
    context.save();
  }
  if (review.action === 'save-proposals') { proposalGate(context); context.save(); return false; }
  const approved = (context.job.data.proposalTargets as ProposalReviewTarget[]).filter(t => t.approved && !t.rejected);
  if (!approved.length) { proposalGate(context); context.job.review!.message = 'Approve at least one target, or cancel this job.'; context.save(); return false; }
  context.job.data.proposalReviewApproved = true;
  context.save(); return true;
}
