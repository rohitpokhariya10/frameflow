import type { DecompositionReview, DiscoverySummary, ProposalReviewTarget, ProposalSummary, ProposalTargetProvenance } from '@frameflow/shared';
import type { PipelineContext } from '../context.js';
import { DecompositionError } from '../errors.js';
import { applyBrush, decodeMask, emptyMask, mapMaskToNative, unionMasks } from '../image/masks.js';
import type { ImageTransform } from '../image/coordinates.js';
import { saveTrio } from './semanticPipeline.js';
import { classifyTarget } from './classification.js';

export function proposalGate(context: PipelineContext) {
  context.review('QWEN_PROPOSAL_REVIEW', 'Choose what to isolate. Approve, rename, group or reject the discovered layers. Edit provisional regions on the original image; source segmentation will verify ownership.', ['save-proposals', 'approve-proposals']);
  context.job.review!.gate = 'qwen-proposal-review';
  context.job.phase = 3;
}
export async function initializeProposalReview(context: PipelineContext, master: Buffer) {
  context.job.data.reviewWorkflow = 2;
  const proposals = context.job.data.proposals as ProposalSummary[];
  const labels = context.job.options.targetLabels;
  const created = new Date().toISOString();
  // Provider names (e.g. Seedream "Woman holding phone") are the default wording; generic proposals keep "Layer N".
  const targets: ProposalReviewTarget[] = labels.length ? labels.map((label, i) => ({ id: `target-${i + 1}`, label, proposalIds: [], approved: false, rejected: false, groupMode: /\b(with|holding|and|plus)\b|\+/i.test(label.replaceAll('_', ' ')) ? 'group' : 'single', role: 'unknown', provenance: { operation: 'target-label', sourceRevision: 0, createdAt: created, originalLabel: label } }))
    : proposals.map((p, i) => { const label = p.labelSource === 'provider' && p.label.trim() ? p.label : `Layer ${i + 1}`; return { id: `target-${i + 1}`, label, ...(p.description ? { description: p.description } : {}), proposalIds: [p.id], approved: false, rejected: false, groupMode: 'single', role: 'unknown', provenance: { operation: 'discovered', sourceRevision: 0, createdAt: created, originalLabel: label, proposalIds: [p.id] } }; });
  if (!targets.length) targets.push({ id: 'target-1', label: 'Object', proposalIds: [], approved: false, rejected: false, groupMode: 'single', role: 'unknown', provenance: { operation: 'user-created', sourceRevision: 0, createdAt: created } });
  const base = (context.job.data.discovery as DiscoverySummary | undefined)?.baseLayer;
  // The discovered base layer is kept as the background element; it is reviewable but never sent to source segmentation.
  if (base && base.sourceRegistration.method !== 'unregistered') targets.push({ id: BASE_TARGET_ID, label: base.name ?? 'Background', ...(base.description ? { description: base.description } : {}), proposalIds: [], approved: false, rejected: false, groupMode: 'single', role: 'background', baseLayer: true, provenance: { operation: 'discovered-base', sourceRevision: 0, createdAt: created, originalLabel: base.name ?? 'Background' } });
  await persistProposalTargets(context, master, targets, true);
  proposalGate(context);
}
export const BASE_TARGET_ID = 'target-background';
/** Provenance is server-owned: kept for known targets, derived and verified for new ones. Client values are ignored. */
function provenanceFor(target: ProposalReviewTarget, old: ProposalReviewTarget | undefined, prior: ProposalReviewTarget[], revision: number): ProposalTargetProvenance {
  if (old?.provenance) return old.provenance;
  const createdAt = new Date().toISOString();
  if (old) return { operation: 'discovered', sourceRevision: 0, createdAt, originalLabel: old.label, proposalIds: old.proposalIds };
  const members = (target.memberTargetIds ?? []).map(id => prior.find(t => t.id === id)!).filter(Boolean);
  if (target.groupMode === 'group' && members.length) return { operation: 'user-group', sourceRevision: revision, createdAt, originalLabel: target.label, proposalIds: target.proposalIds, memberTargetIds: members.map(m => m.id), memberLabels: members.map(m => m.label) };
  const parent = target.splitFromTargetId ? prior.find(t => t.id === target.splitFromTargetId) : undefined;
  if (parent && target.proposalIds.length && target.proposalIds.every(id => parent.proposalIds.includes(id))) return { operation: 'user-split', sourceRevision: revision, createdAt, originalLabel: target.label, proposalIds: target.proposalIds, parentTargetId: parent.id, parentLabel: parent.label };
  return { operation: 'user-created', sourceRevision: revision, createdAt, originalLabel: target.label, proposalIds: target.proposalIds };
}
/** `initial` targets are built by the server at discovery; later calls carry untrusted client edits. */
async function persistProposalTargets(context: PipelineContext, master: Buffer, targets: ProposalReviewTarget[], initial = false) {
  const proposals = context.job.data.proposals as ProposalSummary[];
  const prior = (context.job.data.proposalTargets ?? []) as ProposalReviewTarget[];
  const source = context.repository.getSource(context.job.sourceId)!;
  const revision = Number(context.job.data.reviewRevision ?? 0);
  const saved: ProposalReviewTarget[] = [];
  for (const incoming of targets) {
    const old = prior.find(t => t.id === incoming.id);
    // Only the server marks the base layer; a client cannot promote an arbitrary target into it.
    const isBase = initial ? incoming.baseLayer === true : old?.baseLayer === true;
    const { baseLayer: _base, provenance: _claimed, splitFromTargetId: _split, classification: _class, ...fields } = incoming; void _base; void _claimed; void _split; void _class;
    const target: ProposalReviewTarget = { ...fields, ...(isBase ? { baseLayer: true } : {}) };
    if (isBase && target.proposalIds.length) throw new DecompositionError('INVALID_TARGET', 'The background layer cannot take discovered proposals; create a separate target instead.', 409);
    target.provenance = initial && incoming.provenance ? incoming.provenance : provenanceFor({ ...target, splitFromTargetId: incoming.splitFromTargetId }, old, prior, revision);
    target.classification = classifyTarget(target, proposals);
    if (target.proposalIds.some(id => !proposals.some(p => p.id === id))) throw new DecompositionError('INVALID_PROPOSAL', 'Choose proposals belonging to this job.', 409);
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
    const baseIds = new Set(((context.job.data.proposalTargets ?? []) as ProposalReviewTarget[]).filter(t => t.baseLayer).map(t => t.id));
    if (!review.targets?.length || review.targets.filter(t => t.approved && !t.rejected && !baseIds.has(t.id)).length > context.job.options.maxObjects) throw new DecompositionError('TARGET_LIMIT', 'Keep the approved targets within the object limit.');
    await persistProposalTargets(context, master, review.targets);
    context.job.data.proposalReviewApplied = context.job.data.reviewRevision;
    context.save();
  }
  if (review.action === 'save-proposals') { proposalGate(context); context.save(); return false; }
  // The background layer is kept, not segmented, so at least one object target must be approved to continue.
  const approved = (context.job.data.proposalTargets as ProposalReviewTarget[]).filter(t => t.approved && !t.rejected && !t.baseLayer);
  if (!approved.length) { proposalGate(context); context.job.review!.message = 'Approve at least one object target, or cancel this job.'; context.save(); return false; }
  const proposals = context.job.data.proposals as ProposalSummary[];
  const classified = (context.job.data.proposalTargets as ProposalReviewTarget[]).filter(t => t.approved && !t.rejected).map(t => ({ target: t, classification: classifyTarget(t, proposals) }));
  const unknown = classified.filter(c => c.classification.kind === 'UNKNOWN');
  // UNKNOWN elements stay reviewable: nothing is routed (or paid for) until the user chooses a type.
  if (unknown.length) { proposalGate(context); context.job.review!.message = `Choose an element type (object, text, shape or background) for: ${unknown.map(c => c.target.label).join(', ')}.`; context.save(); return false; }
  context.job.data.sceneElements = classified.filter(c => c.classification.kind !== 'IMAGE_OBJECT').map(({ target, classification }) => ({
    targetId: target.id, label: target.label, kind: classification.kind, classification, proposalIds: target.proposalIds, description: target.description,
    baseLayer: target.baseLayer === true, provisionalMaskArtifactId: target.maskArtifactId, provisionalMaskRevision: target.provisionalMaskRevision }));
  context.job.data.imageObjectTargetIds = classified.filter(c => c.classification.kind === 'IMAGE_OBJECT').map(c => c.target.id);
  context.repository.event(context.job, 'element_classification', JSON.stringify(classified.map(c => ({ targetId: c.target.id, label: c.target.label, kind: c.classification.kind, confidence: c.classification.confidence, source: c.classification.source }))));
  context.job.data.proposalReviewApproved = true;
  context.save(); return true;
}
