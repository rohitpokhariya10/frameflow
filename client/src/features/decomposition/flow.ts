import type { DecompositionJobSummary, ProposalReviewTarget, QualityCheckSummary, SceneGraph } from '@frameflow/shared';

/**
 * Presentation layer for the layer-separation workflow. Pure functions that translate pipeline/domain state
 * (phases, gates, review actions, quality codes) into the five steps and plain language a customer sees.
 */
export type FlowStep = 'upload' | 'processing' | 'review' | 'refine' | 'edges' | 'ready' | 'error';
export const STEPPER = [
  { key: 'upload', label: 'Upload' },
  { key: 'separate', label: 'Separate' },
  { key: 'review', label: 'Review layers' },
  { key: 'refine', label: 'Refine' },
  { key: 'ready', label: 'Ready' },
] as const;
type Job = Pick<DecompositionJobSummary, 'state' | 'phase' | 'review' | 'reviewSubmission' | 'error' | 'candidates' | 'sceneGraph'>;

const active = (job: Job) => ['queued', 'running', 'cancel_requested'].includes(job.state);

export function flowStep(job: Job | null | undefined): FlowStep {
  if (!job) return 'upload';
  if (job.state === 'failed' || job.state === 'cancelled' || (job.state === 'needs_review' && job.review?.code === 'SUBMISSION_UNKNOWN')) return 'error';
  if (job.state === 'completed' || job.state === 'partial') return 'ready';
  if (active(job)) return 'processing';
  const gate = job.review?.gate;
  if (gate === 'qwen-proposal-review') return 'review';
  if (gate === 'alpha-review') return 'edges';
  if (gate === 'semantic-mask-review' || job.candidates?.length) return 'refine';
  return 'processing';
}

/** Which stepper item is current. Background work belongs to the step it prepares. */
export function stepperIndex(job: Job | null | undefined): number {
  const step = flowStep(job);
  if (step === 'upload') return 0;
  if (step === 'review') return 2;
  if (step === 'refine' || step === 'edges') return 3;
  if (step === 'ready') return 4;
  if (!job) return 0;
  // Processing / error: position by how far the pipeline got.
  if (job.phase < 3) return 1;
  if (job.phase === 3 && ['save-proposals', 'approve-proposals'].includes(job.reviewSubmission?.action ?? '')) return job.reviewSubmission?.action === 'save-proposals' ? 2 : 3;
  if (job.phase === 3) return 1;
  if (job.phase < 5) return 3;
  return 4;
}

export type StageState = 'done' | 'active' | 'pending';
export const PROCESSING_STAGES = ['Understanding design', 'Separating elements', 'Detecting text and shapes', 'Refining object edges', 'Building editable design'] as const;

/** Map the real job phase onto the five user-facing stages. `phase` is the last completed pipeline phase. */
export function processingStages(job: Job): { label: string; state: StageState }[] {
  const running = active(job) ? job.phase + 1 : job.phase;
  let current: number;
  if (running <= 2) current = 0;
  else if (running === 3) current = 1;
  else if (running === 4) current = job.reviewSubmission?.action === 'approve-proposals' ? 2 : 3;
  else if (running === 5) current = 3;
  else current = 4;
  if (job.state === 'completed') current = 5;
  return PROCESSING_STAGES.map((label, i) => ({ label, state: i < current ? 'done' : i === current ? 'active' : 'pending' }));
}

/** A short line for what is happening right now, never naming models or phases. */
export function processingMessage(job: Job): string {
  const action = job.reviewSubmission?.action;
  if (job.state === 'cancel_requested') return 'Stopping…';
  if (active(job) && action === 'save-proposals') return 'Saving your layer choices…';
  if (active(job) && ['manual-masks', 'manual-alpha', 'restore-interior'].includes(action ?? '')) return 'Saving your changes…';
  if (active(job) && action === 'guided-refine') return 'AI is refining the selection…';
  if (active(job) && action === 'back-to-semantic') return 'Reopening the selection…';
  if (active(job) && action === 'approve-result') return 'Building your editable design…';
  const stage = processingStages(job).find(s => s.state === 'active');
  return stage ? `${stage.label}…` : 'Preparing your design…';
}

export type FriendlyType = 'Image' | 'Text' | 'Shape' | 'Background' | 'Choose type';
const ROLE_TYPE: Record<ProposalReviewTarget['role'], FriendlyType | undefined> = { object: 'Image', foreground: 'Image', text: 'Text', shape: 'Shape', background: 'Background', unknown: undefined };
const KIND_TYPE: Record<string, FriendlyType> = { IMAGE_OBJECT: 'Image', TEXT: 'Text', SHAPE: 'Shape', BACKGROUND: 'Background', UNKNOWN: 'Choose type' };
export const TYPE_ROLE: Record<Exclude<FriendlyType, 'Choose type'>, ProposalReviewTarget['role']> = { Image: 'object', Text: 'text', Shape: 'shape', Background: 'background' };

/** Explicit choice first, then the saved suggestion; unsaved new layers are images, as the server will classify them. */
export function friendlyType(target: ProposalReviewTarget): { type: FriendlyType; suggested: boolean } {
  if (target.baseLayer) return { type: 'Background', suggested: false };
  const explicit = ROLE_TYPE[target.role];
  if (explicit) return { type: explicit, suggested: false };
  if (!target.classification) return { type: 'Image', suggested: true };
  return { type: KIND_TYPE[target.classification.kind] ?? 'Choose type', suggested: true };
}

/** Plain-language selection feedback for quality checks. Codes never reach the default UI. */
const CHECK_COPY: Record<string, string> = {
  EMPTY_MASK: 'Nothing is selected yet.',
  MASK_COVERS_MOST_OF_CANVAS: 'The selection covers almost the whole image.',
  TINY_PATCH: 'Only a small part of the object is selected.',
  TARGET_INCOMPLETE: 'Parts of the object seem to be missing.',
  BOX_NOT_COVERED: 'Parts of the object seem to be missing.',
  POSITIVE_GUIDANCE_UNSATISFIED: 'An area you added is not selected yet.',
  NEGATIVE_GUIDANCE_LEAK: 'An area you removed is still selected.',
  PROTECTED_OWNERSHIP_OVERLAP: 'The selection overlaps another layer.',
  GROUP_MEMBER_MISSING: 'One of the combined items is missing from the selection.',
  GROUP_MEMBERS_UNVERIFIED: 'Check that every combined item is included.',
  MASK_PATHOLOGICAL: 'The selection runs along the edge of the image.',
  MASK_TOO_FRAGMENTED: 'The selection is broken into many small pieces.',
  BORDER_CONTACT: 'The object touches the edge of the image — check nothing is cut off.',
  DISJOINT_PIECES: 'The selection has separate pieces — check they all belong.',
  INTERIOR_HOLES: 'There are gaps inside the selection.',
  LOW_PROVIDER_CONFIDENCE: 'AI was not fully sure about this selection.',
  MANUAL_OWNERSHIP: 'You edited this selection — take a quick look before continuing.',
};
export type SelectionStatus = { tone: 'good' | 'check' | 'fix'; title: string; details: string[] };
export function selectionStatus(candidate: { qualityTier?: string; qualityStatus?: string; qualityChecks?: QualityCheckSummary[] } | undefined): SelectionStatus {
  const tier = candidate?.qualityTier ?? (candidate?.qualityStatus === 'needs-correction' ? 'FAIL' : 'REVIEW');
  const details = [...new Set((candidate?.qualityChecks ?? []).map(check => CHECK_COPY[check.code] ?? 'Take a quick look at this selection.'))];
  if (tier === 'FAIL') return { tone: 'fix', title: 'Needs a fix', details: details.length ? details : ['AI could not find the whole object. Paint over it or use AI refine.'] };
  if (tier === 'PASS') return { tone: 'good', title: 'Looks right', details };
  return { tone: 'check', title: 'Take a quick look', details };
}

/** Friendly error copy with a recovery hint; technical codes stay in Developer details. */
export function friendlyError(job: Pick<DecompositionJobSummary, 'state' | 'error' | 'review' | 'retry'>): { title: string; message: string; canRetry: boolean; exhausted?: boolean } {
  if (job.state === 'cancelled') return { title: 'This design was stopped', message: 'You can start again with the same image.', canRetry: false };
  // The server allows one explicit retry per attempt; after that, offer a fresh attempt instead of a dead button.
  if (job.retry && !job.retry.available && job.retry.reason !== 'NOT_RETRYABLE_STATE') return { title: 'This attempt can’t be retried', canRetry: false, exhausted: true,
    message: job.retry.reason === 'CALL_BUDGET' ? 'This attempt has used its AI allowance. Your image and progress are kept — start a new attempt to continue.' : 'We already tried again once. Your image and progress are kept — start a new attempt and we’ll reuse what AI already found.' };
  const code = job.error?.code ?? job.review?.code ?? '';
  if (code === 'SUBMISSION_UNKNOWN') return { title: 'We lost track of a request', message: 'The AI service may still have finished. Try again later or start over.', canRetry: false };
  if (['PROVIDER_AUTH', 'PROVIDER_CREDITS', 'PROVIDER_NOT_CONFIGURED', 'FAL_NOT_CONFIGURED'].includes(code)) return { title: 'AI layers are unavailable right now', message: 'The AI service is not available for this account. Your design is safe.', canRetry: false };
  if (code === 'PROVIDER_SAFETY_REFUSAL') return { title: 'This image cannot be processed', message: 'The AI service declined this image. Try a different one.', canRetry: false };
  if (['PROVIDER_RATE_LIMIT', 'PROVIDER_NETWORK', 'PROVIDER_UNAVAILABLE', 'PROVIDER_DEADLINE', 'DEADLINE_EXCEEDED'].includes(code)) return { title: 'The AI service is busy', message: 'Nothing you did was lost. Try again in a moment.', canRetry: job.error?.retryable !== false };
  return { title: 'Something went wrong', message: 'Your progress is saved. Try again, or start over with a new image.', canRetry: job.error?.retryable !== false };
}

/** Counts for the ready screen. */
export function readySummary(graph: SceneGraph | undefined) {
  const layers = graph?.layers ?? [];
  const count = (type: string) => layers.filter(l => l.type === type).length;
  return { editable: layers.filter(l => l.type !== 'background').length, text: count('text'), shapes: count('shape'), images: count('image'), background: count('background') > 0 };
}

/** A friendly note about the outcome of the last review action, when the pipeline sent the user back. */
export function reviewNotice(job: Pick<DecompositionJobSummary, 'review' | 'reviewSubmission'>): string | undefined {
  const code = job.review?.code, action = job.reviewSubmission?.action;
  if (code === 'TARGET_NOT_RECOVERED') return action === 'guided-refine' ? 'AI couldn’t improve this selection. Paint over the missing parts or remove extra areas, then save.' : 'This selection still needs a fix before we can continue.';
  if (code === 'GUIDANCE_MASK_CONFLICT') return 'Some of your hints don’t match the selection. Paint the area directly or use AI refine.';
  if (code === 'ALPHA_REVIEW_REQUIRED') return 'That edge change couldn’t be saved because it would remove too much. Your previous version is kept.';
  if (code && /^PROVIDER_/.test(code)) return 'The AI service is busy right now. Your selection is saved — try AI refine again in a moment, or paint the fix yourself.';
  return undefined;
}
