import { describe, expect, it } from 'vitest';
import type { DecompositionJobSummary, ProposalReviewTarget } from '@frameflow/shared';
import { flowStep, friendlyError, friendlyType, processingMessage, processingStages, readySummary, selectionStatus, stepperIndex } from './flow';

const job = (patch: Partial<DecompositionJobSummary>) => ({ state: 'running', phase: 0, warnings: [], ...patch }) as DecompositionJobSummary;
const target = (patch: Partial<ProposalReviewTarget>): ProposalReviewTarget => ({ id: 't', label: 'x', proposalIds: [], approved: false, rejected: false, groupMode: 'single', role: 'unknown', ...patch });

describe('presentation flow', () => {
  it('maps pipeline state to the five customer steps without exposing phases', () => {
    expect(flowStep(null)).toBe('upload');
    expect(flowStep(job({ state: 'running', phase: 1 }))).toBe('processing');
    expect(flowStep(job({ state: 'needs_review', phase: 3, review: { gate: 'qwen-proposal-review', code: 'x', message: '', actions: [], artifactIds: [] } }))).toBe('review');
    expect(flowStep(job({ state: 'needs_review', phase: 4, review: { gate: 'semantic-mask-review', code: 'x', message: '', actions: [], artifactIds: [] } }))).toBe('refine');
    expect(flowStep(job({ state: 'needs_review', phase: 5, review: { gate: 'alpha-review', code: 'x', message: '', actions: [], artifactIds: [] } }))).toBe('edges');
    expect(flowStep(job({ state: 'completed', phase: 6 }))).toBe('ready');
    expect(flowStep(job({ state: 'failed', phase: 3 }))).toBe('error');
    expect(flowStep(job({ state: 'failed', phase: 3, error: { code: 'TARGET_LIMIT', message: '', retryable: true }, reviewSubmission: { expectedRevision: 1, action: 'save-proposals', targets: [] } }))).toBe('review');
    expect(flowStep(job({ state: 'needs_review', phase: 3, review: { code: 'SUBMISSION_UNKNOWN', message: '', actions: [], artifactIds: [] } }))).toBe('error');
    expect(stepperIndex(job({ state: 'running', phase: 1 }))).toBe(1);
    expect(stepperIndex(job({ state: 'queued', phase: 3, reviewSubmission: { expectedRevision: 1, action: 'approve-proposals', targets: [] } }))).toBe(3);
    expect(stepperIndex(job({ state: 'running', phase: 5 }))).toBe(4);
  });

  it('shows progress stages from the real phase, and friendly activity messages', () => {
    expect(processingStages(job({ state: 'running', phase: 1 })).map(s => s.state)).toEqual(['active', 'pending', 'pending', 'pending', 'pending']);
    expect(processingStages(job({ state: 'running', phase: 2 })).map(s => s.state)).toEqual(['done', 'active', 'pending', 'pending', 'pending']);
    expect(processingStages(job({ state: 'queued', phase: 3, reviewSubmission: { expectedRevision: 1, action: 'approve-proposals', targets: [] } })).map(s => s.state)).toEqual(['done', 'done', 'active', 'pending', 'pending']);
    expect(processingStages(job({ state: 'running', phase: 4 })).map(s => s.state)).toEqual(['done', 'done', 'done', 'active', 'pending']);
    expect(processingStages(job({ state: 'running', phase: 5 })).map(s => s.state)).toEqual(['done', 'done', 'done', 'done', 'active']);
    expect(processingMessage(job({ state: 'queued', phase: 3, reviewSubmission: { expectedRevision: 1, action: 'save-proposals', targets: [] } }))).toBe('Saving your layer choices…');
    expect(processingMessage(job({ state: 'queued', phase: 4, reviewSubmission: { expectedRevision: 1, action: 'guided-refine' } }))).toBe('AI is refining the selection…');
    for (const message of [processingMessage(job({ state: 'running', phase: 1 })), processingMessage(job({ state: 'running', phase: 4 }))]) expect(message).not.toMatch(/SAM|Seedream|BiRefNet|phase/i);
  });

  it('uses friendly element types and "Choose type" for ambiguous layers', () => {
    expect(friendlyType(target({ role: 'text' }))).toEqual({ type: 'Text', suggested: false });
    expect(friendlyType(target({ classification: { kind: 'SHAPE', confidence: 'medium', source: 'provider-label', reasons: [] } }))).toEqual({ type: 'Shape', suggested: true });
    expect(friendlyType(target({ classification: { kind: 'UNKNOWN', confidence: 'low', source: 'default', reasons: [] } })).type).toBe('Choose type');
    expect(friendlyType(target({ baseLayer: true, role: 'background' })).type).toBe('Background');
  });

  it('turns quality codes into plain-language selection feedback', () => {
    expect(selectionStatus({ qualityTier: 'FAIL', qualityChecks: [{ code: 'TINY_PATCH', tier: 'FAIL', message: 'x' }] })).toEqual({ tone: 'fix', title: 'Needs a fix', details: ['Only a small part of the object is selected.'] });
    expect(selectionStatus({ qualityTier: 'PASS', qualityChecks: [] })).toMatchObject({ tone: 'good', title: 'Looks right' });
    expect(selectionStatus({ qualityTier: 'REVIEW', qualityChecks: [{ code: 'NEW_CODE', tier: 'REVIEW', message: 'x' }] }).details).toEqual(['Take a quick look at this selection.']);
  });

  it('gives friendly errors and ready-state counts', () => {
    expect(friendlyError({ state: 'failed', error: { code: 'PROVIDER_NETWORK', message: 'HTTP 503', retryable: true } })).toMatchObject({ title: 'The AI service is busy', canRetry: true });
    expect(friendlyError({ state: 'failed', error: { code: 'PROVIDER_CREDITS', message: 'x', retryable: false } }).canRetry).toBe(false);
    expect(readySummary({ layers: [{ type: 'background' }, { type: 'image' }, { type: 'text' }, { type: 'text' }, { type: 'shape' }] } as never)).toEqual({ editable: 4, text: 2, shapes: 1, images: 1, background: true });
  });
});

it('never reports a provisional AI selection as looking right', () => {
  expect(selectionStatus({ provisional: true, qualityTier: 'PASS', qualityChecks: [] })).toMatchObject({ tone: 'check', title: 'Check this selection', details: ['AI found a possible selection. Check it and fix any missing or extra areas.'] });
});
