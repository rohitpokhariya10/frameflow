import { describe, expect, it, vi } from 'vitest';
import { DurableFalClient, providerInputHash } from './falClient.js';
import type { FalTransport, ProviderRepository, ProviderRequestRecord } from './falClient.js';
import { ProviderError } from './adapters.js';

function fixture() {
  let now = 1000;
  const records = new Map<string, ProviderRequestRecord>();
  const repo: ProviderRepository = {
    getProviderRequest: (stepId, inputHash) => [...records.values()].find(record => record.stepId === stepId && record.inputHash === inputHash),
    reserveProviderRequest: vi.fn(input => {
      const record: ProviderRequestRecord = { ...input, id: `request-${records.size}`, status: 'SUBMITTING', attempts: 0, nextPollAt: now, createdAt: now, updatedAt: now };
      records.set(record.id, record);
      return record;
    }),
    updateProviderRequest: (id, patch) => { Object.assign(records.get(id)!, patch); },
  };
  const transport: FalTransport = {
    submit: vi.fn(async () => ({ requestId: 'fal-request-123' })),
    status: vi.fn(async () => 'COMPLETED' as const),
    result: vi.fn(async () => ({ images: [{ url: 'https://v3b.fal.media/test.png' }], has_nsfw_concepts: [false] })),
    cancel: vi.fn(async () => {}), upload: vi.fn(async () => 'https://v3b.fal.media/source.png'), download: vi.fn(async () => Buffer.alloc(0)),
  };
  const input = { jobId: 'job', stepId: 'step', model: 'qwen' as const, input: { image_url: 'https://v3b.fal.media/source.png' }, inputHash: 'stable-image-hash' };
  const options = { maxGlobalCalls: 10, now: () => now, random: () => 0.5, phaseTimeoutMs: 300_000 };
  const client = new DurableFalClient(repo, transport, options);
  return { repo, transport, records, input, client, options, advance: (ms = 2000) => { now += ms; } };
}

describe('durable paid-call lifecycle', () => {
  it('persists before submission and resumes known IDs after process replacement', async () => {
    const f = fixture();
    f.transport.submit = vi.fn(async () => { expect([...f.records.values()][0].status).toBe('SUBMITTING'); return { requestId: 'fal-accepted' }; });
    expect((await f.client.advance(f.input)).state).toBe('pending');
    const restarted = new DurableFalClient(f.repo, f.transport, f.options);
    expect((await restarted.advance(f.input)).state).toBe('pending');
    expect(f.transport.status).not.toHaveBeenCalled();
    f.advance();
    expect((await restarted.advance(f.input)).state).toBe('completed');
    expect(f.transport.submit).toHaveBeenCalledTimes(1);
    expect(f.transport.status).toHaveBeenCalledWith('fal-ai/qwen-image-layered', 'fal-accepted');
    expect((await restarted.advance(f.input)).state).toBe('completed');
    expect(f.transport.result).toHaveBeenCalledTimes(1);
  });

  it('does not replay an ambiguous submission or crash-before-ID', async () => {
    const f = fixture();
    f.transport.submit = vi.fn(async () => { throw new ProviderError('PROVIDER_NETWORK', 'timeout', true); });
    await expect(f.client.advance(f.input)).rejects.toMatchObject({ code: 'SUBMISSION_UNKNOWN' });
    expect([...f.records.values()][0].status).toBe('SUBMISSION_UNKNOWN');
    await expect(f.client.advance(f.input)).rejects.toMatchObject({ code: 'SUBMISSION_UNKNOWN' });
    expect(f.transport.submit).toHaveBeenCalledTimes(1);
    [...f.records.values()][0].status = 'SUBMITTING';
    await expect(new DurableFalClient(f.repo, f.transport, f.options).advance(f.input)).rejects.toMatchObject({ code: 'SUBMISSION_UNKNOWN' });
    expect(f.transport.submit).toHaveBeenCalledTimes(1);
  });

  it('retries known-ID lookups durably within a bound without resubmission', async () => {
    const f = fixture();
    await f.client.advance(f.input);
    f.transport.status = vi.fn(async () => { throw new ProviderError('PROVIDER_RATE_LIMIT', '429', true, 429, 30_000); });
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(31_000);
      const result = await f.client.advance(f.input);
      expect(result.state).toBe('pending');
      expect(result.request.attempts).toBe(attempt + 1);
    }
    f.advance(31_000);
    await expect(f.client.advance(f.input)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT' });
    expect(f.transport.submit).toHaveBeenCalledTimes(1);
  });

  it('stops on known auth rejection, cancellation, and deadlines', async () => {
    const f = fixture();
    f.transport.submit = vi.fn(async () => { throw new ProviderError('PROVIDER_AUTH', 'unauthorized', false, 401); });
    await expect(f.client.advance(f.input)).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
    expect([...f.records.values()][0].status).toBe('FAILED');
    const cancelled = fixture();
    await cancelled.client.advance(cancelled.input);
    await expect(cancelled.client.advance({ ...cancelled.input, cancelled: true })).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
    expect(cancelled.transport.cancel).toHaveBeenCalledTimes(1);
    expect(cancelled.transport.result).not.toHaveBeenCalled();
    const deadline = fixture();
    await deadline.client.advance(deadline.input);
    deadline.advance(301_000);
    await expect(deadline.client.advance(deadline.input)).rejects.toMatchObject({ code: 'PROVIDER_DEADLINE' });
    expect(deadline.transport.cancel).toHaveBeenCalledTimes(1);
  });

  it('delegates atomic budget reservations before any network work', async () => {
    const f = fixture();
    f.repo.reserveProviderRequest = vi.fn(() => { throw new Error('CALL_BUDGET_EXCEEDED'); });
    await expect(f.client.advance(f.input)).rejects.toThrow('CALL_BUDGET_EXCEEDED');
    expect(f.transport.submit).not.toHaveBeenCalled();
    expect(providerInputHash('sam2', { hash: 'same', settings: { b: 2, a: 1 } })).toBe(providerInputHash('sam2', { settings: { a: 1, b: 2 }, hash: 'same' }));
  });
});
