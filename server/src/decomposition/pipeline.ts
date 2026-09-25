import type { DecompositionReview } from '@frameflow/shared';
import type { PipelineContext } from './context.js';
import { createAnalysis } from './phases/analysis.js';
import { createLayerProposals, type LayerProposal } from './phases/proposals.js';
import { segmentObjects } from './phases/segmentation.js';
import { refineObjects, type RefinementObject } from './phases/refinement.js';
import { applyBrush, decodeMask, encodeMask, mapMaskToNative, measureMask, overlapMasks, unionMasks, emptyMask, resizeMask } from './image/masks.js';
import type { Mask } from './image/types.js';
import type { ImageTransform } from './image/coordinates.js';
import { overlayMasks } from './image/overlay.js';
import { DecompositionError } from './errors.js';

interface SavedProposal { id: string; label: string; artifactId: string; width: number; height: number; registered: boolean; warnings: string[] }
interface SavedCandidate {
  id: string; label: string; maskArtifactId: string; analysisMaskArtifactId: string; overlayArtifactId: string;
  selected: boolean; warnings: string[]; statistics: ReturnType<typeof measureMask>; proposalMatches: unknown[];
  labelSource: 'generic' | 'target-prompt' | 'user';
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));
const seq = (i: number) => String(i + 1).padStart(3, '0');

async function proposals(context: PipelineContext): Promise<LayerProposal[]> {
  const output: LayerProposal[] = [];
  for (const saved of (context.job.data.proposals ?? []) as SavedProposal[]) {
    const rgba = await context.artifact(saved.artifactId);
    output.push({ ...saved, rgba, alpha: await decodeMask(rgba, { encoding: 'alpha' }) });
  }
  return output;
}

/** Concrete five-stage demo. There is no dispatch path to extraction or completion. */
export async function runPhase(context: PipelineContext) {
  const { job } = context;
  const source = context.repository.getSource(job.sourceId, job.ownerId);
  if (!source) throw new DecompositionError('SOURCE_NOT_FOUND', 'The validated source is unavailable.', 404);
  const phase = job.phase + 1;
  if (phase > 5) throw new DecompositionError('DEMO_SCOPE', 'This iteration stops at refined masks in phase 5.', 409);
  const master = await context.artifact(source.masterArtifactId);
  if (phase === 1) {
    await context.artifact(source.originalArtifactId); // Hash integrity is verified by the artifact store.
    await context.put('source-master', master, '01-original/working-master.png');
    await context.put('source-metadata', json({ width: source.width, height: source.height, originalSha256: source.originalSha256, workingMasterSha256: source.workingMasterSha256, mimeType: source.mimeType, colorSpace: 'srgb', precision: '8-bit SDR', orientationNormalized: source.orientationNormalized, hasAlpha: source.hasAlpha, verificationMode: job.data.verificationMode ?? 'live' }), '01-original/metadata.json', 'application/json');
    context.finish(1, 'Source validated and preserved'); return;
  }
  if (phase === 2) {
    const result = await createAnalysis(master, context.config.analysisMaxSide);
    const analysis = await context.put('analysis', result.analysis, '02-analysis/analysis.png');
    const preview = await context.put('source-preview', result.preview, '02-analysis/preview.png');
    job.data.analysisArtifactId = analysis.artifactId; job.data.previewArtifactId = preview.artifactId; job.data.analysisTransform = result.transform;
    await context.put('transform', json({ ...result.transform, analysisWidth: result.width, analysisHeight: result.height, analysisSha256: result.sha256 }), '02-analysis/transform.json', 'application/json');
    context.finish(2, 'Analysis image and exact transform ready'); return;
  }
  const analysis = await context.artifact(String(job.data.analysisArtifactId));
  const transform = job.data.analysisTransform as ImageTransform;
  if (phase === 3) {
    const result = await createLayerProposals(analysis, context.infer, 4);
    const saved: SavedProposal[] = [];
    for (const [i, proposal] of result.proposals.entries()) {
      const record = await context.put('qwen-proposal', proposal.rgba, `03-qwen/proposal-${seq(i)}.png`);
      const { id, label, width, height, registered, warnings } = proposal;
      saved.push({ id, label, width, height, registered, warnings, artifactId: record.artifactId });
    }
    context.job.data.proposals = saved;
    result.warnings.forEach((warning) => context.warn(warning));
    await context.put('proposal-metadata', json({ proposals: saved, warnings: result.warnings, provenance: context.job.data.inferences }), '03-qwen/proposals.json', 'application/json');
    context.finish(3, 'Qwen proposals saved; source masks are next'); return;
  }
  if (phase === 4) {
    const result = await segmentObjects(analysis, context.infer, { proposals: await proposals(context), maxObjects: job.options.maxObjects });
    const saved: SavedCandidate[] = []; const overlays: { mask: Mask }[] = [];
    for (const [i, candidate] of result.candidates.entries()) {
      const mask = await context.put('candidate-mask', await encodeMask(candidate.mask), `04-sam2/candidate-${seq(i)}.png`);
      const native = mapMaskToNative(candidate.mask, transform);
      const nativeRecord = await context.put('review-mask', await encodeMask(native), `04-sam2/review-${seq(i)}-native.png`);
      const overlay = await context.put('candidate-overlay', await overlayMasks(analysis, [{ mask: candidate.mask }]), `04-sam2/candidate-${seq(i)}-overlay.png`);
      saved.push({ id: candidate.id, label: candidate.label, labelSource: candidate.labelSource, maskArtifactId: nativeRecord.artifactId, analysisMaskArtifactId: mask.artifactId, overlayArtifactId: overlay.artifactId, selected: result.selectedIds.includes(candidate.id), warnings: candidate.warnings, statistics: candidate.statistics, proposalMatches: candidate.proposalMatches });
      overlays.push({ mask: candidate.mask });
    }
    context.job.data.candidates = saved;
    const overlay = await context.put('segmentation-overlay', await overlayMasks(analysis, overlays), '04-sam2/overlay.png');
    await context.put('candidate-metadata', json({ candidates: saved, rejected: result.rejected, analysisTransform: transform, reviewRequired: true, warnings: result.warnings, suggestedTargetLabels: job.options.targetLabels }), '04-sam2/candidates.json', 'application/json');
    context.review('OWNERSHIP_CONFIRMATION_REQUIRED', 'Select the intended objects, name them, and confirm their visible masks. Add negative points on face, shirt and fingers near a board.', ['accept-masks', 'guided-refine'], [overlay.artifactId]);
    context.finish(4, 'Object candidates ready for review'); return;
  }
  const correction = job.data.reviewSubmission as DecompositionReview | undefined;
  if (!correction) throw new DecompositionError('REVIEW_REQUIRED', 'Confirm the candidate masks before refinement.', 409);
  if (correction.action === 'approve-result' && job.data.refined) {
    job.state = job.data.refinementHasDefects ? 'partial' : 'completed'; job.data.resultReviewed = true; job.review = undefined;
    context.finish(5, job.state === 'completed' ? 'Phase 5 complete — reviewed masks ready' : 'Phase 5 partial — reviewed masks and warnings saved'); return;
  }
  const candidates = job.data.candidates as SavedCandidate[];
  const selected = (correction.objects ?? []).filter((object) => object.selected !== false);
  if (!selected.length || selected.length > job.options.maxObjects) throw new DecompositionError('OBJECT_SELECTION_REQUIRED', `Select between 1 and ${job.options.maxObjects} objects.`, 409);
  const nativeObjects: RefinementObject[] = [];
  for (const object of selected) {
    const candidate = candidates.find((item) => item.id === (object.candidateId ?? object.id));
    if (!candidate) throw new DecompositionError('INVALID_CANDIDATE', 'Choose a candidate from this job.', 409);
    const corrected = applyBrush(await decodeMask(await context.artifact(candidate.maskArtifactId), { encoding: 'luminance', binary: true }), object.strokes ?? []);
    if (!measureMask(corrected).area) throw new DecompositionError('EMPTY_MASK', 'The corrected object mask is empty.', 409);
    nativeObjects.push({ id: candidate.id, label: object.label?.trim() || candidate.label, mask: corrected, points: object.points, box: object.box, ownershipConfirmed: true });
  }
  for (const object of nativeObjects) {
    let excluded = emptyMask(source.width, source.height);
    for (const neighbor of nativeObjects) if (neighbor.id !== object.id) excluded = unionMasks(excluded, neighbor.mask);
    // Ownership conflicts must be corrected explicitly. Do not invent a front/back order.
    if (overlapMasks(object.mask, excluded).intersection) {
      context.review('OVERLAPPING_VISIBLE_OWNERSHIP', 'Selected masks share visible pixels. Subtract neighboring face, fingers or background pixels before confirming.', ['accept-masks', 'guided-refine']);
      context.save(); return;
    }
    object.excludedMask = excluded;
  }
  const result = await refineObjects(master, context.infer, nativeObjects);
  const refined = [];
  for (const [i, object] of result.objects.entries()) {
    const base = `05-refined/object-${seq(i)}`;
    const mask = await context.put('refined-mask', await encodeMask(object.visibleOwnership), `${base}-mask.png`);
    const alpha = await context.put('refined-alpha', await encodeMask(object.alpha), `${base}-alpha.png`);
    const previewMask = resizeMask(object.alpha, transform.resizedWidth, transform.resizedHeight, 'alpha');
    const overlay = await context.put('refined-overlay', await overlayMasks(analysis, [{ mask: previewMask }]), `${base}-overlay.png`);
    refined.push({ id: object.id, label: object.label, maskArtifactId: mask.artifactId, alphaArtifactId: alpha.artifactId, overlayArtifactId: overlay.artifactId, maskSha256: mask.sha256, alphaSha256: alpha.sha256, width: mask.width, height: mask.height, polarity: 'white-is-object', coordinateSpace: 'working-master-pixels', transform: object.transform, warnings: object.warnings, reviewRequired: object.reviewRequired });
  }
  context.job.data.refined = refined; context.job.data.refinementHasDefects = result.reviewRequired;
  result.warnings.forEach((warning) => context.warn(warning));
  await context.put('refinement-summary', json({ phase: 5, verificationMode: job.data.verificationMode ?? 'live', objects: refined, analysisTransform: transform, provenance: context.job.data.inferences, warnings: result.warnings, originalPixelsExtracted: false }), '05-refined/summary.json', 'application/json');
  context.review('REFINEMENT_VISUAL_REVIEW', 'Inspect refined masks and alpha on light/dark surfaces. Check face and finger exclusions. Approve the inspection or correct the masks; this demo stops at phase 5.', ['approve-result', 'accept-masks'], refined.map((r) => r.overlayArtifactId));
  context.finish(5, 'Phase 5 refined masks ready for inspection');
}
