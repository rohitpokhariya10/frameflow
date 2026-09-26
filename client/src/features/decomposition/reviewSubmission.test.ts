import { expect, it, vi } from 'vitest';
import { submitReviewOnce } from './reviewSubmission';
import { decompositionApi } from './api';
import type { DecompositionReview } from '@frameflow/shared';

const body: DecompositionReview = { expectedRevision: 14, action: 'accept-masks', objects: [{ id: 'candidate-6', candidateId: 'candidate-6', label: 'person', selected: true, points: [{ x: 100, y: 100, label: 1 }, { x: 1, y: 1, label: 0 }], strokes: [] }] };
it('sends one exact review payload during rapid duplicate clicks and exposes submitting state', async () => {
  let finish!: (value: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetch);
  try {
    const lock = { current: false }, status = vi.fn();
    const submit = async (review: DecompositionReview) => { await decompositionApi.review('job-1', review); };
    const first = submitReviewOnce(lock, body, submit, status);
    await submitReviewOnce(lock, body, submit, status);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['/api/decomposition/jobs/job-1/review', expect.objectContaining({ method: 'POST', body: JSON.stringify(body) })]);
    expect(status).toHaveBeenLastCalledWith({ pending: true, error: '' });
    finish(new Response(JSON.stringify({ state: 'queued', phase: 4, revision: 15 })));
    await first;
    expect(status).toHaveBeenLastCalledWith({ pending: false, error: '' });
    expect(lock.current).toBe(false);
  } finally { vi.unstubAllGlobals(); }
});
it('exposes stale-revision response text beside review controls and unlocks retry', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Review changed. Reload the latest masks before applying corrections.' } }), { status: 409 })));
  try {
    const lock = { current: false }, status = vi.fn();
    await submitReviewOnce(lock, body, async review => { await decompositionApi.review('job-1', review); }, status);
    expect(status).toHaveBeenLastCalledWith({ pending: false, error: 'Review changed. Reload the latest masks before applying corrections.' });
    expect(lock.current).toBe(false);
  } finally { vi.unstubAllGlobals(); }
});
