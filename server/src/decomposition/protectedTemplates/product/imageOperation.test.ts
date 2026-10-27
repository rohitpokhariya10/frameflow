import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { liveArtworkGenerator } from './artwork.js';
import { boundedImage, failureKind, imageConcurrency, imageFailure, limitedImage } from './imageOperation.js';

const input = { prompt: 'one appliance', size: { width: 1024, height: 1024 }, operationId: 'test-operation-1' };
const log = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
describe('image request diagnostics without retries', () => {
  it('preserves connection causes, excludes secrets, and makes only one request', async () => {
    const output: object[] = [], fetch = vi.fn(async () => { throw new TypeError('fetch failed sk-secret', { cause: Object.assign(new Error('private headers'), { code: 'ECONNRESET' }) }); }), spy = log();
    try {
      const g = liveArtworkGenerator({ client: new OpenAI({ apiKey: 'fake-key', fetch }) });
      await expect(g.generate(input, (_f, v) => output.push(v))).rejects.toMatchObject({ failure: { code: 'IMAGE_TRANSPORT_INTERRUPTED', outcome: 'unknown' } });
      expect(fetch).toHaveBeenCalledTimes(1); expect(JSON.stringify(output)).toContain('ECONNRESET'); expect(JSON.stringify(output)).not.toMatch(/sk-secret|private headers|fake-key/);
      const request = fetch.mock.calls[0] as unknown as [unknown, RequestInit];
      expect(new Headers(request[1].headers).get('X-Client-Request-Id')).toBe(input.operationId);
    } finally { spy.mockRestore(); }
  });
  it('retains the request ID when a 200 response body terminates during JSON parsing', async () => {
    const output: Record<string, object> = {}, spy = log(); let calls = 0;
    const client = new OpenAI({ apiKey: 'fake', fetch: async () => {
      calls++; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); setTimeout(() => controller.error(new TypeError('terminated', { cause: Object.assign(new Error(), { code: 'UND_ERR_SOCKET' }) })), 5); } }), { headers: { 'content-type': 'application/json', 'x-request-id': 'req_truncated' } });
    } });
    try {
      await expect(liveArtworkGenerator({ client }).generate(input, (f, v) => { output[f] = v; })).rejects.toMatchObject({ failure: { outcome: 'unknown', requestId: 'req_truncated' } });
      expect(calls).toBe(1); expect(JSON.stringify(output['artwork.openai-error.json'])).toContain('UND_ERR_SOCKET');
    } finally { spy.mockRestore(); }
  });
  it('reports credit exhaustion without retrying HTTP 429', async () => {
    const spy = log(), fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'You have no credits remaining', code: 'credit_balance_exhausted' } }), { status: 429, headers: { 'content-type': 'application/json', 'x-request-id': 'req_quota' } }));
    try {
      await expect(liveArtworkGenerator({ client: new OpenAI({ apiKey: 'fake', fetch }) }).generate(input, () => undefined)).rejects.toMatchObject({ failure: { code: 'OPENAI_HTTP_429', outcome: 'rejected', message: expect.stringContaining('no credit left') } });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
  it('bounds a hanging operation, aborts its signal, and releases its permit', async () => {
    let signal: AbortSignal | undefined;
    await expect(limitedImage(() => boundedImage({ model: 'hung', offline: false, async generate(i) { signal = i.signal; return new Promise(() => undefined); } }, input, () => undefined, 10))).rejects.toMatchObject({ failure: { code: 'IMAGE_TIMEOUT', outcome: 'unknown' } });
    expect(signal?.aborted).toBe(true); expect(await limitedImage(async () => 'next permitted')).toBe('next permitted');
    expect(imageFailure(Object.assign(new Error(), { name: 'AbortError' }))).toMatchObject({ code: 'IMAGE_ABORTED', outcome: 'unknown' });
  });
  it('never exceeds the request concurrency across concurrent jobs, and classifies what a failure means for the batch', async () => {
    const before = process.env.FRAMEFLOW_PRODUCT_IMAGE_CONCURRENCY;
    try {
      for (const [setting, expected] of [[undefined, 2], ['1', 1], ['3', 3], ['99', 4]] as const) {
        if (setting === undefined) delete process.env.FRAMEFLOW_PRODUCT_IMAGE_CONCURRENCY; else process.env.FRAMEFLOW_PRODUCT_IMAGE_CONCURRENCY = setting;
        let active = 0, peak = 0;
        await Promise.all(Array.from({ length: 9 }, () => limitedImage(async () => { peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 5)); active--; })));
        expect([imageConcurrency(), peak]).toEqual([expected, expected]);
      }
    } finally { if (before === undefined) delete process.env.FRAMEFLOW_PRODUCT_IMAGE_CONCURRENCY; else process.env.FRAMEFLOW_PRODUCT_IMAGE_CONCURRENCY = before; }
    const credit = imageFailure(Object.assign(new Error('You have no credits remaining'), { status: 429, code: 'credit_balance_exhausted' }));
    expect(failureKind(credit)).toBe('insufficient-credits');
    expect(failureKind(imageFailure(Object.assign(new Error('Rate limit'), { status: 429, code: 'rate_limit_exceeded' })))).toBe('provider-failure');
    expect(failureKind(imageFailure(Object.assign(new Error('Bad gateway'), { status: 502 })))).toBe('provider-failure');
    expect(failureKind(imageFailure(new TypeError('terminated', { cause: Object.assign(new Error(), { code: 'ECONNRESET' }) })))).toBe('connection-interrupted');
    expect(failureKind(imageFailure(new Error('text detected'), true))).toBe('image-rejected');
  });
});
