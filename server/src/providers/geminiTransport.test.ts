import { afterEach, expect, it, vi } from 'vitest';
import { geminiProvider } from './geminiProvider.js';
import { mapProviderError } from '../services/aiService.js';
import { mockPng } from '../testSupport.js';

afterEach(() => vi.unstubAllGlobals());

it('serializes the real SDK Interactions request without unsupported delivery and reads image steps', async () => {
  const data = mockPng().toString('base64');
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).pathname).toBe('/v1beta/interactions');
    expect(request.method).toBe('POST');
    const body = await request.json();
    expect(body).toMatchObject({ model: 'configured-model', input: 'Minimal floral artwork', store: false,
      response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: '1K' } });
    expect(body.response_format).not.toHaveProperty('delivery');
    return Response.json({ id: 'test-interaction', status: 'completed', model: 'configured-model',
      steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data }] }] });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(geminiProvider('test-only-credential', 'configured-model')('Minimal floral artwork', '1:1', new AbortController().signal))
    .resolves.toEqual({ data, mimeType: 'image/png' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('preserves the observed SDK 400 classification without retrying or exposing raw messages', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: {
    code: 'invalid_request', message: 'Image delivery mode is not supported. private-provider-detail',
  } }, { status: 400 }));
  vi.stubGlobal('fetch', fetch);
  const result = geminiProvider('test-only-credential', 'configured-model')('Artwork', '4:5', new AbortController().signal);
  await expect(result).rejects.toMatchObject({ status: 400, statusCode: 400 });
  const normalized = await result.catch(mapProviderError);
  expect(normalized).toMatchObject({ code: 'PROVIDER_REQUEST', status: 400, retryable: false,
    providerDiagnostic: { providerStatus: 400 } });
  expect(JSON.stringify(normalized)).not.toContain('private-provider-detail');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('normalizes the observed quota rejection through the actual SDK without a retry', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: {
    code: 'too_many_requests', message: 'Rate limit exceeded for model (limit: 0 requests per day on Free Tier).',
  } }, { status: 429 }));
  vi.stubGlobal('fetch', fetch);
  const result = geminiProvider('test-only-credential', 'configured-model')('Artwork', '1:1', new AbortController().signal);
  await expect(result).rejects.toMatchObject({ status: 429, statusCode: 429 });
  expect(await result.catch(mapProviderError)).toMatchObject({ code: 'RATE_LIMIT', status: 429,
    providerDiagnostic: { providerStatus: 429, canonicalCode: 'too_many_requests' } });
  expect(fetch).toHaveBeenCalledTimes(1);
});
