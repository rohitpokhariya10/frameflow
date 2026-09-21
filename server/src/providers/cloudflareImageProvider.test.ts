import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_LIMITS } from '@frameflow/shared';
import { cloudflareDimensions, cloudflareImageProvider, CLOUDFLARE_IMAGE_MODEL } from './cloudflareImageProvider.js';
import { artworkPrompt, generateArtwork } from '../services/aiService.js';
import { mockPng, mockRequest } from '../testSupport.js';

// All transport calls are intercepted; fixtures never use credentials or a live provider.
const account = 'mock-account';
const token = 'mock-token';
const model = CLOUDFLARE_IMAGE_MODEL;
const provider = () => cloudflareImageProvider(account, token, model);
function intercept(implementation: typeof globalThis.fetch) {
  const fetch = vi.fn(implementation);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function generate(disconnected?: AbortSignal, timeout = 1000) {
  return generateArtwork(mockRequest, 'cloudflare-test-request', model, timeout, provider(), disconnected, 'cloudflare');
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Cloudflare multipart transport and normalized artwork', () => {
  it('sends the server-only bearer token and multipart dimensions while returning actual image metadata', async () => {
    const data = mockPng(4, 5).toString('base64');
    let received: Request | undefined;
    let options: RequestInit | undefined;
    const fetch = intercept(async (input, init) => {
      received = new Request(input, init); options = init;
      return Response.json({ success: true, result: { image: data, width: 999, height: 999, mimeType: 'image/jpeg' } });
    });
    const result = await generate();
    expect(received?.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`);
    expect(received?.method).toBe('POST');
    expect(received?.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(received?.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(options?.headers).toEqual({ Authorization: `Bearer ${token}` });
    expect(options?.redirect).toBe('error');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const body = await received!.formData();
    // Multipart text fields use CRLF on the wire; their content is otherwise unchanged.
    body.set('prompt', String(body.get('prompt')).replace(/\r\n/g, '\n'));
    expect(Object.fromEntries(body)).toEqual({ prompt: artworkPrompt(mockRequest, '4:5'), width: '816', height: '1024' });
    expect(result).toEqual({ requestId: 'cloudflare-test-request',
      image: { base64: data, mimeType: 'image/png', width: 4, height: 5 },
      generation: { mode: 'live', provider: 'cloudflare', model, requestedAspectRatio: '4:5', promptUsed: artworkPrompt(mockRequest, '4:5') },
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['image/jpeg', 'image/webp'])('detects %s and dimensions from bytes when envelope metadata disagrees', async (mimeType) => {
    // Synthetic format headers test server inspection, not full browser decoding.
    // The real JPEG decode was separately verified once through the app.
    const bytes = mimeType === 'image/jpeg'
      ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xc0, 0, 11, 8, 4, 0, 3, 48, 1, 1, 17, 0, 0xff, 0xd9])
      : Buffer.alloc(30);
    if (mimeType === 'image/webp') {
      bytes.write('RIFF'); bytes.writeUInt32LE(22, 4); bytes.write('WEBPVP8X', 8);
      bytes.writeUInt32LE(10, 16); bytes.writeUIntLE(815, 24, 3); bytes.writeUIntLE(1023, 27, 3);
    }
    const data = bytes.toString('base64');
    const fetch = intercept(async () => Response.json({ success: true, result: { image: data, mimeType: 'image/png', width: 1, height: 1 } }));
    const result = await generate();
    expect(result.image).toEqual({ base64: data, mimeType, width: 816, height: 1024 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('encodes the account path segment and derives bounded dimensions when only an aspect ratio is supplied', async () => {
    const fetch = intercept(async (input, init) => {
      expect(String(input)).toContain('/accounts/mock%2Faccount/ai/run/');
      expect(Object.fromEntries(init?.body as FormData)).toEqual({ prompt: 'Artwork only', width: '816', height: '1024' });
      return Response.json({ success: true, result: { image: mockPng().toString('base64') } });
    });
    await expect(cloudflareImageProvider('mock/account', token, model)('Artwork only', '4:5', new AbortController().signal))
      .resolves.toMatchObject({ mimeType: 'image/png' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ width: 1080, height: 1350 }, { width: 816, height: 1024 }],
    [{ width: 1600, height: 900 }, { width: 1024, height: 576 }],
    [{ width: 1080, height: 1920 }, { width: 576, height: 1024 }],
    [{ width: 1080, height: 1080 }, { width: 1024, height: 1024 }],
    [{ width: 4096, height: 256 }, { width: 1024, height: 256 }],
    [{ width: 256, height: 4096 }, { width: 256, height: 1024 }],
    [{ width: 256, height: 256 }, { width: 256, height: 256 }],
  ])('keeps provider dimensions within model bounds without mutating logical target %#', (target, expected) => {
    const before = { ...target };
    expect(cloudflareDimensions(target)).toEqual(expected);
    expect(target).toEqual(before);
    expect(expected.width % 16).toBe(0); expect(expected.height % 16).toBe(0);
    expect(expected.width * expected.height).toBeLessThanOrEqual(1024 * 1024);
  });
});

describe('Cloudflare safe failure classification', () => {
  it.each([
    [400, 'PROVIDER_REQUEST', 400, false],
    [401, 'CONFIGURATION', 503, false], [403, 'CONFIGURATION', 503, false],
    [404, 'MODEL_UNAVAILABLE', 503, false], [429, 'RATE_LIMIT', 429, true],
    [408, 'TIMEOUT', 504, true], [413, 'PROVIDER_REQUEST', 400, false], [500, 'PROVIDER_FAILURE', 502, true],
  ] as const)('normalizes HTTP %d without leaking provider messages or retrying', async (httpStatus, code, status, retryable) => {
    const fetch = intercept(async () => Response.json({ success: false, errors: [{ message: 'private-provider-detail', code: 99999 }] }, { status: httpStatus }));
    const error = await generate().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code, status, retryable, providerDiagnostic: { providerStatus: httpStatus } });
    expect(JSON.stringify(error)).not.toMatch(/private-provider-detail|99999|mock-token/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [10000, 'CONFIGURATION', 503], [5018, 'CONFIGURATION', 503],
    [5007, 'MODEL_UNAVAILABLE', 503], [3036, 'RATE_LIMIT', 429],
    [3008, 'TIMEOUT', 504], [5004, 'PROVIDER_REQUEST', 400],
  ] as const)('classifies success:false numeric code %d even when HTTP status is 200', async (providerCode, code, status) => {
    const fetch = intercept(async () => Response.json({ success: false, errors: [{ code: providerCode, message: 'private-error-message' }] }));
    const error = await generate().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code, status, providerDiagnostic: { providerStatus: 200, canonicalCode: `CLOUDFLARE_${providerCode}` } });
    expect(JSON.stringify(error)).not.toContain('private-error-message');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('handles an unrecognized success:false envelope as a provider failure with no raw details', async () => {
    const fetch = intercept(async () => Response.json({ success: false, errors: [null, { code: 'private-code', message: 'private-detail' }] }));
    const error = await generate().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'PROVIDER_FAILURE', status: 502, retryable: true });
    expect(JSON.stringify(error)).not.toContain('private-');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('classifies known error codes without replacing the actual upstream HTTP status in diagnostics', async () => {
    const fetch = intercept(async () => Response.json({ success: false, errors: [{ code: 5007, message: 'private model detail' }] }, { status: 400 }));
    await expect(generate()).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', status: 503,
      providerDiagnostic: { providerStatus: 400, canonicalCode: 'CLOUDFLARE_5007' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains the HTTP failure classification when an upstream proxy returns non-JSON text', async () => {
    const fetch = intercept(async () => new Response('<html>private proxy failure</html>', { status: 403 }));
    await expect(generate()).rejects.toMatchObject({ code: 'CONFIGURATION', status: 503, providerDiagnostic: { providerStatus: 403 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Cloudflare malformed image and response handling', () => {
  it.each([null, {}, { success: true }, { success: true, result: {} }, { success: true, result: { image: 12 } }])('rejects missing image envelope %#', async (response) => {
    const fetch = intercept(async () => Response.json(response));
    await expect(generate()).rejects.toMatchObject({ code: 'NO_IMAGE', status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'not base64!', 'abcd', `${mockPng().toString('base64')}\n`, 'bm90IGFuIGltYWdl'])('rejects malformed or undecodable image bytes %#', async (image) => {
    const fetch = intercept(async () => Response.json({ success: true, result: { image } }));
    await expect(generate()).rejects.toMatchObject({ code: 'INVALID_IMAGE', status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid JSON and empty response bodies', async () => {
    const fetch = intercept(async () => new Response('{"success":'));
    await expect(generate()).rejects.toMatchObject({ code: 'INVALID_IMAGE', status: 502 });
    fetch.mockResolvedValueOnce(new Response(null));
    await expect(generate()).rejects.toMatchObject({ code: 'INVALID_IMAGE', status: 502 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds streamed JSON before parsing or storing a large response', async () => {
    const cancel = vi.fn();
    const maxBytes = Math.ceil(AI_LIMITS.imageBytes / 3) * 4 + 64 * 1024;
    const fetch = intercept(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(maxBytes + 1)); }, cancel,
    })));
    await expect(generate()).rejects.toMatchObject({ code: 'INVALID_IMAGE', status: 502 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('validates image dimensions from bytes against the application pixel limit', async () => {
    const image = mockPng(); image.writeUInt32BE(100_000, 16); image.writeUInt32BE(100_000, 20);
    const fetch = intercept(async () => Response.json({ success: true, result: { image: image.toString('base64') } }));
    await expect(generate()).rejects.toMatchObject({ code: 'INVALID_IMAGE', status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Cloudflare transport cancellation and timeouts', () => {
  it('normalizes a failed network connection without retrying', async () => {
    const fetch = intercept(async () => { throw new TypeError('private connection message', { cause: { code: 'ENOTFOUND' } }); });
    await expect(generate()).rejects.toMatchObject({ code: 'NETWORK', status: 502, retryable: true, providerDiagnostic: { reason: 'ENOTFOUND' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not contact the provider for a request already disconnected', async () => {
    const fetch = intercept(async () => { throw new Error('Unexpected provider request'); });
    const disconnected = new AbortController(); disconnected.abort();
    await expect(generate(disconnected.signal)).rejects.toMatchObject({ code: 'CANCELLED', status: 499 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('propagates disconnection to fetch and clears the request timeout without retrying', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = intercept(async (_input, init) => new Promise<never>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const disconnected = new AbortController();
    const assertion = expect(generate(disconnected.signal)).rejects.toMatchObject({ code: 'CANCELLED', status: 499 });
    disconnected.abort(); await assertion;
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a timed-out fetch exactly once and does not retry', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = intercept(async (_input, init) => new Promise<never>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const assertion = expect(generate(undefined, 1000)).rejects.toMatchObject({ code: 'TIMEOUT', status: 504, retryable: true });
    await vi.advanceTimersByTimeAsync(1000); await assertion;
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
