import sharp from 'sharp';
import { randomUUID, createHash } from 'node:crypto';
import type { DecompositionReview, SemanticTarget } from '@frameflow/shared';
import type { PipelineContext } from '../context.js';
import { createTransform } from '../image/coordinates.js';
import { applyBrush, constrainMatte, decodeMask, encodeMask, emptyMask, mapMaskToNative, maskBounds, measureMask, unionMasks, validateGuidance } from '../image/masks.js';
import { overlayMasks } from '../image/overlay.js';
import { ProviderError, endpointRegistry } from '../providers/adapters.js';
import { recoverSemanticOwnership, semanticTarget, proposalSeeds, scoreSemanticMask } from './semanticOwnership.js';
import type { LayerProposal } from './proposals.js';
import type { Mask } from '../image/types.js';

export type SemanticCandidate = {
  id: string; label: string; target: SemanticTarget; source: 'sam3'; selected: boolean;
  maskArtifactId: string; alphaArtifactId?: string; overlayArtifactId: string; memberArtifactIds: string[];
  qualityStatus: 'needs-correction' | 'needs-confirmation'; warnings: string[]; revisionId: string;
  statistics: ReturnType<typeof measureMask>;
};
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));
export function deterministicProposalSeed(sourceHash: string, settings: unknown) {
  return createHash('sha256').update(sourceHash + JSON.stringify(settings)).digest().readUInt32BE(0) & 0x7fffffff;
}
async function saveTrio(context: PipelineContext, master: Buffer, mask: Mask, alpha: Mask, base: string) {
  const revisionId = randomUUID();
  const ownership = await context.put('ownership-mask', await encodeMask(mask), `${base}-mask.png`);
  const alphaRef = await context.put('ownership-alpha', await encodeMask(alpha), `${base}-alpha.png`);
  // Native-size overlay is built from the exact stored alpha, never a cached earlier preview.
  const overlay = await context.put('ownership-overlay', await overlayMasks(master, [{ mask: alpha }]), `${base}-overlay.png`);
  return { revisionId, maskRevisionId: revisionId, alphaRevisionId: revisionId, overlayRevisionId: revisionId,
    maskArtifactId: ownership.artifactId, alphaArtifactId: alphaRef.artifactId, overlayArtifactId: overlay.artifactId,
    maskSha256: ownership.sha256, alphaSha256: alphaRef.sha256, overlaySha256: overlay.sha256,
    width: mask.width, height: mask.height, coordinateSpace: 'working-master-pixels', polarity: 'white-is-object' };
}
/** Target mode has no dependency on SAM2. Automatic mode needs registered geometry or falls back to raw review. */
export async function semanticDiscovery(context: PipelineContext, master: Buffer, proposals: LayerProposal[]): Promise<boolean> {
  const source = context.repository.getSource(context.job.sourceId)!;
  const analysisTransform = context.job.data.analysisTransform as ReturnType<typeof createTransform>;
  const targets = (context.job.options.targetLabels ?? []).map((label, i) => ({ target: semanticTarget(label, `target-${i + 1}`), proposal: undefined as Mask | undefined }));
  if (!targets.length) for (const proposal of proposals.filter(p => p.registered && !p.warnings.length).slice(0, context.job.options.maxObjects)) {
    targets.push({ target: { id: `semantic-${proposal.id}`, label: `Semantic ${proposal.id}`, providerPrompt: 'the indicated object', origin: 'proposal', compositionMode: 'single', proposalId: proposal.id }, proposal: mapMaskToNative(proposal.alpha, analysisTransform) });
  }
  if (!targets.length) return false;
  const saved: SemanticCandidate[] = [];
  const priorCandidates = (context.job.data.candidates ?? []) as SemanticCandidate[];
  for (const { target, proposal } of targets.slice(0, context.job.options.maxObjects)) {
    const cached = priorCandidates.find(candidate => candidate.target?.id === target.id && candidate.target?.providerPrompt === target.providerPrompt && candidate.revisionId);
    if (cached) { await context.artifact(cached.maskArtifactId); saved.push(cached); continue; }
    const startedAt = Date.now();
    const result = await recoverSemanticOwnership(master, context.infer, { target, proposal, points: proposal && proposalSeeds(proposal), box: proposal ? maskBounds(proposal) ?? undefined : undefined });
    context.repository.event(context.job, 'semantic_quality', JSON.stringify({ targetId: target.id, label: target.label, accepted: !!result.mask, requestIds: result.providerRequestIds, latencyMs: Date.now() - startedAt, inputRevision: context.job.revision }));
    const mask = result.mask ?? emptyMask(source.width, source.height);
    const trio = await saveTrio(context, master, mask, mask, `04-semantic/${target.id}`);
    const memberArtifactIds: string[] = [];
    for (const [i, member] of result.members.entries()) memberArtifactIds.push((await context.put('member-evidence', await encodeMask(member), `04-semantic/${target.id}-member-${i + 1}.png`)).artifactId);
    saved.push({ id: target.id, label: target.label, target, source: 'sam3', selected: false, ...trio, memberArtifactIds, qualityStatus: result.mask ? 'needs-confirmation' : 'needs-correction', statistics: measureMask(mask), warnings: result.warnings });
    await context.put('semantic-quality', json({ ...result, mask: undefined, members: undefined, memberArtifactIds, ...trio, provider: endpointRegistry.sam3, unknownImmutableModelRevision: true }), `04-semantic/${target.id}-quality.json`, 'application/json');
    context.job.data.candidates = saved; context.save();
  }
  context.review(saved.some(c => c.qualityStatus === 'needs-correction') ? 'TARGET_NOT_RECOVERED' : 'SEMANTIC_OWNERSHIP_REVIEW', 'Inspect the entire requested target, including every group member. If incomplete, add/adjust guidance or repair with the native brush. Model confidence is not proof of semantic correctness.', ['accept-masks', 'guided-refine', 'manual-masks'], saved.map(c => c.overlayArtifactId));
  context.finish(4, 'Semantic ownership requires review');
  return true;
}

export async function semanticReview(context: PipelineContext, master: Buffer, correction: DecompositionReview) {
  const candidates = context.job.data.candidates as SemanticCandidate[];
  const selected = correction.objects?.filter(o => o.selected !== false) ?? [];
  if (!selected.length || selected.length > context.job.options.maxObjects || new Set(selected.map(o => o.candidateId ?? o.id)).size !== selected.length) throw new ProviderError('OBJECT_SELECTION_REQUIRED', 'Select distinct intended targets.');
  const objects = [];
  for (const object of selected) {
    const candidate = candidates.find(c => c.id === (object.candidateId ?? object.id));
    if (!candidate || candidate.id !== object.id) throw new ProviderError('INVALID_CANDIDATE', 'Reload the selected target.');
    const mask = applyBrush(await decodeMask(await context.artifact(candidate.maskArtifactId), { encoding: 'luminance', binary: true }), object.strokes ?? []);
    if (correction.action === 'accept-masks' && validateGuidance(mask, { positivePoints: object.points?.filter(p => p.label === 1), negativePoints: object.points?.filter(p => p.label === 0) }).length) {
      context.review('GUIDANCE_MASK_CONFLICT', 'Confirmed mask does not match guidance (POSITIVE_GUIDANCE_UNSATISFIED or NEGATIVE_GUIDANCE_LEAK). Use Refine with AI or manual correction.', ['guided-refine', 'manual-masks'], [candidate.overlayArtifactId]); context.save(); return;
    }
    const target = candidate.target && (!object.label || object.label === candidate.label) ? candidate.target : semanticTarget(object.label || candidate.label, candidate.id);
    objects.push({ object, candidate, mask, target });
  }
  const refined = [];
  for (const { object, candidate, mask: current, target } of objects) {
    let protectedMask = emptyMask(current.width, current.height);
    for (const other of objects) if (other.candidate.id !== candidate.id) protectedMask = unionMasks(protectedMask, other.mask);
    const manual = correction.action === 'manual-masks';
    const members: Mask[] = [];
    if (candidate.target?.label === target.label) for (const id of candidate.memberArtifactIds ?? []) members.push(await decodeMask(await context.artifact(id), { encoding: 'luminance', binary: true }));
    let mask = current;
    let quality;
    let result;
    const startedAt = Date.now();
    try {
      if (correction.action === 'guided-refine' || (!manual && (!candidate.target || target.label !== candidate.target.label))) {
        result = await recoverSemanticOwnership(master, context.infer, { target, points: object.points, box: object.box, prior: current, protectedMask, members });
        quality = { candidates: result.scores, members: result.memberScores, requestIds: result.providerRequestIds, transform: result.transform, unionSources: result.unionSources };
        if (!result.mask) {
          context.job.data.lastSemanticAttempt = { target, scores: result.scores, warnings: result.warnings, inputRevision: correction.expectedRevision };
          await context.put('rejected-semantic-attempt', json(context.job.data.lastSemanticAttempt), `review/${target.id}-${context.job.revision}-rejected.json`, 'application/json');
          context.job.phase = 4;
          context.review('TARGET_NOT_RECOVERED', 'Automatic segmentation could not confidently recover the requested object. Add/adjust guidance or use manual brush correction. Previous masks are preserved.', ['guided-refine', 'manual-masks'], [candidate.overlayArtifactId]);
          context.save(); return;
        }
        mask = result.mask;
      } else {
        const failures = manual ? validateGuidance(mask, { positivePoints: object.points?.filter(p => p.label === 1), negativePoints: object.points?.filter(p => p.label === 0), excludedMask: protectedMask }) : scoreSemanticMask(mask, { target, points: object.points, box: object.box, members, protectedMask }).reasons;
        if ((!manual && candidate.qualityStatus === 'needs-correction') || failures.length) {
          context.job.phase = 4;
          context.review('TARGET_NOT_RECOVERED', `Target needs correction (${failures.join(', ') || 'no accepted semantic mask'}). Refine with AI or save a manual mask.`, ['guided-refine', 'manual-masks'], [candidate.overlayArtifactId]); context.save(); return;
        }
      }
      let alpha = mask;
      const warnings = manual ? ['MANUAL_OWNERSHIP_REQUIRES_VISUAL_CONFIRMATION'] : ['SEMANTIC_VISUAL_REVIEW_REQUIRED'];
      // Alpha is a separate, bounded operation only after ownership passes. It cannot remove the interior.
      if (!manual && /\b(person|woman|man|girl|boy|hair|fur|portrait|dog|cat)\b/i.test(target.providerPrompt)) {
        const bounds = maskBounds(mask)!; const pad = 16;
        const crop = { x: Math.max(0, bounds.x - pad), y: Math.max(0, bounds.y - pad), width: 0, height: 0 };
        crop.width = Math.min(mask.width, bounds.x + bounds.width + pad) - crop.x; crop.height = Math.min(mask.height, bounds.y + bounds.height + pad) - crop.y;
        const transform = createTransform(mask.width, mask.height, 2048, crop);
        const image = await sharp(master).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).flatten({ background: '#ffffff' }).resize(transform.resizedWidth, transform.resizedHeight).png().toBuffer();
        const outputs = await context.infer('birefnet', { image, transform, highResolutionMatte: Math.max(crop.width, crop.height) > 1024, key: `alpha-${target.id}` });
        const matte = await decodeMask(outputs[0], { encoding: 'luminance' });
        if (matte.width !== transform.modelWidth || matte.height !== transform.modelHeight) throw new ProviderError('PROVIDER_INVALID_IMAGE', 'Alpha dimensions do not match the source crop.');
        alpha = constrainMatte(mask, mapMaskToNative(matte, transform, 'alpha'), Math.max(2, Math.ceil(Math.max(mask.width, mask.height) / 1024)), protectedMask);
        for (const point of object.points?.filter(p => p.label === 0) ?? []) alpha.data[Math.floor(point.y) * alpha.width + Math.floor(point.x)] = 0;
        warnings.push('SOFT_EDGE_VISUAL_REVIEW_REQUIRED');
      }
      const trio = await saveTrio(context, master, mask, alpha, `05-refined/${target.id}`);
      if (result?.members.length) { candidate.memberArtifactIds = []; for (const member of result.members) candidate.memberArtifactIds.push((await context.put('member-evidence', await encodeMask(member))).artifactId); }
      const entry = { id: candidate.id, label: target.label, target, ...trio, provider: manual ? 'local-brush' : endpointRegistry.sam3.endpoint,
        inputRevision: correction.expectedRevision, quality, warnings, refinementAccepted: true, ownershipSource: manual ? 'user' : 'source-semantic', memberArtifactIds: candidate.memberArtifactIds };
      refined.push(entry);
      // Updating the three references together makes the next review operate on this exact revision.
      Object.assign(candidate, trio, { label: target.label, target, qualityStatus: 'needs-confirmation', statistics: measureMask(mask), warnings });
      context.repository.event(context.job, 'semantic_refinement', JSON.stringify({ targetId: target.id, label: target.label, provider: entry.provider, inputRevision: correction.expectedRevision, maskRevision: trio.revisionId, requestIds: result?.providerRequestIds ?? [], quality, callsUsed: context.job.callsUsed, latencyMs: Date.now() - startedAt }));
      context.job.data.candidates = candidates; context.save();
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      // Auth/safety/network errors never cause a model carousel; keep the last usable revision.
      context.job.phase = 4;
      context.review(error.code, `${error.message} Previous mask revision is preserved. Use manual correction or retry explicitly.`, ['manual-masks', 'guided-refine'], [candidate.overlayArtifactId]);
      context.save(); return;
    }
  }
  context.job.data.refined = refined;
  context.job.data.refinementHasDefects = false;
  await context.put('refinement-summary', json({ phase: 5, objects: refined, provenance: context.job.data.inferences }), '05-refined/summary.json', 'application/json');
  context.review('REFINEMENT_VISUAL_REVIEW', 'Ownership checks passed. Inspect the complete target and alpha before approving original-pixel extraction. Automated checks do not prove semantic completeness.', ['approve-result', 'guided-refine', 'manual-masks'], refined.map(r => r.overlayArtifactId));
  context.finish(5, 'Semantic masks await visual confirmation');
}
export { saveTrio };
