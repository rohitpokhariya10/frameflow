import sharp from 'sharp';
import { initializeProposalReview, applyProposalReview, proposalGate } from './phases/proposalReview.js';
import { regroupMasks, reviewAlpha } from './phases/maskReviewActions.js';
import { decodeRgba } from './image/extract.js';
import { semanticDiscovery, semanticReview } from './phases/semanticPipeline.js';
import { extractVisibleLayers } from './phases/extract.js';
import { mockReviewObjects } from './providers/mock.js';
import { validDecompositionReview, type DecompositionReview } from '@frameflow/shared';
import type { PipelineContext } from './context.js';
import { createAnalysis } from './phases/analysis.js';
import { createLayerProposals, type LayerProposal } from './phases/proposals.js';
import { segmentObjects } from './phases/segmentation.js';
import { refineObjects, type RefinementObject } from './phases/refinement.js';
import { applyBrush, decodeMask, encodeMask, mapMaskToNative, measureMask, overlapMasks, unionMasks, emptyMask, resizeMask, validateGuidance } from './image/masks.js';
import type { Mask } from './image/types.js';
import type { ImageTransform } from './image/coordinates.js';
import { overlayMasks } from './image/overlay.js';
import { DecompositionError } from './errors.js';

interface SavedProposal { id: string; label: string; artifactId: string; width: number; height: number; registered: boolean; warnings: string[] }
interface SavedCandidate {
  id: string; label: string; source?: string; sourceCandidateIds?: string[]; proposalId?: string; maskArtifactId: string; analysisMaskArtifactId: string; overlayArtifactId: string;
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

/** Durable review gates surround source segmentation and alpha; dispatch stops at phase 6. */
export async function runPhase(context: PipelineContext) {
  const { job } = context;
  const source = context.repository.getSource(job.sourceId, job.ownerId);
  if (!source) throw new DecompositionError('SOURCE_NOT_FOUND', 'The validated source is unavailable.', 404);
  const phase = job.phase + 1;
  if (phase > 6) throw new DecompositionError('DEMO_SCOPE', 'This iteration stops at native extraction in phase 6.', 409);
  const master = await context.artifact(source.masterArtifactId);
  if (phase === 6) {
    if (job.data.reviewWorkflow === 2 && !job.data.resultReviewed) throw new DecompositionError('FINAL_REVIEW_REQUIRED', 'Approve the current alpha revision before extracting pixels.', 409);
    const refined = job.data.refined as {id:string;label:string;alphaArtifactId:string;maskArtifactId:string}[];
    if (!refined?.length) throw new DecompositionError('MASKS_REQUIRED','Accept refined masks before extraction.',409);
    const selections = [];
    for (const object of refined) selections.push({id:object.id,label:object.label,mask:await decodeMask(await context.artifact(object.alphaArtifactId),{encoding:'luminance'})});
    const result = await extractVisibleLayers(master,selections);
    const native = await decodeRgba(master);
    for (const [i, selection] of selections.entries()) {
      const pixels = Buffer.from(native.data);
      for (let p = 0; p < selection.mask.data.length; p++) pixels[p * 4 + 3] = Math.round(pixels[p * 4 + 3] * selection.mask.data[p] / 255);
      await context.put('native-extracted-layer', await sharp(pixels, { raw: { width: source.width, height: source.height, channels: 4 } }).png().toBuffer(), `06-extracted/object-${seq(i)}-native.png`);
    }
    const metadata = [];
    for (const [i,layer] of [...result.layers,...(result.residual?[result.residual]:[])].entries()) {
      const name = job.data.verificationMode === 'mock' && ['person','board'].includes(layer.label) ? layer.label : layer.id === 'residual' ? 'residual' : `object-${seq(i)}`;
      const rgba = await context.put('extracted-layer',layer.rgba,`06-extracted/${name}.png`);
      await context.put('extracted-alpha',layer.alpha,`06-extracted/${name}-alpha.png`);
      for (const [surface,color] of [['white','#ffffff'],['dark','#18202c']]) await context.put('extracted-preview',await sharp(layer.rgba).flatten({background:color}).png().toBuffer(),`06-extracted/${name}-on-${surface}.png`);
      metadata.push({objectId:layer.id,label:layer.label,bbox:layer.bbox,rgbaArtifactId:rgba.artifactId,alphaMode:'straight',workingMasterSha256:source.workingMasterSha256});
    }
    await context.put('extraction-metadata',json({phase:6,providerMode:job.data.verificationMode,liveVerified:false,nativeWidth:source.width,nativeHeight:source.height,objects:metadata,rgbProvenance:'Original working-master RGB',coverage:result.coverage}),'06-extracted/metadata.json','application/json');
    context.job.state='completed';context.job.review=undefined;context.job.data.extracted=metadata;
    context.finish(6,'Phase 6 of 6 — Extracted native layers ready');return;
  }
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
    const request = context.job.data.qwenRequest as { sentSeed?: number; effectiveInput?: { prompt?: string }; requestFingerprint?: string } | undefined;
    const saved: SavedProposal[] = [];
    for (const [i, proposal] of result.proposals.entries()) {
      const record = await context.put('qwen-proposal', proposal.rgba, `03-qwen/proposal-${seq(i)}.png`);
      const alpha = await context.put('qwen-alpha', await encodeMask(proposal.alpha), `03-qwen/proposal-${seq(i)}-alpha.png`);
      const { id, label, width, height, registered, warnings } = proposal;
      saved.push({ id, label, width, height, registered, warnings, artifactId: record.artifactId, ...{ alphaArtifactId: alpha.artifactId, bounds: measureMask(proposal.alpha).bbox, coverage: measureMask(proposal.alpha).areaFraction, seed: request?.sentSeed, prompt: request?.effectiveInput?.prompt, requestFingerprint: request?.requestFingerprint, promptNote: 'Fixed image caption for discovery only; explicit target intent belongs to source SAM segmentation.' } });
    }
    context.job.data.proposals = saved;
    result.warnings.forEach((warning) => context.warn(warning));
    await context.put('proposal-metadata', json({ proposals: saved, warnings: result.warnings, provenance: context.job.data.inferences }), '03-qwen/proposals.json', 'application/json');
    await initializeProposalReview(context, master);
    context.finish(3, 'Review discovered layers before source segmentation'); return;
  }
  if (phase === 4) {
    if (job.data.reviewWorkflow === 2) {
      const review = job.data.reviewSubmission as DecompositionReview | undefined;
      if (!job.data.proposalReviewApproved) {
        if (!review || !['save-proposals','approve-proposals'].includes(review.action)) { proposalGate(context); context.save(); return; }
        if (!await applyProposalReview(context, master, review)) return;
      }
      if (await semanticDiscovery(context, master, await proposals(context))) return;
    } else if (job.data.verificationMode !== 'mock' && await semanticDiscovery(context, master, await proposals(context))) return;
    const result = await segmentObjects(analysis, context.infer, { proposals: await proposals(context), maxObjects: job.options.maxObjects });
    const saved: SavedCandidate[] = []; const overlays: { mask: Mask }[] = [];
    for (const candidate of result.candidates) {
      const candidateName = candidate.id.replace(/(\d+)$/, (number) => number.padStart(3, '0'));
      const mask = await context.put('candidate-mask', await encodeMask(candidate.mask), `04-sam2/${candidateName}.png`);
      const native = mapMaskToNative(candidate.mask, transform);
      const nativeRecord = await context.put('review-mask', await encodeMask(native), `04-sam2/${candidateName}-native.png`);
      const overlay = await context.put('candidate-overlay', await overlayMasks(analysis, [{ mask: candidate.mask }]), `04-sam2/${candidateName}-overlay.png`);
      saved.push({ source: candidate.source, sourceCandidateIds: candidate.sourceCandidateIds, proposalId: candidate.proposalId, id: candidate.id, label: candidate.label, labelSource: candidate.labelSource, maskArtifactId: nativeRecord.artifactId, analysisMaskArtifactId: mask.artifactId, overlayArtifactId: overlay.artifactId, selected: false, warnings: candidate.warnings, statistics: candidate.statistics, proposalMatches: candidate.proposalMatches });
      overlays.push({ mask: candidate.mask });
    }
    context.job.data.candidates = saved;
    const overlay = await context.put('segmentation-overlay', await overlayMasks(analysis, overlays), '04-sam2/overlay.png');
    await context.put('candidate-metadata', json({ candidates: saved, rejected: result.rejected, analysisTransform: transform, reviewRequired: true, warnings: result.warnings, suggestedTargetLabels: job.options.targetLabels }), '04-sam2/candidates.json', 'application/json');
    if (job.data.verificationMode === 'mock') {
      context.job.data.reviewSubmission={expectedRevision:context.job.revision,action:'accept-masks',objects:mockReviewObjects};
      context.finish(4,'Phase 4 of 6 — Known fixture masks selected (mock)');return;
    }
    context.review('OWNERSHIP_CONFIRMATION_REQUIRED', 'Select an intended raw or synthesized object and name it. If none covers the full object, choose the closest mask, add positive points on missing regions and negative points on background, then Refine with guidance.', ['accept-masks', 'guided-refine'], [overlay.artifactId]);
    context.finish(4, 'Object candidates ready for review'); return;
  }
  const correction = job.data.reviewSubmission as DecompositionReview | undefined;
  if (!correction) throw new DecompositionError('REVIEW_REQUIRED', 'Confirm the candidate masks before refinement.', 409);
  if (!validDecompositionReview(correction, source.width, source.height)) throw new DecompositionError('INVALID_REVIEW', 'Review coordinates or structure are invalid.', 400);
  if (['merge-targets','split-target'].includes(correction.action)) { await regroupMasks(context, master, correction); return; }
  if (['manual-alpha','restore-interior','back-to-semantic'].includes(correction.action)) { await reviewAlpha(context, master, correction); return; }
  if (correction.action === 'approve-result' && job.data.refined) {
    if ((job.data.refined as { refinementAccepted?: boolean }[]).some(item => item.refinementAccepted === false)) {
      context.review('TARGET_NOT_RECOVERED', 'A rejected semantic mask cannot be approved. Correct the target or save a manual mask.', ['guided-refine', 'manual-masks']); context.save(); return;
    }
    const records = job.data.refined as { revisionId?: string; maskRevisionId?: string; alphaRevisionId?: string; overlayRevisionId?: string; qualityStatus?: string }[];
    if (records.some(r => r.revisionId && (r.maskRevisionId !== r.revisionId || r.alphaRevisionId !== r.revisionId || r.overlayRevisionId !== r.revisionId))) throw new DecompositionError('REVISION_MISMATCH', 'Reload matching mask, alpha and overlay before approval.', 409);
    for (const r of records) r.qualityStatus = 'PASS';
    job.state = 'running'; job.data.resultReviewed = true; job.review = undefined;
    context.finish(5, 'Phase 5 of 6 — Refined masks accepted; extracting source pixels'); return;
  }
  if (job.data.reviewWorkflow === 2 || job.data.verificationMode !== 'mock' || correction.action === 'manual-masks') { await semanticReview(context, master, correction); return; }
  const candidates = job.data.candidates as SavedCandidate[];
  const selected = (correction.objects ?? []).filter((object) => object.selected !== false);
  if (!selected.length || selected.length > job.options.maxObjects) throw new DecompositionError('OBJECT_SELECTION_REQUIRED', `Select between 1 and ${job.options.maxObjects} objects.`, 409);
  const nativeObjects: RefinementObject[] = [];
  const seen = new Set<string>();
  const refinementInputs = [];
  for (const object of selected) {
    const candidate = candidates.find((item) => item.id === (object.candidateId ?? object.id));
    if (candidate && (object.id !== candidate.id || seen.has(candidate.id))) throw new DecompositionError('INVALID_CANDIDATE_MAPPING', 'Each review object must identify its own unique candidate.', 409);
    if (!candidate) throw new DecompositionError('INVALID_CANDIDATE', 'Choose a candidate from this job.', 409);
    seen.add(candidate.id);
    const corrected = applyBrush(await decodeMask(await context.artifact(candidate.maskArtifactId), { encoding: 'luminance', binary: true }), object.strokes ?? []);
    if (!measureMask(corrected).area) throw new DecompositionError('EMPTY_MASK', 'The corrected object mask is empty.', 409);
    const conflicts = validateGuidance(corrected, { positivePoints: object.points?.filter(p => p.label === 1), negativePoints: object.points?.filter(p => p.label === 0) });
    if (conflicts.length && correction.action !== 'guided-refine') {
      context.review('GUIDANCE_MASK_CONFLICT', `${candidate.id}: saved points conflict with this mask (${conflicts.join(', ')}). Use Refine with guidance to add missing regions or remove unwanted support, or correct the mask with the brush. Renaming a patch does not select the whole person. No refinement call was made.`, ['accept-masks', 'guided-refine'], [candidate.overlayArtifactId]);
      context.save(); return;
    }
    refinementInputs.push({ labelSource: object.label?.trim() && object.label.trim() !== candidate.label ? 'user' : candidate.labelSource, candidateId: candidate.id, inputMaskArtifactId: candidate.maskArtifactId, positivePointCount: object.points?.filter(p => p.label === 1).length ?? 0, negativePointCount: object.points?.filter(p => p.label === 0).length ?? 0, correctionMode: correction.action === 'guided-refine', sourceCandidateIds: candidate.sourceCandidateIds, proposalId: candidate.proposalId, correctedArea: measureMask(corrected).area });
    nativeObjects.push({ id: candidate.id, label: object.label?.trim() || candidate.label, mask: corrected, points: object.points, box: object.box, ownershipConfirmed: true, correctionMode: correction.action === 'guided-refine' });
  }
  for (const object of nativeObjects) {
    let excluded = emptyMask(source.width, source.height);
    for (const neighbor of nativeObjects) if (neighbor.id !== object.id) excluded = unionMasks(excluded, neighbor.mask);
    // Ownership conflicts must be corrected explicitly. Do not invent a front/back order.
    if (overlapMasks(object.mask, excluded).intersection) {
      context.review('OVERLAPPING_VISIBLE_OWNERSHIP', `${object.id} overlaps another included candidate. Included: ${nativeObjects.map(item => item.id).join(', ')}. Use only the full-object candidate or exclude overlapping fragments; viewing a dropdown option does not exclude others. No provider call was made.`, ['accept-masks', 'guided-refine']);
      context.save(); return;
    }
    object.excludedMask = excluded;
  }
  context.job.data.refinementInputs = refinementInputs;
  context.save();
  const result = await refineObjects(master, context.infer, nativeObjects);
  if (result.objects.some(object => !object.refinementAccepted)) {
    context.review('TARGET_NOT_RECOVERED', 'Segmentation did not recover the intended object. Correct guidance or repair the mask manually.', ['guided-refine', 'manual-masks']); context.save(); return;
  }
  const refined = [];
  for (const [i, object] of result.objects.entries()) {
    const base = `05-refined/object-${seq(i)}`;
    const mask = await context.put('refined-mask', await encodeMask(object.visibleOwnership), `${base}-mask.png`);
    const alpha = await context.put('refined-alpha', await encodeMask(object.alpha), `${base}-alpha.png`);
    const previewMask = resizeMask(object.alpha, transform.resizedWidth, transform.resizedHeight, 'alpha');
    const overlay = await context.put('refined-overlay', await overlayMasks(analysis, [{ mask: previewMask }]), `${base}-overlay.png`);
    refined.push({ input: refinementInputs.find(input => input.candidateId === object.id), refinementAccepted: object.refinementAccepted, id: object.id, label: object.label, labelSource: refinementInputs.find(input => input.candidateId === object.id)?.labelSource, source: object.refinementAccepted ? 'sam3-refined' : 'retained-input', maskArtifactId: mask.artifactId, alphaArtifactId: alpha.artifactId, overlayArtifactId: overlay.artifactId, maskSha256: mask.sha256, alphaSha256: alpha.sha256, width: mask.width, height: mask.height, polarity: 'white-is-object', coordinateSpace: 'working-master-pixels', transform: object.transform, warnings: object.warnings, reviewRequired: object.reviewRequired });
  }
  context.job.data.refined = refined; context.job.data.refinementHasDefects = result.reviewRequired;
  result.warnings.forEach((warning) => context.warn(warning));
  await context.put('refinement-summary', json({ phase: 5, verificationMode: job.data.verificationMode ?? 'live', objects: refined, analysisTransform: transform, provenance: context.job.data.inferences, warnings: result.warnings, originalPixelsExtracted: false }), '05-refined/summary.json', 'application/json');
  if (job.data.verificationMode === 'mock') {context.warn('Mock fixture masks; soft edges remain for visual inspection.');context.finish(5,'Phase 5 of 6 — Refined fixture masks ready');return;}
  context.review('REFINEMENT_VISUAL_REVIEW', 'Inspect refined masks and alpha on light/dark surfaces. Check face and finger exclusions. Approve the inspection or correct the masks; this demo stops at phase 5.', ['approve-result', 'accept-masks'], refined.map((r) => r.overlayArtifactId));
  context.finish(5, 'Phase 5 refined masks ready for inspection');
}
